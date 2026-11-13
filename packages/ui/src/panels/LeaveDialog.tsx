import { useEffect } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { Layers, Play, Square } from 'lucide-react';

export type LeaveChoice = 'keep' | 'stop' | 'cancel';

interface Ask {
  /** The board being left, as shown on screen. */
  name: string;
  running: number;
  /** Has a file of its own. If not, "Keep running" saves it as `saveAs` first. */
  saved: boolean;
  saveAs: string;
  resolve: (c: LeaveChoice) => void;
}

const useLeave = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** Ask what happens to the running sessions of the board you're leaving. */
export function askLeave(opts: Omit<Ask, 'resolve'>): Promise<LeaveChoice> {
  useLeave.getState().ask?.resolve('cancel');
  return new Promise((resolve) => useLeave.setState({ ask: { ...opts, resolve } }));
}

export function LeaveDialog() {
  const ask = useLeave((s) => s.ask);
  const pick = (c: LeaveChoice) => {
    // A dialog that is still fading out keeps its old question: it must not answer (or close) the new one.
    if (!ask || useLeave.getState().ask !== ask) return;
    ask.resolve(c);
    useLeave.setState({ ask: null });
  };

  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      pick('cancel');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  const n = ask?.running ?? 0;
  const sessions = `${n} session${n === 1 ? '' : 's'}`;

  return (
    <AnimatePresence>
      {ask && (
        <motion.div className="fixed inset-0 z-[70] flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[3px]" onClick={() => pick('cancel')} />
          <motion.div
            role="dialog"
            aria-label={`Leave ${ask.name}`}
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="relative w-[400px] max-w-full rounded-[22px] border border-line bg-panel/95 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl"
          >
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent/15 text-accent">
                <Layers size={16} />
              </div>
              <div className="min-w-0 truncate text-[15px] font-semibold">Leave “{ask.name}”?</div>
            </div>
            <div className="mb-4 text-[12.5px] text-ink-3">{sessions} on this board {n === 1 ? 'is' : 'are'} still working.</div>
            <div className="flex flex-col gap-2">
              <motion.button
                autoFocus
                whileTap={{ scale: 0.98 }}
                onClick={() => pick('keep')}
                className="group flex items-start gap-3 rounded-[14px] border border-accent/40 bg-accent/10 px-3.5 py-3 text-left transition hover:border-accent hover:bg-accent/15"
              >
                <Play size={15} className="mt-0.5 shrink-0 text-accent" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-ink">Keep running</span>
                  <span className="block text-[11.5px] leading-relaxed text-ink-3">
                    {ask.saved ? `They keep working in the background. Open “${ask.name}” again to see them live.` : `They keep working in the background. The board is saved as “${ask.saveAs}” so you can come back to it.`}
                  </span>
                </span>
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={() => pick('stop')}
                className="flex items-start gap-3 rounded-[14px] border border-line px-3.5 py-3 text-left transition hover:border-line-hi hover:bg-card-hi"
              >
                <Square size={14} className="mt-0.5 shrink-0 text-ink-2" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-ink">Stop them</span>
                  <span className="block text-[11.5px] leading-relaxed text-ink-3">
                    {ask.saved ? `They come back with Resume when you open “${ask.name}” again.` : 'This board was never saved, so it is lost.'}
                  </span>
                </span>
              </motion.button>
            </div>
            <div className="mt-3 flex justify-end">
              <button onClick={() => pick('cancel')} className="rounded-[10px] px-3 py-1.5 text-[12.5px] text-ink-3 transition hover:bg-card-hi hover:text-ink">
                Cancel
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
