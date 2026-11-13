// Shared wire protocol between the Sinnect UI and the engine.
// The UI imports this file directly, so keep it free of Node-only imports.

export type Awareness = 'solo' | 'family' | 'everyone';
export type PermissionChoice = 'ask' | 'acceptEdits' | 'auto';
export type AuthMode = 'apiKey' | 'local';
export type Provider = 'claude' | 'gemini' | 'openai';

/**
 * Which backend runs a model. "gemini…" runs on Google's Gemini API, "gpt-…",
 * "o3", "o4-mini", "codex-…" run on OpenAI's API, everything else on Claude.
 */
export function providerOf(model: string | null | undefined): Provider {
  const m = model ?? '';
  if (/^(models\/)?gemini/i.test(m)) return 'gemini';
  if (/^(gpt-|o\d|codex|chatgpt)/i.test(m)) return 'openai';
  return 'claude';
}

/** "gpt-5-mini" reads as "GPT-5 mini", "gpt-6.1-sol" as "GPT-6.1 Sol", "o4-mini" stays "o4-mini". */
export function openaiLabel(id: string): string {
  if (!/^gpt-/i.test(id)) return id;
  const [ver, ...rest] = id.slice(4).split('-');
  const words = rest.filter((w) => w !== 'latest').map((w) => (/^(mini|nano)$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)));
  return [`GPT-${ver}`, ...words].join(' ');
}

/** What a helper (worker) session is for. Picks its model through the routing rules in settings. */
export type WorkerKind = 'search' | 'read' | 'test' | 'code' | 'review' | 'plan';
export const WORKER_KINDS: WorkerKind[] = ['search', 'read', 'test', 'code', 'review', 'plan'];
export const WORKER_KIND_LABEL: Record<WorkerKind, string> = {
  search: 'Search',
  read: 'Read',
  test: 'Tests',
  code: 'Code',
  review: 'Review',
  plan: 'Plan',
};

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
  /** Set on helper sessions: the boss session that spawned it. */
  parentId?: string | null;
  /** Helpers only: what kind of job it got. */
  workerKind?: WorkerKind | null;
  /** May this session spawn helpers? Missing = yes (unless it is a helper itself). */
  canSpawn?: boolean;
  /** Id of the workspace (board) it belongs to. Sessions only see their own workspace's sessions. */
  workspace?: string | null;
}

/** Live helper numbers, shown on the boss card. */
export interface WorkerStats {
  running: number;
  total: number;
  spentUsd: number;
  capUsd: number;
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

export type LessonType = 'rule' | 'worked' | 'broke';

/** One note in the memory folder: a lesson (short fact) or a skill (reusable steps). */
export interface MemoryNote {
  /** Path inside the memory folder, e.g. "Lessons/2026-11-06 Use npm ci.md". */
  id: string;
  kind: 'lesson' | 'skill';
  title: string;
  body: string;
  /** Skills only: one line on when to use it. */
  description?: string;
  /** Lessons only. */
  type?: LessonType;
  /** Folder name it applies to, null = everywhere. */
  project: string | null;
  tags: string[];
  /** Name of the session that wrote it. */
  source: string;
  createdAt: number;
  /** false until you press Keep. Unreviewed notes are still used. */
  reviewed: boolean;
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
  /** Boss sessions: their helpers. */
  workers?: WorkerStats;
  /** Helpers: the short summary sent back to the boss, once done. */
  summary?: string;
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

/** How OpenAI sessions sign in: the ChatGPT plan (through OpenAI's Codex app) or a pay-per-token API key. */
export type OpenaiAuth = 'chatgpt' | 'apiKey';

/** A plan's usage windows, like Claude's and ChatGPT's 5-hour and weekly limits. */
export interface PlanUsage {
  primary: { usedPercent: number; windowMins: number | null; resetsAt: number | null } | null;
  secondary: { usedPercent: number; windowMins: number | null; resetsAt: number | null } | null;
  reached: boolean;
}

/** What Sinnect knows about Codex and the ChatGPT sign-in on this computer. Read-only. */
export interface ChatgptStatus {
  /** Codex is installed. */
  found: boolean;
  path: string | null;
  version: string | null;
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  /** Models the plan can use, from Codex. */
  models: { id: string; label: string }[];
  /** How much of the plan's usage windows is used up, from OpenAI. */
  usage: PlanUsage | null;
}

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
  /** A Gemini API key (from aistudio.google.com) is saved. */
  hasGeminiKey: boolean;
  /** Gemini models this key can use, fetched from Google. Empty until a key is saved. */
  geminiModels: { id: string; label: string }[];
  /** An OpenAI API key (from platform.openai.com) is saved. */
  hasOpenaiKey: boolean;
  /** OpenAI models this key can use, fetched from OpenAI. The defaults until a key is saved. */
  openaiModels: { id: string; label: string }[];
  /** How OpenAI sessions sign in. */
  openaiAuth: OpenaiAuth;
  /** A Codex binary picked by hand. null = find it. */
  codexPath: string | null;
  /** Codex + ChatGPT sign-in state. Read-only. */
  chatgpt: ChatgptStatus;
  /** The Claude plan's usage windows (local login mode). null = unknown or no plan. Read-only. */
  claudeUsage: { plan: string | null; usage: PlanUsage; checkedAt: number } | null;
  /** Sessions read and write lesson notes and skills. */
  memoryEnabled: boolean;
  /** Folder for memory notes. null = inside Sinnect's data folder. Can point into an Obsidian vault. */
  memoryDir: string | null;
  /** The folder actually in use (resolved from memoryDir). Read-only. */
  memoryPath: string;
  /** When a session that did real work is stopped, it writes down what it learned first (one short turn). */
  memoryReflect: boolean;
  /** Max lesson notes loaded into a new session. */
  memoryMaxNotes: number;
  /** Which model each kind of helper runs on. */
  workerRouting: Record<WorkerKind, string>;
  /** Max helpers one boss can have running at once. */
  maxWorkersPerBoss: number;
  /** Total a boss's helpers may spend (USD). 0 = no cap. */
  workerSpendCapUsd: number;
  /** Helpers may spawn their own helpers. Off by default. */
  workerNesting: boolean;
  /** Ask you (dynamic island) before a boss spawns helpers. */
  askBeforeSpawn: boolean;
  /** The setup guide was finished or skipped. */
  onboarded: boolean;
}

export const DEFAULT_WORKER_ROUTING: Record<WorkerKind, string> = {
  search: 'claude-haiku-5-5',
  read: 'claude-haiku-5-5',
  test: 'claude-haiku-5-5',
  code: 'claude-sonnet-5-5',
  review: 'claude-sonnet-5-5',
  plan: 'claude-opus-5-5',
};

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
  memory: MemoryNote[];
}

// ---- UI -> engine ----
export type ClientMsg =
  | { t: 'hello'; token: string }
  | { t: 'session.create'; id: string; config: SessionConfig }
  | { t: 'session.send'; id: string; text: string }
  | { t: 'session.interrupt'; id: string }
  | { t: 'session.stop'; id: string }
  | { t: 'session.remove'; id: string }
  | { t: 'session.update'; id: string; patch: Partial<Pick<SessionConfig, 'name' | 'priority' | 'awareness' | 'permission' | 'familyId' | 'canSpawn' | 'workspace'>> }
  | { t: 'prompt.respond'; response: PromptResponse }
  | { t: 'links.set'; links: Link[] }
  | { t: 'families.set'; families: Family[] }
  | { t: 'settings.set'; patch: Partial<Omit<EngineSettings, 'hasApiKey' | 'hasGeminiKey' | 'geminiModels' | 'hasOpenaiKey' | 'openaiModels' | 'chatgpt' | 'claudeUsage' | 'mock' | 'memoryPath'>> & { apiKey?: string; geminiKey?: string; openaiKey?: string } }
  /** Ask the session to write down what it learned now (one short turn). */
  | { t: 'session.reflect'; id: string }
  /** Re-read the memory folder (it may have been edited by hand). */
  | { t: 'memory.list' }
  | { t: 'memory.keep'; ids: string[] }
  | { t: 'memory.delete'; ids: string[] }
  | { t: 'auth.login' }
  | { t: 'auth.check' }
  /** Sign in to ChatGPT through Codex (opens the browser). */
  | { t: 'codex.login' }
  /** Opens a terminal that installs Codex. */
  | { t: 'codex.install' }
  /** Look for Codex and the sign-in again. */
  | { t: 'codex.check' }
  /** Read the plan limits of everything connected (the island asks when it opens). */
  | { t: 'usage.check' }
  | { t: 'snapshot' }
  | { t: 'workspace.save'; name: string; data: unknown }
  | { t: 'workspace.list' }
  | { t: 'workspace.load'; name: string }
  | { t: 'workspace.delete'; name: string }
  /** Create or overwrite (same id) a template. */
  | { t: 'template.save'; template: SessionTemplate }
  | { t: 'template.delete'; id: string };

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
  /** Full memory list, sent after every change. */
  | { t: 'memory'; notes: MemoryNote[] }
  /** A session just saved these notes. The UI shows "Sinnect learned N things". */
  | { t: 'memory.learned'; sessionId: string; notes: MemoryNote[] };

export interface WorkspaceInfo {
  name: string;
  savedAt: number;
  sessions: number;
  /** The board's id, which its sessions carry as config.workspace. Older files have none. */
  id?: string | null;
}

export const DEFAULT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];

/**
 * Used until Google sends the real list for the saved key. These are Google's
 * moving aliases, so they keep pointing at the current models.
 */
export const DEFAULT_GEMINI_MODELS = [
  { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)' },
  { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (latest)' },
  { id: 'gemini-pro-latest', label: 'Gemini Pro (latest)' },
];

/** Used until OpenAI sends the real list for the saved key. */
export const DEFAULT_OPENAI_MODELS = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
];

/** A file name for a workspace. Letters of any language stay ("Müşteri işleri"), anything else becomes "_". */
export function safeName(name: string) {
  return name.normalize('NFC').replace(/[^\p{L}\p{N}\- _]+/gu, '_').slice(0, 80) || 'workspace';
}
