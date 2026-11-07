import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, MessagesSquare, X } from 'lucide-react';
import type { MatrixStatus } from '@engine/protocol';
import { useApp } from '../store';
import { send } from '../engine';
import { spring } from '../lib';

const STATE: Record<MatrixStatus['state'], { label: string; color: string }> = {
  off: { label: 'Off', color: 'var(--color-st-stopped)' },
  connecting: { label: 'Connecting', color: 'var(--color-st-thinking)' },
  online: { label: 'Listening', color: 'var(--color-st-idle)' },
  error: { label: 'Error', color: 'var(--color-st-error)' },
};

/** "@a:x, @b:y" or one per line -> ['@a:x', '@b:y']. */
const parseUsers = (text: string) => text.split(/[\s,]+/).map((u) => u.trim()).filter((u) => u.startsWith('@'));
const showUsers = (list?: string[]) => (list ?? []).join(', ');

export function MatrixDialog() {
  const id = useApp((s) => s.matrixFor);
  return <AnimatePresence>{id && <Dialog key={id} id={id} />}</AnimatePresence>;
}

function Dialog({ id }: { id: string }) {
  const st = useApp((s) => s.sessions[id]);
  const cfg = st?.config.matrix;
  const status = st?.matrix ?? { state: 'off' as const, userId: null, rooms: [] };
  const [homeserver, setHomeserver] = useState(cfg?.homeserver ?? 'https://matrix.org');
  const [token, setToken] = useState('');
  const [everywhere, setEverywhere] = useState(showUsers(cfg?.allowed['*']));
  const [perRoom, setPerRoom] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(cfg?.allowed ?? {}).filter(([k]) => k !== '*').map(([k, v]) => [k, showUsers(v)])),
  );
  const close = () => useApp.getState().set({ matrixFor: null });
  if (!st) return null;

  const live = status.state === 'online' || status.state === 'connecting';
  const allowed = () => {
    const out: Record<string, string[]> = { '*': parseUsers(everywhere) };
    for (const [room, text] of Object.entries(perRoom)) {
      const users = parseUsers(text);
      if (users.length) out[room] = users;
    }
    return out;
  };
  const connect = () => send({ t: 'matrix.enable', id, homeserver, token: token.trim() || undefined, allowed: allowed() });
  const nobody = Object.values(allowed()).every((l) => l.length === 0);
  const s = STATE[status.state];

  return (
    <motion.div className="fixed inset-0 z-50 flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={close} />
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={spring}
        onKeyDown={(e) => e.key === 'Escape' && close()}
        className="relative max-h-[calc(100vh-48px)] w-[520px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-[24px] border border-line bg-panel p-6 shadow-[0_30px_80px_rgba(0,0,0,0.55)]"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[17px] font-semibold">
              <MessagesSquare size={17} className="text-ink-3" /> Matrix chat
            </div>
            <div className="text-[12.5px] text-ink-3">{st.config.name} answers mentions in its rooms, in a thread.</div>
          </div>
          <button onClick={close} className="rounded-xl p-2 text-ink-3 hover:bg-card hover:text-ink">
            <X size={17} />
          </button>
        </div>

        <div className="mb-4 flex items-center gap-2 rounded-xl border border-line bg-[#1a1a1a] px-3 py-2.5 text-[12.5px]">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
          <span>{s.label}</span>
          {status.userId && <span className="truncate font-mono text-[11.5px] text-ink-3">{status.userId}</span>}
          {status.state === 'online' && <span className="ml-auto shrink-0 text-[11.5px] text-ink-3">{status.rooms.length} room{status.rooms.length === 1 ? '' : 's'}</span>}
        </div>
        {status.error && <div className="-mt-2 mb-4 text-[11.5px] text-st-error">{status.error}</div>}

        <Label text="Homeserver" />
        <input className="field mb-3 font-mono !text-[12px]" value={homeserver} onChange={(e) => setHomeserver(e.target.value)} placeholder="https://matrix.example.org" />
        <Label text="Access token" hint="Of this session's own Matrix account" />
        <input
          className="field mb-4 font-mono !text-[12px]"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={cfg?.userId ? `Saved for ${cfg.userId}, paste to replace` : 'syt_…'}
        />

        <Label text="Who can talk to it" hint="Matrix ids, comma separated" />
        <div className="mb-1 text-[11.5px] text-ink-3">In every room</div>
        <input className="field mb-3 font-mono !text-[12px]" value={everywhere} onChange={(e) => setEverywhere(e.target.value)} placeholder="@you:matrix.org" />
        {status.rooms.map((r) => (
          <div key={r.id} className="mb-3">
            <div className="mb-1 truncate text-[11.5px] text-ink-3" title={r.id}>
              Only in {r.name}
            </div>
            <input className="field font-mono !text-[12px]" value={perRoom[r.id] ?? ''} onChange={(e) => setPerRoom((p) => ({ ...p, [r.id]: e.target.value }))} placeholder="Nobody else" />
          </div>
        ))}
        <div className="mb-4 text-[11.5px] leading-relaxed text-ink-3">
          Mention it (or reply in its thread) and it answers there. Messages from anyone else are ignored. Invite it from an allowed account and it joins by itself. Unencrypted rooms only.
        </div>

        {st.config.permission === 'auto' && (
          <div className="mb-4 flex gap-2 rounded-xl border border-st-blocked/40 bg-st-blocked/10 p-3 text-[12px] leading-relaxed text-[#fecaca]">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            This session runs in Full auto: the people you allow can make it run commands and edit files without asking you.
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {cfg?.enabled && (
            <button onClick={() => send({ t: 'matrix.disable', id })} className="rounded-[12px] border border-line px-4 py-2.5 text-[13px] text-ink-2 hover:border-st-error hover:text-st-error">
              Turn off
            </button>
          )}
          {live && (
            <button onClick={() => send({ t: 'matrix.allow', id, allowed: allowed() })} className="rounded-[12px] border border-line px-4 py-2.5 text-[13px] text-ink-2 hover:border-line-hi hover:text-ink">
              Save who can talk
            </button>
          )}
          <button
            onClick={connect}
            disabled={nobody || st.status === 'stopped'}
            title={nobody ? 'Allow at least one person first' : undefined}
            className="rounded-[12px] bg-accent px-5 py-2.5 text-[13.5px] font-semibold text-white hover:bg-accent-hi disabled:opacity-40"
          >
            {live ? 'Reconnect' : 'Connect'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Label({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-2">
      <span className="text-[12px] font-medium text-ink-2">{text}</span>
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </div>
  );
}
