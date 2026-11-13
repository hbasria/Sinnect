import { useEffect } from 'react';
import { ReactFlowProvider, useReactFlow, type Viewport } from '@xyflow/react';
import { AnimatePresence } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { Canvas } from './canvas/Canvas';
import { DynamicIsland } from './island/DynamicIsland';
import { ExpandedSession } from './panels/ExpandedSession';
import { SetupCard } from './panels/SetupCard';
import { SignInCard } from './panels/SignInCard';
import { Intro } from './Intro';
import { UpdateCard } from './panels/UpdateCard';
import { startUpdateChecks } from './updater';
import { SettingsSheet, Toolbar, WorkspacesSheet } from './panels/Toolbar';
import { useApp } from './store';
import { connect, onEngine } from './engine';
import { startAutosave } from './workspace';
import { CommandPalette } from './panels/CommandPalette';
import { startNotifications } from './notify';
import { focusSession } from './actions';
import { LearnedCard, MemorySheet } from './panels/Memory';
import { Onboarding } from './panels/Onboarding';
import { LeaveDialog } from './panels/LeaveDialog';

let booted = false;

function Shell() {
  const expanded = useApp((s) => s.expanded);
  const setup = useApp((s) => s.setup);
  const rf = useReactFlow();

  useEffect(() => {
    if (booted) return;
    booted = true;
    startAutosave();
    startUpdateChecks();
    connect();
    onEngine((m) => {
      if (m.t === 'toast') (m.level === 'error' ? toast.error : m.level === 'warn' ? toast.warning : toast)(m.text);
    });
    startNotifications();
    // Old message pulses are only for the animation; drop them.
    setInterval(() => {
      const s = useApp.getState();
      if (s.pulses.length && s.pulses.some((p) => Date.now() - p.at > 2500)) s.set({ pulses: s.pulses.filter((p) => Date.now() - p.at <= 2500) });
    }, 1000);
  }, []);

  useEffect(() => {
    const onVp = (e: Event) => {
      const vp = (e as CustomEvent<Viewport | null>).detail;
      if (vp) rf.setViewport(vp, { duration: 400 });
      else setTimeout(() => rf.fitView({ padding: 0.3, duration: 400 }), 50);
    };
    const onFocus = (e: Event) => {
      const { id, expand } = (e as CustomEvent<{ id: string; expand: boolean }>).detail;
      useApp.getState().set({ paletteOpen: false, setup: null });
      focusSession(rf, id, expand);
    };
    // Ctrl+F opens the command palette from anywhere, even while typing.
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        const s = useApp.getState();
        s.set({ paletteOpen: !s.paletteOpen });
      }
    };
    window.addEventListener('sinnect:viewport', onVp);
    window.addEventListener('sinnect:focus-session', onFocus);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('sinnect:viewport', onVp);
      window.removeEventListener('sinnect:focus-session', onFocus);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [rf]);

  return (
    <div className="relative h-full w-full">
      <Canvas />
      <Toolbar />
      <DynamicIsland />
      <AnimatePresence>{expanded && <ExpandedSession key={expanded} />}</AnimatePresence>
      <AnimatePresence>{setup && <SetupCard key={setup.template?.id ?? 'setup'} />}</AnimatePresence>
      <SignInCard />
      <UpdateCard />
      <WorkspacesSheet />
      <SettingsSheet />
      <MemorySheet />
      <LearnedCard />
      <CommandPalette />
      <LeaveDialog />
      <Onboarding rf={rf} />
      <Intro />
      <Toaster theme="dark" position="bottom-center" toastOptions={{ style: { background: '#1e1e1f', border: '1px solid #363638', color: '#ededec' } }} />
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  );
}
