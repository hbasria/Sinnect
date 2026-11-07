// Matrix chat bridge. Each session can have its own Matrix account: the bridge
// listens to the rooms that account is in and turns mentions from allowed users
// into turns, and the session's reply goes back into a thread. Plain
// client-server API over fetch, so unencrypted rooms only.

import type { MatrixOrigin, MatrixStatus } from './protocol.js';

export interface BridgeHooks {
  /** A mention from an allowed user, or a follow-up in one of the bot's threads. */
  message(text: string, origin: MatrixOrigin): void;
  status(s: MatrixStatus): void;
  /** The token works and belongs to `userId`. Called once, before listening starts. */
  authed(userId: string): void;
  /** Matrix ids of the other Sinnect sessions. Their messages are ignored: sessions talk through the hub. */
  peers(): Set<string>;
}

/** Biggest message body we send. Matrix caps whole events at 64 KiB. */
const MAX_BODY = 30_000;
const TYPING_MS = 30_000;
const ROOM_STATE = ['m.room.name', 'm.room.canonical_alias'];
const filter = (limit: number) =>
  JSON.stringify({
    presence: { types: [] },
    account_data: { types: [] },
    room: { state: { types: ROOM_STATE }, timeline: { types: ['m.room.message', ...ROOM_STATE], limit }, ephemeral: { types: [] }, account_data: { types: [] } },
  });

export class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

type Ev = { type: string; event_id: string; sender: string; state_key?: string; content: Record<string, any> };

export class MatrixBridge {
  userId: string | null = null;
  private displayName = '';
  private readonly homeserver: string;
  private since: string | null = null;
  private abort = new AbortController();
  private stopped = false;
  private state: MatrixStatus = { state: 'off', userId: null, rooms: [] };
  private rooms = new Map<string, { name: string; alias: string }>();
  /** Thread roots the bot has answered in: follow-ups there need no mention. */
  private threads = new Set<string>();
  private typing = new Map<string, ReturnType<typeof setInterval>>();
  private txn = 0;

  constructor(
    homeserver: string,
    private token: string,
    /** Who may talk to the bot. Key '*' = every room, else a room id. */
    public allowed: Record<string, string[]>,
    private hooks: BridgeHooks,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.homeserver = homeserver.trim().replace(/\/+$/, '');
  }

  get status() {
    return this.state;
  }

  async start() {
    this.setStatus({ state: 'connecting' });
    try {
      const me = await this.api('GET', '/account/whoami');
      this.userId = String(me.user_id);
      this.hooks.authed(this.userId);
      const profile = await this.api('GET', `/profile/${encodeURIComponent(this.userId)}/displayname`).catch(() => ({}));
      this.displayName = String(profile.displayname ?? '');
      // The first sync only learns the rooms and where "now" is, so old messages never get answered.
      const first = await this.api('GET', `/sync?timeout=0&filter=${encodeURIComponent(filter(0))}`);
      this.absorb(first, false);
      this.since = first.next_batch;
      this.setStatus({ state: 'online', error: undefined });
    } catch (err) {
      if (!this.stopped) this.setStatus({ state: 'error', error: describe(err) });
      return;
    }
    void this.loop();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    for (const t of this.typing.values()) clearInterval(t);
    this.typing.clear();
    this.setStatus({ state: 'off', error: undefined });
  }

  private async loop() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const res = await this.api('GET', `/sync?since=${encodeURIComponent(this.since!)}&timeout=30000&filter=${encodeURIComponent(filter(50))}`);
        if (this.stopped) return;
        this.since = res.next_batch;
        this.absorb(res, true);
        if (this.state.state !== 'online') this.setStatus({ state: 'online', error: undefined });
        backoff = 1000;
      } catch (err) {
        if (this.stopped) return;
        this.setStatus({ state: 'error', error: describe(err) });
        // A rejected token won't start working by itself.
        if (err instanceof MatrixError && err.status === 401) return;
        await sleep(backoff, this.abort.signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Who may talk to the bot in this room. */
  isAllowed(sender: string, roomId: string) {
    const who = sender.toLowerCase();
    return [...(this.allowed['*'] ?? []), ...(this.allowed[roomId] ?? [])].some((u) => u.trim().toLowerCase() === who);
  }

  private absorb(res: any, live: boolean) {
    let changed = false;
    for (const [roomId, room] of Object.entries<any>(res.rooms?.invite ?? {})) {
      const invite = (room.invite_state?.events ?? []).find((e: Ev) => e.type === 'm.room.member' && e.state_key === this.userId);
      // Only join when someone allowed asked, so strangers can't pull the bot into their rooms.
      if (invite && this.isAllowed(invite.sender, roomId)) {
        this.api('POST', `/rooms/${encodeURIComponent(roomId)}/join`, {}).catch(() => {});
      }
    }
    for (const [roomId, room] of Object.entries<any>(res.rooms?.join ?? {})) {
      const known = this.rooms.get(roomId) ?? { name: '', alias: '' };
      if (!this.rooms.has(roomId)) changed = true;
      for (const ev of [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])] as Ev[]) {
        if (ev.type === 'm.room.name' && ev.content.name !== known.name) (known.name = String(ev.content.name ?? '')), (changed = true);
        if (ev.type === 'm.room.canonical_alias' && ev.content.alias !== known.alias) (known.alias = String(ev.content.alias ?? '')), (changed = true);
      }
      this.rooms.set(roomId, known);
      if (live) for (const ev of (room.timeline?.events ?? []) as Ev[]) if (ev.type === 'm.room.message') this.onMessage(roomId, ev);
    }
    for (const roomId of Object.keys(res.rooms?.leave ?? {})) changed = this.rooms.delete(roomId) || changed;
    if (changed) this.setStatus({});
  }

  private onMessage(roomId: string, ev: Ev) {
    const me = this.userId!;
    if (ev.sender === me || this.hooks.peers().has(ev.sender)) return;
    const c = ev.content;
    // m.notice is what bots send; edits arrive as new events carrying m.new_content.
    if (c.msgtype !== 'm.text' || c['m.new_content'] || typeof c.body !== 'string') return;
    const rel = c['m.relates_to'];
    const threadRoot: string | null = rel?.rel_type === 'm.thread' ? rel.event_id : null;
    const body: string = c.body;
    const local = me.slice(1).split(':')[0];
    // A bare word never counts ("the backend is down"): only a real mention, "@name", or "Display name: …".
    const mentioned =
      (Array.isArray(c['m.mentions']?.user_ids) && c['m.mentions'].user_ids.includes(me)) ||
      body.toLowerCase().includes(me.toLowerCase()) ||
      new RegExp(`(^|\\s)@${escapeRe(local)}\\b`, 'i').test(body) ||
      (!!this.displayName && new RegExp(`^${escapeRe(this.displayName)}\\s*:`, 'i').test(body));
    if (!mentioned && !(threadRoot && this.threads.has(threadRoot))) return;
    if (!this.isAllowed(ev.sender, roomId)) return;
    const root = threadRoot ?? ev.event_id;
    this.threads.add(root);
    // Replies carry the quoted original as "> " lines first; the session only needs the new text.
    const text = rel?.['m.in_reply_to'] ? body.replace(/^(> .*\n?)+\n?/, '') : body;
    this.hooks.message(text.trim(), { roomId, roomName: this.roomName(roomId), eventId: ev.event_id, threadRoot: root, sender: ev.sender });
  }

  /** Post the session's answer into the thread the question came from. */
  async reply(origin: MatrixOrigin, text: string) {
    const body = text.trim() || '(no reply)';
    for (let i = 0; i < body.length; i += MAX_BODY) {
      const content = {
        msgtype: 'm.text',
        body: body.slice(i, i + MAX_BODY),
        'm.mentions': { user_ids: [origin.sender] },
        'm.relates_to': { rel_type: 'm.thread', event_id: origin.threadRoot, is_falling_back: true, 'm.in_reply_to': { event_id: origin.eventId } },
      };
      const txn = `sinnect${Date.now().toString(36)}${(this.txn++).toString(36)}`;
      await this.api('PUT', `/rooms/${encodeURIComponent(origin.roomId)}/send/m.room.message/${txn}`, content);
    }
  }

  /** "Is typing…" in a room while a turn for it runs. Refreshed until turned off. */
  setTyping(roomId: string, on: boolean) {
    const send = (typing: boolean) =>
      this.api('PUT', `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.userId ?? '')}`, typing ? { typing, timeout: TYPING_MS } : { typing }).catch(() => {});
    clearInterval(this.typing.get(roomId));
    this.typing.delete(roomId);
    if (this.stopped || !this.userId) return;
    void send(on);
    if (on) this.typing.set(roomId, setInterval(() => void send(true), TYPING_MS - 5000));
  }

  private roomName(roomId: string) {
    const r = this.rooms.get(roomId);
    return r?.name || r?.alias || roomId;
  }

  private setStatus(patch: Partial<MatrixStatus>) {
    this.state = {
      ...this.state,
      ...patch,
      userId: this.userId,
      rooms: [...this.rooms].map(([id]) => ({ id, name: this.roomName(id) })).sort((a, b) => a.name.localeCompare(b.name)),
    };
    this.hooks.status(this.state);
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.homeserver}/_matrix/client/v3${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.abort.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429 && attempt < 3) {
        await sleep(Math.min(Number(data.retry_after_ms) || 1000, 30_000), this.abort.signal);
        continue;
      }
      if (!res.ok) throw new MatrixError(res.status, data.errcode ?? '', data.error ?? `HTTP ${res.status}`);
      return data;
    }
  }
}

function describe(err: unknown) {
  if (err instanceof MatrixError) return err.status === 401 ? 'The access token was rejected' : `${err.errcode || 'Error'}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
