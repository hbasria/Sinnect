// WebSocket client for the local engine. Reconnects on its own.

import type { ClientMsg, EngineMsg } from '@engine/protocol';
import { applyDeltas, useApp } from './store';

type Info = { port: number; token: string };

export const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function engineInfo(): Promise<Info> {
  if (inTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    // The shell starts the engine and tells us where it is. Retry until it's up.
    for (let i = 0; i < 60; i++) {
      try {
        return await invoke<Info>('engine_info');
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  const q = new URLSearchParams(location.search);
  return { port: Number(q.get('port') || 4317), token: q.get('token') || 'dev' };
}

let ws: WebSocket | null = null;
let outbox: ClientMsg[] = [];
let retry = 0;
const listeners = new Set<(m: EngineMsg) => void>();

// Streaming text arrives in many tiny deltas. Collect them and apply once per frame.
let pending = new Map<string, Map<string, string>>();
let scheduled = false;
function queueDelta(id: string, itemId: string, text: string) {
  let m = pending.get(id);
  if (!m) pending.set(id, (m = new Map()));
  m.set(itemId, (m.get(itemId) ?? '') + text);
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const batch = pending;
      pending = new Map();
      applyDeltas(batch);
    });
  }
}

export async function connect() {
  const info = await engineInfo();
  const open = () => {
    useApp.getState().set({ conn: 'connecting' });
    const sock = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      sock.send(JSON.stringify({ t: 'hello', token: info.token } satisfies ClientMsg));
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as EngineMsg;
      if (msg.t === 'ready') {
        useApp.getState().set({ conn: 'open' });
        const queued = outbox;
        outbox = [];
        for (const m of queued) sock.send(JSON.stringify(m));
      }
      if (msg.t === 'feed.delta') queueDelta(msg.id, msg.itemId, msg.text);
      else useApp.getState().apply(msg);
      for (const l of listeners) l(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      useApp.getState().set({ conn: 'closed' });
      const delay = Math.min(5000, 300 * 2 ** retry++);
      setTimeout(open, delay);
    };
  };
  open();
}

export function send(msg: ClientMsg) {
  // A new or resumed session belongs to the open workspace unless it already says which.
  if (msg.t === 'session.create' && !msg.config.workspace) msg = { ...msg, config: { ...msg.config, workspace: useApp.getState().workspaceId } };
  if (ws && ws.readyState === WebSocket.OPEN && useApp.getState().conn === 'open') ws.send(JSON.stringify(msg));
  else outbox.push(msg);
}

export function onEngine(fn: (m: EngineMsg) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
