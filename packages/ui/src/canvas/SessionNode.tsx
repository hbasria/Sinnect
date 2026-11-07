import { memo, useRef } from 'react';
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';
import { Cost } from '../components/Cost';
import { AnimatePresence, motion } from 'motion/react';
import NumberFlow from '@number-flow/react';
import { Eye, EyeOff, Users, FileLock2, MessageSquare, MessagesSquare, Play, ShieldCheck, ShieldAlert, SquareTerminal, Zap } from 'lucide-react';
import { openTerminal } from '../terminal';
import { isActive, totalTokens, useApp, type AppNode, type SessionNodeData } from '../store';
import { STATUS, modelLabel } from '../lib';
import { send } from '../engine';

const zoomSel = (s: { transform: [number, number, number] }) => s.transform[2];

function StatusRing({ status, size = 34 }: { status: keyof typeof STATUS; size?: number }) {
  const color = STATUS[status].color;
  const active = status === 'thinking' || status === 'working' || status === 'starting';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="absolute inset-0 rounded-full" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)` }} />
      {active ? (
        <svg className="spin-slow absolute inset-0" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="15.5" fill="none" stroke={color} strokeOpacity="0.25" strokeWidth="2.5" />
          <circle cx="18" cy="18" r="15.5" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray="30 100" />
        </svg>
      ) : (
        <svg className="absolute inset-0" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="15.5" fill="none" stroke={color} strokeWidth="2.5" strokeOpacity={status === 'stopped' ? 0.5 : 1} />
        </svg>
      )}
      <motion.div
        className="absolute rounded-full"
        style={{ inset: size * 0.33, background: color }}
        animate={status === 'waiting' ? { scale: [1, 1.35, 1] } : { scale: 1 }}
        transition={status === 'waiting' ? { repeat: Infinity, duration: 1.2 } : {}}
      />
    </div>
  );
}

export const SessionNode = memo(function SessionNode({ id, data, selected }: NodeProps<AppNode & { data: SessionNodeData }>) {
  const st = useApp((s) => s.sessions[data.sessionId]);
  const dormant = useApp((s) => !!s.dormant[data.sessionId]);
  const claims = useApp((s) => s.claims.filter((c) => c.sessionId === data.sessionId).length);
  const unread = useApp((s) => s.messages.filter((m) => m.to === data.sessionId && m.from !== 'hub' && Date.now() - m.ts < 60_000).length);
  const family = useApp((s) => s.families.find((f) => f.id === st?.config.familyId));
  // Select the stored object only: a fresh fallback object here would re-render forever.
  const known = useApp((s) => s.agents.find((a) => a.id === st?.config.agent));
  const agent = st?.config.agent ? known ?? { name: st.config.agent, emoji: '' } : null;
  const expanded = useApp((s) => s.expanded === data.sessionId);
  const zoom = useStore(zoomSel);
  const ref = useRef<HTMLDivElement>(null);

  if (!st) return null;
  const status = dormant ? 'stopped' : st.status;
  const color = STATUS[status].color;
  const active = isActive(st) && !dormant;

  const open = () => {
    const rect = ref.current?.getBoundingClientRect() ?? null;
    useApp.getState().set({ expanded: data.sessionId, expandFrom: rect });
  };

  const resume = (e: React.MouseEvent) => {
    e.stopPropagation();
    const cfg = { ...st.config, prompt: '', resumeId: st.sdkSessionId };
    useApp.setState((s) => {
      const d = { ...s.dormant };
      delete d[data.sessionId];
      return { dormant: d };
    });
    send({ t: 'session.create', id: data.sessionId, config: cfg });
  };

  // Far away: a simple glance card keeps big boards smooth and readable.
  if (zoom < 0.42) {
    return (
      <div ref={ref} onDoubleClick={open} className="flex items-center gap-4 rounded-[28px] border-2 px-6 py-5" style={{ width: 280, borderColor: color, background: '#212122' }}>
        <div className="h-10 w-10 shrink-0 rounded-full" style={{ background: color }} />
        <div className="truncate text-3xl font-semibold">{st.config.name}</div>
        <Handle id="in" type="target" position={Position.Left} />
        <Handle id="out" type="source" position={Position.Right} />
      </div>
    );
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.9, y: 8 }}
      animate={{ opacity: expanded ? 0.35 : 1, scale: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 28 }}
      onDoubleClick={open}
      className="group relative"
      style={{ width: 280 }}
    >
      {/* breathing glow while working */}
      {active && (
        <div className="breathe pointer-events-none absolute -inset-[6px] rounded-[22px]" style={{ boxShadow: `0 0 24px 2px color-mix(in srgb, ${color} 45%, transparent)` }} />
      )}
      <div
        className="relative overflow-hidden rounded-[18px] border bg-card transition-colors duration-200"
        style={{
          borderColor: selected ? '#ff6b4a' : status === 'waiting' ? color : 'var(--color-line)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        {family && <div className="absolute inset-x-0 top-0 h-[3px]" style={{ background: family.color }} />}
        <div className="flex items-center gap-3 px-4 pb-2 pt-4">
          <StatusRing status={status} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold leading-tight">{st.config.name}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
              <span style={{ color }}>{dormant ? 'Saved' : STATUS[status].label}</span>
              <span>·</span>
              <span className="whitespace-nowrap">{modelLabel(st.config.model)}</span>
              {agent && (
                <>
                  <span>·</span>
                  {/* The card name usually is the agent's name already, so the emoji is enough here. */}
                  <span className="min-w-0 truncate" title={`Crux agent: ${agent.name}`}>
                    {agent.emoji || agent.name}
                  </span>
                </>
              )}
            </div>
          </div>
          {/* Floats over the corner on hover, so the name keeps its full width the rest of the time. */}
          <div className="pointer-events-none absolute right-3 top-3.5 flex items-center gap-0.5 rounded-lg bg-card opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
            <button
              onClick={(e) => (e.stopPropagation(), openTerminal(st.config.cwd, st.config.name))}
              title={`Terminal in ${st.config.cwd}`}
              className="nodrag rounded-lg p-1.5 text-ink-2 hover:bg-card-hi hover:text-ink"
            >
              <SquareTerminal size={13} />
            </button>
            <button onClick={open} className="nodrag rounded-lg px-2 py-1 text-[11px] text-ink-2 hover:bg-card-hi hover:text-ink">
              Open
            </button>
          </div>
        </div>

        <div className="h-[38px] px-4">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={dormant ? 'dormant' : st.activity}
              initial={{ opacity: 0, y: 8, filter: 'blur(3px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -8, filter: 'blur(3px)' }}
              transition={{ duration: 0.28 }}
              className={`line-clamp-2 text-[12.5px] leading-[19px] ${active ? 'shimmer-text' : 'text-ink-2'}`}
            >
              {dormant ? st.goal || 'Saved session, resume to keep going' : st.goal && status === 'idle' ? st.goal : st.activity}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mt-2 flex items-center gap-3 border-t border-line/70 px-4 py-2.5 text-[11.5px] text-ink-2">
          <div className="flex items-center gap-1" title="Tokens used (input + output)">
            <Zap size={12} className="text-ink-3" />
            <NumberFlow value={totalTokens(st)} format={{ notation: 'compact', maximumFractionDigits: 1 }} className="font-mono tabular-nums" />
          </div>
          <Cost usd={st.costUsd} className="font-mono tabular-nums text-ink-3" />
          <div className="ml-auto flex items-center gap-2 text-ink-3">
            {claims > 0 && (
              <span className="flex items-center gap-0.5" title={`${claims} file(s) claimed`}>
                <FileLock2 size={12} />
                {claims}
              </span>
            )}
            <AnimatePresence>
              {unread > 0 && (
                <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} className="flex items-center gap-0.5 text-st-thinking" title="Recent messages">
                  <MessageSquare size={12} />
                  {unread}
                </motion.span>
              )}
            </AnimatePresence>
            {st.matrix && st.matrix.state !== 'off' && (
              <span
                className={st.matrix.state === 'online' ? 'text-st-idle' : st.matrix.state === 'error' ? 'text-st-error' : 'text-st-thinking'}
                title={st.matrix.state === 'online' ? `Matrix: listening as ${st.matrix.userId}` : `Matrix: ${st.matrix.error ?? st.matrix.state}`}
              >
                <MessagesSquare size={12} />
              </span>
            )}
            <span title={`Awareness: ${st.config.awareness}`}>
              {st.config.awareness === 'solo' ? <EyeOff size={12} /> : st.config.awareness === 'family' ? <Users size={12} /> : <Eye size={12} />}
            </span>
            <span title={`Permissions: ${st.config.permission}`}>
              {st.config.permission === 'ask' ? <ShieldCheck size={12} /> : <ShieldAlert size={12} className={st.config.permission === 'auto' ? 'text-st-blocked' : ''} />}
            </span>
            <span className="rounded-md bg-card-hi px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2" title="Priority">
              P{st.config.priority}
            </span>
          </div>
        </div>

        {dormant && (
          <button onClick={resume} className="nodrag flex w-full items-center justify-center gap-1.5 border-t border-line/70 py-2 text-[12px] font-medium text-st-idle transition hover:bg-card-hi">
            <Play size={12} /> Resume
          </button>
        )}
      </div>
      <Handle id="in" type="target" position={Position.Left} />
      <Handle id="out" type="source" position={Position.Right} />
      <span className="sr-only">{id}</span>
    </motion.div>
  );
});
