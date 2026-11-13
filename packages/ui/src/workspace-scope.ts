// Several workspaces can be live at once: the engine runs every session, the board shows one workspace.
// Running sessions of the others are "parked": still working, kept out of `sessions` so the board,
// palette and panels only see the open workspace. Pure helpers, kept free of store/engine imports
// so they can be unit tested.

import type { Family, Link, SessionState } from '@engine/protocol';

/** A session without a workspace comes from before workspaces had ids: it belongs to the open one. */
export function onBoard(st: SessionState, workspaceId: string): boolean {
  const w = st.config.workspace ?? null;
  return w === null || w === workspaceId;
}

/** Split sessions into the open workspace's and the parked rest. */
export function splitSessions(all: Iterable<SessionState>, workspaceId: string) {
  const sessions: Record<string, SessionState> = {};
  const parked: Record<string, SessionState> = {};
  for (const st of all) (onBoard(st, workspaceId) ? sessions : parked)[st.id] = st;
  return { sessions, parked };
}

/** Links are one list for the whole app: a board being opened adds its own and never drops another board's. */
export function mergeLinks(live: Link[], saved: Link[]): Link[] {
  const key = (l: Link) => [l.a, l.b].sort().join('|');
  const seen = new Set(live.map(key));
  return [...live, ...saved.filter((l) => !seen.has(key(l)) && (seen.add(key(l)), true))];
}

/** Families likewise: the saved ones are added, the ones in use elsewhere stay. */
export function mergeFamilies(live: Family[], saved: Family[]): Family[] {
  const ids = new Set(live.map((f) => f.id));
  return [...live, ...saved.filter((f) => !ids.has(f.id))];
}

/** Running sessions per workspace id, for the Workspaces list. */
export function liveByWorkspace(parked: Record<string, SessionState>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const st of Object.values(parked)) {
    const w = st.config.workspace;
    if (w && st.status !== 'stopped') out[w] = (out[w] ?? 0) + 1;
  }
  return out;
}
