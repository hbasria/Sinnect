// Saving and loading the whole board.

import type { SessionState } from '@engine/protocol';
import { useApp, type AppNode, type CompanyMode, type TermTab } from './store';
import { closeAllTerminals } from './terminal';
import { toast } from 'sonner';
import { onEngine, send } from './engine';

export interface WorkspaceFile {
  version: 1;
  nodes: AppNode[];
  sessions: Pick<SessionState, 'id' | 'config' | 'sdkSessionId' | 'tokens' | 'costUsd' | 'goal' | 'filesTouched' | 'turns'>[];
  links: ReturnType<typeof useApp.getState>['links'];
  families: ReturnType<typeof useApp.getState>['families'];
  viewport: ReturnType<typeof useApp.getState>['viewport'];
  company?: CompanyMode | null;
  /** Terminal tabs. The shells themselves don't survive; tabs come back and start fresh when shown. */
  terminals?: Pick<TermTab, 'id' | 'cwd' | 'title'>[];
}

export function serialize(): WorkspaceFile {
  const s = useApp.getState();
  return {
    version: 1,
    nodes: s.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data, width: n.width, height: n.height, zIndex: n.zIndex }) as AppNode),
    sessions: Object.values(s.sessions).map((x) => ({
      id: x.id,
      config: { ...x.config, prompt: '' },
      sdkSessionId: x.sdkSessionId,
      tokens: x.tokens,
      costUsd: x.costUsd,
      goal: x.goal,
      filesTouched: x.filesTouched,
      turns: x.turns,
    })),
    links: s.links,
    families: s.families,
    viewport: s.viewport,
    company: s.company,
    terminals: s.terminals.map(({ id, cwd, title }) => ({ id, cwd, title })),
  };
}

/** Put a saved board on the canvas. Sessions come back "dormant" with a Resume button. */
export function applyWorkspace(w: WorkspaceFile, name?: string) {
  const s = useApp.getState();
  const sessions: Record<string, SessionState> = {};
  const dormant: Record<string, boolean> = {};
  for (const x of w.sessions) {
    if (s.sessions[x.id] && s.sessions[x.id].status !== 'stopped') {
      sessions[x.id] = s.sessions[x.id];
      continue;
    }
    sessions[x.id] = {
      ...x,
      status: 'stopped',
      activity: 'Saved',
      startedAt: Date.now(),
    } as SessionState;
    dormant[x.id] = true;
  }
  // A tab whose shell is still running in the engine (the UI was reloaded) stays live.
  const live = new Map(s.terminals.map((t) => [t.id, t]));
  const saved: TermTab[] = (w.terminals ?? []).map((t) => live.get(t.id) ?? { ...t, status: 'dormant' });
  const terminals = [...saved, ...s.terminals.filter((t) => !saved.some((x) => x.id === t.id))];
  s.set({ nodes: w.nodes, sessions, dormant, viewport: w.viewport, workspaceName: name ?? s.workspaceName, company: w.company ?? null, terminals, termActive: s.termActive ?? terminals[0]?.id ?? null });
  send({ t: 'links.set', links: w.links });
  send({ t: 'families.set', families: w.families });
  window.dispatchEvent(new CustomEvent('sinnect:viewport', { detail: w.viewport }));
}

export function saveWorkspace(name: string) {
  useApp.getState().set({ workspaceName: name });
  send({ t: 'workspace.save', name, data: serialize() });
}

export async function loadWorkspace(name: string) {
  const s = useApp.getState();
  const running = Object.values(s.sessions).filter((x) => !s.dormant[x.id] && x.status !== 'stopped');
  if (running.length && !confirm(`Stop ${running.length} running session(s) and open "${name}"?`)) return;
  clearBoard();
  send({ t: 'workspace.load', name });
}

/** Close every session and empty the canvas: cards, links, families, company mode. */
function clearBoard() {
  const s = useApp.getState();
  for (const x of Object.values(s.sessions)) if (!s.dormant[x.id]) send({ t: 'session.remove', id: x.id });
  s.set({ sessions: {}, dormant: {}, nodes: [], feeds: {}, company: null, expanded: null });
  closeAllTerminals();
  send({ t: 'links.set', links: [] });
  send({ t: 'families.set', families: [] });
}

const sessionCount = () => Object.keys(useApp.getState().sessions).length;

/** Start over on an empty, unsaved board. */
export function newWorkspace() {
  const n = sessionCount();
  if (n && !confirm(`Close ${n} session(s) and start an empty workspace? Unsaved changes are lost.`)) return;
  clearBoard();
  useApp.getState().set({ workspaceName: 'My workspace' });
}

/** Delete a saved workspace. Deleting the open one also closes its sessions and empties the board. */
export function deleteWorkspace(name: string) {
  const open = useApp.getState().workspaceName === name;
  const n = open ? sessionCount() : 0;
  const ask = n ? `Delete "${name}" and close its ${n} session(s)? This can't be undone.` : `Delete the saved workspace "${name}"? This can't be undone.`;
  if (!confirm(ask)) return;
  send({ t: 'workspace.delete', name });
  if (!open) return;
  clearBoard();
  useApp.getState().set({ workspaceName: 'My workspace' });
  toast(`Deleted "${name}"`);
}

let restoreTried = false;

/** Autosave every few seconds while things change, and restore on first launch. */
export function startAutosave() {
  let last = '';
  const tick = () => {
    const s = useApp.getState();
    if (s.conn !== 'open') return;
    const data = serialize();
    const json = JSON.stringify(data);
    if (json === last) return;
    last = json;
    send({ t: 'workspace.save', name: '__autosave', data: { ...data, name: s.workspaceName } });
  };
  setInterval(tick, 4000);
  window.addEventListener('beforeunload', tick);

  onEngine((msg) => {
    if (msg.t === 'ready' && !restoreTried) {
      restoreTried = true;
      if (msg.snapshot.sessions.length === 0 && useApp.getState().nodes.length === 0) send({ t: 'workspace.load', name: '__autosave' });
      send({ t: 'workspace.list' });
    }
    if (msg.t === 'workspace.data' && msg.data) {
      const w = msg.data as WorkspaceFile & { name?: string };
      if (w.version === 1) applyWorkspace(w, msg.name === '__autosave' ? w.name : msg.name);
    }
  });
}
