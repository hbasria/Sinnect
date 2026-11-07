import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Cost } from '../components/Cost';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import NumberFlow from '@number-flow/react';
import {
  ArrowUp,
  Brain,
  ChevronRight,
  CircleCheck,
  CircleStop,
  FileCode2,
  FileLock2,
  Hand,
  MessageSquare,
  MessagesSquare,
  SquareTerminal,
  Radio,
  TerminalSquare,
  Wrench,
  X,
  AlertTriangle,
  User,
} from 'lucide-react';
import type { FeedItem, SessionState } from '@engine/protocol';
import { isActive, useApp } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { send } from '../engine';
import { STATUS, compact, modelLabel, shortPath } from '../lib';
import { openTerminal } from '../terminal';

const EMPTY: FeedItem[] = [];
const MATRIX_DOT = { connecting: 'var(--color-st-thinking)', online: 'var(--color-st-idle)', error: 'var(--color-st-error)' } as const;

export function ExpandedSession() {
  const id = useApp((s) => s.expanded)!;
  const from = useApp((s) => s.expandFrom);
  const st = useApp((s) => s.sessions[id]);
  const feed = useApp((s) => s.feeds[id] ?? EMPTY);
  const [target, setTarget] = useState(() => targetRect());

  useEffect(() => {
    const onResize = () => setTarget(targetRect());
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!st) return null;
  const color = STATUS[st.status].color;
  const start = from ?? { left: target.left + target.width / 2 - 140, top: target.top + 40, width: 280, height: 150 };

  return (
    <>
      <motion.div className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} />
      <motion.div
        className="fixed z-30 flex overflow-hidden border border-line bg-panel shadow-[0_40px_120px_rgba(0,0,0,0.6)]"
        initial={{ left: start.left, top: start.top, width: start.width, height: start.height, borderRadius: 18, opacity: 0.6 }}
        animate={{ left: target.left, top: target.top, width: target.width, height: target.height, borderRadius: 24, opacity: 1 }}
        exit={{ left: start.left, top: start.top, width: start.width, height: start.height, borderRadius: 18, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 32, mass: 0.9 }}
      >
        <motion.div className="flex min-w-0 flex-1 flex-col" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.12 } }} exit={{ opacity: 0, transition: { duration: 0.08 } }}>
          <Header st={st} color={color} />
          <Feed feed={feed} active={isActive(st)} />
          <Composer st={st} />
        </motion.div>
        <motion.div className="hidden w-[300px] shrink-0 border-l border-line bg-[#1b1b1c] lg:block" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0, transition: { delay: 0.18 } }} exit={{ opacity: 0 }}>
          <Sidebar st={st} />
        </motion.div>
      </motion.div>
    </>
  );
}

function close() {
  useApp.getState().set({ expanded: null });
}

function targetRect() {
  const w = Math.min(1180, window.innerWidth - 48);
  const h = Math.min(820, window.innerHeight - 96);
  return { left: (window.innerWidth - w) / 2, top: Math.max(64, (window.innerHeight - h) / 2 + 20), width: w, height: h };
}

function Header({ st, color }: { st: SessionState; color: string }) {
  const family = useApp((s) => s.families.find((f) => f.id === st.config.familyId));
  return (
    <div className="flex items-center gap-3 border-b border-line px-5 py-4">
      <div className="h-3 w-3 rounded-full" style={{ background: color, boxShadow: `0 0 12px ${color}` }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate text-[16px] font-semibold">{st.config.name}</div>
          {family && (
            <span className="rounded-full px-2 py-0.5 text-[11px]" style={{ color: family.color, background: `color-mix(in srgb, ${family.color} 14%, transparent)` }}>
              {family.name}
            </span>
          )}
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={st.activity} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="truncate text-[12.5px] text-ink-3">
            {STATUS[st.status].label} · {st.activity}
          </motion.div>
        </AnimatePresence>
      </div>
      <button
        onClick={() => openTerminal(st.config.cwd, st.config.name)}
        title={`Open a terminal in ${st.config.cwd}`}
        className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-[12.5px] text-ink-2 hover:border-line-hi hover:text-ink"
      >
        <SquareTerminal size={14} /> Terminal
      </button>
      <button
        onClick={() => useApp.getState().set({ matrixFor: st.id })}
        title={st.matrix?.state === 'online' ? `Listening on Matrix as ${st.matrix.userId}` : 'Answer mentions in Matrix rooms'}
        className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-[12.5px] text-ink-2 hover:border-line-hi hover:text-ink"
      >
        <MessagesSquare size={14} />
        {st.config.matrix?.enabled ? 'Chat' : 'Enable chat'}
        {st.matrix && st.matrix.state !== 'off' && <span className="h-1.5 w-1.5 rounded-full" style={{ background: MATRIX_DOT[st.matrix.state] }} />}
      </button>
      {isActive(st) && (
        <button onClick={() => send({ t: 'session.interrupt', id: st.id })} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-[12.5px] text-ink-2 hover:border-st-waiting hover:text-st-waiting">
          <Hand size={14} /> Interrupt
        </button>
      )}
      {st.status !== 'stopped' && (
        <button onClick={() => send({ t: 'session.stop', id: st.id })} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-[12.5px] text-ink-2 hover:border-st-error hover:text-st-error">
          <CircleStop size={14} /> Stop
        </button>
      )}
      <button onClick={close} className="rounded-xl p-2 text-ink-3 hover:bg-card hover:text-ink">
        <X size={18} />
      </button>
    </div>
  );
}

function Feed({ feed, active }: { feed: FeedItem[]; active: boolean }) {
  const ref = useRef<VirtuosoHandle>(null);
  // Tool results are shown inside their tool row, not as separate lines.
  const { rows, results } = useMemo(() => {
    const results = new Map<string, FeedItem>();
    const rows: FeedItem[] = [];
    for (const f of feed) {
      if (f.kind === 'tool_result' && f.toolUseId) results.set(f.toolUseId, f);
      else if (f.kind !== 'text' || f.text.length > 0 || f === feed.at(-1)) rows.push(f);
    }
    return { rows, results };
  }, [feed]);

  if (rows.length === 0) {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-ink-3">Nothing here yet.</div>;
  }
  return (
    <Virtuoso
      ref={ref}
      className="selectable flex-1"
      data={rows}
      followOutput="smooth"
      initialTopMostItemIndex={rows.length - 1}
      increaseViewportBy={400}
      itemContent={(i, item) => <Row item={item} result={item.toolUseId ? results.get(item.toolUseId) : undefined} streaming={active && i === rows.length - 1 && (item.kind === 'text' || item.kind === 'thinking')} />}
      components={{ Footer: () => <div className="h-4" /> }}
    />
  );
}

const Row = memo(function Row({ item, result, streaming }: { item: FeedItem; result?: FeedItem; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const pad = 'px-6 py-1.5';
  switch (item.kind) {
    case 'user':
      return (
        <div className={`${pad} flex justify-end pt-4`}>
          <div className="flex max-w-[78%] items-start gap-2 rounded-[16px] rounded-tr-[6px] bg-accent-soft px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap">
            {item.text}
            <User size={13} className="mt-1 shrink-0 text-ink-3" />
          </div>
        </div>
      );
    case 'text':
      return (
        <div className={`${pad} pt-3`}>
          <div className={`max-w-[88%] text-[13.5px] leading-[1.65] text-ink ${streaming ? 'caret' : ''}`}>
            <Prose text={item.text} />
          </div>
        </div>
      );
    case 'thinking':
      return (
        <div className={pad}>
          <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink-2">
            <Brain size={13} className={streaming ? 'text-st-thinking' : ''} />
            <span className={streaming ? 'shimmer-text' : ''}>Thinking</span>
            <ChevronRight size={12} className={`transition ${open ? 'rotate-90' : ''}`} />
          </button>
          {open && <div className="mt-1 ml-5 border-l border-line pl-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-3 italic">{item.text}</div>}
        </div>
      );
    case 'tool': {
      const isHub = item.toolName?.startsWith('mcp__sinnect__');
      const Icon = item.toolName === 'Bash' ? TerminalSquare : isHub ? Radio : item.toolName && /Edit|Write|Read/.test(item.toolName) ? FileCode2 : Wrench;
      const done = !!result;
      return (
        <div className={pad}>
          <button onClick={() => setOpen(!open)} className={`group flex w-full max-w-[88%] items-center gap-2.5 rounded-[12px] border px-3 py-2 text-left text-[12.5px] transition ${open ? 'border-line-hi bg-card' : 'border-line/60 bg-card/40 hover:border-line hover:bg-card'}`}>
            <Icon size={14} className={isHub ? 'text-st-thinking' : 'text-ink-3'} />
            <span className="flex-1 truncate font-mono text-ink-2">{item.text}</span>
            {result?.isError ? <AlertTriangle size={13} className="text-st-error" /> : done ? <CircleCheck size={13} className="text-st-idle" /> : <span className="h-3 w-3 rounded-full border-2 border-st-working border-t-transparent spin-slow" />}
            <ChevronRight size={13} className={`text-ink-3 transition ${open ? 'rotate-90' : ''}`} />
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="max-w-[88%] overflow-hidden">
                <pre className="mt-1.5 max-h-72 overflow-auto rounded-[10px] bg-[#131313] p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
                  {item.input ? JSON.stringify(item.input, null, 2) : ''}
                  {result ? `\n\n→ ${result.text}` : ''}
                </pre>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      );
    }
    case 'hub':
      return (
        <div className={pad}>
          <div className="flex max-w-[88%] items-start gap-2 rounded-[12px] border border-st-thinking/30 bg-st-thinking/[0.07] px-3 py-2 text-[12.5px] leading-relaxed text-[#ffd9cf]">
            <MessageSquare size={13} className="mt-0.5 shrink-0 text-st-thinking" />
            <span>{item.text}</span>
          </div>
        </div>
      );
    case 'result':
      return (
        <div className={`${pad} flex items-center gap-2 py-3 text-[11.5px] text-ink-3`}>
          <div className="h-px flex-1 bg-line" />
          <CircleCheck size={12} className="text-st-idle" /> {item.text}
          <div className="h-px flex-1 bg-line" />
        </div>
      );
    case 'error':
      return (
        <div className={pad}>
          <div className="max-w-[88%] rounded-[12px] border border-st-error/40 bg-st-error/10 px-3 py-2 text-[12.5px] text-[#fecaca]">{item.text}</div>
        </div>
      );
    default:
      return <div className={`${pad} text-[12px] text-ink-3`}>{item.text}</div>;
  }
});

/** Claude's replies are markdown: headings, lists, tables, code. */
const MD_PLUGINS = [remarkGfm];
const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};
const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
});

function Composer({ st }: { st: SessionState }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const dead = st.status === 'stopped' || st.status === 'error';
  useEffect(() => ref.current?.focus(), []);
  const go = () => {
    const t = text.trim();
    if (!t || dead) return;
    send({ t: 'session.send', id: st.id, text: t });
    setText('');
  };
  return (
    <div className="border-t border-line p-4">
      <div className="flex items-end gap-2 rounded-[16px] border border-line bg-[#1a1a1a] p-2 pl-4 transition focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(255,107,74,0.15)]">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={dead}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px';
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              go();
            }
          }}
          placeholder={dead ? 'This session has ended' : isActive(st) ? 'Queue a message for when it finishes…' : `Message ${st.config.name}…`}
          className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-relaxed outline-none placeholder:text-ink-3"
        />
        <motion.button whileTap={{ scale: 0.9 }} onClick={go} disabled={!text.trim() || dead} className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-accent text-white transition disabled:bg-card-hi disabled:text-ink-3">
          <ArrowUp size={17} />
        </motion.button>
      </div>
    </div>
  );
}

function Sidebar({ st }: { st: SessionState }) {
  const claims = useApp(useShallow((s) => s.claims.filter((c) => c.sessionId === st.id)));
  const messages = useApp(useShallow((s) => s.messages.filter((m) => m.from === st.id || m.to === st.id).slice(-30)));
  const names = useApp((s) => s.sessions);
  const t = st.tokens;
  const update = (patch: Partial<SessionState['config']>) => send({ t: 'session.update', id: st.id, patch });

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5 text-[12.5px]">
      <Section title="Usage">
        <div className="mb-3 flex items-baseline gap-2">
          <NumberFlow value={t.input + t.output + t.cacheWrite} format={{ notation: 'compact', maximumFractionDigits: 1 }} className="font-mono text-[26px] font-semibold tabular-nums" />
          <span className="text-ink-3">tokens</span>
          <Cost usd={st.costUsd} className="ml-auto font-mono text-[14px] text-ink-2" />
        </div>
        <Stat label="Input" value={compact(t.input)} />
        <Stat label="Output" value={compact(t.output)} />
        <Stat label="Cache write" value={compact(t.cacheWrite)} />
        <Stat label="Cache read (cheap)" value={compact(t.cacheRead)} />
        <div className="mb-2 mt-1 rounded-lg bg-card-hi/60 px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-3">
          The first message is the big one: Claude Code's instructions and tool list (around 20k tokens) get saved to the cache once. After that each turn rereads them from the cache at a tenth of the price.
        </div>
        <Stat label="Turns" value={String(st.turns)} />
        <Stat label="Model" value={modelLabel(st.config.model)} />
      </Section>

      <Section title="Settings">
        <div className="mb-2 text-ink-3">Priority</div>
        <div className="mb-3 flex gap-1">
          {[1, 2, 3, 4, 5].map((p) => (
            <button key={p} onClick={() => update({ priority: p })} className={`h-7 flex-1 rounded-lg border text-[12px] transition ${st.config.priority === p ? 'border-accent bg-accent/25 text-ink' : 'border-line text-ink-3 hover:text-ink-2'}`}>
              {p}
            </button>
          ))}
        </div>
        <div className="mb-2 text-ink-3">Knows about</div>
        <select className="field mb-3 !py-1.5" value={st.config.awareness} onChange={(e) => update({ awareness: e.target.value as SessionState['config']['awareness'] })}>
          <option value="solo">Nobody</option>
          <option value="family">Its family + connections</option>
          <option value="everyone">Everyone</option>
        </select>
        <div className="mb-2 text-ink-3">Permissions</div>
        <select className="field mb-3 !py-1.5" value={st.config.permission} onChange={(e) => update({ permission: e.target.value as SessionState['config']['permission'] })}>
          <option value="ask">Ask me</option>
          <option value="acceptEdits">Auto edits</option>
          <option value="auto">Full auto</option>
        </select>
        <div className="text-[11px] leading-relaxed text-ink-3">Changes apply right away. A session started with "Nobody" only gets the hub tools after a restart.</div>
      </Section>

      <Section title={`Files it holds (${claims.length})`}>
        {claims.length === 0 ? <div className="text-ink-3">None right now</div> : claims.map((c) => <FileRow key={c.path} path={c.path} lock />)}
      </Section>

      <Section title={`Files touched (${st.filesTouched.length})`}>
        {st.filesTouched.length === 0 ? <div className="text-ink-3">None yet</div> : st.filesTouched.slice(-12).reverse().map((p) => <FileRow key={p} path={p} />)}
      </Section>

      <Section title="Messages">
        {messages.length === 0 ? (
          <div className="text-ink-3">No messages yet</div>
        ) : (
          messages
            .slice()
            .reverse()
            .map((m) => (
              <div key={m.id} className="mb-2 rounded-[10px] bg-card/60 p-2.5 leading-relaxed">
                <div className="mb-0.5 text-[11px] text-ink-3">
                  {m.from === 'hub' ? 'Hub' : names[m.from]?.config.name ?? m.from} → {names[m.to]?.config.name ?? m.to}
                </div>
                <div className="text-ink-2">{m.text}</div>
              </div>
            ))
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <div className="mb-2.5 text-[11px] font-semibold tracking-wider text-ink-3 uppercase">{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1 text-ink-2">
      <span className="text-ink-3">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function FileRow({ path, lock }: { path: string; lock?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-1 font-mono text-[11.5px] text-ink-2" title={path}>
      {lock ? <FileLock2 size={12} className="text-st-blocked" /> : <FileCode2 size={12} className="text-ink-3" />}
      <span className="truncate">{shortPath(path)}</span>
    </div>
  );
}
