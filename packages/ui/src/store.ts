import { create } from 'zustand';
import type { Edge, Node, Viewport } from '@xyflow/react';
import type {
  Claim,
  EngineMsg,
  EngineSettings,
  Family,
  FeedItem,
  HubMessage,
  Link,
  MemoryNote,
  PromptRequest,
  SessionState,
  SessionTemplate,
  WorkspaceInfo,
} from '@engine/protocol';
import { onBoard, splitSessions } from './workspace-scope';

export type ConnState = 'connecting' | 'open' | 'closed';

export interface SessionNodeData extends Record<string, unknown> {
  sessionId: string;
}
export interface FamilyNodeData extends Record<string, unknown> {
  familyId: string;
}
export interface NoteNodeData extends Record<string, unknown> {
  text: string;
}

export type AppNode =
  | Node<SessionNodeData, 'session'>
  | Node<FamilyNodeData, 'family'>
  | Node<NoteNodeData, 'note'>;

export interface Pulse {
  id: string;
  from: string;
  to: string;
  at: number;
}

export interface UiState {
  conn: ConnState;
  settings: EngineSettings | null;
  sessions: Record<string, SessionState>;
  /** Sessions loaded from a workspace that aren't running yet. */
  dormant: Record<string, boolean>;
  feeds: Record<string, FeedItem[]>;
  claims: Claim[];
  links: Link[];
  families: Family[];
  prompts: PromptRequest[];
  messages: HubMessage[];
  pulses: Pulse[];
  workspaces: WorkspaceInfo[];
  workspaceName: string;
  /** The open workspace's id; its sessions carry it as config.workspace. */
  workspaceId: string;
  /** Running sessions of the other workspaces (see workspace-scope.ts). */
  parked: Record<string, SessionState>;
  templates: SessionTemplate[];
  memory: MemoryNote[];
  /** Ids of notes for the "Sinnect learned N things" card, newest last. */
  learned: string[];
  memoryOpen: boolean;
  /** Helper cards you pinned, so they don't fade out when done. */
  pinned: Record<string, boolean>;
  guideOpen: boolean;

  nodes: AppNode[];
  viewport: Viewport | null;

  expanded: string | null;
  expandFrom: DOMRect | null;
  /** `template` prefills the card (one-click spawn that had no folder to use). */
  setup: { position: { x: number; y: number }; familyId: string | null; template?: SessionTemplate } | null;
  settingsOpen: boolean;
  workspacesOpen: boolean;
  paletteOpen: boolean;

  apply(msg: EngineMsg): void;
  set(p: Partial<UiState>): void;
}

export const newWorkspaceId = () => `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const MAX_FEED = 1500;

export const useApp = create<UiState>((set, get) => ({
  conn: 'connecting',
  settings: null,
  sessions: {},
  dormant: {},
  feeds: {},
  claims: [],
  links: [],
  families: [],
  prompts: [],
  messages: [],
  pulses: [],
  workspaces: [],
  workspaceName: 'My workspace',
  workspaceId: newWorkspaceId(),
  parked: {},
  templates: [],
  memory: [],
  learned: [],
  memoryOpen: false,
  pinned: {},
  guideOpen: false,
  nodes: [],
  viewport: null,
  expanded: null,
  expandFrom: null,
  setup: null,
  settingsOpen: false,
  workspacesOpen: false,
  paletteOpen: false,

  set: (p) => set(p),

  apply(msg) {
    const s = get();
    switch (msg.t) {
      case 'ready': {
        const snap = msg.snapshot;
        // Other workspaces' sessions are parked. A parked one the engine no longer has is gone (its file can resume it).
        const split = splitSessions(snap.sessions, s.workspaceId);
        const sessions = { ...s.sessions, ...split.sessions };
        const dormant = { ...s.dormant };
        for (const st of snap.sessions) delete dormant[st.id];
        set({
          settings: snap.settings,
          sessions,
          parked: split.parked,
          dormant,
          feeds: { ...s.feeds, ...snap.feeds },
          claims: snap.claims,
          links: snap.links.length ? snap.links : s.links,
          families: snap.families.length ? snap.families : s.families,
          prompts: snap.prompts,
          messages: snap.messages,
          templates: snap.templates ?? s.templates,
          memory: snap.memory ?? s.memory,
          // Notes nobody has reviewed yet come back after a restart.
          learned: (snap.memory ?? []).filter((n) => !n.reviewed).map((n) => n.id).slice(-12),
        });
        // Engine knows sessions the canvas has no node for (e.g. after a UI reload): place them.
        const have = new Set(get().nodes.filter((n) => n.type === 'session').map((n) => n.id));
        const missing = Object.values(split.sessions).filter((x) => !have.has(x.id));
        if (missing.length) {
          set({
            nodes: [
              ...get().nodes,
              ...missing.map((x, i) => ({
                id: x.id,
                type: 'session' as const,
                position: { x: 120 + (i % 4) * 320, y: 120 + Math.floor(i / 4) * 220 },
                data: { sessionId: x.id },
              })),
            ],
          });
        }
        return;
      }
      case 'session.state': {
        const st = msg.state;
        if (!onBoard(st, s.workspaceId)) {
          // A session of a workspace in the background: it keeps running out of sight.
          const { [st.id]: _, ...sessions } = s.sessions;
          set({ parked: { ...s.parked, [st.id]: st }, ...(s.sessions[st.id] ? { sessions } : {}) });
          return;
        }
        const isNew = !s.sessions[st.id];
        if (s.parked[st.id]) {
          const { [st.id]: _, ...parked } = s.parked;
          set({ sessions: { ...s.sessions, [st.id]: st }, parked });
        } else set({ sessions: { ...s.sessions, [st.id]: st } });
        // A boss just spawned a helper: put its card next to the boss.
        const parentId = st.config.parentId;
        if (isNew && parentId && !s.nodes.some((n) => n.id === st.id)) {
          const parent = s.nodes.find((n) => n.id === parentId);
          if (parent) set({ nodes: [...get().nodes, { id: st.id, type: 'session', position: helperSpot(get().nodes, parent), data: { sessionId: st.id } }] });
        }
        return;
      }
      case 'session.removed': {
        const sessions = { ...s.sessions };
        delete sessions[msg.id];
        const parked = { ...s.parked };
        delete parked[msg.id];
        const feeds = { ...s.feeds };
        delete feeds[msg.id];
        set({
          sessions,
          parked,
          feeds,
          nodes: s.nodes.filter((n) => n.id !== msg.id),
          expanded: s.expanded === msg.id ? null : s.expanded,
        });
        return;
      }
      case 'feed.add': {
        const feed = [...(s.feeds[msg.id] ?? []), msg.item];
        if (feed.length > MAX_FEED) feed.splice(0, feed.length - MAX_FEED);
        set({ feeds: { ...s.feeds, [msg.id]: feed } });
        return;
      }
      case 'feed.delta':
        // batched in engine.ts, see applyDeltas
        return;
      case 'prompt.open':
        if (s.prompts.some((p) => p.requestId === msg.prompt.requestId)) return;
        set({ prompts: [...s.prompts, msg.prompt] });
        return;
      case 'prompt.close':
        set({ prompts: s.prompts.filter((p) => p.requestId !== msg.requestId) });
        return;
      case 'claims':
        set({ claims: msg.claims });
        return;
      case 'hub.message': {
        const m = msg.message;
        const messages = [...s.messages, m].slice(-500);
        const pulses = m.from !== 'hub' ? [...s.pulses.filter((p) => Date.now() - p.at < 4000), { id: m.id, from: m.from, to: m.to, at: Date.now() }] : s.pulses;
        set({ messages, pulses });
        return;
      }
      case 'links':
        set({ links: msg.links });
        return;
      case 'families':
        set({ families: msg.families });
        return;
      case 'settings':
        set({ settings: msg.settings });
        return;
      case 'templates':
        set({ templates: msg.templates });
        return;
      case 'memory': {
        const ids = new Set(msg.notes.map((n) => n.id));
        const open = new Set(msg.notes.filter((n) => !n.reviewed).map((n) => n.id));
        set({ memory: msg.notes, learned: s.learned.filter((id) => ids.has(id) && open.has(id)) });
        return;
      }
      case 'memory.learned': {
        const add = msg.notes.map((n) => n.id).filter((id) => !s.learned.includes(id));
        set({ learned: [...s.learned, ...add].slice(-12) });
        return;
      }
      case 'workspace.list':
        set({ workspaces: msg.items });
        return;
      default:
        return;
    }
  },
}));

const HELPER_W = 280;
const HELPER_H = 150;

/** Free spot to the right of the boss, stacking down. Helpers fan out in a column like n8n branches. */
export function helperSpot(nodes: AppNode[], parent: AppNode): { x: number; y: number } {
  const x = parent.position.x + 380;
  const taken = (y: number) =>
    nodes.some((n) => n.type === 'session' && Math.abs(n.position.x - x) < HELPER_W && Math.abs(n.position.y - y) < HELPER_H + 10);
  const start = parent.position.y - 170;
  for (let i = 0; i < 24; i++) {
    const y = start + i * 180;
    if (!taken(y)) return { x, y };
  }
  return { x: x + 320, y: start };
}

/** Apply a batch of streaming text deltas in one store update. */
export function applyDeltas(batch: Map<string, Map<string, string>>) {
  const s = useApp.getState();
  const feeds = { ...s.feeds };
  for (const [sid, items] of batch) {
    const feed = feeds[sid];
    if (!feed) continue;
    const next = feed.slice();
    for (const [itemId, text] of items) {
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].id === itemId) {
          next[i] = { ...next[i], text: next[i].text + text };
          break;
        }
      }
    }
    feeds[sid] = next;
  }
  useApp.setState({ feeds });
}

export const isActive = (st?: SessionState) =>
  !!st && (st.status === 'thinking' || st.status === 'working' || st.status === 'starting');

export const totalTokens = (st: SessionState) => st.tokens.input + st.tokens.output + st.tokens.cacheWrite;

export const linkEdges = (links: Link[]): Edge[] =>
  links.map((l) => ({ id: l.id, source: l.a, target: l.b, type: 'pulse', sourceHandle: 'out', targetHandle: 'in' }));

/** Boss to helper wires. Drawn from the sessions, not saved as links: helpers can't message anyone. */
export const workerEdges = (sessions: Record<string, SessionState>, nodeIds: Set<string>): Edge[] =>
  Object.values(sessions)
    .filter((st) => st.config.parentId && nodeIds.has(st.id) && nodeIds.has(st.config.parentId))
    .map((st) => ({
      id: `w-${st.id}`,
      source: st.config.parentId!,
      target: st.id,
      type: 'worker',
      sourceHandle: 'out',
      targetHandle: 'in',
      selectable: false,
      deletable: false,
      data: { workerId: st.id },
    }));
