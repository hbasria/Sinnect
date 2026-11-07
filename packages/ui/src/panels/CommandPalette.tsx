import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useReactFlow } from '@xyflow/react';
import { toast } from 'sonner';
import { Bell, BellOff, Bot, Boxes, CornerDownLeft, Download, FolderOpen, KeyRound, Layers, Maximize, Save, Search, Settings as Gear, SquareTerminal, StickyNote, User } from 'lucide-react';
import type { SessionState } from '@engine/protocol';
import { isActive, totalTokens, useApp } from '../store';
import { send } from '../engine';
import { STATUS, compact, modelLabel, shortPath } from '../lib';
import { focusSession, newFamily, newNote, openSetup, viewCenter } from '../actions';
import { loadWorkspace, saveWorkspace } from '../workspace';
import { checkForUpdate } from '../updater';
import { openTerminal, toggleTerminals } from '../terminal';
import { spawnFromTemplate, templateFamily } from '../templates';

type Group = 'Sessions' | 'Templates' | 'Actions' | 'Workspaces' | 'Settings';
const GROUPS: Group[] = ['Sessions', 'Templates', 'Actions', 'Workspaces', 'Settings'];
const PERM_SHORT = { ask: 'Ask me', acceptEdits: 'Auto edits', auto: 'Full auto' } as const;

interface Item {
  key: string;
  group: Group;
  label: string;
  sub?: string;
  words?: string;
  icon: React.ReactNode;
  hint?: string;
  right?: React.ReactNode;
  /** `mod` is true for Ctrl+Enter / Ctrl+click. */
  run: (mod: boolean) => void;
}

/** Quick fuzzy match: substring hits rank highest, then letters in order. -1 = no match. */
function score(q: string, text: string) {
  if (!q) return 1;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at + (at === 0 || t[at - 1] === ' ' ? 300 : 0);
  let i = 0;
  let run = 0;
  let s = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      i++;
      run++;
      s += 10 + run * 5 + (j === 0 || t[j - 1] === ' ' ? 15 : 0);
    } else run = 0;
  }
  return i === q.length ? s : -1;
}

const ORDER: Record<string, number> = { waiting: 0, blocked: 1, thinking: 2, working: 2, starting: 3, error: 4, idle: 5, stopped: 6 };

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  return <AnimatePresence>{open && <Palette />}</AnimatePresence>;
}

function Palette() {
  const rf = useReactFlow();
  const sessions = useApp((s) => s.sessions);
  const dormant = useApp((s) => s.dormant);
  const families = useApp((s) => s.families);
  const settings = useApp((s) => s.settings);
  const workspaces = useApp((s) => s.workspaces);
  const workspaceName = useApp((s) => s.workspaceName);
  const templates = useApp((s) => s.templates);
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const [pointer, setPointer] = useState(false);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const close = () => useApp.getState().set({ paletteOpen: false });
  const after = (fn: () => void) => () => {
    close();
    fn();
  };

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    const fam = (id?: string | null) => families.find((f) => f.id === id);

    const ss = (Object.values(sessions) as SessionState[]).slice().sort((a, b) => {
      const sa = dormant[a.id] ? 7 : ORDER[a.status] ?? 6;
      const sb = dormant[b.id] ? 7 : ORDER[b.status] ?? 6;
      return sa - sb || b.startedAt - a.startedAt;
    });
    for (const st of ss) {
      const f = fam(st.config.familyId);
      const status = dormant[st.id] ? 'stopped' : st.status;
      const color = STATUS[status].color;
      const live = isActive(st) && !dormant[st.id];
      list.push({
        key: `s:${st.id}`,
        group: 'Sessions',
        label: st.config.name,
        sub: dormant[st.id] ? `Saved · ${shortPath(st.config.cwd)}` : st.goal || st.activity || STATUS[status].label,
        words: `${f?.name ?? ''} ${st.config.cwd} ${STATUS[status].label} ${st.goal}`,
        icon: (
          <span className="relative flex h-2.5 w-2.5">
            {live && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: color }} />}
            <span className="relative h-2.5 w-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
          </span>
        ),
        right: (
          <span className="flex items-center gap-2">
            {f && (
              <span className="rounded-full px-2 py-0.5 text-[10.5px]" style={{ background: `color-mix(in srgb, ${f.color} 16%, transparent)`, color: f.color }}>
                {f.name}
              </span>
            )}
            <span className="font-mono text-[11px] text-ink-3">{compact(totalTokens(st))}</span>
          </span>
        ),
        run: (mod) => (close(), focusSession(rf, st.id, mod)),
      });
    }

    for (const t of templates) {
      const f = fam(templateFamily(t, families));
      list.push({
        key: `t:${t.id}`,
        group: 'Templates',
        label: t.name,
        sub: t.prompt || `${modelLabel(t.model)} · Priority ${t.priority} · ${PERM_SHORT[t.permission]}`,
        words: `template spawn start ${modelLabel(t.model)} ${f?.name ?? t.familyName ?? ''}`,
        icon: <Layers size={15} />,
        right: (
          <span className="flex items-center gap-2">
            {f && (
              <span className="rounded-full px-2 py-0.5 text-[10.5px]" style={{ background: `color-mix(in srgb, ${f.color} 16%, transparent)`, color: f.color }}>
                {f.name}
              </span>
            )}
            <span className="font-mono text-[11px] text-ink-3">{modelLabel(t.model).split(' ')[0]}</span>
          </span>
        ),
        run: after(() => spawnFromTemplate(t, viewCenter(rf), undefined, { confirmAuto: true })),
      });
    }

    list.push(
      { key: 'a:new', group: 'Actions', label: 'New session', words: 'spawn start create add claude', icon: <Bot size={15} />, hint: 'Tab', run: after(() => openSetup(viewCenter(rf))) },
      { key: 'a:family', group: 'Actions', label: 'New family', words: 'group frame topic', icon: <Boxes size={15} />, run: after(() => newFamily(viewCenter(rf))) },
      { key: 'a:term', group: 'Actions', label: 'New terminal', words: 'shell console bash zsh command line', icon: <SquareTerminal size={15} />, run: after(() => openTerminal()) },
      { key: 'a:termtoggle', group: 'Actions', label: 'Show or hide terminals', words: 'shell console panel', icon: <SquareTerminal size={15} />, hint: 'Ctrl `', run: after(toggleTerminals) },
      { key: 'a:note', group: 'Actions', label: 'Sticky note', words: 'note text comment', icon: <StickyNote size={15} />, run: after(() => newNote(viewCenter(rf))) },
      { key: 'a:fit', group: 'Actions', label: 'Show the whole board', words: 'fit view zoom out overview', icon: <Maximize size={15} />, run: after(() => rf.fitView({ padding: 0.25, duration: 600 })) },
      {
        key: 'a:save',
        group: 'Actions',
        label: 'Save workspace',
        sub: workspaceName,
        icon: <Save size={15} />,
        run: after(() => (saveWorkspace(workspaceName), toast(`Saved "${workspaceName}"`))),
      },
    );

    list.push({ key: 'w:all', group: 'Workspaces', label: 'All workspaces', words: 'open load saved', icon: <FolderOpen size={15} />, run: after(() => useApp.getState().set({ workspacesOpen: true })) });
    for (const w of workspaces.filter((x) => !x.name.startsWith('__'))) {
      list.push({
        key: `w:${w.name}`,
        group: 'Workspaces',
        label: `Open ${w.name}`,
        sub: `${w.sessions} session${w.sessions === 1 ? '' : 's'} · ${new Date(w.savedAt).toLocaleDateString()}`,
        words: 'workspace load',
        icon: <FolderOpen size={15} />,
        run: after(() => loadWorkspace(w.name)),
      });
    }

    if (settings) {
      const on = settings.notify !== false;
      list.push(
        { key: 'o:settings', group: 'Settings', label: 'Open settings', words: 'preferences options budget', icon: <Gear size={15} />, run: after(() => useApp.getState().set({ settingsOpen: true })) },
        {
          key: 'o:notify',
          group: 'Settings',
          label: on ? 'Turn notifications off' : 'Turn notifications on',
          sub: 'Pop-ups when a session finishes or needs you',
          words: 'notifications toast alerts windows mac',
          icon: on ? <BellOff size={15} /> : <Bell size={15} />,
          run: after(() => (send({ t: 'settings.set', patch: { notify: !on } }), toast(on ? 'Notifications off' : 'Notifications on'))),
        },
        {
          key: 'o:auth',
          group: 'Settings',
          label: settings.authMode === 'local' ? 'Sign in with an API key instead' : 'Sign in with my Claude account instead',
          words: 'auth login account api key plan subscription',
          icon: settings.authMode === 'local' ? <KeyRound size={15} /> : <User size={15} />,
          run: after(() => {
            send({ t: 'settings.set', patch: { authMode: settings.authMode === 'local' ? 'apiKey' : 'local' } });
            useApp.getState().set({ settingsOpen: true });
          }),
        },
        { key: 'o:update', group: 'Settings', label: 'Check for updates', words: 'version upgrade release', icon: <Download size={15} />, run: after(() => (useApp.getState().set({ settingsOpen: true }), checkForUpdate())) },
      );
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, dormant, families, settings, workspaces, workspaceName, templates]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const scored = items
      .map((it) => ({ it, s: Math.max(score(needle, it.label) * 2, score(needle, `${it.sub ?? ''} ${it.words ?? ''}`)) }))
      .filter((x) => x.s > 0);
    const best = new Map<Group, number>();
    for (const x of scored) best.set(x.it.group, Math.max(best.get(x.it.group) ?? 0, x.s));
    const groups = needle ? [...GROUPS].filter((g) => best.has(g)).sort((a, b) => best.get(b)! - best.get(a)!) : GROUPS;
    const out: { group: Group; items: Item[]; more: number }[] = [];
    for (const g of groups) {
      let gi = scored.filter((x) => x.it.group === g);
      if (needle) gi = gi.sort((a, b) => b.s - a.s);
      const cap = needle ? 8 : g === 'Workspaces' ? 4 : g === 'Templates' ? 6 : 50;
      if (gi.length) out.push({ group: g, items: gi.slice(0, cap).map((x) => x.it), more: g === 'Templates' ? Math.max(0, gi.length - cap) : 0 });
    }
    return out;
  }, [items, q]);

  const flat = useMemo(() => shown.flatMap((g) => g.items), [shown]);

  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    if (index >= flat.length) setIndex(Math.max(0, flat.length - 1));
  }, [flat.length, index]);
  useEffect(() => {
    if (!pointer) rows.current[index]?.scrollIntoView({ block: 'nearest' });
  }, [index, pointer]);
  useEffect(() => input.current?.focus(), []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      setPointer(false);
      setIndex((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      setPointer(false);
      setIndex((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      flat[index]?.run(e.ctrlKey || e.metaKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  let n = -1;
  const current = flat[index];

  return (
    <motion.div className="fixed inset-0 z-[60] flex justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={close} />
      <motion.div
        initial={{ opacity: 0, y: -14, scale: 0.97, filter: 'blur(6px)' }}
        animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, y: -8, scale: 0.98, filter: 'blur(4px)' }}
        transition={{ type: 'spring', stiffness: 520, damping: 36, mass: 0.7 }}
        className="relative mt-[13vh] flex h-fit max-h-[min(560px,74vh)] w-[min(620px,calc(100vw-32px))] flex-col overflow-hidden rounded-[22px] border border-line bg-panel/95 shadow-[0_30px_90px_rgba(0,0,0,0.6)] backdrop-blur-xl"
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={17} className="shrink-0 text-ink-3" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search sessions, templates, actions and settings"
            spellCheck={false}
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
          />
          <kbd className="shrink-0 rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3">Esc</kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5" onMouseMove={() => !pointer && setPointer(true)}>
          {flat.length === 0 && (
            <div className="px-4 py-10 text-center text-[13px] text-ink-3">
              Nothing matches <span className="text-ink-2">"{q}"</span>
            </div>
          )}
          {shown.map((g) => (
            <div key={g.group} className="mb-1 last:mb-0">
              <div className="px-3 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3">{g.group}</div>
              {g.items.map((it) => {
                const i = ++n;
                const on = i === index;
                return (
                  <button
                    key={it.key}
                    ref={(el) => {
                      rows.current[i] = el;
                    }}
                    onMouseEnter={() => pointer && setIndex(i)}
                    onClick={(e) => it.run(e.ctrlKey || e.metaKey)}
                    className="relative flex w-full items-center gap-3 rounded-[13px] px-3 py-2 text-left"
                  >
                    {on && <motion.div layoutId="palette-hl" className="absolute inset-0 rounded-[13px] bg-white/[0.06] ring-1 ring-white/[0.05]" transition={{ type: 'spring', stiffness: 700, damping: 45 }} />}
                    {on && <motion.div layoutId="palette-bar" className="absolute bottom-2 left-0 top-2 w-[3px] rounded-full bg-accent" transition={{ type: 'spring', stiffness: 700, damping: 45 }} />}
                    <span className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] transition-colors ${on ? 'bg-accent-soft text-accent-hi' : 'bg-white/[0.04] text-ink-2'}`}>{it.icon}</span>
                    <span className="relative min-w-0 flex-1">
                      <span className={`block truncate text-[13.5px] ${on ? 'text-ink' : 'text-ink/90'}`}>{it.label}</span>
                      {it.sub && <span className="block truncate text-[11.5px] text-ink-3">{it.sub}</span>}
                    </span>
                    {it.right && <span className="relative shrink-0">{it.right}</span>}
                    {it.hint && <kbd className="relative shrink-0 rounded-md border border-line px-1.5 font-mono text-[10.5px] text-ink-3">{it.hint}</kbd>}
                  </button>
                );
              })}
              {g.more > 0 && (
                <div className="flex items-center gap-1.5 px-3 pb-1 pt-1 text-[11.5px] text-ink-3">
                  <Search size={11} /> {g.more} more, type to filter
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>
              <CornerDownLeft size={10} />
            </Kbd>
            {current?.group === 'Sessions' ? 'jump to it' : current?.group === 'Templates' ? 'start it' : 'run'}
          </span>
          {current?.group === 'Sessions' && (
            <span className="flex items-center gap-1.5">
              <Kbd>Ctrl</Kbd>
              <Kbd>
                <CornerDownLeft size={10} />
              </Kbd>
              open it
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>Ctrl</Kbd>
            <Kbd>F</Kbd> anywhere
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line bg-white/[0.03] px-1 font-mono text-[10px] text-ink-2">{children}</kbd>;
}
