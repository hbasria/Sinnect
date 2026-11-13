import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type NodeChange,
  type OnNodeDrag,
} from '@xyflow/react';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, Boxes, StickyNote } from 'lucide-react';
import { SessionNode } from './SessionNode';
import { FamilyNode, NoteNode } from './FamilyNode';
import { PulseEdge } from './PulseEdge';
import { WorkerEdge } from './WorkerEdge';
import { linkEdges, useApp, workerEdges, type AppNode } from '../store';
import { send } from '../engine';
import { STATUS, uid } from '../lib';
import { CARD_H, CARD_W, newFamily as addFamily, newNote as addNote, openSetup } from '../actions';

const nodeTypes = { session: SessionNode, family: FamilyNode, note: NoteNode };
const edgeTypes = { pulse: PulseEdge, worker: WorkerEdge };


export function Canvas() {
  const nodes = useApp((s) => s.nodes);
  const links = useApp((s) => s.links);
  const sessions = useApp((s) => s.sessions);
  // Only the boss/helper pairs matter for helper wires, so status ticks don't rebuild the edge list.
  const helperKey = Object.values(sessions)
    .filter((x) => x.config.parentId)
    .map((x) => `${x.id}>${x.config.parentId}`)
    .join(',');
  const nodeKey = nodes.map((n) => n.id).join(',');
  const edges = useMemo(() => {
    const ids = new Set(nodeKey.split(','));
    // The link list is shared by every workspace: draw only the ones between cards on this board.
    return [...linkEdges(links.filter((l) => ids.has(l.a) && ids.has(l.b))), ...workerEdges(useApp.getState().sessions, ids)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, helperKey, nodeKey]);
  const rf = useReactFlow();
  const [menu, setMenu] = useState<{ x: number; y: number; flow: { x: number; y: number }; familyId: string | null } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const onNodesChange = useCallback((changes: NodeChange<AppNode>[]) => {
    const st = useApp.getState();
    // Deleting a session node from the canvas stops and removes the session.
    for (const c of changes) {
      if (c.type === 'remove') {
        const n = st.nodes.find((x) => x.id === c.id);
        if (n?.type === 'session') {
          if (st.dormant[c.id]) {
            const sessions = { ...st.sessions };
            delete sessions[c.id];
            st.set({ sessions });
          } else send({ t: 'session.remove', id: c.id });
        }
        if (n?.type === 'family') {
          const fid = (n.data as { familyId: string }).familyId;
          for (const s of Object.values(st.sessions)) if (s.config.familyId === fid) send({ t: 'session.update', id: s.id, patch: { familyId: null } });
          send({ t: 'families.set', families: st.families.filter((f) => f.id !== fid) });
        }
      }
    }
    st.set({ nodes: applyNodeChanges(changes, st.nodes) });
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const st = useApp.getState();
    if (st.links.some((l) => (l.a === c.source && l.b === c.target) || (l.a === c.target && l.b === c.source))) return;
    send({ t: 'links.set', links: [...st.links, { id: uid('l'), a: c.source, b: c.target }] });
  }, []);

  // Dragging a family frame drags its members along.
  const onNodeDragStart: OnNodeDrag<AppNode> = useCallback((_e, node) => {
    dragStart.current = { ...node.position };
  }, []);
  const onNodeDrag: OnNodeDrag<AppNode> = useCallback((_e, node) => {
    if (node.type !== 'family' || !dragStart.current) return;
    const dx = node.position.x - dragStart.current.x;
    const dy = node.position.y - dragStart.current.y;
    if (!dx && !dy) return;
    dragStart.current = { ...node.position };
    const st = useApp.getState();
    const fid = (node.data as { familyId: string }).familyId;
    const members = new Set(Object.values(st.sessions).filter((s) => s.config.familyId === fid).map((s) => s.id));
    st.set({
      nodes: st.nodes.map((n) =>
        n.id === node.id ? { ...n, position: node.position } : members.has(n.id) && !n.selected ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
      ),
    });
  }, []);

  // Dropping a session inside a family frame joins it; dropping it outside leaves.
  const onNodeDragStop: OnNodeDrag<AppNode> = useCallback((_e, node, dragged) => {
    dragStart.current = null;
    const st = useApp.getState();
    const frames = st.nodes.filter((n) => n.type === 'family');
    for (const n of dragged ?? [node]) {
      if (n.type !== 'session') continue;
      const cx = n.position.x + CARD_W / 2;
      const cy = n.position.y + CARD_H / 2;
      const hit = frames.find((f) => {
        const w = f.width ?? (f.style?.width as number) ?? 600;
        const h = f.height ?? (f.style?.height as number) ?? 400;
        return cx > f.position.x && cx < f.position.x + w && cy > f.position.y && cy < f.position.y + h;
      });
      const fid = hit ? (hit.data as { familyId: string }).familyId : null;
      const s = st.sessions[n.id];
      if (s && (s.config.familyId ?? null) !== fid) {
        if (st.dormant[n.id]) st.set({ sessions: { ...st.sessions, [n.id]: { ...s, config: { ...s.config, familyId: fid } } } });
        else send({ t: 'session.update', id: n.id, patch: { familyId: fid } });
      }
    }
  }, []);

  const openMenu = useCallback(
    (e: React.MouseEvent | MouseEvent, familyId: string | null = null) => {
      e.preventDefault();
      const rect = wrap.current!.getBoundingClientRect();
      setMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }), familyId });
    },
    [rf],
  );
  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: AppNode) => {
      if (node.type === 'family') openMenu(e, (node.data as { familyId: string }).familyId);
      else e.preventDefault();
    },
    [openMenu],
  );

  const center = () => {
    const r = wrap.current!.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  };

  const newSession = (pos: { x: number; y: number }, familyId: string | null = null) => {
    setMenu(null);
    openSetup(pos, familyId);
  };
  const newFamily = (pos: { x: number; y: number }) => {
    setMenu(null);
    addFamily(pos);
  };
  const newNote = (pos: { x: number; y: number }) => {
    setMenu(null);
    addNote(pos);
  };

  // Tab opens the spawn card in the middle of the screen, like n8n.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,[contenteditable]')) return;
      const st = useApp.getState();
      if (st.setup || st.expanded || st.paletteOpen) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        newSession(center());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const empty = nodes.length === 0;

  return (
    <div ref={wrap} className="absolute inset-0" onClick={() => menu && setMenu(null)}>
      <ReactFlow<AppNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onPaneContextMenu={openMenu}
        onNodeContextMenu={onNodeContextMenu}
        onMoveEnd={(_e, viewport) => useApp.getState().set({ viewport })}
        onEdgesDelete={(del) => send({ t: 'links.set', links: useApp.getState().links.filter((l) => !del.some((d) => d.id === l.id)) })}
        defaultViewport={useApp.getState().viewport ?? { x: 0, y: 0, zoom: 1 }}
        minZoom={0.15}
        maxZoom={2}
        snapToGrid
        snapGrid={[20, 20]}
        onlyRenderVisibleElements
        deleteKeyCode={['Delete', 'Backspace']}
        selectionOnDrag
        panOnDrag={[1, 2]}
        panOnScroll={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="#38383b" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeBorderRadius={14}
          nodeColor={(n) => {
            if (n.type === 'family') return 'rgba(255,107,74,0.10)';
            if (n.type === 'note') return '#4a4320';
            const s = sessions[n.id];
            return s ? STATUS[s.status].color : '#444';
          }}
          maskColor="rgba(10,10,14,0.65)"
        />
      </ReactFlow>

      <AnimatePresence>
        {empty && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }} className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto flex flex-col items-center text-center">
              <motion.button
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => newSession(center())}
                className="mb-5 flex h-20 w-20 items-center justify-center rounded-[26px] border-2 border-dashed border-line-hi text-ink-2 transition-colors hover:border-st-thinking hover:text-st-thinking"
              >
                <Bot size={30} />
              </motion.button>
              <div className="text-[17px] font-semibold">Start your first session</div>
              <div className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-3">Click the button, press Tab, or right-click anywhere on the canvas. Drag between two sessions to connect them.</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {menu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.14 }}
            className="glass absolute z-50 w-56 origin-top-left overflow-hidden rounded-2xl border border-line p-1.5 shadow-2xl"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <MenuItem icon={<Bot size={15} />} label="New session" hint="Tab" onClick={() => newSession(menu.flow, menu.familyId)} />
            {!menu.familyId && <MenuItem icon={<Boxes size={15} />} label="New family" onClick={() => newFamily(menu.flow)} />}
            <MenuItem icon={<StickyNote size={15} />} label="Sticky note" onClick={() => newNote(menu.flow)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-ink transition hover:bg-white/[0.06]">
      <span className="text-ink-2">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <kbd className="rounded-md border border-line px-1.5 font-mono text-[10.5px] text-ink-3">{hint}</kbd>}
    </button>
  );
}
