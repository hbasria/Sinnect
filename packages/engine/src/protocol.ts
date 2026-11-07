// Shared wire protocol between the Sinnect UI and the engine.
// The UI imports this file directly, so keep it free of Node-only imports.

export type Awareness = 'solo' | 'family' | 'everyone';
export type PermissionChoice = 'ask' | 'acceptEdits' | 'auto';
export type AuthMode = 'apiKey' | 'local';

export interface SessionConfig {
  name: string;
  cwd: string;
  model: string;
  prompt: string;
  /** 1 (lowest) to 5 (highest). Used to settle file conflicts. */
  priority: number;
  awareness: Awareness;
  permission: PermissionChoice;
  familyId?: string | null;
  /** SDK session id to resume instead of starting fresh. */
  resumeId?: string | null;
  /** Crux agent id. Its AGENT.md is added to the system prompt. */
  agent?: string | null;
  /** Crux company coordinator: runs company onboarding and may start team sessions (hub_spawn). */
  coordinator?: boolean;
  /** Matrix chat for this session. The access token is kept by the engine, never here. */
  matrix?: MatrixConfig | null;
}

export interface MatrixConfig {
  homeserver: string;
  /** The session's own Matrix account, known once the token has been checked. */
  userId: string | null;
  enabled: boolean;
  /** Who may talk to the session. Key '*' = every room, else a room id. */
  allowed: Record<string, string[]>;
}

export interface MatrixStatus {
  state: 'off' | 'connecting' | 'online' | 'error';
  userId: string | null;
  error?: string;
  /** Rooms the account has joined. */
  rooms: { id: string; name: string }[];
}

/** Where a Matrix message came from, so the reply can go back into its thread. */
export interface MatrixOrigin {
  roomId: string;
  roomName: string;
  eventId: string;
  threadRoot: string;
  sender: string;
}

/** A session the coordinator wants to start, from its hub_spawn call. */
export interface SpawnRequest {
  name: string;
  /** Working folder, relative to the coordinator's folder or absolute. Created if missing. */
  folder: string;
  agent?: string | null;
  /** Family name; created if no family has it yet. */
  family?: string | null;
  prompt?: string | null;
}

/** A Crux agent definition a session can run as. */
export interface CruxAgent {
  id: string;
  name: string;
  description: string;
  emoji: string;
}

export type SessionStatus =
  | 'starting'
  | 'thinking'
  | 'working'
  | 'waiting' // waiting on the user (permission / question)
  | 'blocked' // waiting on another session (file conflict)
  | 'idle' // turn finished, can take more input
  | 'stopped'
  | 'error';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionState {
  id: string;
  config: SessionConfig;
  status: SessionStatus;
  /** One short line: what the session is doing right now. Built from tool calls, costs no tokens. */
  activity: string;
  /** The session's own one-line goal, set through hub_set_status. */
  goal: string;
  tokens: TokenUsage;
  costUsd: number;
  sdkSessionId: string | null;
  filesTouched: string[];
  turns: number;
  startedAt: number;
  error?: string;
  matrix?: MatrixStatus;
}

export type FeedKind =
  | 'user'
  | 'text'
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'hub'
  | 'system'
  | 'result'
  | 'error';

export interface FeedItem {
  id: string;
  ts: number;
  kind: FeedKind;
  text: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  isError?: boolean;
}

export interface Claim {
  path: string;
  sessionId: string;
  reason: string;
  since: number;
}

export interface HubMessage {
  id: string;
  ts: number;
  from: string; // session id or 'hub'
  to: string; // session id
  text: string;
  kind: 'message' | 'notice' | 'negotiation';
  /** Set when this message started (or will start) a turn for the receiver. */
  woke?: boolean;
  /** How many hub wakes in a row led here. A turn the user started is 0. */
  depth?: number;
}

export interface Link {
  id: string;
  a: string;
  b: string;
}

export interface Family {
  id: string;
  name: string;
  color: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export type PromptRequest =
  | {
      kind: 'tool';
      requestId: string;
      sessionId: string;
      toolName: string;
      title: string;
      detail: string;
      canAlwaysAllow: boolean;
    }
  | {
      kind: 'question';
      requestId: string;
      sessionId: string;
      questions: Question[];
    }
  | {
      kind: 'negotiation';
      requestId: string;
      sessionId: string; // the session that asked for the file
      otherId: string; // the session holding the file
      path: string;
      title: string;
      detail: string;
    };

export type PromptResponse =
  | { requestId: string; kind: 'tool'; decision: 'allow' | 'deny' | 'always'; message?: string }
  | { requestId: string; kind: 'question'; answers: Record<string, string>; skipped?: boolean }
  | { requestId: string; kind: 'negotiation'; winner: string };

export interface EngineSettings {
  authMode: AuthMode;
  hasApiKey: boolean;
  defaultModel: string;
  mock: boolean;
  /** Max characters per hub message. */
  maxMessageChars: number;
  /** Max hub messages a session may send per hour. */
  maxMessagesPerHour: number;
  /** Max negotiation rounds before asking the user. */
  maxNegotiationRounds: number;
  /** How many sessions in a row may wake each other from one user message. Stops ping-pong. */
  maxWakeChain: number;
  /** Max times per hour a session can be woken up by hub messages. */
  maxWakesPerHour: number;
  /** Stop every session once total spend passes this. 0 = no limit. */
  budgetUsd: number;
  claudePath: string | null;
  /** Whether Claude Code is signed in on this computer (only matters in local mode). */
  signedIn: boolean;
  /** Windows notifications when a session finishes or needs you while Sinnect is in the background. */
  notify: boolean;
  /** Crux framework folder to read agents from. null = CRUX_HOME, else ~/.crux. */
  cruxPath: string | null;
}

/** A saved new-session setup. Spawning from it reuses everything except the folder. */
export interface SessionTemplate {
  id: string;
  name: string;
  model: string;
  priority: number;
  awareness: Awareness;
  permission: PermissionChoice;
  familyId: string | null;
  /** Kept so the template can re-match a family by name when the id no longer exists. */
  familyName: string | null;
  /** First message sent to the session. */
  prompt: string;
  /** Crux agent id the session runs as. */
  agent?: string | null;
  createdAt: number;
}

export interface Snapshot {
  sessions: SessionState[];
  feeds: Record<string, FeedItem[]>;
  claims: Claim[];
  links: Link[];
  families: Family[];
  prompts: PromptRequest[];
  messages: HubMessage[];
  settings: EngineSettings;
  templates: SessionTemplate[];
  agents: CruxAgent[];
  /** The Crux folder the agents were read from. */
  cruxHome: string;
  terminals: TerminalSnapshot[];
  /** Why terminals can't be used here (node-pty missing, turned off), or null. */
  terminalsUnavailable: string | null;
}

/** A shell the engine runs in a folder, shown in the UI's terminal panel. */
export interface TerminalInfo {
  id: string;
  cwd: string;
  title: string;
  alive: boolean;
  exitCode?: number;
}

/** A terminal with its recent output, so a (re)connecting UI can redraw it. */
export interface TerminalSnapshot extends TerminalInfo {
  buffer: string;
}

// ---- UI -> engine ----
export type ClientMsg =
  | { t: 'hello'; token: string }
  | { t: 'session.create'; id: string; config: SessionConfig }
  | { t: 'session.send'; id: string; text: string }
  | { t: 'session.interrupt'; id: string }
  | { t: 'session.stop'; id: string }
  | { t: 'session.remove'; id: string }
  | { t: 'session.update'; id: string; patch: Partial<Pick<SessionConfig, 'name' | 'priority' | 'awareness' | 'permission' | 'familyId'>> }
  | { t: 'prompt.respond'; response: PromptResponse }
  | { t: 'links.set'; links: Link[] }
  | { t: 'families.set'; families: Family[] }
  | { t: 'settings.set'; patch: Partial<Omit<EngineSettings, 'hasApiKey' | 'mock'>> & { apiKey?: string } }
  | { t: 'auth.login' }
  | { t: 'auth.check' }
  | { t: 'snapshot' }
  | { t: 'workspace.save'; name: string; data: unknown }
  | { t: 'workspace.list' }
  | { t: 'workspace.load'; name: string }
  | { t: 'workspace.delete'; name: string }
  /** Create or overwrite (same id) a template. */
  | { t: 'template.save'; template: SessionTemplate }
  | { t: 'template.delete'; id: string }
  /** Connect the session to Matrix. No token = reuse the one saved for its account. */
  | { t: 'matrix.enable'; id: string; homeserver: string; token?: string; allowed: Record<string, string[]> }
  | { t: 'matrix.disable'; id: string }
  /** Change who may talk to the session, without reconnecting. */
  | { t: 'matrix.allow'; id: string; allowed: Record<string, string[]> }
  /** Start a shell in `cwd`. The UI picks the id. */
  | { t: 'term.open'; id: string; cwd: string; cols: number; rows: number; title?: string }
  | { t: 'term.input'; id: string; data: string }
  | { t: 'term.resize'; id: string; cols: number; rows: number }
  | { t: 'term.close'; id: string };

// ---- engine -> UI ----
export type EngineMsg =
  | { t: 'ready'; snapshot: Snapshot }
  | { t: 'session.state'; state: SessionState }
  | { t: 'session.removed'; id: string }
  | { t: 'feed.add'; id: string; item: FeedItem }
  | { t: 'feed.delta'; id: string; itemId: string; text: string }
  | { t: 'prompt.open'; prompt: PromptRequest }
  | { t: 'prompt.close'; requestId: string }
  | { t: 'claims'; claims: Claim[] }
  | { t: 'hub.message'; message: HubMessage }
  | { t: 'links'; links: Link[] }
  | { t: 'families'; families: Family[] }
  | { t: 'settings'; settings: EngineSettings }
  | { t: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'workspace.list'; items: WorkspaceInfo[] }
  | { t: 'workspace.data'; name: string; data: unknown }
  /** Full template list, sent after every save/delete. */
  | { t: 'templates'; templates: SessionTemplate[] }
  /** Crux agent list, sent when the Crux folder changes. */
  | { t: 'agents'; agents: CruxAgent[]; cruxHome: string }
  /** A session started a new one (hub_spawn). Sent after its first session.state, so the UI can place it. */
  | { t: 'session.spawned'; id: string; parentId: string }
  | { t: 'term.opened'; terminal: TerminalInfo }
  | { t: 'term.data'; id: string; data: string }
  | { t: 'term.exit'; id: string; exitCode: number }
  | { t: 'term.closed'; id: string };

export interface WorkspaceInfo {
  name: string;
  savedAt: number;
  sessions: number;
}

export const FAMILY_COLORS = ['#ff6b4a', '#2dd4bf', '#fbbf24', '#7dd3fc', '#f472b6', '#a3e635', '#fb923c', '#e2e8f0'];

export const DEFAULT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];
