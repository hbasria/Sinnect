// A tiny in-memory Matrix homeserver for tests: just the endpoints the bridge uses.
// `fetch` plugs straight into MatrixBridge / Engine({ fetch }).

type Json = Record<string, any>;

export class FakeHomeserver {
  sent: { roomId: string; content: Json }[] = [];
  typing: { roomId: string; typing: boolean }[] = [];
  joined: string[] = [];
  private pending: Json[] = [];
  private wake: (() => void) | null = null;
  private seq = 0;

  constructor(
    readonly userId = '@bot:hs',
    readonly token = 'secret',
    readonly rooms: Record<string, string> = { '!general:hs': 'General' },
    readonly displayName = 'Bot',
  ) {}

  /** A new message in a room; returns its event id. */
  message(roomId: string, sender: string, content: Json): string {
    const event_id = `$e${++this.seq}`;
    this.push({ join: { [roomId]: { timeline: { events: [{ type: 'm.room.message', event_id, sender, content }] } } } });
    return event_id;
  }

  invite(roomId: string, sender: string) {
    this.push({ invite: { [roomId]: { invite_state: { events: [{ type: 'm.room.member', state_key: this.userId, sender, content: { membership: 'invite' } }] } } } });
  }

  private push(rooms: Json) {
    this.pending.push(rooms);
    this.wake?.();
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.replace('/_matrix/client/v3', ''));
    const method = init.method ?? 'GET';
    const reply = (data: Json, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (new Headers(init.headers).get('authorization') !== `Bearer ${this.token}`) return reply({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid token' }, 401);

    if (path === '/account/whoami') return reply({ user_id: this.userId });
    if (path.startsWith('/profile/')) return reply({ displayname: this.displayName });
    if (path === '/sync') {
      if (!url.searchParams.get('since')) {
        const join = Object.fromEntries(Object.entries(this.rooms).map(([id, name]) => [id, { state: { events: [{ type: 'm.room.name', event_id: `$n${id}`, sender: '@admin:hs', state_key: '', content: { name } }] }, timeline: { events: [] } }]));
        return reply({ next_batch: 'b0', rooms: { join } });
      }
      if (!this.pending.length) {
        await new Promise<void>((resolve, reject) => {
          this.wake = resolve;
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
        this.wake = null;
      }
      const batch = this.pending.splice(0);
      const rooms: Json = { join: {}, invite: {} };
      for (const b of batch) {
        Object.assign(rooms.invite, b.invite);
        // Several messages to one room in a batch share its timeline.
        for (const [id, r] of Object.entries<Json>(b.join ?? {})) (rooms.join[id] ??= { timeline: { events: [] } }).timeline.events.push(...r.timeline.events);
      }
      return reply({ next_batch: `b${++this.seq}`, rooms });
    }
    let m = /^\/rooms\/([^/]+)\/send\/m\.room\.message\/[^/]+$/.exec(path);
    if (m && method === 'PUT') {
      this.sent.push({ roomId: m[1], content: JSON.parse(String(init.body)) });
      return reply({ event_id: `$s${++this.seq}` });
    }
    m = /^\/rooms\/([^/]+)\/typing\//.exec(path);
    if (m && method === 'PUT') {
      this.typing.push({ roomId: m[1], typing: JSON.parse(String(init.body)).typing });
      return reply({});
    }
    m = /^\/rooms\/([^/]+)\/join$/.exec(path);
    if (m && method === 'POST') {
      this.joined.push(m[1]);
      return reply({ room_id: m[1] });
    }
    return reply({ errcode: 'M_UNRECOGNIZED', error: `No fake for ${method} ${path}` }, 404);
  };
}
