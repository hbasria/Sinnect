// The engine: owns every session, the Hub, prompts and settings, and talks to
// the UI over a local WebSocket.

import fs from 'node:fs';
import path from 'node:path';
import { Hub } from './hub.js';
import { BaseSession, type SessionHost } from './session.js';
import { RealSession } from './real-session.js';
import { MockSession } from './mock-session.js';
import { isSignedIn, openLogin } from './auth.js';
import { MatrixBridge } from './matrix.js';
import { loadNodePty, Terminals, type SpawnPty } from './terminals.js';
import { agentPrompt, coordinatorPrompt, cruxHome, listAgents, ONBOARDING_MESSAGE } from './crux.js';
import { commitTemplates, demoTemplates, loadTemplates, upsertTemplate } from './templates.js';
import type {
  ClientMsg,
  CruxAgent,
  EngineMsg,
  EngineSettings,
  Family,
  FeedItem,
  HubMessage,
  Link,
  MatrixConfig,
  PromptRequest,
  PromptResponse,
  SessionConfig,
  SessionTemplate,
  Snapshot,
  SpawnRequest,
  WorkspaceInfo,
} from './protocol.js';
import { FAMILY_COLORS } from './protocol.js';

const FEED_LIMIT = 1500;

export interface EngineOptions {
  dataDir: string;
  mock: boolean;
  broadcast(msg: EngineMsg): void;
  /** For tests: the fetch Matrix bridges use. */
  fetch?: typeof fetch;
  /** For tests: how terminals start a shell. Default node-pty; SINNECT_TERMINAL=0 turns terminals off. */
  spawnPty?: SpawnPty | null;
}

interface Secrets {
  apiKey?: string | null;
  /** Matrix access tokens by account id (@bot:server). */
  matrix?: Record<string, string>;
}

export class Engine {
  private sessions = new Map<string, BaseSession>();
  private feeds = new Map<string, FeedItem[]>();
  private prompts = new Map<string, { req: PromptRequest; resolve: (r: PromptResponse) => void }>();
  private links: Link[] = [];
  private families: Family[] = [];
  private templates: SessionTemplate[] = [];
  private agents: CruxAgent[] = [];
  private settings: EngineSettings;
  private key: string | null = null;
  private secrets: Secrets = {};
  private bridges = new Map<string, MatrixBridge>();
  private loginWatch: ReturnType<typeof setInterval> | undefined;
  readonly hub: Hub;
  private terminals: Terminals;

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
      cruxPath: null,
      ...saved,
      hasApiKey: false,
      signedIn: opts.mock || isSignedIn(),
      mock: opts.mock,
    };
    this.templates = loadTemplates(opts.dataDir);
    if (opts.mock && !this.templates.length) this.templates = demoTemplates();
    this.secrets = this.readJson<Secrets>('secrets.json') ?? {};
    this.key = process.env.SINNECT_API_KEY || this.secrets.apiKey || null;
    this.settings.hasApiKey = !!this.key;
    this.agents = listAgents(cruxHome(this.settings.cruxPath));
    this.terminals = new Terminals({ ...this.terminalBackend(), send: (m) => this.send(m) });

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

  /** Re-checks the Claude Code login and tells the UI if it changed. */
  private refreshSignIn(): boolean {
    const now = this.opts.mock || isSignedIn();
    if (now !== this.settings.signedIn) {
      this.settings.signedIn = now;
      this.send({ t: 'settings', settings: this.settings });
    }
    return now;
  }

  private terminalBackend(): { spawn: SpawnPty | null; unavailable: string | null } {
    if (process.env.SINNECT_TERMINAL === '0') return { spawn: null, unavailable: 'Terminals are turned off (SINNECT_TERMINAL=0).' };
    if (this.opts.spawnPty !== undefined) return { spawn: this.opts.spawnPty, unavailable: this.opts.spawnPty ? null : 'Terminals are off.' };
    const pty = loadNodePty();
    return 'spawn' in pty ? { spawn: pty.spawn, unavailable: null } : { spawn: null, unavailable: pty.error };
  }

  /** Re-reads the Crux agent list and sends it to the UI. */
  private refreshAgents() {
    const home = cruxHome(this.settings.cruxPath);
    this.agents = listAgents(home);
    this.send({ t: 'agents', agents: this.agents, cruxHome: home });
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.opts.dataDir, file), 'utf8')) as T;
    } catch {
      return null;
    }
  }
  private writeJson(file: string, data: unknown) {
    const full = path.join(this.opts.dataDir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(full + '.tmp', full);
  }

  snapshot(): Snapshot {
    // Every (re)connect re-reads the agents, so new ones show up without a restart.
    const home = cruxHome(this.settings.cruxPath);
    this.agents = listAgents(home);
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
      agents: this.agents,
      cruxHome: home,
      terminals: this.terminals.snapshot(),
      terminalsUnavailable: this.terminals.unavailable,
    };
  }

  private host(): SessionHost {
    return {
      hub: this.hub,
      settings: () => this.settings,
      apiKey: () => this.key,
      state: (state) => this.send({ t: 'session.state', state }),
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
      agentPrompt: (agent) => agentPrompt(cruxHome(this.settings.cruxPath), agent),
      coordinatorPrompt: () => coordinatorPrompt(cruxHome(this.settings.cruxPath)),
      spawn: (parentId, req) => this.spawn(parentId, req),
      turnDone: () => this.checkBudget(),
      matrixReply: (id, origin, text) =>
        this.bridges.get(id)?.reply(origin, text).catch((err) => this.send({ t: 'toast', level: 'error', text: `Matrix reply failed: ${err instanceof Error ? err.message : err}` })),
      matrixTyping: (id, roomId, on) => this.bridges.get(id)?.setTyping(roomId, on),
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
    if (cfg.coordinator) {
      // The company root may not exist yet: onboarding creates the company in it.
      if (!this.opts.mock) fs.mkdirSync(cfg.cwd, { recursive: true });
      if (!cfg.resumeId && !cfg.prompt.trim()) cfg.prompt = ONBOARDING_MESSAGE;
    }
    if (!this.opts.mock && !fs.existsSync(cfg.cwd)) {
      this.send({ t: 'toast', level: 'error', text: `Folder not found: ${cfg.cwd}` });
      return;
    }
    if (!this.opts.mock && this.settings.authMode === 'apiKey' && !this.key) {
      this.send({ t: 'toast', level: 'error', text: 'Add an API key in Settings, or switch to local login.' });
      return;
    }
    const Ctor = this.opts.mock ? MockSession : RealSession;
    const s = new Ctor(id, cfg, this.host());
    this.sessions.set(id, s);
    this.feeds.set(id, []);
    this.send({ t: 'session.state', state: s.state });
    try {
      s.start();
    } catch (err) {
      this.send({ t: 'toast', level: 'error', text: `Could not start ${cfg.name}: ${err instanceof Error ? err.message : err}` });
    }
    // A resumed session reconnects to Matrix with the token saved for its account.
    const m = cfg.matrix;
    const token = m?.userId && this.secrets.matrix?.[m.userId];
    if (m?.enabled && token) this.connectMatrix(id, m.homeserver, token, m.allowed);
  }

  /** Start (or restart) a session's Matrix bridge. The token is saved once the homeserver accepts it. */
  private connectMatrix(id: string, homeserver: string, token: string, allowed: Record<string, string[]>) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.bridges.get(id)?.stop();
    const bridge: MatrixBridge = new MatrixBridge(
      homeserver,
      token,
      allowed,
      {
        message: (text, origin) => this.sessions.get(id)?.sendFromMatrix(text, origin),
        status: (st) => {
          // An old bridge's last "off" must not overwrite the new one's status.
          if (this.bridges.get(id) === bridge || st.state === 'off') this.sessions.get(id)?.setMatrix(st);
        },
        authed: (userId) => {
          this.secrets.matrix = { ...this.secrets.matrix, [userId]: token };
          this.writeJson('secrets.json', this.secrets);
          s.updateConfig({ matrix: { homeserver, userId, enabled: true, allowed } });
        },
        peers: () => new Set([...this.bridges].filter(([sid]) => sid !== id).map(([, b]) => b.userId).filter((u): u is string => !!u)),
      },
      this.opts.fetch,
    );
    this.bridges.set(id, bridge);
    void bridge.start();
  }

  private disconnectMatrix(id: string) {
    const bridge = this.bridges.get(id);
    if (!bridge) return;
    this.bridges.delete(id);
    bridge.stop();
    this.sessions.get(id)?.setMatrix(bridge.status);
  }

  /** A coordinator's hub_spawn, after the user said yes: new session, its family, a link back. */
  spawn(parentId: string, req: SpawnRequest): { ok: true; id: string; name: string } | { ok: false; error: string } {
    const parent = this.sessions.get(parentId);
    if (!parent) return { ok: false, error: 'Your session is gone.' };
    const name = req.name.trim().slice(0, 60);
    if (!name) return { ok: false, error: 'The session needs a name.' };
    let agent = req.agent?.trim() || null;
    if (agent && !this.agents.some((a) => a.id === agent)) {
      // Demo mode runs without a Crux install, so it just drops an unknown agent.
      if (!this.opts.mock) return { ok: false, error: `Unknown Crux agent "${agent}". Known: ${this.agents.map((a) => a.id).join(', ') || 'none'}.` };
      agent = null;
    }
    const cwd = path.resolve(parent.config.cwd, req.folder || '.');
    if (!this.opts.mock) {
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch (err) {
        return { ok: false, error: `Could not create ${cwd}: ${err instanceof Error ? err.message : err}` };
      }
    }
    let familyId: string | null = null;
    const famName = req.family?.trim();
    if (famName) {
      let fam = this.families.find((f) => f.name.toLowerCase() === famName.toLowerCase());
      if (!fam) {
        fam = { id: newId('f'), name: famName, color: FAMILY_COLORS[this.families.length % FAMILY_COLORS.length] };
        this.families = [...this.families, fam];
        this.send({ t: 'families', families: this.families });
      }
      familyId = fam.id;
    }
    const taken = new Set([...this.sessions.values()].map((s) => s.config.name.toLowerCase()));
    let unique = name;
    for (let i = 2; taken.has(unique.toLowerCase()); i++) unique = `${name} ${i}`;
    const id = newId('s');
    this.createSession(id, {
      name: unique,
      cwd,
      model: parent.config.model,
      prompt: req.prompt?.trim() ?? '',
      priority: 3,
      awareness: 'family',
      permission: parent.config.permission,
      familyId,
      agent,
    });
    if (!this.sessions.has(id)) return { ok: false, error: `Could not start ${unique}.` };
    this.links = [...this.links, { id: newId('l'), a: parentId, b: id }];
    this.send({ t: 'links', links: this.links });
    this.send({ t: 'session.spawned', id, parentId });
    return { ok: true, id, name: unique };
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
        return this.sessions.get(msg.id)?.interrupt();
      case 'session.stop':
        this.disconnectMatrix(msg.id);
        return this.sessions.get(msg.id)?.stop();
      case 'session.remove': {
        this.disconnectMatrix(msg.id);
        const s = this.sessions.get(msg.id);
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
        return this.refreshSignIn();
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
        const { apiKey, ...rest } = msg.patch;
        if (apiKey !== undefined) {
          this.key = apiKey.trim() || null;
          this.secrets.apiKey = this.key;
          this.writeJson('secrets.json', this.secrets);
        }
        delete (rest as Partial<EngineSettings>).signedIn;
        Object.assign(this.settings, rest, { hasApiKey: !!this.key });
        const { hasApiKey: _h, mock: _m, signedIn: _s, ...persist } = this.settings;
        this.writeJson('settings.json', persist);
        this.send({ t: 'settings', settings: this.settings });
        if ('cruxPath' in rest) this.refreshAgents();
        return;
      }
      case 'template.save': {
        const r = upsertTemplate(this.templates, msg.template);
        if (!r.ok) return this.rejectTemplate(r.error);
        return this.persistTemplates(r.list);
      }
      case 'matrix.enable': {
        const s = this.sessions.get(msg.id);
        if (!s || s.state.status === 'stopped') return;
        const prev = s.config.matrix;
        const sameServer = prev?.homeserver.replace(/\/+$/, '') === msg.homeserver.trim().replace(/\/+$/, '');
        const token = msg.token?.trim() || (sameServer && prev?.userId ? this.secrets.matrix?.[prev.userId] : undefined);
        if (!msg.homeserver.trim()) return this.send({ t: 'toast', level: 'error', text: 'Enter the Matrix homeserver address.' });
        if (!token) return this.send({ t: 'toast', level: 'error', text: 'Paste the access token of this session\'s Matrix account.' });
        this.connectMatrix(msg.id, msg.homeserver.trim(), token, msg.allowed);
        return;
      }
      case 'matrix.disable': {
        this.disconnectMatrix(msg.id);
        const s = this.sessions.get(msg.id);
        if (s?.config.matrix) s.updateConfig({ matrix: { ...s.config.matrix, enabled: false } });
        return;
      }
      case 'matrix.allow': {
        const s = this.sessions.get(msg.id);
        const bridge = this.bridges.get(msg.id);
        if (bridge) bridge.allowed = msg.allowed;
        if (s?.config.matrix) s.updateConfig({ matrix: { ...s.config.matrix, allowed: msg.allowed } satisfies MatrixConfig });
        return;
      }
      case 'term.open':
        return this.terminals.open(msg.id, msg.cwd, msg.cols, msg.rows, msg.title);
      case 'term.input':
        return this.terminals.input(msg.id, msg.data);
      case 'term.resize':
        return this.terminals.resize(msg.id, msg.cols, msg.rows);
      case 'term.close':
        return this.terminals.close(msg.id);
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
        const w = this.readJson<{ savedAt: number; data: { sessions?: unknown[] } }>(path.join('workspaces', f));
        return { name: f.slice(0, -5), savedAt: w?.savedAt ?? 0, sessions: w?.data?.sessions?.length ?? 0 };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  async shutdown() {
    this.terminals.closeAll();
    for (const id of [...this.bridges.keys()]) this.disconnectMatrix(id);
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
  }
}

let idSeq = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(idSeq++).toString(36)}`;

/** A file name for a workspace. Letters of any language stay ("Müşteri işleri"), anything else becomes "_". */
export function safeName(name: string) {
  return name.normalize('NFC').replace(/[^\p{L}\p{N}\- _]+/gu, '_').slice(0, 80) || 'workspace';
}
