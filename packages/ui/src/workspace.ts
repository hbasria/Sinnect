// Saving and loading the whole board. Several workspaces can be live at once: the board shows one,
// and the running sessions of the others are parked (see workspace-scope.ts) and keep working.

import type { SessionState } from '@engine/protocol';
import { helperSpot, newWorkspaceId, useApp, type AppNode } from './store';
import { toast } from 'sonner';
import { onEngine, send } from './engine';
import { freeName, hasOwnFile, isOpenWorkspace } from './workspace-file';
import { mergeFamilies, mergeLinks, splitSessions } from './workspace-scope';
import { askLeave } from './panels/LeaveDialog';

export { isOpenWorkspace };

export interface WorkspaceFile {
  version: 1;
  /** The board's id; its sessions carry it as config.workspace. Older files have none and get one when opened. */
  id?: string;
  nodes: AppNode[];
  sessions: Pick<SessionState, 'id' | 'config' | 'sdkSessionId' | 'tokens' | 'costUsd' | 'goal' | 'filesTouched' | 'turns'>[];
  links: ReturnType<typeof useApp.getState>['links'];
  families: ReturnType<typeof useApp.getState>['families'];
  viewport: ReturnType<typeof useApp.getState>['viewport'];
}

export function serialize(): WorkspaceFile {
  const s = useApp.getState();
  // Helpers are throwaway unless you pinned them. A session without a card can't be resumed from the file:
  // it's one of the previous board's, still wrapping up after a switch, whose last update came in late.
  const cards = new Set(s.nodes.map((n) => n.id));
  const skip = new Set(Object.values(s.sessions).filter((x) => (x.config.parentId && !s.pinned[x.id]) || !cards.has(x.id)).map((x) => x.id));
  const kept = new Set(Object.keys(s.sessions).filter((id) => !skip.has(id)));
  return {
    version: 1,
    id: s.workspaceId,
    nodes: s.nodes.filter((n) => !skip.has(n.id)).map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data, width: n.width, height: n.height, zIndex: n.zIndex }) as AppNode),
    sessions: Object.values(s.sessions).filter((x) => !skip.has(x.id)).map((x) => ({
      id: x.id,
      config: { ...x.config, prompt: '' },
      sdkSessionId: x.sdkSessionId,
      tokens: x.tokens,
      costUsd: x.costUsd,
      goal: x.goal,
      filesTouched: x.filesTouched,
      turns: x.turns,
    })),
    // The link list is shared by every workspace; this board keeps only its own.
    links: s.links.filter((l) => kept.has(l.a) && kept.has(l.b)),
    families: s.families,
    viewport: s.viewport,
  };
}

/** Put a saved board on the canvas. Its sessions still running in the engine stay live; the rest come back "dormant" with a Resume button. */
export function applyWorkspace(w: WorkspaceFile, name?: string) {
  const s = useApp.getState();
  const id = w.id ?? newWorkspaceId();
  // Everything the engine runs, split again for the board being opened.
  const live = Object.values({ ...s.parked, ...s.sessions }).filter((x) => !s.dormant[x.id]);
  const split = splitSessions(live, id);
  const sessions: Record<string, SessionState> = { ...split.sessions };
  const dormant: Record<string, boolean> = {};
  for (const x of w.sessions) {
    if (sessions[x.id] && sessions[x.id].status !== 'stopped') continue;
    sessions[x.id] = {
      ...x,
      // An old file, or a copy made with Save as: resuming puts the session on this board.
      config: { ...x.config, workspace: id },
      status: 'stopped',
      activity: 'Saved',
      startedAt: Date.now(),
    } as SessionState;
    dormant[x.id] = true;
  }
  s.set({ nodes: w.nodes, sessions, parked: split.parked, dormant, workspaceId: id, viewport: w.viewport, workspaceName: name ?? s.workspaceName });
  // One list for the whole app: this board adds its own, the background boards' stay.
  send({ t: 'links.set', links: mergeLinks(s.links, w.links) });
  send({ t: 'families.set', families: mergeFamilies(s.families, w.families) });
  placeOrphans();
  window.dispatchEvent(new CustomEvent('sinnect:viewport', { detail: w.viewport }));
}

/** Cards for this board's running sessions that have none: started while it was in the background, or after its last save. */
function placeOrphans() {
  const s = useApp.getState();
  const have = new Set(s.nodes.map((n) => n.id));
  const orphans = Object.values(s.sessions).filter((x) => !have.has(x.id));
  if (!orphans.length) return;
  const nodes = [...s.nodes];
  let free = 0;
  for (const x of orphans) {
    const parent = x.config.parentId ? nodes.find((n) => n.id === x.config.parentId) : undefined;
    const position = parent ? helperSpot(nodes, parent) : { x: 120 + (free % 4) * 320, y: 120 + Math.floor(free++ / 4) * 220 };
    nodes.push({ id: x.id, type: 'session', position, data: { sessionId: x.id } });
  }
  s.set({ nodes });
}

export function saveWorkspace(name: string) {
  useApp.getState().set({ workspaceName: name });
  send({ t: 'workspace.save', name, data: serialize() });
}

const running = () => {
  const s = useApp.getState();
  return Object.values(s.sessions).filter((x) => !s.dormant[x.id] && x.status !== 'stopped');
};

/**
 * Leaving the open board (Open another workspace, or New). With sessions running, ask whether they keep going.
 * Keep: the board is saved and moves to the background. Stop: it is saved if it has a file, and its sessions stop.
 */
async function leave(): Promise<'kept' | 'cleared' | 'cancel'> {
  const s = useApp.getState();
  const own = hasOwnFile(s.workspaceName, s.workspaces, s.workspaceId);
  const n = running().length;
  if (n) {
    const choice = await askLeave({ name: s.workspaceName, running: n, saved: own, saveAs: freeName(s.workspaceName, s.workspaces) });
    if (choice === 'cancel') return 'cancel';
    if (choice === 'keep') {
      keepBoard();
      parkBoard();
      return 'kept';
    }
  }
  if (own) saveWorkspace(s.workspaceName);
  // Load only once the old sessions are gone: a late "removed" would take the card of a session
  // that's on the new board too (reopening the open workspace, or one saved under two names).
  await clearBoard();
  return 'cleared';
}

/** Save the open board into its own file, or under a free name if it never had one, so it can be opened again. */
function keepBoard() {
  const s = useApp.getState();
  if (hasOwnFile(s.workspaceName, s.workspaces, s.workspaceId)) return saveWorkspace(s.workspaceName);
  const name = freeName(s.workspaceName, s.workspaces);
  saveWorkspace(name);
  toast(`Saved this board as "${name}"`);
}

/** Empty the canvas without stopping anything: the board's running sessions move to `parked`. */
function parkBoard() {
  const s = useApp.getState();
  const parked = { ...s.parked };
  for (const x of Object.values(s.sessions)) {
    if (s.dormant[x.id]) continue;
    // From before workspaces had ids: give it this board's, or it would follow whichever board is open.
    if (!x.config.workspace) send({ t: 'session.update', id: x.id, patch: { workspace: s.workspaceId } });
    parked[x.id] = { ...x, config: { ...x.config, workspace: x.config.workspace ?? s.workspaceId } };
  }
  s.set({ sessions: {}, parked, dormant: {}, nodes: [], expanded: null });
}

export async function loadWorkspace(name: string) {
  if ((await leave()) === 'cancel') return;
  send({ t: 'workspace.load', name });
}

/** Stop the open board's sessions and empty the canvas. Resolves once the engine has removed them. */
function clearBoard(): Promise<void> {
  const s = useApp.getState();
  const board = new Set(Object.keys(s.sessions));
  const live = [...board].filter((id) => !s.dormant[id]);
  const gone = untilRemoved(live);
  for (const id of live) send({ t: 'session.remove', id });
  const feeds = Object.fromEntries(Object.entries(s.feeds).filter(([id]) => !board.has(id)));
  s.set({ sessions: {}, dormant: {}, nodes: [], feeds, expanded: null });
  // Links and families are one list for the whole app: drop this board's, keep the background boards'.
  const inUse = new Set(Object.values(s.parked).map((x) => x.config.familyId));
  send({ t: 'links.set', links: s.links.filter((l) => !board.has(l.a) && !board.has(l.b)) });
  send({ t: 'families.set', families: s.families.filter((f) => inUse.has(f.id)) });
  return gone;
}

function untilRemoved(ids: string[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  const left = new Set(ids);
  return new Promise((resolve) => {
    const finish = () => {
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = onEngine((m) => {
      if (m.t === 'session.removed' && left.delete(m.id) && !left.size) finish();
    });
    // A session that reflects before it goes takes one model turn. Don't wait forever if the engine never answers.
    const timer = setTimeout(finish, 30_000);
  });
}

/** Start an empty workspace. The open board is saved first if it has a file, and you pick whether its running sessions keep going. */
export async function newWorkspace() {
  const s = useApp.getState();
  const n = Object.keys(s.sessions).length;
  // Nothing running, so leave() won't ask: still warn before a never-saved board with cards on it is lost.
  if (n && !running().length && !hasOwnFile(s.workspaceName, s.workspaces, s.workspaceId)) {
    if (!confirm(`Close ${n} session(s) and start an empty workspace? This board was never saved, so it is lost.`)) return;
  }
  if ((await leave()) === 'cancel') return;
  useApp.getState().set({ workspaceName: 'My workspace', workspaceId: newWorkspaceId() });
}

/** Delete a saved workspace and stop its sessions, whether it is open or running in the background. */
export function deleteWorkspace(name: string) {
  const s = useApp.getState();
  const open = isOpenWorkspace(name, s.workspaceName);
  const id = s.workspaces.find((w) => w.name === name)?.id;
  const background = !open && id ? Object.values(s.parked).filter((x) => x.config.workspace === id) : [];
  const n = open ? Object.keys(s.sessions).length : background.length;
  const ask = n ? `Delete "${name}" and stop its ${n} session(s)? This can't be undone.` : `Delete the saved workspace "${name}"? This can't be undone.`;
  if (!confirm(ask)) return;
  send({ t: 'workspace.delete', name });
  for (const x of background) send({ t: 'session.remove', id: x.id });
  if (!open) return;
  clearBoard();
  useApp.getState().set({ workspaceName: 'My workspace', workspaceId: newWorkspaceId() });
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
      // Also when the engine still runs sessions (the page was reloaded): the autosave knows which board was open,
      // so its sessions go back on the board and the other workspaces' stay in the background.
      send({ t: 'workspace.load', name: '__autosave' });
      send({ t: 'workspace.list' });
    }
    if (msg.t === 'workspace.data' && msg.data) {
      const w = msg.data as WorkspaceFile & { name?: string };
      if (w.version === 1) applyWorkspace(w, msg.name === '__autosave' ? w.name : msg.name);
    }
  });
}
