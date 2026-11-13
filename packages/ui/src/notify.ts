// Native notifications (Windows toasts, macOS banners) when a session finishes or needs you while Sinnect is in the
// background. The shell decides if the window is in front; clicking a toast
// brings Sinnect back and flies to that session.

import type { PromptRequest, SessionState } from '@engine/protocol';
import { useApp } from './store';
import { inTauri } from './engine';
import { requestFocus } from './actions';

type Kind = 'needs' | 'error' | 'done';
interface Event {
  kind: Kind;
  sessionId: string;
  name: string;
  detail: string;
}

const RANK: Record<Kind, number> = { needs: 0, error: 1, done: 2 };
let queue: Event[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

const clip = (s: string, n = 140) => {
  const one = s.replace(/[#*_`>|~]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1).trimEnd() + '…' : one;
};

function lastReply(id: string) {
  const feed = useApp.getState().feeds[id] ?? [];
  for (let i = feed.length - 1; i >= 0; i--) if (feed[i].kind === 'text' && feed[i].text.trim()) return feed[i].text;
  return '';
}

function promptDetail(p: PromptRequest) {
  if (p.kind === 'tool') return p.title;
  if (p.kind === 'question') return p.questions[0]?.question ?? 'Has a question for you';
  return `Who gets ${p.path.split(/[\\/]/).pop()} first?`;
}

function push(e: Event) {
  queue.push(e);
  // Several sessions often finish together: wait a beat and send one toast.
  clearTimeout(timer);
  timer = setTimeout(flush, 700);
}

function flush() {
  const items = queue.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  queue = [];
  if (!items.length || useApp.getState().settings?.notify === false) return;
  const top = items[0];
  let title: string;
  let body: string;
  if (items.length === 1) {
    title = top.kind === 'needs' ? `${top.name} needs you` : top.kind === 'error' ? `${top.name} hit an error` : `${top.name} finished`;
    body = top.detail || (top.kind === 'done' ? 'Ready for the next step.' : 'Open Sinnect to see what happened.');
  } else {
    const needs = items.filter((x) => x.kind === 'needs').length;
    const names = [...new Set(items.map((x) => x.name))];
    title = needs ? `${needs === 1 ? top.name + ' needs you' : `${needs} sessions need you`}` : `${names.length} sessions finished`;
    body = names.slice(0, 4).join(', ') + (names.length > 4 ? ` and ${names.length - 4} more` : '');
  }
  show(title, body, `${top.kind}:${top.sessionId}`);
}

export async function show(title: string, body: string, tag: string | null, force = false) {
  if (inTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('notify', { title, body, session: tag, force });
      return;
    } catch {
      /* no native notifications here: fall through to the browser one */
    }
  }
  if (!force && document.hasFocus()) return;
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') await Notification.requestPermission().catch(() => 'denied');
  if (Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, icon: '/sinnect.svg' });
  n.onclick = () => {
    window.focus();
    openFromTag(tag);
  };
}

function openFromTag(tag: string | null) {
  if (!tag) return;
  const i = tag.indexOf(':');
  const kind = tag.slice(0, i);
  const id = tag.slice(i + 1);
  if (useApp.getState().sessions[id]) requestFocus(id, kind === 'done' || kind === 'error');
}

export function testNotification() {
  show('Notifications are on', "You'll get one like this when a session finishes or needs you while Sinnect is in the background.", null, true);
}

let started = false;

export function startNotifications() {
  if (started) return;
  started = true;

  if (inTauri()) {
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<string | null>('toast-click', (e) => openFromTag(e.payload)))
      .catch(() => {});
  }

  useApp.subscribe((s, old) => {
    if (s.sessions !== old.sessions) {
      for (const st of Object.values(s.sessions) as SessionState[]) {
        const before = old.sessions[st.id]?.status;
        if (!before || before === st.status || s.dormant[st.id]) continue;
        // Helpers report to their boss, not to you.
        if (st.config.parentId) continue;
        const name = st.config.name;
        if ((before === 'thinking' || before === 'working') && st.status === 'idle') {
          push({ kind: 'done', sessionId: st.id, name, detail: clip(lastReply(st.id) || st.goal || st.activity) });
        } else if (st.status === 'error') {
          push({ kind: 'error', sessionId: st.id, name, detail: clip(st.error ?? '') });
        }
      }
    }
    if (s.prompts !== old.prompts) {
      const had = new Set(old.prompts.map((p) => p.requestId));
      for (const p of s.prompts) {
        if (had.has(p.requestId)) continue;
        const name = (s.sessions[p.sessionId] ?? s.parked[p.sessionId])?.config.name ?? 'A session';
        push({ kind: 'needs', sessionId: p.sessionId, name, detail: clip(promptDetail(p)) });
      }
    }
  });
}
