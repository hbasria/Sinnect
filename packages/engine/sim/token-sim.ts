// Token drain simulator. Runs the real Hub + BaseSession wake logic with fake
// "agents" instead of Claude, and counts how many model turns and requests a
// board of wired sessions burns. Run: npx tsx sim/token-sim.ts
//
// The fake agents are deliberately worst case: they reply to every hub
// message they get (thanks / done / noted) and always ask to wake the other
// side. Real Claude does a softer version of this, which is exactly the drain.

import { Hub } from '../src/hub.js';
import { BaseSession, type SessionHost } from '../src/session.js';
import type { EngineSettings, SessionConfig } from '../src/protocol.js';

const BASE_CTX = 22_000; // Claude Code system prompt + tools, roughly
const CTX_GROWTH = 2_500; // context added per turn (tool output, replies)

class SimSession extends BaseSession {
  requests = 0;
  tokens = 0;
  wokenTurns = 0;
  protected wakeBatchMs = 20;
  start() {
    this.setStatus('idle', 'Waiting for you');
  }
  async interrupt() {}
  protected async shutdown() {}
  protected pushInput(t: string) {
    setImmediate(() => this.turn(t));
  }
  private request() {
    // Every model request re-reads the whole context (cached or not, it counts).
    this.requests += 1;
    this.tokens += BASE_CTX + CTX_GROWTH * this.state.turns;
  }
  private turn(t: string) {
    if (this.closed) return;
    const fromHub = t.includes('[Sinnect hub]');
    if (fromHub) this.wokenTurns += 1;
    this.request();
    const hub = this.host.hub;
    const send = (to: string, text: string) => {
      this.request(); // the hub_send tool call is another round trip
      (hub.send as (...a: unknown[]) => unknown)(this.id, to, text, { wake: true, depth: this.turnDepth });
    };
    if (!fromHub && this.config.name === 'Lead') {
      for (const p of hub.visibleTo(this.id)) send(p.id, `Please build your part of session templates.`);
    }
    // Reply to every message (worst case polite agent).
    for (const m of t.matchAll(/- from [^(]+\((\w+)\): (.*)/g)) {
      const [, from, body] = m;
      if (from === 'hub') continue;
      send(from, /please/i.test(body) ? 'Done with my part.' : 'Thanks, noted!');
    }
    this.onTurnEnd();
  }
}

export async function simulate(label: string, extra: Partial<EngineSettings> = {}) {
  const sessions = new Map<string, SimSession>();
  const settings = {
    maxMessageChars: 500,
    maxMessagesPerHour: 30,
    maxNegotiationRounds: 2,
    ...extra,
  } as EngineSettings;
  const hub: Hub = new Hub({
    sessions: () =>
      [...sessions.values()].map((s) => ({
        id: s.id, name: s.config.name, priority: s.config.priority, familyId: 'fam', awareness: 'family' as const,
        goal: s.state.goal, status: s.state.status, activity: s.state.activity,
      })),
    links: () => [],
    limits: () => settings,
    deliver: (msg, wake) => sessions.get(msg.to)?.deliver(msg, wake),
    openPrompt: () => {}, closePrompt: () => {}, claimsChanged: () => {}, messageLogged: () => {},
  });
  const host: SessionHost = {
    hub, settings: () => settings, apiKey: () => null, state: () => {}, feedAdd: () => {}, feedDelta: () => {},
    ask: async () => ({ requestId: '', kind: 'tool', decision: 'deny' }),
    nameOf: (id) => sessions.get(id)?.config.name ?? id, agentPrompt: () => null, coordinatorPrompt: () => '', spawn: () => ({ ok: false, error: 'no spawning in the sim' }), turnDone: () => {}, matrixReply: () => {}, matrixTyping: () => {},
  };
  for (const name of ['Lead', 'UI', 'Engine', 'Reviewer']) {
    const cfg: SessionConfig = { name, cwd: '/tmp', model: 'opus', prompt: '', priority: 3, awareness: 'family', permission: 'auto', familyId: 'fam' };
    const s = new SimSession(name.toLowerCase(), cfg, host);
    sessions.set(s.id, s);
    s.start();
  }
  sessions.get('lead')!.send('Build session templates with the team.');
  // Let it run until nothing happens for a while (or 5s of wall time).
  let last = -1;
  let still = 0;
  for (let i = 0; i < 500 && still < 10; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const total = [...sessions.values()].reduce((a, s) => a + s.requests, 0);
    still = total === last ? still + 1 : 0;
    last = total;
  }
  const rows = [...sessions.values()].map((s) => ({ session: s.config.name, turns: s.state.turns, wokenByHub: s.wokenTurns, requests: s.requests, tokens: s.tokens }));
  const sum = rows.reduce((a, r) => ({ turns: a.turns + r.turns, woken: a.woken + r.wokenByHub, requests: a.requests + r.requests, tokens: a.tokens + r.tokens }), { turns: 0, woken: 0, requests: 0, tokens: 0 });
  for (const s of sessions.values()) await s.stop();
  return { label, rows, sum, messages: hub.log.filter((m) => m.kind === 'message').length };
}

if (process.argv[1]?.endsWith('token-sim.ts')) {
  const r = await simulate('current');
  console.table(r.rows);
  console.log(r.label, { ...r.sum, hubMessages: r.messages, tokensM: (r.sum.tokens / 1e6).toFixed(2) + 'M' });
}
