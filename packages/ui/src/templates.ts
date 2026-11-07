// Session templates: saved new-session setups. The engine stores them; this file turns them into sessions.

import type { SessionConfig, SessionTemplate } from '@engine/protocol';
import { useApp, type AppNode } from './store';
import { send } from './engine';
import { CARD_H, CARD_W } from './actions';
import { uid } from './lib';
import { renamedFamilyTemplates, templateFamily } from './template-family';

export { templateFamily };

export const LAST_SETUP = 'sinnect.lastSetup';

export function loadLastSetup(): Partial<SessionConfig> {
  try {
    return JSON.parse(localStorage.getItem(LAST_SETUP) || '{}');
  } catch {
    return {};
  }
}

export function rememberSetup(c: Pick<SessionConfig, 'cwd' | 'model' | 'awareness' | 'permission' | 'agent'>) {
  localStorage.setItem(LAST_SETUP, JSON.stringify({ cwd: c.cwd, model: c.model, awareness: c.awareness, permission: c.permission, agent: c.agent ?? null }));
}

/** Template spawns only remember the folder, never the template's model or permissions as new defaults. */
export function rememberFolder(cwd: string) {
  localStorage.setItem(LAST_SETUP, JSON.stringify({ ...loadLastSetup(), cwd }));
}

/** "Reviewer", then "Reviewer 2", "Reviewer 3"... so cards stay tellable apart. */
export function freshName(base: string) {
  const taken = new Set(Object.values(useApp.getState().sessions).map((s) => s.config.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Don't drop a card exactly on top of another one. */
function freePosition(p: { x: number; y: number }) {
  const nodes = useApp.getState().nodes.filter((n) => n.type === 'session');
  let pos = p;
  for (let i = 0; i < 12 && nodes.some((n) => Math.abs(n.position.x - pos.x) < 24 && Math.abs(n.position.y - pos.y) < 24); i++) {
    pos = { x: pos.x + 32, y: pos.y + 32 };
  }
  return pos;
}

/**
 * Start a session from a template, centred on `center` (board coords).
 * Folder: the one given, else the last used one. No folder at all = open the setup card prefilled instead.
 * `confirmAuto`: a Full auto template also opens the card first, so it never runs unseen.
 * Returns the new session id, or null when it opened the card.
 */
export function spawnFromTemplate(t: SessionTemplate, center: { x: number; y: number }, folder?: string, opts: { confirmAuto?: boolean } = {}): string | null {
  const st = useApp.getState();
  const cwd = (folder?.trim() || loadLastSetup().cwd?.trim() || (st.settings?.mock ? '/demo/project' : '')).trim();
  if (!cwd || (opts.confirmAuto && t.permission === 'auto')) {
    st.set({ setup: { position: { x: center.x - CARD_W / 2, y: center.y - CARD_H / 2 }, familyId: templateFamily(t, st.families), template: t } });
    return null;
  }
  const id = uid('s');
  const config: SessionConfig = {
    name: freshName(t.name.trim() || 'Session'),
    cwd,
    model: t.model,
    prompt: t.prompt,
    priority: t.priority,
    awareness: t.awareness,
    permission: t.permission,
    familyId: templateFamily(t, st.families),
    agent: t.agent ?? null,
  };
  rememberFolder(cwd);
  const node: AppNode = { id, type: 'session', position: freePosition({ x: center.x - CARD_W / 2, y: center.y - CARD_H / 2 }), data: { sessionId: id } };
  st.set({ nodes: [...st.nodes, node], setup: null });
  send({ t: 'session.create', id, config });
  return id;
}

export function saveTemplate(t: SessionTemplate) {
  // Optimistic: the engine answers with the full list, which replaces this.
  const st = useApp.getState();
  const i = st.templates.findIndex((x) => x.id === t.id);
  st.set({ templates: i >= 0 ? st.templates.map((x) => (x.id === t.id ? t : x)) : [...st.templates, t] });
  send({ t: 'template.save', template: t });
}

export function deleteTemplate(id: string) {
  const st = useApp.getState();
  st.set({ templates: st.templates.filter((x) => x.id !== id) });
  send({ t: 'template.delete', id });
}

/** Keep templates' stored family name in step when a family is renamed, so the name fallback keeps working. */
export function syncTemplateFamilyName(familyId: string, name: string) {
  for (const t of renamedFamilyTemplates(useApp.getState().templates, familyId, name)) saveTemplate(t);
}
