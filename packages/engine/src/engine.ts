// The engine: owns every session, the Hub, prompts and settings, and talks to
// the UI over a local WebSocket.

import fs from 'node:fs';
import path from 'node:path';
import { Hub } from './hub.js';
import { BaseSession, type SessionHost } from './session.js';
import { RealSession } from './real-session.js';
import { MockSession } from './mock-session.js';
import { GeminiSession, listGeminiModels } from './gemini-session.js';
import { OpenAISession, listOpenAIModels } from './openai-session.js';
import { CodexSession } from './codex-session.js';
import { readClaudeUsage } from './claude-usage.js';
import { findCodex, openCodexInstall, openUrl, probeCodex, startChatgptLogin } from './codex.js';
import { isSignedIn, openLogin } from './auth.js';
import { commitTemplates, demoTemplates, loadTemplates, upsertTemplate } from './templates.js';
import { MemoryStore, REFLECT_PROMPT, parseReflection, projectOf } from './memory.js';
import type { MemoryToolName } from './session.js';
import { WORKER_TIMEOUT_MS, classifyTask, clipSummary, isWorkerKind, workerName, workerPrompt, type WorkerSpec } from './workers.js';
import type {
  ClientMsg,
  EngineMsg,
  EngineSettings,
  Family,
  FeedItem,
  HubMessage,
  Link,
  LessonType,
  MemoryNote,
  PromptRequest,
  PromptResponse,
  SessionConfig,
  SessionTemplate,
  Snapshot,
  WorkspaceInfo,
} from './protocol.js';
import { type ChatgptStatus, DEFAULT_GEMINI_MODELS, DEFAULT_MODELS, DEFAULT_OPENAI_MODELS, DEFAULT_WORKER_ROUTING, WORKER_KIND_LABEL, providerOf, safeName } from './protocol.js';

const FEED_LIMIT = 1500;
/** The file holds API keys, so only its owner may read it. */
const SECRETS_MODE = 0o600;

export interface EngineOptions {
  dataDir: string;
  mock: boolean;
  broadcast(msg: EngineMsg): void;
}

export class Engine {
  private sessions = new Map<string, BaseSession>();
  private feeds = new Map<string, FeedItem[]>();
  private prompts = new Map<string, { req: PromptRequest; resolve: (r: PromptResponse) => void }>();
  private links: Link[] = [];
  private families: Family[] = [];
  private templates: SessionTemplate[] = [];
  private settings: EngineSettings;
  private key: string | null = null;
  private geminiKey: string | null = null;
  private openaiKey: string | null = null;
  private codexBin: string | null = null;
  private codexTimer: ReturnType<typeof setInterval> | undefined;
  /** Plan usage warnings already shown, so each shows once per window. */
  private usageWarned = new Set<string>();
  private loginWatch: ReturnType<typeof setInterval> | undefined;
  readonly hub: Hub;
  readonly memory: MemoryStore;
  /** Sessions writing down what they learned right now. */
  private reflecting = new Map<string, { since: number; finish: () => void }>();
  /** Turn count at each session's last reflection, so nothing is reflected twice. */
  private reflectedAt = new Map<string, number>();
  /** Helpers whose boss is waiting on their summary. */
  private waiting = new Map<string, { since: number; done: (summary: string) => void }>();

  constructor(private opts: EngineOptions) {
    fs.mkdirSync(path.join(opts.dataDir, 'workspaces'), { recursive: true });
    const saved = this.readJson<Partial<EngineSettings>>('settings.json') ?? {};
    this.settings = {
      authMode: 'local',
      defaultModel: 'claude-sonnet-5-5',
      maxMessageChars: 500,
      maxMessagesPerHour: 30,
      maxNegotiationRounds: 2,
      maxWakeChain: 2,
      maxWakesPerHour: 8,
      budgetUsd: 0,
      claudePath: null,
      notify: true,
      memoryEnabled: true,
      memoryDir: null,
      memoryReflect: true,
      memoryMaxNotes: 6,
      maxWorkersPerBoss: 4,
      workerSpendCapUsd: 2,
      workerNesting: false,
      askBeforeSpawn: false,
      onboarded: false,
      openaiAuth: 'chatgpt',
      codexPath: null,
      ...saved,
      workerRouting: { ...DEFAULT_WORKER_ROUTING, ...(saved.workerRouting ?? {}) },
      memoryPath: '',
      hasApiKey: false,
      hasGeminiKey: false,
      geminiModels: DEFAULT_GEMINI_MODELS,
      hasOpenaiKey: false,
      openaiModels: DEFAULT_OPENAI_MODELS,
      chatgpt: noChatgpt(),
      claudeUsage: null,
      signedIn: opts.mock || isSignedIn(),
      mock: opts.mock,
    };
    this.settings.memoryPath = this.resolveMemoryPath();
    this.memory = new MemoryStore(() => this.settings.memoryPath);
    this.templates = loadTemplates(opts.dataDir);
    if (opts.mock && !this.templates.length) this.templates = demoTemplates();
    // Older versions left this file readable by other users on the machine.
    try {
      fs.chmodSync(path.join(opts.dataDir, 'secrets.json'), SECRETS_MODE);
    } catch {
      // No secrets saved yet.
    }
    const secrets = this.readJson<{ apiKey?: string | null; geminiKey?: string | null; openaiKey?: string | null }>('secrets.json') ?? {};
    this.key = process.env.SINNECT_API_KEY || secrets.apiKey || null;
    this.geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || secrets.geminiKey || null;
    this.settings.hasApiKey = !!this.key;
    this.openaiKey = process.env.OPENAI_API_KEY || secrets.openaiKey || null;
    this.settings.hasGeminiKey = !!this.geminiKey;
    this.settings.hasOpenaiKey = !!this.openaiKey;
    if (this.geminiKey && !opts.mock) this.refreshGeminiModels();
    if (this.openaiKey && !opts.mock) this.refreshOpenaiModels();
    if (opts.mock) {
      const h = Date.now() / 1000;
      this.settings.chatgpt = { ...noChatgpt(), found: true, signedIn: true, plan: 'plus', models: DEFAULT_OPENAI_MODELS, usage: demoUsage(18, 41, h) };
      this.settings.claudeUsage = { plan: 'max', usage: demoUsage(36, 62, h), checkedAt: Date.now() };
    }
    else {
      void this.refreshChatgpt();
      // Plan usage moves while sessions work. Cheap: one short Codex call every 10 minutes, only while a ChatGPT session is open.
      this.codexTimer = setInterval(() => {
        if ([...this.sessions.values()].some((x) => x instanceof CodexSession && x.state.status !== 'stopped')) void this.refreshChatgpt();
      }, 10 * 60_000);
      (this.codexTimer as { unref?: () => void }).unref?.();
    }

    this.hub = new Hub({
      sessions: () =>
        [...this.sessions.values()]
          .filter((s) => s.state.status !== 'stopped')
          .map((s) => ({
            id: s.id,
            name: s.config.name,
            priority: s.config.priority,
            familyId: s.config.familyId ?? null,
            awareness: s.config.awareness,
            goal: s.state.goal,
            status: s.state.status,
            activity: s.state.activity,
            parentId: s.config.parentId ?? null,
            workspace: s.config.workspace ?? null,
          })),
      links: () => this.links,
      limits: () => this.settings,
      deliver: (msg, wake) => this.sessions.get(msg.to)?.deliver(msg, wake),
      openPrompt: (p) => this.openPrompt(p),
      closePrompt: (id) => this.closePrompt(id),
      claimsChanged: (claims) => this.send({ t: 'claims', claims }),
      messageLogged: (message: HubMessage) => this.send({ t: 'hub.message', message }),
    });
  }

  private send(msg: EngineMsg) {
    this.opts.broadcast(msg);
  }

  private resolveMemoryPath() {
    const d = this.settings.memoryDir?.trim();
    return d ? path.resolve(d) : path.join(this.opts.dataDir, 'memory');
  }

  private sendMemory() {
    this.send({ t: 'memory', notes: this.memory.list() });
  }

  private learned(sessionId: string, notes: MemoryNote[]) {
    if (!notes.length) return;
    this.send({ t: 'memory.learned', sessionId, notes });
    this.sendMemory();
  }

  private memoryContext(cfg: SessionConfig) {
    if (!this.settings.memoryEnabled) return '';
    return this.memory.contextFor(cfg.cwd, cfg.prompt, { maxNotes: this.settings.memoryMaxNotes });
  }

  /** memory_save, skill_save, skill_get, memory_search. Plain code, the only tokens are the short reply. */
  private memoryTool(sessionId: string, name: MemoryToolName, a: Record<string, unknown>): string {
    if (!this.settings.memoryEnabled) return 'Memory is turned off in Sinnect settings.';
    const cfg = this.sessions.get(sessionId)?.config;
    const project = cfg ? projectOf(cfg.cwd) : null;
    const source = cfg?.name ?? 'A session';
    try {
      switch (name) {
        case 'memory_save': {
          const type = (['rule', 'worked', 'broke'].includes(String(a.type)) ? a.type : 'rule') as LessonType;
          const n = this.memory.addLesson({ type, title: String(a.title ?? ''), note: String(a.note ?? ''), project: a.everywhere === true ? null : project, source });
          if (!n) return 'Not saved: empty, or a note like it already exists.';
          this.learned(sessionId, [n]);
          return 'Saved. Future sessions here will see it.';
        }
        case 'skill_save': {
          const n = this.memory.addSkill({ name: String(a.name ?? ''), description: String(a.description ?? ''), steps: String(a.steps ?? ''), project: null, source });
          if (!n) return 'Not saved: a skill needs a name and steps.';
          this.learned(sessionId, [n]);
          return `Saved skill "${n.title}". Any session can load it with skill_get.`;
        }
        case 'skill_get': {
          const n = this.memory.getSkill(String(a.name ?? ''), project);
          if (n) return `# ${n.title}\n${n.description ? n.description + '\n\n' : ''}${n.body}`;
          const names = this.memory.list().filter((x) => x.kind === 'skill').map((x) => x.title);
          return names.length ? `No skill called "${a.name}". Saved skills: ${names.slice(0, 20).join(', ')}` : 'No skills saved yet.';
        }
        case 'memory_search': {
          const hits = this.memory.ranked(project, String(a.query ?? '')).slice(0, 8);
          if (!hits.length) return 'Nothing saved about that.';
          return hits.map((n) => (n.kind === 'skill' ? `- skill "${n.title}": ${n.description}` : `- (${n.type}) ${n.title}: ${n.body.replace(/\s+/g, ' ').slice(0, 200)}`)).join('\n');
        }
      }
    } catch (e) {
      return `Memory folder error: ${e instanceof Error ? e.message : e}`;
    }
  }

  // ---------- helpers (boss / worker) ----------

  private canSpawn(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.config.canSpawn === false) return false;
    if (s.config.parentId && !this.settings.workerNesting) return false;
    return this.settings.maxWorkersPerBoss > 0;
  }

  private workersOf(bossId: string) {
    return [...this.sessions.values()].filter((s) => s.config.parentId === bossId);
  }

  /** Pick a model for a helper that will actually run with the keys and login we have. */
  private routeModel(kind: ReturnType<typeof classifyTask>, asked: string | undefined, boss: BaseSession) {
    const ok = (m: string | undefined): m is string => {
      if (!m) return false;
      if (providerOf(m) === 'gemini') return this.opts.mock || !!this.geminiKey;
      if (providerOf(m) === 'openai') return this.opts.mock || (this.settings.openaiAuth === 'chatgpt' ? this.settings.chatgpt.signedIn : !!this.openaiKey);
      if (this.opts.mock) return true;
      return this.settings.authMode === 'local' ? this.settings.signedIn : !!this.key;
    };
    const wanted = [asked, this.settings.workerRouting[kind], DEFAULT_WORKER_ROUTING[kind], boss.config.model];
    return wanted.find(ok) ?? boss.config.model;
  }

  private bossStats(bossId: string) {
    const list = this.workersOf(bossId);
    return {
      running: list.filter((w) => this.waiting.has(w.id)).length,
      total: list.length + (this.goneCount.get(bossId) ?? 0),
      spentUsd: list.reduce((a, w) => a + w.state.costUsd, 0) + (this.spentByGone.get(bossId) ?? 0),
      capUsd: this.settings.workerSpendCapUsd,
    };
  }
  /** Spend of helpers that were already removed, so the cap still counts them. */
  private spentByGone = new Map<string, number>();
  private goneCount = new Map<string, number>();
  private removing = new Set<string>();

  private publishBoss(bossId: string) {
    const boss = this.sessions.get(bossId);
    if (!boss) return;
    boss.state.workers = this.bossStats(bossId);
    this.send({ t: 'session.state', state: boss.state });
  }

  /** A helper's state changed: keep the boss card live and enforce the spend cap. */
  private workerChanged(id: string) {
    const w = this.sessions.get(id);
    const bossId = w?.config.parentId;
    if (!w || !bossId) return;
    const stats = this.bossStats(bossId);
    const boss = this.sessions.get(bossId);
    if (boss) {
      const prev = boss.state.workers;
      // Only rebroadcast the boss when something visible moved.
      if (!prev || prev.running !== stats.running || prev.total !== stats.total || Math.abs(prev.spentUsd - stats.spentUsd) >= 0.005 || prev.capUsd !== stats.capUsd) {
        boss.state.workers = stats;
        this.send({ t: 'session.state', state: boss.state });
      }
    }
    if (stats.capUsd > 0 && stats.spentUsd >= stats.capUsd) {
      for (const x of this.workersOf(bossId)) if (this.waiting.has(x.id)) this.endWorker(x.id, `(stopped: the helpers hit the $${stats.capUsd.toFixed(2)} spend cap)`);
    }
    const st = w.state.status;
    if ((st === 'error' || st === 'stopped') && this.waiting.has(id)) this.endWorker(id, `(failed: ${w.state.error ?? st})`);
  }

  /** The helper's turn ended: its last reply is the summary. */
  private finishWorker(id: string) {
    const wait = this.waiting.get(id);
    if (!wait) return;
    const reply = (this.feeds.get(id) ?? []).filter((i) => i.ts >= wait.since && i.kind === 'text' && i.text.trim()).at(-1)?.text ?? '';
    this.endWorker(id, reply || '(finished without a summary)');
  }

  private endWorker(id: string, summary: string) {
    const wait = this.waiting.get(id);
    if (!wait) return;
    this.waiting.delete(id);
    const w = this.sessions.get(id);
    const clipped = clipSummary(summary);
    if (w) {
      w.state.summary = clipped;
      // Done means done: stop it so it frees its process, the card fades out in the UI.
      w.stop()
        .catch(() => {})
        .finally(() => {
          w.setActivity('Summary sent to the boss');
          if (w.config.parentId) this.publishBoss(w.config.parentId);
        });
    }
    wait.done(clipped);
  }

  /** Start helpers for a boss and wait for all their summaries. */
  async spawnWorkers(bossId: string, specs: WorkerSpec[]): Promise<string> {
    const boss = this.sessions.get(bossId);
    if (!boss) return 'Boss session not found.';
    if (!this.canSpawn(bossId)) return 'Spawning helpers is turned off for this session.';
    const clean = (Array.isArray(specs) ? specs : []).filter((x) => x && typeof x.task === 'string' && x.task.trim());
    if (!clean.length) return 'Give each helper a task.';
    const max = this.settings.maxWorkersPerBoss;
    const running = this.workersOf(bossId).filter((w) => this.waiting.has(w.id)).length;
    const room = Math.max(0, max - running);
    if (!room) return `You already have ${running} helpers running (max ${max}). Wait for them to finish.`;
    const stats = this.bossStats(bossId);
    if (stats.capUsd > 0 && stats.spentUsd >= stats.capUsd) return `Your helpers already spent $${stats.spentUsd.toFixed(2)} of the $${stats.capUsd.toFixed(2)} cap. Do the rest yourself.`;
    const take = clean.slice(0, room);
    const dropped = clean.length - take.length;

    const plan = take.map((x) => {
      const kind = isWorkerKind(x.kind) ? x.kind : classifyTask(x.task);
      return { task: x.task.trim(), kind, model: this.routeModel(kind, x.model, boss) };
    });

    if (this.settings.askBeforeSpawn) {
      const res = await this.host().ask({
        kind: 'tool',
        requestId: `spawn_${Date.now().toString(36)}`,
        sessionId: bossId,
        toolName: 'spawn_workers',
        title: `${boss.config.name} wants ${plan.length} helper${plan.length === 1 ? '' : 's'}`,
        detail: plan.map((p) => `${WORKER_KIND_LABEL[p.kind]} on ${modelName(p.model)}: ${p.task.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n'),
        canAlwaysAllow: true,
      });
      if (res.kind !== 'tool' || res.decision === 'deny') return 'The user said no to helpers. Do it yourself.';
      if (res.decision === 'always') {
        this.settings.askBeforeSpawn = false;
        this.send({ t: 'settings', settings: this.settings });
      }
    }

    const results = await Promise.all(
      plan.map(
        (p, i) =>
          new Promise<{ name: string; model: string; summary: string }>((resolve) => {
            const id = `w_${bossId.slice(-6)}_${Date.now().toString(36)}${i}`;
            const name = workerName(p.task, p.kind);
            const cfg: SessionConfig = {
              name,
              cwd: boss.config.cwd,
              model: p.model,
              prompt: '',
              priority: boss.config.priority,
              awareness: 'solo',
              permission: boss.config.permission,
              familyId: boss.config.familyId ?? null,
              parentId: bossId,
              workspace: boss.config.workspace ?? null,
              workerKind: p.kind,
              canSpawn: this.settings.workerNesting,
            };
            const timer = setTimeout(() => this.endWorker(id, '(timed out after 20 minutes)'), WORKER_TIMEOUT_MS);
            this.waiting.set(id, {
              since: Date.now(),
              done: (summary) => {
                clearTimeout(timer);
                resolve({ name, model: p.model, summary });
              },
            });
            this.createSession(id, cfg);
            const w = this.sessions.get(id);
            if (!w) return this.endWorker(id, '(could not start)');
            w.send(workerPrompt(p.task, p.kind, boss.config.name));
            this.publishBoss(bossId);
          }),
      ),
    );
    const spent = this.bossStats(bossId).spentUsd;
    return [
      `${results.length} helper${results.length === 1 ? '' : 's'} finished ($${spent.toFixed(2)} spent by helpers so far).`,
      ...results.map((r) => `\n### ${r.name} (${modelName(r.model)})\n${r.summary}`),
      dropped ? `\n${dropped} task(s) were not started: max ${max} helpers at once.` : '',
    ].join('\n');
  }

  /** Stopping a boss stops its helpers too. */
  private stopWorkersOf(bossId: string) {
    for (const w of this.workersOf(bossId)) if (this.waiting.has(w.id)) this.endWorker(w.id, '(stopped because the boss stopped)');
  }

  /** Did this session do enough since its last reflection to be worth one more short turn? */
  private worthReflecting(s: BaseSession) {
    if (!this.settings.memoryEnabled || s.isBusy) return false;
    if (s.state.status === 'error' || s.state.status === 'stopped' || this.reflecting.has(s.id)) return false;
    const since = s.state.turns - (this.reflectedAt.get(s.id) ?? 0);
    return since >= 2 || (since >= 1 && s.state.filesTouched.length > 0);
  }

  /** Ask a session to write down what it learned: one short turn on its already-cached conversation. */
  reflect(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || s.state.status === 'stopped') return Promise.resolve();
    if (s.isBusy || this.reflecting.has(id)) {
      this.send({ t: 'toast', level: 'info', text: `${s.config.name} is busy. Try again when it's idle.` });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(), 150_000);
      const finish = () => {
        clearTimeout(timer);
        this.reflecting.delete(id);
        resolve();
      };
      this.reflecting.set(id, { since: Date.now(), finish });
      s.sendInternal(REFLECT_PROMPT, 'Writing down what it learned');
    });
  }

  /** Turn ended: if it was a reflection, save what it wrote. */
  private finishReflection(id: string) {
    const r = this.reflecting.get(id);
    if (!r) return;
    const s = this.sessions.get(id);
    const reply = (this.feeds.get(id) ?? [])
      .filter((i) => i.ts >= r.since && i.kind === 'text')
      .map((i) => i.text)
      .join('\n');
    if (s) this.reflectedAt.set(id, s.state.turns + 1);
    const out = parseReflection(reply);
    const project = s ? projectOf(s.config.cwd) : null;
    const source = s?.config.name ?? 'A session';
    const notes: MemoryNote[] = [];
    try {
      for (const l of out.lessons) {
        const n = this.memory.addLesson({ type: l.type, title: l.title, note: l.note, project: l.everywhere ? null : project, source });
        if (n) notes.push(n);
      }
      for (const k of out.skills) {
        const n = this.memory.addSkill({ name: k.name, description: k.description, steps: k.steps, project: null, source });
        if (n) notes.push(n);
      }
    } catch (e) {
      this.send({ t: 'toast', level: 'error', text: `Couldn't write to the memory folder: ${e instanceof Error ? e.message : e}` });
    }
    this.learned(id, notes);
    r.finish();
  }

  /** Stop (or remove) a session, letting it write down lessons first when that's worth it. */
  private async wrapUp(id: string) {
    const s = this.sessions.get(id);
    if (s && this.settings.memoryReflect && this.worthReflecting(s)) await this.reflect(id);
  }

  /** Re-checks the Claude Code login and tells the UI if it changed. */
  private refreshSignIn(): boolean {
    const now = this.opts.mock || isSignedIn();
    if (now !== this.settings.signedIn) {
      this.settings.signedIn = now;
      this.send({ t: 'settings', settings: this.settings });
    }
    return now;
  }

  /** Ask Google which Gemini models this key can use, so the picker never offers a dead one. */
  private refreshGeminiModels() {
    const key = this.geminiKey;
    if (!key) return;
    listGeminiModels(key)
      .then((models) => {
        if (key !== this.geminiKey || !models.length) return;
        this.settings.geminiModels = models;
        this.send({ t: 'settings', settings: this.settings });
      })
      .catch((e) => this.send({ t: 'toast', level: 'warn', text: `Gemini key check failed: ${e instanceof Error ? e.message : e}` }));
  }

  /** Ask OpenAI which models this key can use, so the picker never offers a dead one. */
  private refreshOpenaiModels() {
    const key = this.openaiKey;
    if (!key) return;
    listOpenAIModels(key)
      .then((models) => {
        if (key !== this.openaiKey || !models.length) return;
        this.settings.openaiModels = models;
        this.send({ t: 'settings', settings: this.settings });
      })
      .catch((e) => this.send({ t: 'toast', level: 'warn', text: `OpenAI key check failed: ${e instanceof Error ? e.message : e}` }));
  }

  /** Look for Codex and ask it about the ChatGPT sign-in, the plan's models and usage. */
  private async refreshChatgpt() {
    if (this.opts.mock) return;
    const bin = findCodex(this.settings.codexPath);
    this.codexBin = bin;
    if (!bin) {
      this.settings.chatgpt = noChatgpt();
      this.send({ t: 'settings', settings: this.settings });
      return;
    }
    try {
      this.settings.chatgpt = await probeCodex(bin, VERSION);
      this.warnUsage(this.settings.chatgpt.usage);
    } catch (e) {
      this.settings.chatgpt = { ...noChatgpt(), found: true, path: bin };
      if (this.settings.openaiAuth === 'chatgpt') this.send({ t: 'toast', level: 'warn', text: `Could not talk to Codex: ${e instanceof Error ? e.message : e}` });
    }
    this.send({ t: 'settings', settings: this.settings });
  }

  private usageCheckedAt = 0;
  /** Plan limits for the island. Throttled: opening it again and again only asks once a minute. */
  private async checkUsage() {
    if (this.opts.mock || Date.now() - this.usageCheckedAt < 60_000) return this.send({ t: 'settings', settings: this.settings });
    this.usageCheckedAt = Date.now();
    const jobs: Promise<unknown>[] = [];
    if (this.settings.chatgpt.signedIn || (this.settings.openaiAuth === 'chatgpt' && this.settings.chatgpt.found)) jobs.push(this.refreshChatgpt());
    if (this.settings.authMode === 'local' && this.settings.signedIn) {
      jobs.push(
        readClaudeUsage(this.settings.claudePath)
          .then((r) => {
            this.settings.claudeUsage = r ? { ...r, checkedAt: Date.now() } : null;
            if (r) this.warnUsage(r.usage, 'Claude plan');
          })
          .catch(() => {
            /* keep the last numbers */
          }),
      );
    } else this.settings.claudeUsage = null;
    await Promise.all(jobs);
    this.send({ t: 'settings', settings: this.settings });
  }

  /** A heads-up before the ChatGPT plan runs out, so a busy board doesn't burn it without anyone noticing. */
  private warnUsage(usage: ChatgptStatus['usage'], who = 'ChatGPT plan') {
    if (!usage) return;
    for (const [name, w] of [['primary', usage.primary], ['secondary', usage.secondary]] as const) {
      if (!w) continue;
      const span = w.windowMins ? (w.windowMins >= 1440 ? `${Math.round(w.windowMins / 1440)}-day` : `${Math.round(w.windowMins / 60)}-hour`) : '';
      for (const at of [95, 80]) {
        const key = `${who}:${name}:${w.resetsAt}:${at}`;
        if (w.usedPercent < at || this.usageWarned.has(key)) continue;
        this.usageWarned.add(key);
        if (at === 95) this.usageWarned.add(`${who}:${name}:${w.resetsAt}:80`);
        this.send({ t: 'toast', level: 'warn', text: `${who}: ${Math.round(w.usedPercent)}% of your ${span} limit is used.` });
        break;
      }
    }
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.opts.dataDir, file), 'utf8')) as T;
    } catch {
      return null;
    }
  }
  private writeJson(file: string, data: unknown, mode?: number) {
    const full = path.join(this.opts.dataDir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // A mode only applies to a new file, so a .tmp left by a crash must go first.
    if (mode !== undefined) fs.rmSync(full + '.tmp', { force: true });
    fs.writeFileSync(full + '.tmp', JSON.stringify(data, null, 2), { mode });
    fs.renameSync(full + '.tmp', full);
  }

  snapshot(): Snapshot {
    return {
      sessions: [...this.sessions.values()].map((s) => s.state),
      feeds: Object.fromEntries(this.feeds),
      claims: this.hub.allClaims(),
      links: this.links,
      families: this.families,
      prompts: [...this.prompts.values()].map((p) => p.req),
      messages: this.hub.log.slice(-300),
      settings: this.settings,
      templates: this.templates,
      memory: this.memory.list(),
    };
  }

  private host(): SessionHost {
    return {
      hub: this.hub,
      settings: () => this.settings,
      apiKey: () => this.key,
      geminiKey: () => this.geminiKey,
      openaiKey: () => this.openaiKey,
      codexBin: () => this.codexBin,
      planUsage: (usage) => {
        if (!usage) return;
        this.settings.chatgpt = { ...this.settings.chatgpt, usage };
        this.warnUsage(usage);
        this.send({ t: 'settings', settings: this.settings });
      },
      dataDir: this.opts.dataDir,
      state: (state) => {
        this.send({ t: 'session.state', state });
        if (state.config.parentId) this.workerChanged(state.id);
      },
      feedAdd: (id, item) => {
        const feed = this.feeds.get(id) ?? [];
        feed.push(item);
        if (feed.length > FEED_LIMIT) feed.splice(0, feed.length - FEED_LIMIT);
        this.feeds.set(id, feed);
        this.send({ t: 'feed.add', id, item });
      },
      feedDelta: (id, itemId, text) => {
        const feed = this.feeds.get(id);
        const item = feed?.findLast((i) => i.id === itemId);
        if (item) item.text += text;
        this.send({ t: 'feed.delta', id, itemId, text });
      },
      ask: (req) =>
        new Promise<PromptResponse>((resolve) => {
          this.prompts.set(req.requestId, { req, resolve });
          this.send({ t: 'prompt.open', prompt: req });
        }),
      nameOf: (id) => this.sessions.get(id)?.config.name ?? id,
      turnDone: (id) => {
        this.checkBudget();
        this.finishReflection(id);
        this.finishWorker(id);
      },
      memoryContext: (cfg) => this.memoryContext(cfg),
      memoryTool: (sid, name, args) => this.memoryTool(sid, name, args),
      memoryOn: () => this.settings.memoryEnabled,
      canSpawn: (id) => this.canSpawn(id),
      spawnWorkers: (boss, specs) => this.spawnWorkers(boss, specs),
    };
  }

  private openPrompt(req: PromptRequest) {
    // Hub prompts (negotiations) are answered through hub.decide, not a promise.
    this.prompts.set(req.requestId, { req, resolve: () => {} });
    this.send({ t: 'prompt.open', prompt: req });
  }

  private closePrompt(requestId: string) {
    if (this.prompts.delete(requestId)) this.send({ t: 'prompt.close', requestId });
  }

  private checkBudget() {
    const budget = this.settings.budgetUsd;
    if (!budget) return;
    const total = [...this.sessions.values()].reduce((a, s) => a + s.state.costUsd, 0);
    if (total >= budget) {
      for (const s of this.sessions.values()) if (s.state.status !== 'idle' && s.state.status !== 'stopped') s.interrupt().catch(() => {});
      this.send({ t: 'toast', level: 'warn', text: `Budget of $${budget.toFixed(2)} reached. Sessions were paused.` });
    }
  }

  createSession(id: string, config: SessionConfig) {
    if (this.sessions.has(id)) return;
    const cfg: SessionConfig = {
      ...config,
      priority: Math.min(5, Math.max(1, Math.round(config.priority || 3))),
      model: config.model || this.settings.defaultModel,
    };
    if (!this.opts.mock && !fs.existsSync(cfg.cwd)) {
      this.send({ t: 'toast', level: 'error', text: `Folder not found: ${cfg.cwd}` });
      return;
    }
    const provider = providerOf(cfg.model);
    if (!this.opts.mock && provider === 'gemini' && !this.geminiKey) {
      this.send({ t: 'toast', level: 'error', text: 'Add a Gemini API key in Settings first. It is free at aistudio.google.com.' });
      return;
    }
    // A resumed session keeps the sign-in it was made with.
    const chatgpt = provider === 'openai' && (cfg.resumeId?.startsWith('codex-') || (!cfg.resumeId?.startsWith('openai-') && this.settings.openaiAuth === 'chatgpt'));
    if (!this.opts.mock && chatgpt && !this.codexBin) {
      this.send({ t: 'toast', level: 'error', text: 'Install Codex in Settings first, it runs OpenAI sessions on your ChatGPT plan.' });
      return;
    }
    if (!this.opts.mock && chatgpt && !this.settings.chatgpt.signedIn) {
      this.send({ t: 'toast', level: 'error', text: 'Sign in with ChatGPT in Settings first.' });
      return;
    }
    if (!this.opts.mock && provider === 'openai' && !chatgpt && !this.openaiKey) {
      this.send({ t: 'toast', level: 'error', text: 'Add an OpenAI API key in Settings first. You can make one at platform.openai.com/api-keys.' });
      return;
    }
    if (!this.opts.mock && provider === 'claude' && this.settings.authMode === 'apiKey' && !this.key) {
      this.send({ t: 'toast', level: 'error', text: 'Add an API key in Settings, or switch to local login.' });
      return;
    }
    const Ctor = this.opts.mock ? MockSession : provider === 'gemini' ? GeminiSession : provider === 'openai' ? (chatgpt ? CodexSession : OpenAISession) : RealSession;
    const s = new Ctor(id, cfg, this.host());
    this.sessions.set(id, s);
    this.feeds.set(id, []);
    this.send({ t: 'session.state', state: s.state });
    try {
      s.start();
    } catch (err) {
      this.send({ t: 'toast', level: 'error', text: `Could not start ${cfg.name}: ${err instanceof Error ? err.message : err}` });
    }
  }

  async handle(msg: ClientMsg) {
    switch (msg.t) {
      case 'snapshot':
        return this.send({ t: 'ready', snapshot: this.snapshot() });
      case 'session.create':
        return this.createSession(msg.id, msg.config);
      case 'session.send':
        return this.sessions.get(msg.id)?.send(msg.text);
      case 'session.interrupt':
        this.stopWorkersOf(msg.id);
        return this.sessions.get(msg.id)?.interrupt();
      case 'session.stop':
        this.stopWorkersOf(msg.id);
        await this.wrapUp(msg.id);
        return this.sessions.get(msg.id)?.stop();
      case 'session.reflect':
        return this.reflect(msg.id);
      case 'memory.list':
        this.memory.refresh();
        return this.sendMemory();
      case 'memory.keep':
        this.memory.keep(msg.ids);
        return this.sendMemory();
      case 'memory.delete':
        this.memory.remove(msg.ids);
        return this.sendMemory();
      case 'session.remove': {
        // A second remove while the first is still wrapping up would count the session twice.
        if (this.removing.has(msg.id)) return;
        this.removing.add(msg.id);
        this.stopWorkersOf(msg.id);
        try {
          await this.wrapUp(msg.id);
        } finally {
          this.removing.delete(msg.id);
        }
        const s = this.sessions.get(msg.id);
        const parent = s?.config.parentId;
        if (s && parent) {
          this.spentByGone.set(parent, (this.spentByGone.get(parent) ?? 0) + s.state.costUsd);
          this.goneCount.set(parent, (this.goneCount.get(parent) ?? 0) + 1);
        }
        if (s) await s.stop();
        for (const [rid, p] of this.prompts) {
          if (p.req.sessionId === msg.id) {
            p.resolve(p.req.kind === 'question' ? { requestId: rid, kind: 'question', answers: {}, skipped: true } : { requestId: rid, kind: 'tool', decision: 'deny' });
            this.closePrompt(rid);
          }
        }
        this.sessions.delete(msg.id);
        this.feeds.delete(msg.id);
        this.links = this.links.filter((l) => l.a !== msg.id && l.b !== msg.id);
        this.send({ t: 'session.removed', id: msg.id });
        this.send({ t: 'links', links: this.links });
        if (parent) this.publishBoss(parent);
        return;
      }
      case 'session.update':
        return this.sessions.get(msg.id)?.updateConfig(msg.patch);
      case 'prompt.respond': {
        const r = msg.response;
        const p = this.prompts.get(r.requestId);
        if (!p) return;
        if (r.kind === 'negotiation') this.hub.decide(r.requestId, r.winner);
        else p.resolve(r);
        this.closePrompt(r.requestId);
        return;
      }
      case 'links.set':
        this.links = msg.links;
        return this.send({ t: 'links', links: this.links });
      case 'families.set':
        this.families = msg.families;
        return this.send({ t: 'families', families: this.families });
      case 'auth.check':
        if (this.settings.openaiAuth === 'chatgpt' && !this.settings.chatgpt.signedIn) void this.refreshChatgpt();
        return this.refreshSignIn();
      case 'codex.check':
        return this.refreshChatgpt();
      case 'usage.check':
        return this.checkUsage();
      case 'codex.install': {
        const err = openCodexInstall();
        if (err) this.send({ t: 'toast', level: 'error', text: `Could not open a terminal: ${err}` });
        return;
      }
      case 'codex.login': {
        if (this.opts.mock) return;
        if (!this.codexBin) await this.refreshChatgpt();
        if (!this.codexBin) return this.send({ t: 'toast', level: 'error', text: 'Install Codex first.' });
        try {
          const url = await startChatgptLogin(this.codexBin, VERSION, (ok, err) => {
            this.send({ t: 'toast', level: ok ? 'info' : 'error', text: ok ? 'Signed in with ChatGPT' : `ChatGPT sign-in did not finish${err ? `: ${err}` : ''}` });
            void this.refreshChatgpt();
          });
          openUrl(url);
          this.send({ t: 'toast', level: 'info', text: 'Finish signing in to ChatGPT in your browser' });
        } catch (e) {
          this.send({ t: 'toast', level: 'error', text: `Could not start the ChatGPT sign-in: ${e instanceof Error ? e.message : e}` });
        }
        return;
      }
      case 'auth.login': {
        const err = openLogin(this.settings.claudePath);
        if (err) return this.send({ t: 'toast', level: 'error', text: `Couldn't open the sign-in window: ${err}` });
        this.send({ t: 'toast', level: 'info', text: 'Finish signing in in the window that just opened.' });
        // Watch for the login to land, for up to 5 minutes.
        clearInterval(this.loginWatch);
        let ticks = 0;
        this.loginWatch = setInterval(() => {
          if (this.refreshSignIn() || ++ticks > 150) clearInterval(this.loginWatch);
        }, 2000);
        return;
      }
      case 'settings.set': {
        const { apiKey, geminiKey, openaiKey, ...rest } = msg.patch;
        if (apiKey !== undefined) this.key = apiKey.trim() || null;
        if (geminiKey !== undefined) {
          this.geminiKey = geminiKey.trim() || null;
          this.settings.geminiModels = DEFAULT_GEMINI_MODELS;
          this.refreshGeminiModels();
        }
        if (openaiKey !== undefined) {
          this.openaiKey = openaiKey.trim() || null;
          this.settings.openaiModels = DEFAULT_OPENAI_MODELS;
          this.refreshOpenaiModels();
        }
        if (apiKey !== undefined || geminiKey !== undefined || openaiKey !== undefined) {
          this.writeJson('secrets.json', { apiKey: this.key, geminiKey: this.geminiKey, openaiKey: this.openaiKey }, SECRETS_MODE);
        }
        const loose = rest as Partial<EngineSettings>;
        delete loose.signedIn;
        delete loose.hasGeminiKey;
        delete loose.geminiModels;
        delete loose.hasOpenaiKey;
        delete loose.openaiModels;
        delete loose.chatgpt;
        delete loose.claudeUsage;
        const recheckCodex = (loose.codexPath !== undefined && loose.codexPath !== this.settings.codexPath) || (loose.openaiAuth === 'chatgpt' && this.settings.openaiAuth !== 'chatgpt');
        delete loose.memoryPath;
        // Picking an Obsidian vault's root puts the notes in a Sinnect folder inside it, not all over the vault.
        if (typeof loose.memoryDir === 'string' && loose.memoryDir.trim()) {
          const d = path.resolve(loose.memoryDir.trim());
          loose.memoryDir = isVaultRoot(d) ? path.join(d, 'Sinnect') : d;
        }
        if (loose.workerRouting) loose.workerRouting = { ...this.settings.workerRouting, ...loose.workerRouting };
        if (typeof loose.maxWorkersPerBoss === 'number') loose.maxWorkersPerBoss = Math.min(12, Math.max(0, Math.round(loose.maxWorkersPerBoss)));
        if (typeof loose.memoryMaxNotes === 'number') loose.memoryMaxNotes = Math.min(20, Math.max(0, Math.round(loose.memoryMaxNotes)));
        Object.assign(this.settings, rest, { hasApiKey: !!this.key, hasGeminiKey: !!this.geminiKey, hasOpenaiKey: !!this.openaiKey });
        const memPath = this.resolveMemoryPath();
        if (memPath !== this.settings.memoryPath) {
          this.settings.memoryPath = memPath;
          this.memory.refresh();
          this.sendMemory();
        }
        const { hasApiKey: _h, hasGeminiKey: _g, geminiModels: _gm, hasOpenaiKey: _o, openaiModels: _om, chatgpt: _c, claudeUsage: _cu, mock: _m, signedIn: _s, memoryPath: _mp, ...persist } = this.settings;
        this.writeJson('settings.json', persist);
        if (recheckCodex) void this.refreshChatgpt();
        return this.send({ t: 'settings', settings: this.settings });
      }
      case 'template.save': {
        const r = upsertTemplate(this.templates, msg.template);
        if (!r.ok) return this.rejectTemplate(r.error);
        return this.persistTemplates(r.list);
      }
      case 'template.delete':
        return this.persistTemplates(this.templates.filter((t) => t.id !== msg.id));
      case 'workspace.save':
        this.writeJson(path.join('workspaces', safeName(msg.name) + '.json'), { savedAt: Date.now(), data: msg.data });
        if (!msg.name.startsWith('__')) this.send({ t: 'workspace.list', items: this.listWorkspaces() });
        return;
      case 'workspace.list':
        return this.send({ t: 'workspace.list', items: this.listWorkspaces() });
      case 'workspace.load': {
        const w = this.readJson<{ data: unknown }>(path.join('workspaces', safeName(msg.name) + '.json'));
        return this.send({ t: 'workspace.data', name: msg.name, data: w?.data ?? null });
      }
      case 'workspace.delete':
        try {
          fs.unlinkSync(path.join(this.opts.dataDir, 'workspaces', safeName(msg.name) + '.json'));
        } catch {
          /* gone already */
        }
        return this.send({ t: 'workspace.list', items: this.listWorkspaces() });
    }
  }

  /** The UI saves optimistically, so a rejection must resend the real list. */
  private rejectTemplate(error: string) {
    this.send({ t: 'toast', level: 'error', text: error });
    this.send({ t: 'templates', templates: this.templates });
  }

  private persistTemplates(next: SessionTemplate[]) {
    const r = commitTemplates(this.templates, next, (list) => this.writeJson('templates.json', list));
    this.templates = r.list;
    if (r.error) this.send({ t: 'toast', level: 'error', text: `Could not save templates: ${r.error}` });
    this.send({ t: 'templates', templates: this.templates });
  }

  private listWorkspaces(): WorkspaceInfo[] {
    const dir = path.join(this.opts.dataDir, 'workspaces');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const w = this.readJson<{ savedAt: number; data: { sessions?: unknown[]; id?: string } }>(path.join('workspaces', f));
        return { name: f.slice(0, -5), savedAt: w?.savedAt ?? 0, sessions: w?.data?.sessions?.length ?? 0, id: w?.data?.id ?? null };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  async shutdown() {
    clearInterval(this.codexTimer);
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
  }
}

/** An Obsidian vault has a .obsidian folder at its root. */
export function isVaultRoot(dir: string) {
  try {
    return fs.statSync(path.join(dir, '.obsidian')).isDirectory();
  } catch {
    return false;
  }
}

function modelName(id: string) {
  return DEFAULT_MODELS.find((m) => m.id === id)?.label ?? id;
}

const VERSION = process.env.npm_package_version ?? '0';

function noChatgpt(): ChatgptStatus {
  return { found: false, path: null, version: null, signedIn: false, email: null, plan: null, models: [], usage: null };
}

/** Made-up plan numbers for demo mode, so the island has something to show. */
function demoUsage(five: number, week: number, now: number) {
  return { primary: { usedPercent: five, windowMins: 300, resetsAt: Math.round(now + 2.4 * 3600) }, secondary: { usedPercent: week, windowMins: 10_080, resetsAt: Math.round(now + 3.2 * 86_400) }, reached: false };
}
