import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useReactFlow } from '@xyflow/react';
import { Check, ChevronLeft, ChevronRight, FileWarning, HelpCircle, ShieldQuestion, X } from 'lucide-react';
import type { PromptRequest } from '@engine/protocol';
import { isActive, useApp } from '../store';
import { send } from '../engine';
import { STATUS, money, shortPath } from '../lib';
import { UsagePanel } from './Usage';

const islandSpring = { type: 'spring' as const, stiffness: 380, damping: 30, mass: 0.8 };

/**
 * The dynamic island. Idle it's a small pill with a live summary. Click it and
 * it grows into the plan limits of everything connected. When any session
 * needs you, it drops down and grows into the question (that always wins).
 */
export function DynamicIsland() {
  const prompts = useApp((s) => s.prompts);
  const [index, setIndex] = useState(0);
  const current = prompts[Math.min(index, prompts.length - 1)];
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const expanded = !!current || open;

  // Opening asks the engine for fresh numbers (it throttles itself).
  useEffect(() => {
    if (open) send({ t: 'usage.check' });
  }, [open]);

  // Click anywhere else or press Escape to fold it back up.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  useEffect(() => {
    if (index >= prompts.length) setIndex(Math.max(0, prompts.length - 1));
  }, [prompts.length, index]);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center">
      <motion.div
        ref={box}
        layout
        transition={islandSpring}
        className="pointer-events-auto overflow-hidden bg-black text-white shadow-[0_18px_50px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.08]"
        style={{ borderRadius: expanded ? 30 : 22 }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {current ? (
            <motion.div
              key={current.requestId}
              initial={{ opacity: 0, y: -10, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
              transition={{ duration: 0.22 }}
              className="w-[min(520px,calc(100vw-32px))] p-4"
            >
              <PromptView prompt={current} index={index} total={prompts.length} onIndex={setIndex} />
            </motion.div>
          ) : open ? (
            <motion.div
              key="usage"
              initial={{ opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.target === e.currentTarget && setOpen(false)}
            >
              <UsagePanel />
            </motion.div>
          ) : (
            <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <button onClick={() => setOpen(true)} title="Plan limits" className="block cursor-pointer transition-opacity hover:opacity-90">
                <IdlePill />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

function IdlePill() {
  const sessions = useApp((s) => s.sessions);
  const conn = useApp((s) => s.conn);
  const mock = useApp((s) => s.settings?.mock);
  const parked = useApp((s) => s.parked);
  const list = Object.values(sessions);
  const working = list.filter(isActive).length;
  // Workspaces in the background keep running: say so, and count their cost too.
  const elsewhere = Object.values(parked).filter(isActive).length;
  const cost = [...list, ...Object.values(parked)].reduce((a, s) => a + s.costUsd, 0);
  return (
    <div className="flex h-9 items-center gap-2.5 px-4 text-[12px]">
      <span className={`h-2 w-2 rounded-full ${conn === 'open' ? (working ? 'bg-st-working' : 'bg-st-idle') : 'bg-st-error'}`} style={working ? { boxShadow: '0 0 10px var(--color-st-working)' } : {}} />
      {conn !== 'open' ? (
        <span className="text-white/70">Connecting to engine…</span>
      ) : list.length === 0 ? (
        <span className="text-white/70">Sinnect{mock ? ' · demo mode' : ''}</span>
      ) : (
        <>
          <span className="text-white/90">
            {working} of {list.length} working
          </span>
          {elsewhere > 0 && <span className="text-white/50">· {elsewhere} in other workspaces</span>}
          <span className="text-white/30">·</span>
          <span className="font-mono text-white/60">{money(cost)}</span>
          {mock && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10.5px] text-white/60">demo</span>}
        </>
      )}
    </div>
  );
}

function PromptView({ prompt, index, total, onIndex }: { prompt: PromptRequest; index: number; total: number; onIndex: (i: number) => void }) {
  const session = useApp((s) => s.sessions[prompt.sessionId] ?? s.parked[prompt.sessionId]);
  // A session of a workspace in the background still asks; say which workspace it's on.
  const away = useApp((s) => {
    const p = s.parked[prompt.sessionId];
    return p ? (s.workspaces.find((w) => w.id && w.id === p.config.workspace)?.name ?? 'another workspace') : null;
  });
  const rf = useReactFlow();
  const name = session?.config.name ?? 'Session';
  const color = session ? STATUS[session.status].color : '#fbbf24';

  const fly = () => {
    const n = rf.getNode(prompt.sessionId);
    if (n) rf.setCenter(n.position.x + 140, n.position.y + 75, { zoom: 1.1, duration: 600 });
  };

  const Icon = prompt.kind === 'tool' ? ShieldQuestion : prompt.kind === 'question' ? HelpCircle : FileWarning;

  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: `color-mix(in srgb, ${color} 22%, transparent)` }}>
          <Icon size={15} style={{ color }} />
        </div>
        <button onClick={fly} className="text-[13px] font-semibold hover:underline">
          {name}
        </button>
        <span className="text-[12px] text-white/45">{prompt.kind === 'tool' ? 'needs permission' : prompt.kind === 'question' ? 'has a question' : 'file conflict'}{away ? ` · in ${away}` : ''}</span>
        {total > 1 && (
          <div className="ml-auto flex items-center gap-1 text-[11.5px] text-white/50">
            <button disabled={index === 0} onClick={() => onIndex(index - 1)} className="rounded-full p-1 hover:bg-white/10 disabled:opacity-30">
              <ChevronLeft size={14} />
            </button>
            {index + 1} of {total}
            <button disabled={index >= total - 1} onClick={() => onIndex(index + 1)} className="rounded-full p-1 hover:bg-white/10 disabled:opacity-30">
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>
      {prompt.kind === 'tool' && <ToolPrompt prompt={prompt} />}
      {prompt.kind === 'question' && <QuestionPrompt prompt={prompt} />}
      {prompt.kind === 'negotiation' && <NegotiationPrompt prompt={prompt} />}
    </div>
  );
}

function Btn({ children, onClick, tone = 'plain', autoFocus }: { children: React.ReactNode; onClick: () => void; tone?: 'plain' | 'go' | 'no'; autoFocus?: boolean }) {
  const cls = tone === 'go' ? 'bg-white text-black hover:bg-white/90' : tone === 'no' ? 'bg-white/[0.08] text-white/80 hover:bg-[#f87171]/25 hover:text-white' : 'bg-white/[0.08] text-white/85 hover:bg-white/[0.14]';
  return (
    <motion.button autoFocus={autoFocus} whileTap={{ scale: 0.95 }} onClick={onClick} className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full px-4 text-[12.5px] font-medium transition-colors ${cls}`}>
      {children}
    </motion.button>
  );
}

function ToolPrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'tool' }> }) {
  const respond = (decision: 'allow' | 'deny' | 'always') => send({ t: 'prompt.respond', response: { requestId: prompt.requestId, kind: 'tool', decision } });
  return (
    <div>
      <div className="mb-2 text-[13.5px] leading-snug text-white/90">{prompt.title}</div>
      {prompt.detail && <pre className="selectable mb-3 max-h-40 overflow-auto rounded-2xl bg-white/[0.06] p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-white/75">{prompt.detail}</pre>}
      <div className="flex gap-2">
        <Btn tone="no" onClick={() => respond('deny')}>
          <X size={14} /> Deny
        </Btn>
        {prompt.canAlwaysAllow && <Btn onClick={() => respond('always')}>Always allow</Btn>}
        <Btn tone="go" autoFocus onClick={() => respond('allow')}>
          <Check size={14} /> Allow
        </Btn>
      </div>
    </div>
  );
}

function QuestionPrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'question' }> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const done = prompt.questions.every((q) => answers[q.question] || other[q.question]?.trim());
  const submit = () => {
    const out: Record<string, string> = {};
    for (const q of prompt.questions) out[q.question] = other[q.question]?.trim() || answers[q.question] || '';
    send({ t: 'prompt.respond', response: { requestId: prompt.requestId, kind: 'question', answers: out } });
  };
  const toggle = (q: string, label: string, multi?: boolean) =>
    setAnswers((a) => {
      if (!multi) return { ...a, [q]: label };
      const cur = new Set((a[q] || '').split(', ').filter(Boolean));
      cur.has(label) ? cur.delete(label) : cur.add(label);
      return { ...a, [q]: [...cur].join(', ') };
    });
  return (
    <div className="max-h-[60vh] overflow-y-auto">
      {prompt.questions.map((q) => (
        <div key={q.question} className="mb-3">
          <div className="mb-2 text-[13.5px] leading-snug text-white/90">{q.question}</div>
          <div className="flex flex-col gap-1.5">
            {q.options.map((o) => {
              const on = (answers[q.question] || '').split(', ').includes(o.label);
              return (
                <button key={o.label} onClick={() => toggle(q.question, o.label, q.multiSelect)} className={`rounded-2xl px-3.5 py-2 text-left text-[12.5px] transition ${on ? 'bg-white text-black' : 'bg-white/[0.07] text-white/85 hover:bg-white/[0.12]'}`}>
                  <div className="font-medium">{o.label}</div>
                  {o.description && <div className={`text-[11.5px] ${on ? 'text-black/60' : 'text-white/45'}`}>{o.description}</div>}
                </button>
              );
            })}
            <input value={other[q.question] ?? ''} onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))} placeholder="Or type your own answer" className="rounded-2xl bg-white/[0.05] px-3.5 py-2 text-[12.5px] text-white outline-none placeholder:text-white/35 focus:bg-white/[0.09]" />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Btn tone="no" onClick={() => send({ t: 'prompt.respond', response: { requestId: prompt.requestId, kind: 'question', answers: {}, skipped: true } })}>
          Skip
        </Btn>
        <Btn tone="go" onClick={() => done && submit()}>
          <Check size={14} /> Send answer
        </Btn>
      </div>
    </div>
  );
}

function NegotiationPrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'negotiation' }> }) {
  const sessions = useApp((s) => s.sessions);
  const parked = useApp((s) => s.parked);
  const a = sessions[prompt.sessionId] ?? parked[prompt.sessionId];
  const b = sessions[prompt.otherId] ?? parked[prompt.otherId];
  const pick = (winner: string) => send({ t: 'prompt.respond', response: { requestId: prompt.requestId, kind: 'negotiation', winner } });
  return (
    <div>
      <div className="mb-1 text-[13.5px] leading-snug text-white/90">
        Who gets <span className="font-mono text-[12.5px]">{shortPath(prompt.path)}</span> first?
      </div>
      <div className="mb-3 text-[12px] leading-relaxed text-white/50">{prompt.detail}</div>
      <div className="flex gap-2">
        <Btn onClick={() => pick(prompt.otherId)}>{b?.config.name ?? 'Holder'} (has it now)</Btn>
        <Btn tone="go" onClick={() => pick(prompt.sessionId)}>
          {a?.config.name ?? 'Requester'}
        </Btn>
      </div>
    </div>
  );
}
