// Shared session logic. RealSession (Agent SDK) and MockSession (demo mode)
// both extend this, so the Hub and the UI see the exact same behaviour.

import path from 'node:path';
import type { Hub } from './hub.js';
import { short } from './hub.js';
import type {
  EngineSettings,
  FeedItem,
  HubMessage,
  MatrixOrigin,
  MatrixStatus,
  PromptRequest,
  PromptResponse,
  SessionConfig,
  SpawnRequest,
  SessionState,
  SessionStatus,
} from './protocol.js';

export interface SessionHost {
  hub: Hub;
  settings(): EngineSettings;
  apiKey(): string | null;
  state(s: SessionState): void;
  feedAdd(id: string, item: FeedItem): void;
  feedDelta(id: string, itemId: string, text: string): void;
  ask(p: PromptRequest): Promise<PromptResponse>;
  nameOf(id: string): string;
  /** System prompt text for a Crux agent, or null if it doesn't exist. */
  agentPrompt(agent: string): string | null;
  /** System prompt text with the company coordinator's duties. */
  coordinatorPrompt(): string;
  /** Start a session for `parentId` (the coordinator). The user has already said yes. */
  spawn(parentId: string, req: SpawnRequest): { ok: true; id: string; name: string } | { ok: false; error: string };
  /** Called after each finished turn so the engine can check the budget. */
  turnDone(id: string): void;
  /** Post a turn's answer back into the Matrix thread it came from. */
  matrixReply(id: string, origin: MatrixOrigin, text: string): void;
  matrixTyping(id: string, roomId: string, on: boolean): void;
}

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

let itemSeq = 0;
export const newItemId = () => `i${Date.now().toString(36)}${(itemSeq++).toString(36)}`;

export abstract class BaseSession {
  readonly state: SessionState;
  protected queue: { text: string; depth: number; origin?: MatrixOrigin }[] = [];
  /** Set while a turn started by a Matrix message runs: its answer goes back there. */
  private turnOrigin: MatrixOrigin | null = null;
  /** Hub wake depth of the turn running now. 0 = the user started it. */
  turnDepth = 0;
  /** Wait this long before a hub wake starts a turn, so messages that arrive together share one turn. */
  protected wakeBatchMs = 1500;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hub notices waiting to be slipped into the next tool result. */
  protected notices: HubMessage[] = [];
  protected busy = false;
  /** A notice arrived that should start a turn once this one ends. */
  private pendingWake = false;
  protected closed = false;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The user picked "always" on a spawn prompt: start sessions without asking again. */
  private spawnAlways = false;

  constructor(
    readonly id: string,
    config: SessionConfig,
    protected host: SessionHost,
  ) {
    this.state = {
      id,
      config,
      status: 'starting',
      activity: 'Starting up',
      goal: '',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      sdkSessionId: config.resumeId ?? null,
      filesTouched: [],
      turns: 0,
      startedAt: Date.now(),
    };
  }

  abstract start(): void;
  abstract interrupt(): Promise<void>;
  protected abstract pushInput(text: string): void;
  protected abstract shutdown(): Promise<void>;

  get config() {
    return this.state.config;
  }

  /** Throttled state broadcast: at most ~20 per second per session. */
  protected publish(now = false) {
    if (now) {
      if (this.stateTimer) clearTimeout(this.stateTimer);
      this.stateTimer = null;
      this.host.state(this.state);
      return;
    }
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.host.state(this.state);
    }, 50);
  }

  protected setStatus(status: SessionStatus, activity?: string) {
    this.state.status = status;
    if (activity !== undefined) this.state.activity = activity;
    this.publish();
  }

  protected feed(kind: FeedItem['kind'], text: string, extra: Partial<FeedItem> = {}): FeedItem {
    const item: FeedItem = { id: newItemId(), ts: Date.now(), kind, text, ...extra };
    this.host.feedAdd(this.id, item);
    return item;
  }

  updateConfig(patch: Partial<SessionConfig>) {
    Object.assign(this.state.config, patch);
    this.publish(true);
  }

  setGoal(goal: string) {
    this.state.goal = goal.slice(0, 160);
    this.publish();
  }

  /** Crux text for the system prompt: the agent's AGENT.md and the coordinator's duties. Says in the feed what it applied. */
  protected rolePrompt(): string | null {
    const parts: string[] = [];
    const agent = this.config.agent;
    if (agent) {
      const text = this.host.agentPrompt(agent);
      this.feed('system', text ? `Running as Crux agent ${agent}` : `Crux agent ${agent} not found, running as plain Claude`);
      if (text) parts.push(text);
    }
    if (this.config.coordinator) {
      this.feed('system', 'Company coordinator: runs Crux onboarding and can start team sessions');
      parts.push(this.host.coordinatorPrompt());
    }
    return parts.length ? parts.join('\n\n') : null;
  }

  /** hub_spawn: ask the user, then start the session. Returns the text the model sees. */
  async spawnSession(req: SpawnRequest): Promise<string> {
    if (!this.config.coordinator) return 'Only the company coordinator can start sessions.';
    if (!this.spawnAlways) {
      const prev = this.state.status;
      this.setStatus('waiting', `Wants to start ${clip(req.name, 30)}`);
      const res = await this.host.ask({
        kind: 'tool',
        requestId: newItemId(),
        sessionId: this.id,
        toolName: 'hub_spawn',
        title: `${this.config.name} wants to start a session: ${req.name}`,
        detail: [
          `Folder: ${path.resolve(this.config.cwd, req.folder)} (created if missing)`,
          req.agent && `Agent: ${req.agent}`,
          req.family && `Family: ${req.family}`,
          req.prompt && `First message: ${clip(req.prompt, 300)}`,
        ]
          .filter(Boolean)
          .join('\n'),
        canAlwaysAllow: true,
      });
      this.setStatus(prev === 'waiting' ? 'working' : prev, 'Got your answer');
      if (res.kind !== 'tool' || res.decision === 'deny') return `The user said no to starting ${req.name}${res.kind === 'tool' && res.message ? `: ${res.message}` : '.'}`;
      if (res.decision === 'always') this.spawnAlways = true;
    }
    const r = this.host.spawn(this.id, req);
    if (!r.ok) return r.error;
    return `Started ${r.name} (id ${r.id}). It is linked to you and can message you through the hub.`;
  }

  /** User typed into the session. */
  send(text: string) {
    if (this.closed) return;
    this.feed('user', text);
    // Free status line for the roster, so the model doesn't need a tool call for it.
    if (!this.state.goal && this.config.awareness !== 'solo') this.setGoal(clip(text, 160));
    // Messages that arrived while idle (without a wake) ride along with the user's turn.
    const pending = this.busy ? null : this.takeNoticeText();
    this.queueTurn(pending ? `${pending}\n\n${text}` : text, 0);
  }

  /** A Matrix message that mentions this session (or follows up in its thread). */
  sendFromMatrix(text: string, origin: MatrixOrigin) {
    if (this.closed) return;
    this.feed('user', `[Matrix · ${origin.roomName}] ${origin.sender}: ${text}`);
    if (!this.state.goal && this.config.awareness !== 'solo') this.setGoal(clip(text, 160));
    const pending = this.busy ? null : this.takeNoticeText();
    const msg = `[Matrix message from ${origin.sender} in ${origin.roomName}. Your final reply is posted to that thread.]\n${text}`;
    this.queueTurn(pending ? `${pending}\n\n${msg}` : msg, 0, origin);
  }

  setMatrix(status: MatrixStatus) {
    this.state.matrix = status;
    this.publish();
  }

  protected queueTurn(text: string, depth: number, origin?: MatrixOrigin) {
    if (this.busy) {
      this.queue.push({ text, depth, origin });
      return;
    }
    this.startTurn(text, depth, origin);
  }

  private startTurn(text: string, depth: number, origin?: MatrixOrigin) {
    this.busy = true;
    this.turnDepth = depth;
    this.turnOrigin = origin ?? null;
    if (origin) this.host.matrixTyping(this.id, origin.roomId, true);
    this.setStatus('thinking', 'Thinking');
    this.pushInput(text);
  }

  /** Send the finished turn's answer to Matrix if the turn came from there. */
  protected answerMatrix(reply: string | undefined) {
    const origin = this.turnOrigin;
    if (!origin) return;
    this.turnOrigin = null;
    this.host.matrixTyping(this.id, origin.roomId, false);
    this.host.matrixReply(this.id, origin, reply?.trim() || 'Stopped before writing an answer.');
  }

  /** The engine calls this when a turn finishes. `reply` is its final text, for Matrix. */
  protected onTurnEnd(reply?: string) {
    this.answerMatrix(reply);
    this.busy = false;
    this.state.turns += 1;
    // Claims only live for the turn that made them, so nothing gets locked forever.
    this.host.hub.release(this.id);
    this.host.turnDone(this.id);
    const next = this.queue.shift();
    if (next !== undefined) {
      this.startTurn(next.text, next.depth, next.origin);
      return;
    }
    if (this.pendingWake) {
      this.scheduleWake();
      return;
    }
    if (this.state.status !== 'error' && this.state.status !== 'stopped') this.setStatus('idle', 'Waiting for you');
  }

  /** The Hub handed us a message. */
  deliver(msg: HubMessage, wake: boolean) {
    if (this.closed) return;
    const from = msg.from === 'hub' ? 'Hub' : this.host.nameOf(msg.from);
    const quiet = msg.kind === 'message' && !wake && !this.busy ? ' (no wake, it waits for the next turn)' : '';
    this.feed('hub', `${from}: ${msg.text}${quiet}`);
    this.notices.push(msg);
    if (wake) this.pendingWake = true;
    if (wake && !this.busy) this.scheduleWake();
  }

  /** Start a turn for pending notices after a short pause, so a burst of messages costs one turn. */
  private scheduleWake() {
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      if (this.closed || this.busy) return;
      this.flushNoticesAsTurn();
    }, this.wakeBatchMs);
    (this.wakeTimer as { unref?: () => void }).unref?.();
  }

  private flushNoticesAsTurn() {
    this.pendingWake = false;
    const depth = Math.max(1, ...this.notices.map((n) => n.depth ?? 1));
    const text = this.takeNoticeText();
    if (!text) return;
    this.queueTurn(text, depth);
  }

  /** Short text block with pending hub notices, then clears them. */
  takeNoticeText(): string | null {
    if (this.notices.length === 0) return null;
    const lines = this.notices.map((n) => {
      const from = n.from === 'hub' ? 'hub' : `${this.host.nameOf(n.from)} (${n.from})`;
      return `- from ${from}: ${n.text}`;
    });
    this.notices = [];
    // These were delivered, so the inbox doesn't need to show them again.
    this.host.hub.inbox(this.id);
    return `[Sinnect hub]\n${lines.join('\n')}`;
  }

  /** Shared PreToolUse logic: file claims. Returns a deny reason or null. */
  protected checkEdit(toolName: string, input: Record<string, unknown>): string | null {
    if (!EDIT_TOOLS.has(toolName)) return null;
    const raw = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
    if (!raw) return null;
    const abs = normalizePath(path.resolve(this.config.cwd, raw));
    const reason = this.state.goal || `editing via ${toolName}`;
    const res = this.host.hub.requestEdit(this.id, abs, reason);
    if (!res.ok) {
      this.setStatus('blocked', `Waiting for ${short(abs)}`);
      this.feed('system', `Blocked from editing ${short(abs)}: ${res.reason}`);
      return res.reason;
    }
    if (!this.state.filesTouched.includes(abs)) {
      this.state.filesTouched.push(abs);
      if (this.state.filesTouched.length > 200) this.state.filesTouched.shift();
    }
    return null;
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.host.hub.forget(this.id);
    try {
      await this.shutdown();
    } catch {
      /* ignore */
    }
    this.setStatus('stopped', 'Stopped');
    this.publish(true);
  }
}

export function normalizePath(p: string) {
  const n = path.normalize(p);
  // Windows and macOS file systems ignore case by default, so Foo.ts and foo.ts are one file.
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

/** One cheap line describing a tool call, for the card. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const file = (k = 'file_path') => short(String(input[k] ?? input.path ?? ''));
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${file()}`;
    case 'Write':
      return `Writing ${file()}`;
    case 'NotebookEdit':
      return `Editing ${file('notebook_path')}`;
    case 'Read':
      return `Reading ${file()}`;
    case 'Bash':
      return `Running ${clip(String(input.description || input.command || ''), 48)}`;
    case 'Grep':
      return `Searching for "${clip(String(input.pattern ?? ''), 32)}"`;
    case 'Glob':
      return `Finding ${clip(String(input.pattern ?? ''), 40)}`;
    case 'WebFetch':
      return `Reading ${clip(String(input.url ?? ''), 44)}`;
    case 'WebSearch':
      return `Searching the web: ${clip(String(input.query ?? ''), 36)}`;
    case 'Task':
    case 'Agent':
      return `Running a helper: ${clip(String(input.description ?? ''), 36)}`;
    case 'TodoWrite':
      return 'Planning next steps';
    case 'AskUserQuestion':
      return 'Asking you something';
    default:
      if (name.startsWith('mcp__sinnect__')) return 'Syncing with other sessions';
      return `Using ${name.replace(/^mcp__/, '').replace(/__/g, ' ')}`;
  }
}

export function clip(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** System prompt addition that teaches a session about Sinnect. Kept short on purpose. */
export function sinnectPrompt(cfg: SessionConfig, roster: string): string {
  if (cfg.awareness === 'solo') {
    return `You are running inside Sinnect, a canvas of Claude sessions. File edits are coordinated for you: if an edit is blocked because another session holds the file, work on something else and wait for a [Sinnect hub] notice.`;
  }
  return [
    `You are "${cfg.name}", one of several Claude sessions on a Sinnect canvas. Your priority is ${cfg.priority} (1 low, 5 high).`,
    `Coordination tools (mcp__sinnect__*): hub_send (short message to another session), hub_roster, hub_set_status, hub_inbox, hub_claim / hub_release (optional, edits are claimed automatically), hub_negotiate (answer a file negotiation)${cfg.coordinator ? ', hub_spawn (start a new session on the canvas, the user approves each one)' : ''}.`,
    `Token rules, every hub message can cost the other session a full turn:`,
    `- Only message someone when it changes what they should do. Never send thanks, acks, "got it", "noted", or progress updates.`,
    `- A hub message does not need a reply unless it asks you a question. If you reply, put everything in one message.`,
    `- hub_send wake=true starts a turn for them right now. Use it only for a task or a blocking question. Otherwise leave it off, they see it on their next step.`,
    `- Your status is set from your task automatically. Only call hub_set_status if your goal really changes.`,
    `- Don't poll hub_inbox or hub_roster, notices arrive by themselves as [Sinnect hub] blocks. If an edit is blocked, do other work and wait for a notice.`,
    `Sessions you could see when you started:\n${roster}`,
  ].join('\n');
}
