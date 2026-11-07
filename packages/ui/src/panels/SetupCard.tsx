import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { BookmarkPlus, Check, Eye, EyeOff, FolderOpen, Layers, Rocket, ShieldAlert, ShieldCheck, ShieldEllipsis, Trash2, Users, X } from 'lucide-react';
import { DEFAULT_MODELS, type Awareness, type PermissionChoice, type SessionConfig, type SessionTemplate } from '@engine/protocol';
import { useApp, type AppNode } from '../store';
import { inTauri, send } from '../engine';
import { modelLabel, spring, uid } from '../lib';
import { CARD_H, CARD_W } from '../actions';
import { deleteTemplate, freshName, loadLastSetup, rememberSetup, saveTemplate, spawnFromTemplate, templateFamily } from '../templates';

const PERM_SHORT: Record<PermissionChoice, string> = { ask: 'Ask me', acceptEdits: 'Auto edits', auto: 'Full auto' };

export function SetupCard() {
  // Keep the value we opened with: during the exit animation the store's setup is already null.
  const live = useApp((s) => s.setup);
  const setup = useRef(live!).current;
  const families = useApp((s) => s.families);
  const settings = useApp((s) => s.settings);
  const templates = useApp((s) => s.templates);
  const agents = useApp((s) => s.agents);
  const count = useApp((s) => Object.keys(s.sessions).length);
  const last = useRef(loadLastSetup()).current;
  const t0 = setup.template;

  // Template's agent, else the last one used. One that no longer exists falls back to none.
  const agent0 = useRef(agents.find((a) => a.id === (t0 ? t0.agent : last.agent)) ?? null).current;
  const [name, setName] = useState(t0?.name ?? agent0?.name ?? `Session ${count + 1}`);
  const [cwd, setCwd] = useState(last.cwd ?? '');
  const [model, setModel] = useState(t0?.model ?? last.model ?? settings?.defaultModel ?? DEFAULT_MODELS[1].id);
  const [prompt, setPrompt] = useState(t0?.prompt ?? '');
  const [agent, setAgent] = useState<string | null>(agent0?.id ?? null);
  const [priority, setPriority] = useState(t0?.priority ?? 3);
  const [awareness, setAwareness] = useState<Awareness>(t0?.awareness ?? last.awareness ?? 'family');
  const [permission, setPermission] = useState<PermissionChoice>(t0?.permission ?? last.permission ?? 'ask');
  const [familyId, setFamilyId] = useState<string | null>(setup.familyId);
  const [flash, setFlash] = useState(0);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [picked, setPicked] = useState<string | null>(t0?.id ?? null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Opened from a template with no folder known: the folder is the one thing left to fill.
    (t0 && !cwd ? folderRef.current : promptRef.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => useApp.getState().set({ setup: null });

  const pickFolder = async () => {
    if (!inTauri()) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true, multiple: false, defaultPath: cwd || undefined });
    if (typeof dir === 'string') setCwd(dir);
  };

  const canStart = cwd.trim().length > 0 || settings?.mock;
  const agentInfo = agents.find((a) => a.id === agent);

  const start = () => {
    if (!canStart) return;
    const id = uid('s');
    const config: SessionConfig = {
      name: freshName(name.trim() || 'Session'),
      cwd: cwd.trim() || '/demo/project',
      model,
      prompt: prompt.trim(),
      priority,
      awareness,
      permission,
      familyId,
      agent,
    };
    rememberSetup(config);
    const st = useApp.getState();
    const node: AppNode = { id, type: 'session', position: setup.position, data: { sessionId: id } };
    st.set({ nodes: [...st.nodes, node], setup: null });
    send({ t: 'session.create', id, config });
  };

  // ---- templates ----
  const resolved = (t: SessionTemplate) => templateFamily(t, families);
  const matches = (t: SessionTemplate) =>
    t.model === model && t.priority === priority && t.awareness === awareness && t.permission === permission && t.prompt.trim() === prompt.trim() && (t.agent ?? null) === agent && resolved(t) === familyId;
  // Two templates can hold the same setup: prefer the one last picked or saved.
  const current = templates.find((t) => t.id === picked && matches(t)) ?? templates.find(matches);

  const applyTemplate = (t: SessionTemplate) => {
    setName(t.name);
    setModel(t.model);
    setPriority(t.priority);
    setAwareness(t.awareness);
    setPermission(t.permission);
    setFamilyId(resolved(t));
    setPrompt(t.prompt);
    setAgent(t.agent && agents.some((a) => a.id === t.agent) ? t.agent : null);
    setPicked(t.id);
    setFlash((n) => n + 1);
  };

  const spawnNow = (t: SessionTemplate) => {
    if (!cwd.trim() && !last.cwd?.trim() && !settings?.mock) {
      applyTemplate(t);
      toast('Pick a working folder first');
      folderRef.current?.focus();
      return;
    }
    spawnFromTemplate(t, { x: setup.position.x + CARD_W / 2, y: setup.position.y + CARD_H / 2 }, cwd);
  };

  const removeTemplate = (t: SessionTemplate) => {
    deleteTemplate(t.id);
    toast(`Deleted template "${t.name}"`, { action: { label: 'Undo', onClick: () => saveTemplate(t) } });
  };

  const saveAsTemplate = (tname: string) => {
    const clean = tname.trim();
    if (!clean) return;
    const same = templates.find((t) => t.name.trim().toLowerCase() === clean.toLowerCase());
    const id = same?.id ?? uid('t');
    setPicked(id);
    saveTemplate({
      id,
      name: clean,
      model,
      priority,
      awareness,
      permission,
      familyId,
      familyName: families.find((f) => f.id === familyId)?.name ?? null,
      prompt: prompt.trim(),
      agent,
      createdAt: same?.createdAt ?? Date.now(),
    });
  };

  return (
    <motion.div className="fixed inset-0 z-40 flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={close} />
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={spring}
        className="relative w-[560px] max-w-[calc(100vw-32px)] rounded-[24px] border border-line bg-panel p-6 shadow-[0_30px_80px_rgba(0,0,0,0.55)]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start();
        }}
      >
        {flash > 0 && (
          <motion.div
            key={flash}
            initial={{ opacity: 0.9 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.75, ease: 'easeOut' }}
            className="pointer-events-none absolute -inset-px rounded-[24px] border border-accent shadow-[0_0_28px_color-mix(in_srgb,var(--color-accent)_25%,transparent)]"
          />
        )}

        <div className="mb-5 flex items-center justify-between">
          <div>
            <div className="text-[17px] font-semibold">New session</div>
            <div className="text-[12.5px] text-ink-3">Set it up, then let it run.</div>
          </div>
          <button onClick={close} className="rounded-xl p-2 text-ink-3 hover:bg-card hover:text-ink">
            <X size={17} />
          </button>
        </div>

        <AnimatePresence initial={false}>
          {templates.length > 0 && (
            <motion.div
              key="templates"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring}
              className="overflow-hidden"
            >
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
                <Layers size={13} className="text-ink-3" /> Templates
                <span className="text-[11px] font-normal text-ink-3">Click to fill in, rocket to start right away</span>
              </div>
              <div className="flex max-h-[76px] flex-wrap gap-1.5 overflow-y-auto pb-4">
                <AnimatePresence initial={false} mode="popLayout">
                  {templates.map((t) => (
                    <TemplateChip key={t.id} t={t} on={current?.id === t.id} onApply={() => applyTemplate(t)} onSpawn={() => spawnNow(t)} onDelete={() => removeTemplate(t)} />
                  ))}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Model">
            <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
              {DEFAULT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Working folder" className="mt-3">
          <div className="flex gap-2">
            <input
              ref={folderRef}
              className="field font-mono !text-[12.5px]"
              placeholder={settings?.mock ? 'Demo mode, any path works' : 'C:\\Users\\you\\projects\\my-app'}
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
            />
            {inTauri() && (
              <button onClick={pickFolder} className="shrink-0 rounded-[10px] border border-line px-3 text-ink-2 hover:border-line-hi hover:text-ink" title="Browse">
                <FolderOpen size={16} />
              </button>
            )}
          </div>
        </Field>

        <Field label="Agent" hint={agents.length ? 'Runs the session as a Crux role' : 'No Crux agents found, set the folder in Settings'} className="mt-3">
          <select
            className="field"
            value={agent ?? ''}
            disabled={!agents.length}
            onChange={(e) => {
              const next = agents.find((a) => a.id === e.target.value) ?? null;
              setAgent(next?.id ?? null);
              // A default name follows the agent, a name the user typed stays.
              if (next && (/^Session \d+$/.test(name.trim()) || agents.some((a) => a.name === name.trim()))) setName(next.name);
            }}
          >
            <option value="">No agent, plain Claude</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji ? `${a.emoji} ` : ''}
                {a.name}
              </option>
            ))}
          </select>
          {agentInfo?.description && <div className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-ink-3">{agentInfo.description}</div>}
        </Field>

        <Field label="First message" hint="Optional" className="mt-3">
          <textarea ref={promptRef} className="field h-16" placeholder="What should this session work on?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>

        <Field label="Priority" hint="Higher wins when two sessions want the same file" className="mt-4">
          <div className="flex gap-1.5">
            {[1, 2, 3, 4, 5].map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                className={`relative h-9 flex-1 rounded-[10px] border text-[13px] font-medium transition ${priority === p ? 'border-transparent text-white' : 'border-line text-ink-2 hover:border-line-hi'}`}
              >
                {priority === p && <motion.div layoutId="prio" className="absolute inset-0 rounded-[10px] bg-accent" transition={spring} />}
                <span className="relative">{p}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Knows about" className="mt-4">
          <Segmented
            id="aw"
            value={awareness}
            onChange={setAwareness}
            options={[
              { v: 'solo', label: 'Nobody', icon: <EyeOff size={14} />, tip: 'Works alone. Edits still get checked for clashes.' },
              { v: 'family', label: 'Its family', icon: <Users size={14} />, tip: 'Sees its family and sessions it is connected to.' },
              { v: 'everyone', label: 'Everyone', icon: <Eye size={14} />, tip: 'Sees every session on the canvas.' },
            ]}
          />
        </Field>

        <Field label="Permissions" className="mt-4">
          <Segmented
            id="perm"
            value={permission}
            onChange={setPermission}
            options={[
              { v: 'ask', label: 'Ask me', icon: <ShieldCheck size={14} />, tip: 'Asks before running commands or editing.' },
              { v: 'acceptEdits', label: 'Auto edits', icon: <ShieldEllipsis size={14} />, tip: 'Edits files freely, asks before commands.' },
              { v: 'auto', label: 'Full auto', icon: <ShieldAlert size={14} />, tip: 'Never asks. Only use in folders you trust.' },
            ]}
          />
        </Field>

        {families.length > 0 && (
          <Field label="Family" className="mt-4">
            <div className="flex flex-wrap gap-1.5">
              <Chip on={familyId === null} onClick={() => setFamilyId(null)} color="#6f6e6b" label="None" />
              {families.map((f) => (
                <Chip key={f.id} on={familyId === f.id} onClick={() => setFamilyId(f.id)} color={f.color} label={f.name} />
              ))}
            </div>
          </Field>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <SaveTemplate suggested={/^Session \d+$/.test(name.trim()) ? '' : name.trim()} existing={templates} onSave={saveAsTemplate} onEditing={setSavingTemplate} />
          <div className="flex shrink-0 items-center gap-3">
            <AnimatePresence initial={false}>
              {!savingTemplate && (
                <motion.div
                  key="hint"
                  initial={{ opacity: 0, x: 6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 6 }}
                  transition={{ duration: 0.15 }}
                  className="whitespace-nowrap text-[11.5px] text-ink-3"
                >
                  <kbd className="rounded border border-line px-1 font-mono">Ctrl</kbd> + <kbd className="rounded border border-line px-1 font-mono">Enter</kbd>
                </motion.div>
              )}
            </AnimatePresence>
            <motion.button
              whileHover={{ scale: canStart ? 1.03 : 1 }}
              whileTap={{ scale: canStart ? 0.97 : 1 }}
              disabled={!canStart}
              onClick={start}
              className="flex items-center gap-2 rounded-[12px] bg-accent hover:bg-accent-hi px-5 py-2.5 text-[13.5px] font-semibold text-white shadow-[0_8px_24px_color-mix(in_srgb,var(--color-accent)_28%,transparent)] disabled:opacity-40"
            >
              <Rocket size={15} /> Start session
            </motion.button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function TemplateChip({ t, on, onApply, onSpawn, onDelete }: { t: SessionTemplate; on: boolean; onApply: () => void; onSpawn: () => void; onDelete: () => void }) {
  const agentName = useApp((s) => s.agents.find((a) => a.id === t.agent)?.name ?? t.agent);
  const tip = [
    modelLabel(t.model),
    agentName && `Agent: ${agentName}`,
    `Priority ${t.priority}`,
    PERM_SHORT[t.permission],
    t.familyName,
    t.prompt && `"${t.prompt.length > 60 ? `${t.prompt.slice(0, 60)}...` : t.prompt}"`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={spring}
      title={tip}
      className={`group relative flex h-8 items-center rounded-full border transition-colors ${on ? 'border-accent bg-accent-soft' : 'border-line bg-field hover:border-line-hi'}`}
    >
      <button onClick={onApply} className="flex h-full items-center gap-2 pl-3 pr-3 text-[12.5px]">
        <span className={on ? 'text-ink' : 'text-ink-2 group-hover:text-ink'}>{t.name}</span>
        <span
          className={`min-w-[44px] font-mono text-[10.5px] transition-opacity duration-150 group-focus-within:opacity-0 group-hover:opacity-0 ${on ? 'text-accent-hi' : 'text-ink-3'}`}
        >
          {modelLabel(t.model).split(' ')[0]}
        </span>
      </button>
      {/* Actions fade in over the model label: the chip never changes size, so neighbours stay put. */}
      <span className="pointer-events-none absolute inset-y-0 right-0.5 flex translate-x-1 items-center gap-0.5 opacity-0 transition-all duration-150 group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100">
        <button onClick={onSpawn} title="Start a session from this now" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-accent hover:text-white">
          <Rocket size={12} />
        </button>
        <button onClick={onDelete} title="Delete template" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-white/[0.08] hover:text-st-error">
          <Trash2 size={12} />
        </button>
      </span>
    </motion.div>
  );
}

/** "Save as template" that opens into an inline name field. */
function SaveTemplate({
  suggested,
  existing,
  onSave,
  onEditing,
}: {
  suggested: string;
  existing: SessionTemplate[];
  onSave: (name: string) => void;
  onEditing: (on: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // After saving or cancelling, keep focus inside the card so Esc and Ctrl+Enter still work.
  const refocus = useRef(false);
  const update = existing.some((t) => t.name.trim().toLowerCase() === value.trim().toLowerCase());

  useEffect(() => {
    if (!saved) return;
    const h = setTimeout(() => setSaved(false), 1400);
    return () => clearTimeout(h);
  }, [saved]);

  useEffect(() => {
    onEditing(editing);
    if (editing) input.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    if (!value.trim()) return;
    onSave(value);
    refocus.current = true;
    setEditing(false);
    setSaved(true);
  };

  return (
    <div className="flex min-w-0 items-center">
      <AnimatePresence mode="popLayout" initial={false}>
        {editing ? (
          <motion.div
            key="edit"
            initial={{ opacity: 0, scale: 0.95, x: -6 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.95, x: -6 }}
            transition={spring}
            className="flex h-9 items-center gap-1 rounded-[11px] border border-accent bg-field pl-3 pr-1 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_18%,transparent)]"
          >
            <BookmarkPlus size={14} className="shrink-0 text-accent-hi" />
            <input
              ref={input}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  refocus.current = true;
                  setEditing(false);
                } else if (e.key === 'Enter') {
                  // Plain Enter saves; Ctrl+Enter is swallowed so it never starts the session from here.
                  e.preventDefault();
                  e.stopPropagation();
                  if (!e.ctrlKey && !e.metaKey) commit();
                }
              }}
              placeholder="Template name"
              spellCheck={false}
              className="w-[140px] min-w-0 bg-transparent px-1 text-[12.5px] text-ink outline-none placeholder:text-ink-3"
            />
            <button
              onClick={commit}
              disabled={!value.trim()}
              className="flex h-7 items-center gap-1 rounded-[8px] bg-accent px-2.5 text-[12px] font-medium text-white hover:bg-accent-hi disabled:opacity-40"
            >
              <Check size={13} /> {update ? 'Update' : 'Save'}
            </button>
            <button
              onClick={() => {
                refocus.current = true;
                setEditing(false);
              }}
              title="Cancel" className="flex h-7 w-7 items-center justify-center rounded-[8px] text-ink-3 hover:bg-white/[0.06] hover:text-ink">
              <X size={13} />
            </button>
          </motion.div>
        ) : (
          <motion.button
            key="btn"
            ref={(el) => {
              if (el && refocus.current) {
                refocus.current = false;
                el.focus({ preventScroll: true });
              }
            }}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={spring}
            onClick={() => {
              setValue(suggested);
              setEditing(true);
            }}
            className={`flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[11px] border px-3 text-[12.5px] transition-colors ${saved ? 'border-accent/60 text-accent-hi' : 'border-line text-ink-2 hover:border-line-hi hover:text-ink'}`}
          >
            {saved ? <Check size={14} /> : <BookmarkPlus size={14} />}
            {saved ? 'Saved' : 'Save as template'}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function Field({ label, hint, className = '', children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`block ${className}`}>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12px] font-medium text-ink-2">{label}</span>
        {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: T;
  onChange: (v: T) => void;
  options: { v: T; label: string; icon: React.ReactNode; tip: string }[];
}) {
  const tip = options.find((o) => o.v === value)?.tip;
  return (
    <div>
      <div className="flex gap-1 rounded-[12px] border border-line bg-field p-1">
        {options.map((o) => (
          <button key={o.v} onClick={() => onChange(o.v)} className={`relative flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[9px] text-[12.5px] transition ${value === o.v ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
            {value === o.v && <motion.div layoutId={`seg-${id}`} className="absolute inset-0 rounded-[9px] bg-card-hi shadow" transition={spring} />}
            <span className="relative flex items-center gap-1.5">
              {o.icon}
              {o.label}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-1.5 text-[11.5px] text-ink-3">{tip}</div>
    </div>
  );
}

function Chip({ on, onClick, color, label }: { on: boolean; onClick: () => void; color: string; label: string }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition ${on ? 'text-ink' : 'border-line text-ink-3 hover:text-ink-2'}`} style={on ? { borderColor: color, background: `color-mix(in srgb, ${color} 14%, transparent)` } : {}}>
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </button>
  );
}
