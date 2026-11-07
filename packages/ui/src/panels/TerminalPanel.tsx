import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useApp, type TermTab } from '../store';
import { send } from '../engine';
import { spring } from '../lib';
import { bufferOf, closeTerminal, openTerminal, restartTerminal, startTerminal, subscribe } from '../terminal';

const HEIGHT_KEY = 'sinnect.termHeight';
const MIN_H = 140;

function savedHeight() {
  try {
    return Number(localStorage.getItem(HEIGHT_KEY)) || 300;
  } catch {
    return 300;
  }
}

export function TerminalPanel() {
  const open = useApp((s) => s.termOpen);
  const tabs = useApp((s) => s.terminals);
  const active = useApp((s) => s.termActive);
  const unavailable = useApp((s) => s.terminalsUnavailable);
  const [height, setHeight] = useState(savedHeight);
  const tab = tabs.find((t) => t.id === active);

  // Drag the top edge to resize; remembered for next time.
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let h = startH;
    const move = (ev: PointerEvent) => {
      h = Math.min(window.innerHeight * 0.85, Math.max(MIN_H, startH + startY - ev.clientY));
      setHeight(h);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(Math.round(h)));
      } catch {
        /* private window */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          transition={spring}
          style={{ height }}
          className="glass fixed bottom-3 left-4 right-4 z-20 flex flex-col overflow-hidden rounded-2xl border border-line shadow-2xl"
        >
          <div onPointerDown={drag} className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-ns-resize" title="Drag to resize" />
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {tabs.map((t) => (
                <div
                  key={t.id}
                  title={t.cwd}
                  className={`group flex h-7 shrink-0 items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-[12px] transition ${t.id === active ? 'bg-card-hi text-ink' : 'text-ink-3 hover:bg-white/[0.04] hover:text-ink-2'}`}
                >
                  <button onClick={() => useApp.getState().set({ termActive: t.id })} className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${t.status === 'running' ? 'bg-st-idle' : t.status === 'exited' ? 'bg-st-error' : 'bg-ink-3'}`} />
                    <span className="max-w-[160px] truncate">{t.title}</span>
                  </button>
                  <button onClick={() => closeTerminal(t.id)} title="Close terminal" className="flex h-5 w-5 items-center justify-center rounded text-ink-3 opacity-60 hover:bg-white/[0.08] hover:text-ink group-hover:opacity-100">
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button onClick={() => openTerminal()} title="New terminal" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-white/[0.06] hover:text-ink">
                <Plus size={14} />
              </button>
            </div>
            {tab && <div className="hidden max-w-[40%] truncate font-mono text-[11px] text-ink-3 sm:block">{tab.cwd}</div>}
            <button onClick={() => useApp.getState().set({ termOpen: false })} title="Hide (Ctrl+`)" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-white/[0.06] hover:text-ink">
              <ChevronDown size={15} />
            </button>
          </div>
          <div className="relative min-h-0 flex-1">
            {unavailable ? (
              <Empty text={unavailable} />
            ) : tab ? (
              <TermView key={tab.id} tab={tab} />
            ) : (
              <Empty text="No terminals open." action={() => openTerminal()} />
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Empty({ text, action }: { text: string; action?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-[12.5px] text-ink-3">
      <SquareTerminal size={22} />
      <div className="max-w-[480px] text-center">{text}</div>
      {action && (
        <button onClick={action} className="rounded-[10px] bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-accent-hi">
          New terminal
        </button>
      )}
    </div>
  );
}

const THEME = {
  background: '#1a1a1a',
  foreground: '#ededec',
  cursor: '#ff6b4a',
  cursorAccent: '#1a1a1a',
  selectionBackground: 'rgba(255, 107, 74, 0.3)',
};

function TermView({ tab }: { tab: TermTab }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Geist Mono Variable", ui-monospace, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el.current!);
    let size = '';
    const sync = () => {
      try {
        fit.fit();
      } catch {
        return; // not laid out yet
      }
      const next = `${term.cols}x${term.rows}`;
      if (next === size) return;
      size = next;
      // Sent even before the shell runs: messages arrive in order, so it lands after term.open.
      send({ t: 'term.resize', id: tab.id, cols: term.cols, rows: term.rows });
    };
    sync();
    term.write(bufferOf(tab.id));
    const unsub = subscribe(tab.id, { data: (d) => term.write(d), reset: (all) => (term.reset(), term.write(all)) });
    const input = term.onData((data) => send({ t: 'term.input', id: tab.id, data }));
    const ro = new ResizeObserver(sync);
    ro.observe(el.current!);
    // The mono font may load after the first measure; measure again once it has.
    void document.fonts?.ready.then(sync);
    if (tab.status === 'dormant') startTerminal(tab, term.cols, term.rows);
    term.focus();
    return () => {
      ro.disconnect();
      input.dispose();
      unsub();
      term.dispose();
    };
    // One xterm per tab id; status changes don't need a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  return (
    <div className="absolute inset-0 bg-field">
      <div ref={el} className="absolute inset-x-3 bottom-1 top-2" />
      {tab.status === 'exited' && (
        <div className="absolute bottom-3 right-4 flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-1.5 text-[12px] text-ink-2 shadow-lg">
          Exited{tab.exitCode !== undefined ? ` (code ${tab.exitCode})` : ''}
          <button onClick={() => restartTerminal(tab.id)} className="flex items-center gap-1 rounded-lg px-2 py-0.5 text-ink hover:bg-white/[0.06]">
            <RotateCcw size={12} /> Restart
          </button>
        </div>
      )}
    </div>
  );
}
