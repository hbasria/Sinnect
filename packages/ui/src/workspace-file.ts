// Pure workspace helpers, kept free of store/engine imports so they can be unit tested.

import { safeName } from '@engine/protocol';

type Saved = { name: string; id?: string | null };

/** The board's name is kept as typed, but the list shows the file name, so compare through safeName. */
export const isOpenWorkspace = (listed: string, current: string) => safeName(current) === listed;

/**
 * True when the open board has a saved file of its own (not the hidden __autosave).
 * Autosave only writes __autosave, so leaving such a board must save it there first.
 * A file from before workspaces had ids counts as this board's; one with another id is another board.
 */
export function hasOwnFile(current: string, saved: Saved[], id?: string): boolean {
  return !current.startsWith('__') && saved.some((w) => isOpenWorkspace(w.name, current) && (!w.id || !id || w.id === id));
}

/** `base`, or `base 2`, `base 3`… so saving a board never overwrites another board's file. */
export function freeName(base: string, saved: Saved[]): string {
  const root = base.trim() || 'My workspace';
  const taken = new Set(saved.map((w) => w.name.toLowerCase()));
  let name = root;
  for (let i = 2; taken.has(safeName(name).toLowerCase()); i++) name = `${root} ${i}`;
  return name;
}
