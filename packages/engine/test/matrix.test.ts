import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MatrixBridge } from '../src/matrix.js';
import { Engine } from '../src/engine.js';
import type { EngineMsg, MatrixOrigin, MatrixStatus } from '../src/protocol.js';
import { FakeHomeserver } from './fake-homeserver.js';

const ROOM = '!general:hs';
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function bridge(hs: FakeHomeserver, allowed: Record<string, string[]> = { '*': ['@ayse:hs'] }, token = hs.token) {
  const got: { text: string; origin: MatrixOrigin }[] = [];
  const statuses: MatrixStatus[] = [];
  const b = new MatrixBridge(
    'http://hs/',
    token,
    allowed,
    { message: (text, origin) => got.push({ text, origin }), status: (s) => statuses.push(s), authed: () => {}, peers: () => new Set(['@other-agent:hs']) },
    hs.fetch,
  );
  return { b, got, statuses, last: () => statuses.at(-1)! };
}

test('listens to mentions from allowed users only', async () => {
  const hs = new FakeHomeserver();
  const { b, got, last } = bridge(hs);
  await b.start();
  assert.equal(last().state, 'online');
  assert.deepEqual(last().rooms, [{ id: ROOM, name: 'General' }]);

  hs.message(ROOM, '@ayse:hs', { msgtype: 'm.text', body: 'the bot word alone is not a mention' });
  hs.message(ROOM, '@mehmet:hs', { msgtype: 'm.text', body: '@bot are you there?' });
  hs.message(ROOM, '@other-agent:hs', { msgtype: 'm.text', body: '@bot from another session' });
  hs.message(ROOM, '@ayse:hs', { msgtype: 'm.notice', body: '@bot notices are for bots' });
  const asked = hs.message(ROOM, '@ayse:hs', { msgtype: 'm.text', body: '@bot what is the status?' });
  hs.message(ROOM, '@ayse:hs', { msgtype: 'm.text', body: 'pill mention', 'm.mentions': { user_ids: ['@bot:hs'] } });
  hs.message(ROOM, '@ayse:hs', { msgtype: 'm.text', body: 'Bot: display name form' });
  await until(() => got.length === 3);
  assert.equal(got[0].text, '@bot what is the status?');
  assert.deepEqual(got[0].origin, { roomId: ROOM, roomName: 'General', eventId: asked, threadRoot: asked, sender: '@ayse:hs' });
  b.stop();
  assert.equal(last().state, 'off');
});

test('follow-ups in its thread need no mention; replies go into the thread', async () => {
  const hs = new FakeHomeserver();
  const { b, got } = bridge(hs);
  await b.start();
  const root = hs.message(ROOM, '@ayse:hs', { msgtype: 'm.text', body: '@bot start' });
  await until(() => got.length === 1);
  const follow = hs.message(ROOM, '@ayse:hs', {
    msgtype: 'm.text',
    body: '> <@bot:hs> earlier answer\n\nand then?',
    'm.relates_to': { rel_type: 'm.thread', event_id: root, 'm.in_reply_to': { event_id: root } },
  });
  hs.message(ROOM, '@ayse:hs', { msgtype: 'm.text', body: 'someone else thread', 'm.relates_to': { rel_type: 'm.thread', event_id: '$elsewhere' } });
  await until(() => got.length === 2);
  assert.equal(got[1].text, 'and then?');
  assert.equal(got[1].origin.threadRoot, root);

  await b.reply(got[1].origin, 'here it is');
  assert.deepEqual(hs.sent[0], {
    roomId: ROOM,
    content: {
      msgtype: 'm.text',
      body: 'here it is',
      'm.mentions': { user_ids: ['@ayse:hs'] },
      'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true, 'm.in_reply_to': { event_id: follow } },
    },
  });
  b.stop();
});

test('per-room allow lists, joining only when an allowed user invites', async () => {
  const hs = new FakeHomeserver('@bot:hs', 'secret', { [ROOM]: 'General', '!ops:hs': 'Ops' });
  const { b, got } = bridge(hs, { '*': ['@ayse:hs'], '!ops:hs': ['@mehmet:hs'] });
  await b.start();
  hs.message(ROOM, '@mehmet:hs', { msgtype: 'm.text', body: '@bot not here' });
  hs.message('!ops:hs', '@mehmet:hs', { msgtype: 'm.text', body: '@bot but here' });
  hs.invite('!stranger:hs', '@stranger:hs');
  hs.invite('!new:hs', '@ayse:hs');
  await until(() => got.length === 1 && hs.joined.length === 1);
  assert.equal(got[0].origin.roomName, 'Ops');
  assert.deepEqual(hs.joined, ['!new:hs']);

  b.allowed = { '*': ['@ayse:hs', '@mehmet:hs'] };
  hs.message(ROOM, '@mehmet:hs', { msgtype: 'm.text', body: '@bot now allowed everywhere' });
  await until(() => got.length === 2);
  b.stop();
});

test('a rejected token is an error, not a retry loop', async () => {
  const hs = new FakeHomeserver();
  const { b, last } = bridge(hs, undefined, 'wrong');
  await b.start();
  assert.equal(last().state, 'error');
  assert.match(last().error!, /rejected/);
});

test('Engine: a mention starts a turn, the answer goes back to the thread, the token is saved', { timeout: 40_000 }, async () => {
  const hs = new FakeHomeserver();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-matrix-'));
  const engine: Engine = new Engine({
    dataDir: dir,
    mock: true,
    fetch: hs.fetch,
    // The demo session may ask a question or for permission: answer so the turn can finish.
    broadcast: (m: EngineMsg) => {
      if (m.t !== 'prompt.open') return;
      const p = m.prompt;
      setTimeout(() => engine.handle({ t: 'prompt.respond', response: p.kind === 'question' ? { requestId: p.requestId, kind: 'question', answers: {}, skipped: true } : { requestId: p.requestId, kind: 'tool', decision: 'allow' } }));
    },
  });
  engine.createSession('s1', { name: 'Bot', cwd: '/demo', model: 'm', prompt: '', priority: 3, awareness: 'solo', permission: 'auto' });
  await engine.handle({ t: 'matrix.enable', id: 's1', homeserver: 'http://hs', token: 'secret', allowed: { '*': ['@ayse:hs'] } });
  const session = () => engine.snapshot().sessions[0];
  await until(() => session().matrix?.state === 'online');
  assert.deepEqual(session().config.matrix, { homeserver: 'http://hs', userId: '@bot:hs', enabled: true, allowed: { '*': ['@ayse:hs'] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).matrix, { '@bot:hs': 'secret' });

  const asked = hs.message(ROOM, '@ayse:hs', { msgtype: 'm.text', body: '@bot fix the login page' });
  await until(() => hs.sent.length > 0, 35_000);
  assert.equal(hs.sent[0].content['m.relates_to'].event_id, asked);
  assert.ok(hs.sent[0].content.body.length > 0);
  assert.ok(hs.typing.some((t) => t.typing) && hs.typing.at(-1)!.typing === false);
  assert.ok(engine.snapshot().feeds.s1.some((f) => f.kind === 'user' && f.text.includes('[Matrix · General] @ayse:hs')));

  await engine.handle({ t: 'matrix.disable', id: 's1' });
  assert.equal(session().matrix?.state, 'off');
  assert.equal(session().config.matrix?.enabled, false);
  await engine.shutdown();
});
