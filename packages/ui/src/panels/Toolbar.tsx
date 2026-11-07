import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Cost } from '../components/Cost';
import NumberFlow from '@number-flow/react';
import { Building2, FolderOpen, Plus, Save, Search, Settings as Gear, SquareTerminal, Trash2, Zap } from 'lucide-react';
import { testNotification } from '../notify';
import { useReactFlow } from '@xyflow/react';
import { totalTokens, useApp } from '../store';
import { deleteWorkspace, loadWorkspace, newWorkspace, saveWorkspace } from '../workspace';
import { inTauri, send } from '../engine';
import { toggleTerminals } from '../terminal';
import { requestFocus, startCompany, stopCompany, viewCenter } from '../actions';
import { checkForUpdate, installUpdate, useUpdate } from '../updater';
import { spring } from '../lib';

export function Toolbar() {
  const name = useApp((s) => s.workspaceName);
  const sessions = useApp((s) => s.sessions);
  const rf = useReactFlow();
  const list = Object.values(sessions);
  const tokens = list.reduce((a, s) => a + totalTokens(s), 0);
  const cost = list.reduce((a, s) => a + s.costUsd, 0);

  const add = () => {
    const c = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    useApp.getState().set({ setup: { position: { x: c.x - 140, y: c.y - 60 }, familyId: null } });
  };

  return (
    <>
      <div className="glass fixed left-4 top-3 z-40 flex h-11 items-center gap-1 rounded-2xl border border-line pl-3 pr-1.5 shadow-xl">
        <img src="/sinnect.svg" className="h-6 w-6" alt="" />
        <div className="ml-1.5 mr-2 text-[14px] font-semibold tracking-tight">Sinnect</div>
        <div className="mr-1 h-5 w-px bg-line" />
        <button onClick={() => useApp.getState().set({ workspacesOpen: true })} className="max-w-[180px] truncate rounded-xl px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:bg-white/[0.06] hover:text-ink" title="Workspaces">
          {name}
        </button>
        <IconBtn title="Save workspace" onClick={() => saveWorkspace(name)}>
          <Save size={15} />
        </IconBtn>
        <IconBtn title="Settings" onClick={() => useApp.getState().set({ settingsOpen: true })}>
          <Gear size={15} />
        </IconBtn>
        <IconBtn title="Terminal (Ctrl+`)" onClick={toggleTerminals}>
          <SquareTerminal size={15} />
        </IconBtn>
        <button
          title="Search and commands (Ctrl+F)"
          onClick={() => useApp.getState().set({ paletteOpen: true })}
          className="ml-1 flex h-8 items-center gap-2 rounded-xl border border-line bg-white/[0.02] pl-2.5 pr-1.5 text-[12px] text-ink-3 transition hover:border-line-hi hover:text-ink-2"
        >
          <Search size={13} />
          <span className="hidden 2xl:inline">Search</span>
          <kbd className="rounded-md border border-line px-1.5 font-mono text-[10px]">Ctrl F</kbd>
        </button>
      </div>

      <div className="glass fixed right-4 top-3 z-40 flex h-11 items-center gap-3 rounded-2xl border border-line pl-4 pr-1.5 shadow-xl">
        <div className="flex items-center gap-1.5 text-[12.5px] text-ink-2" title="Total tokens across all sessions">
          <Zap size={13} className="text-st-waiting" />
          <NumberFlow value={tokens} format={{ notation: 'compact', maximumFractionDigits: 1 }} className="font-mono tabular-nums" />
        </div>
        <Cost usd={cost} className="font-mono text-[12.5px] text-ink-3" />
        <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.95 }} onClick={add} className="flex h-8 items-center gap-1.5 rounded-xl bg-accent px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_18px_rgba(255,107,74,0.4)]">
          <Plus size={15} /> Session
        </motion.button>
      </div>
    </>
  );
}

function IconBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button title={title} onClick={onClick} className="rounded-xl p-2 text-ink-2 transition hover:bg-white/[0.06] hover:text-ink">
      {children}
    </button>
  );
}

function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/40" onClick={onClose} />
          <motion.div
            initial={{ x: -24, opacity: 0, scale: 0.98 }}
            animate={{ x: 0, opacity: 1, scale: 1 }}
            exit={{ x: -16, opacity: 0 }}
            transition={spring}
            className="absolute left-4 top-16 w-[420px] max-w-[calc(100vw-32px)] rounded-[22px] border border-line bg-panel p-5 shadow-2xl"
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
          >
            <div className="mb-4 text-[15px] font-semibold">{title}</div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function WorkspacesSheet() {
  const open = useApp((s) => s.workspacesOpen);
  const items = useApp((s) => s.workspaces).filter((w) => !w.name.startsWith('__'));
  const current = useApp((s) => s.workspaceName);
  const [name, setName] = useState('');
  const close = () => useApp.getState().set({ workspacesOpen: false });
  return (
    <Sheet open={open} onClose={close} title="Workspaces">
      <div className="mb-4 flex gap-2">
        <input className="field" placeholder={current} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (saveWorkspace(name.trim() || current), setName(''))} />
        <button onClick={() => (saveWorkspace(name.trim() || current), setName(''))} className="shrink-0 rounded-[10px] bg-accent px-3 text-[12.5px] font-semibold text-white">
          Save as
        </button>
        <button onClick={() => (newWorkspace(), close())} title="Close every session and start an empty workspace" className="flex shrink-0 items-center gap-1 rounded-[10px] border border-line px-3 text-[12.5px] text-ink-2 hover:border-line-hi hover:text-ink">
          <Plus size={14} /> New
        </button>
      </div>
      <div className="max-h-[50vh] space-y-1 overflow-y-auto">
        {items.length === 0 && <div className="py-6 text-center text-[12.5px] text-ink-3">No saved workspaces yet. The board also autosaves every few seconds.</div>}
        {items.map((w) => (
          <div key={w.name} className="group flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-white/[0.04]">
            <FolderOpen size={15} className="text-ink-3" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px]">{w.name}</span>
                {w.name === current && <span className="shrink-0 rounded-full bg-accent-soft px-1.5 text-[10.5px] text-accent-hi">open</span>}
              </div>
              <div className="text-[11.5px] text-ink-3">
                {w.sessions} session{w.sessions === 1 ? '' : 's'} · {new Date(w.savedAt).toLocaleString()}
              </div>
            </div>
            <button onClick={() => (loadWorkspace(w.name), close())} className="rounded-lg px-2.5 py-1 text-[12px] text-ink-2 hover:bg-card-hi hover:text-ink">
              Open
            </button>
            <button onClick={() => deleteWorkspace(w.name)} title={`Delete ${w.name}`} className="rounded-lg p-1.5 text-ink-3 transition hover:bg-white/[0.06] hover:text-st-error">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

export function SettingsSheet() {
  const open = useApp((s) => s.settingsOpen);
  const settings = useApp((s) => s.settings);
  const cruxHome = useApp((s) => s.cruxHome);
  const agentCount = useApp((s) => s.agents.length);
  const [key, setKey] = useState('');
  const close = () => useApp.getState().set({ settingsOpen: false });
  if (!settings) return null;
  const set = (patch: Record<string, unknown>) => send({ t: 'settings.set', patch });
  return (
    <Sheet open={open} onClose={close} title="Settings">
      {settings.mock && <div className="mb-4 rounded-xl border border-st-waiting/40 bg-st-waiting/10 p-3 text-[12px] leading-relaxed text-[#fde68a]">Demo mode is on. Sessions are simulated and cost nothing.</div>}
      <div className="mb-2 text-[12px] font-medium text-ink-2">How sessions sign in</div>
      <div className="mb-2 flex gap-1 rounded-[12px] border border-line bg-[#1a1a1a] p-1">
        {(['local', 'apiKey'] as const).map((m) => (
          <button key={m} onClick={() => set({ authMode: m })} className={`h-8 flex-1 rounded-[9px] text-[12.5px] transition ${settings.authMode === m ? 'bg-card-hi text-ink shadow' : 'text-ink-3 hover:text-ink-2'}`}>
            {m === 'local' ? 'My Claude account' : 'API key'}
          </button>
        ))}
      </div>
      <div className="mb-4 text-[11.5px] leading-relaxed text-ink-3">
        {settings.authMode === 'local'
          ? 'Uses your Claude plan through the Claude Code login on this computer. For personal use, at your own risk: Anthropic does not officially support third-party apps on subscription logins.'
          : 'Pay per token with a key from console.anthropic.com. This is the officially supported way.'}
      </div>
      {settings.authMode === 'local' && !settings.mock && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-line bg-[#1a1a1a] px-3 py-2.5">
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className={`h-2 w-2 rounded-full ${settings.signedIn ? 'bg-st-idle' : 'bg-st-waiting'}`} />
            {settings.signedIn ? 'Signed in' : 'Not signed in yet'}
          </div>
          {!settings.signedIn && (
            <button onClick={() => send({ t: 'auth.login' })} className="rounded-[9px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-accent-hi">
              Sign in
            </button>
          )}
        </div>
      )}
      {settings.authMode === 'apiKey' && (
        <div className="mb-4 flex gap-2">
          <input className="field font-mono" type="password" placeholder={settings.hasApiKey ? 'Key saved, paste to replace' : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} />
          <button onClick={() => (set({ apiKey: key }), setKey(''))} className="shrink-0 rounded-[10px] bg-accent px-3 text-[12.5px] font-semibold text-white">
            Save
          </button>
        </div>
      )}
      <CompanyRow />
      <UpdateRow />
      <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-line bg-[#1a1a1a] px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[12.5px]">Notifications</div>
          <div className="text-[11.5px] leading-snug text-ink-3">A pop-up when a session finishes or needs you while Sinnect is in the background</div>
        </div>
        {settings.notify !== false && (
          <button onClick={testNotification} className="shrink-0 rounded-[9px] px-2 py-1 text-[11.5px] text-ink-3 transition hover:text-ink-2">
            Test
          </button>
        )}
        <Switch on={settings.notify !== false} onChange={(v) => set({ notify: v })} />
      </div>
      <Num label="Budget limit (USD, 0 = none)" value={settings.budgetUsd} onChange={(v) => set({ budgetUsd: v })} step={1} />
      <Num label="Max hub message length (characters)" value={settings.maxMessageChars} onChange={(v) => set({ maxMessageChars: v })} step={50} />
      <Num label="Max hub messages per session per hour" value={settings.maxMessagesPerHour} onChange={(v) => set({ maxMessagesPerHour: v })} step={5} />
      <Num label="Times a session can be woken by messages per hour" value={settings.maxWakesPerHour} onChange={(v) => set({ maxWakesPerHour: v })} step={1} />
      <Num label="Sessions that can wake each other in a row" value={settings.maxWakeChain} onChange={(v) => set({ maxWakeChain: v })} step={1} />
      <Num label="Negotiation rounds before asking you" value={settings.maxNegotiationRounds} onChange={(v) => set({ maxNegotiationRounds: v })} step={1} />
      <div className="mt-3">
        <div className="mb-1.5 text-[12px] font-medium text-ink-2">Crux folder (optional)</div>
        <input className="field font-mono !text-[12px]" placeholder={cruxHome || 'CRUX_HOME, else ~/.crux'} defaultValue={settings.cruxPath ?? ''} onBlur={(e) => set({ cruxPath: e.target.value.trim() || null })} />
        <div className="mt-1.5 text-[11.5px] text-ink-3">{agentCount ? `${agentCount} agents found` : 'No agents found'} in {cruxHome || 'the Crux folder'}/agents</div>
      </div>
      <div className="mt-3">
        <div className="mb-1.5 text-[12px] font-medium text-ink-2">Claude Code executable (optional)</div>
        <input className="field font-mono !text-[12px]" placeholder="Leave empty to use the bundled one" defaultValue={settings.claudePath ?? ''} onBlur={(e) => set({ claudePath: e.target.value.trim() || null })} />
      </div>
    </Sheet>
  );
}

function Num({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step: number }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-3">
      <div className="text-[12.5px] text-ink-2">{label}</div>
      <input type="number" min={0} step={step} defaultValue={value} onBlur={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} className="field !w-24 text-right font-mono" />
    </div>
  );
}

function UpdateRow() {
  const { phase, current, version, error, progress } = useUpdate();
  const label =
    phase === 'checking'
      ? 'Checking…'
      : phase === 'latest'
        ? "You're on the latest version"
        : phase === 'available'
          ? `Version ${version} is ready`
          : phase === 'downloading'
            ? `Downloading ${progress > 0 ? Math.round(progress * 100) + '%' : ''}`
            : phase === 'installing'
              ? 'Installing…'
              : phase === 'error'
                ? error ?? "Couldn't check"
                : 'Updates come from GitHub Releases';
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-line bg-[#1a1a1a] px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[12.5px]">Sinnect {current ?? ''}</div>
        <div className={`truncate text-[11.5px] ${phase === 'error' ? 'text-st-error' : phase === 'available' ? 'text-accent-hi' : 'text-ink-3'}`}>{label}</div>
      </div>
      {phase === 'available' ? (
        <button onClick={() => installUpdate()} className="shrink-0 rounded-[9px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-accent-hi">
          Update now
        </button>
      ) : (
        <button
          disabled={phase === 'checking' || phase === 'downloading' || phase === 'installing'}
          onClick={() => checkForUpdate()}
          className="shrink-0 rounded-[9px] border border-line px-3 py-1.5 text-[12px] text-ink-2 transition hover:border-line-hi hover:text-ink disabled:opacity-50"
        >
          Check for updates
        </button>
      )}
    </div>
  );
}

/** Crux company mode for the open workspace: a coordinator session onboards the company and starts its teams. */
function CompanyRow() {
  const company = useApp((s) => s.company);
  const workspace = useApp((s) => s.workspaceName);
  const mock = useApp((s) => !!s.settings?.mock);
  const coordinator = useApp((s) => (s.company?.coordinatorId ? s.sessions[s.company.coordinatorId] : undefined));
  // A saved coordinator comes back stopped with a Resume button, so it still counts.
  const dormant = useApp((s) => !!s.company?.coordinatorId && !!s.dormant[s.company.coordinatorId]);
  const rf = useReactFlow();
  const [enabling, setEnabling] = useState(false);
  const [root, setRoot] = useState('');
  const on = !!company || enabling;
  const canStart = root.trim().length > 0 || mock;

  const start = (folder: string) => {
    startCompany(folder, viewCenter(rf));
    setEnabling(false);
    useApp.getState().set({ settingsOpen: false });
  };
  const browse = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true, multiple: false, defaultPath: root || undefined });
    if (typeof dir === 'string') setRoot(dir);
  };

  return (
    <div className="mb-4 rounded-xl border border-line bg-[#1a1a1a] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12.5px]">
            <Building2 size={13} className="text-ink-3" /> Crux company mode
          </div>
          <div className="text-[11.5px] leading-snug text-ink-3">
            Runs "{workspace}" as a Crux company. A coordinator session asks about the company, sets it up and starts a session per team.
          </div>
        </div>
        <Switch
          on={on}
          onChange={(v) => {
            if (v) setEnabling(true);
            else if (company) stopCompany();
            else setEnabling(false);
          }}
        />
      </div>
      {enabling && !company && (
        <div className="mt-3">
          <div className="mb-1.5 text-[12px] font-medium text-ink-2">Company folder</div>
          <div className="flex gap-2">
            <input
              autoFocus
              className="field font-mono !text-[12px]"
              placeholder={mock ? 'Demo mode, any path works' : '/Users/you/acme/company'}
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canStart && start(root.trim() || '/demo/company')}
            />
            {inTauri() && (
              <button onClick={browse} className="shrink-0 rounded-[10px] border border-line px-3 text-ink-2 hover:border-line-hi hover:text-ink" title="Browse">
                <FolderOpen size={16} />
              </button>
            )}
          </div>
          <div className="mt-1.5 text-[11.5px] leading-snug text-ink-3">Created if missing. Teams get their own folders beside it.</div>
          <button
            disabled={!canStart}
            onClick={() => start(root.trim() || '/demo/company')}
            className="mt-2.5 w-full rounded-[10px] bg-accent py-2 text-[12.5px] font-semibold text-white hover:bg-accent-hi disabled:opacity-40"
          >
            Start onboarding
          </button>
        </div>
      )}
      {company && (
        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-line pt-2.5">
          <div className="min-w-0 truncate font-mono text-[11.5px] text-ink-2" title={company.root}>
            {company.root}
          </div>
          {coordinator && (coordinator.status !== 'stopped' || dormant) ? (
            <button onClick={() => (useApp.getState().set({ settingsOpen: false }), requestFocus(coordinator.id, true))} className="shrink-0 rounded-[9px] px-2 py-1 text-[11.5px] text-ink-2 hover:bg-white/[0.06] hover:text-ink">
              Show coordinator
            </button>
          ) : (
            <button onClick={() => start(company.root)} className="shrink-0 rounded-[9px] bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-accent-hi">
              Start coordinator
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-[#3a3a3c]'}`}>
      <motion.span layout transition={spring} className="absolute top-[3px] h-4 w-4 rounded-full bg-white shadow" style={{ left: on ? 19 : 3 }} />
    </button>
  );
}
