// Board actions shared by the canvas, the command palette and notifications.

import type { useReactFlow } from '@xyflow/react';
import type { SessionConfig } from '@engine/protocol';
import { useApp, type AppNode } from './store';
import { send } from './engine';
import { FAMILY_COLORS, uid } from './lib';

type Flow = ReturnType<typeof useReactFlow>;
type Pos = { x: number; y: number };

export const CARD_W = 280;
export const CARD_H = 150;

/** Middle of the visible canvas, in board coordinates. */
export const viewCenter = (rf: Flow): Pos => rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

export function openSetup(pos: Pos, familyId: string | null = null) {
  useApp.getState().set({ setup: { position: { x: pos.x - CARD_W / 2, y: pos.y - 40 }, familyId } });
}

export function newFamily(pos: Pos) {
  const st = useApp.getState();
  const fam = { id: uid('f'), name: `Family ${st.families.length + 1}`, color: FAMILY_COLORS[st.families.length % FAMILY_COLORS.length] };
  send({ t: 'families.set', families: [...st.families, fam] });
  const node: AppNode = { id: `fam-${fam.id}`, type: 'family', position: { x: pos.x - 300, y: pos.y - 200 }, data: { familyId: fam.id }, width: 640, height: 420, zIndex: -1 };
  st.set({ nodes: [node, ...st.nodes] });
}

export function newNote(pos: Pos) {
  const st = useApp.getState();
  st.set({ nodes: [...st.nodes, { id: uid('n'), type: 'note', position: { x: pos.x - 110, y: pos.y - 50 }, data: { text: '' } }] });
}

/** Company mode on: a coordinator session at the company root runs Crux onboarding and starts the teams. */
export function startCompany(root: string, pos: Pos) {
  const st = useApp.getState();
  const id = uid('s');
  const config: SessionConfig = {
    name: 'Coordinator',
    cwd: root,
    model: st.settings?.defaultModel ?? 'claude-sonnet-5-5',
    // The engine fills in the onboarding message.
    prompt: '',
    priority: 5,
    awareness: 'everyone',
    permission: 'ask',
    familyId: null,
    coordinator: true,
  };
  const node: AppNode = { id, type: 'session', position: { x: pos.x - CARD_W / 2, y: pos.y - CARD_H / 2 }, data: { sessionId: id } };
  st.set({ nodes: [...st.nodes, node], company: { root, coordinatorId: id } });
  send({ t: 'session.create', id, config });
}

/** Company mode off. Sessions and the company's files stay as they are. */
export function stopCompany() {
  useApp.getState().set({ company: null });
}

/** Put a session another one started (hub_spawn) in a row below its parent, in a frame for its family. */
export function placeSpawned(id: string, parentId: string) {
  const st = useApp.getState();
  if (st.nodes.some((n) => n.id === id)) return;
  const parent = st.nodes.find((n) => n.id === parentId);
  const siblings = st.links.filter((l) => l.a === parentId && l.b !== id).length;
  const base = parent?.position ?? { x: 0, y: 0 };
  const position = { x: base.x + siblings * (CARD_W + 120), y: base.y + CARD_H + 200 };
  const nodes: AppNode[] = [...st.nodes, { id, type: 'session', position, data: { sessionId: id } }];
  const familyId = st.sessions[id]?.config.familyId;
  if (familyId && !nodes.some((n) => n.type === 'family' && n.data.familyId === familyId)) {
    nodes.unshift({ id: `fam-${familyId}`, type: 'family', position: { x: position.x - 40, y: position.y - 64 }, data: { familyId }, width: CARD_W + 80, height: CARD_H + 104, zIndex: -1 });
  }
  st.set({ nodes });
}

/** Glide the camera to a session, select it, and optionally open its details. */
export function focusSession(rf: Flow, id: string, expand = false) {
  const n = rf.getNode(id);
  if (!n) return;
  const w = n.measured?.width ?? CARD_W;
  const h = n.measured?.height ?? CARD_H;
  const st = useApp.getState();
  st.set({
    expanded: null,
    nodes: st.nodes.map((x) => ((x.id === id) !== !!x.selected ? { ...x, selected: x.id === id } : x)),
  });
  const zoom = Math.min(1.25, Math.max(rf.getZoom(), 1));
  rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom, duration: 650 });
  if (expand) {
    setTimeout(() => {
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      useApp.getState().set({ expanded: id, expandFrom: el?.getBoundingClientRect() ?? null });
    }, 680);
  }
}

/** Ask the shell (which owns the camera) to focus a session. */
export function requestFocus(id: string, expand = false) {
  window.dispatchEvent(new CustomEvent('sinnect:focus-session', { detail: { id, expand } }));
}
