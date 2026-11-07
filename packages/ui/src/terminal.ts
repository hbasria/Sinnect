// Terminal output and the actions behind the terminal panel. Output stays out of
// the store: a busy shell sends many chunks and only the visible xterm needs them.

import { useApp, type TermTab } from './store';
import { onEngine, send } from './engine';
import { uid } from './lib';
import { loadLastSetup } from './templates';

const MAX_BUFFER = 200_000;

interface Sink {
  data(chunk: string): void;
  /** The engine sent the whole recent output again (after a reconnect): redraw from it. */
  reset(all: string): void;
}

// Kept on the window, not in this module: a hot reload loads a second copy of the module
// while the first keeps running, and two copies each handling output printed everything twice.
// A new copy shares the buffers and replaces the old copy's listener.
type Shared = { buffers: Map<string, string>; sinks: Map<string, Set<Sink>>; stop: (() => void) | null };
const shared: Shared = ((window as { __sinnectTerminals?: Shared }).__sinnectTerminals ??= { buffers: new Map(), sinks: new Map(), stop: null });
const { buffers, sinks } = shared;
shared.stop?.();
shared.stop = onEngine((m) => {
  if (m.t === 'ready') {
    for (const t of m.snapshot.terminals ?? []) {
      buffers.set(t.id, t.buffer);
      sinks.get(t.id)?.forEach((s) => s.reset(t.buffer));
    }
  } else if (m.t === 'term.data') {
    buffers.set(m.id, ((buffers.get(m.id) ?? '') + m.data).slice(-MAX_BUFFER));
    sinks.get(m.id)?.forEach((s) => s.data(m.data));
  } else if (m.t === 'term.closed') {
    buffers.delete(m.id);
  }
});

export const bufferOf = (id: string) => buffers.get(id) ?? '';

export function subscribe(id: string, sink: Sink) {
  const set = sinks.get(id) ?? new Set();
  set.add(sink);
  sinks.set(id, set);
  return () => void set.delete(sink);
}

/** Where a new terminal opens when nothing more specific is known. */
export function defaultFolder() {
  return useApp.getState().company?.root || loadLastSetup().cwd || '~';
}

const titleOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

/** Add a tab and show it. The shell starts once its view knows how big it is. */
export function openTerminal(cwd = defaultFolder(), title?: string) {
  const st = useApp.getState();
  const tab: TermTab = { id: uid('t'), cwd, title: title || titleOf(cwd), status: 'dormant' };
  st.set({ terminals: [...st.terminals, tab], termActive: tab.id, termOpen: true, expanded: null });
}

export function startTerminal(tab: TermTab, cols: number, rows: number) {
  send({ t: 'term.open', id: tab.id, cwd: tab.cwd, cols, rows, title: tab.title });
}

export function closeTerminal(id: string) {
  const st = useApp.getState();
  send({ t: 'term.close', id });
  buffers.delete(id);
  const terminals = st.terminals.filter((t) => t.id !== id);
  st.set({ terminals, termActive: st.termActive === id ? (terminals.at(-1)?.id ?? null) : st.termActive });
}

/** A fresh shell in the same tab. New id, so the old shell's output and exit never mix in. */
export function restartTerminal(id: string) {
  const st = useApp.getState();
  const old = st.terminals.find((t) => t.id === id);
  if (!old) return;
  send({ t: 'term.close', id });
  buffers.delete(id);
  const tab: TermTab = { id: uid('t'), cwd: old.cwd, title: old.title, status: 'dormant' };
  st.set({ terminals: st.terminals.map((t) => (t.id === id ? tab : t)), termActive: tab.id });
}

/** Ctrl+` and the toolbar button: show or hide the panel; showing it with no tabs opens one. */
export function toggleTerminals() {
  const st = useApp.getState();
  if (st.termOpen) return st.set({ termOpen: false });
  if (!st.terminals.length) return openTerminal();
  st.set({ termOpen: true, termActive: st.termActive ?? st.terminals[0].id });
}

/** Workspace switch or reset: end every shell and drop the tabs. */
export function closeAllTerminals() {
  const st = useApp.getState();
  for (const t of st.terminals) send({ t: 'term.close', id: t.id });
  buffers.clear();
  st.set({ terminals: [], termActive: null, termOpen: false });
}
