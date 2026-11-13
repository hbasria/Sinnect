import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, type HubSessionInfo } from '../src/hub.js';
import type { HubMessage, Link, PromptRequest } from '../src/protocol.js';

function setup(sessions: Partial<HubSessionInfo>[], links: Link[] = []) {
  const list: HubSessionInfo[] = sessions.map((s, i) => ({
    id: s.id ?? `s${i + 1}`,
    name: s.name ?? `S${i + 1}`,
    priority: s.priority ?? 3,
    familyId: s.familyId ?? null,
    workspace: s.workspace ?? null,
    awareness: s.awareness ?? 'everyone',
    goal: s.goal ?? '',
    status: 'working',
    activity: '',
  }));
  const delivered: { msg: HubMessage; wake: boolean }[] = [];
  const prompts: PromptRequest[] = [];
  const closed: string[] = [];
  const hub = new Hub({
    sessions: () => list,
    links: () => links,
    limits: () => ({ maxMessageChars: 50, maxMessagesPerHour: 3, maxNegotiationRounds: 2 }),
    deliver: (msg, wake) => delivered.push({ msg, wake }),
    openPrompt: (p) => prompts.push(p),
    closePrompt: (id) => closed.push(id),
    claimsChanged: () => {},
    messageLogged: () => {},
  });
  return { hub, list, delivered, prompts, closed };
}

test('free files are claimed silently', () => {
  const { hub, delivered } = setup([{}, {}]);
  assert.deepEqual(hub.requestEdit('s1', '/a.ts'), { ok: true });
  assert.equal(hub.holder('/a.ts'), 's1');
  assert.equal(delivered.length, 0);
});

test('higher priority takes the file and the holder is told', () => {
  const { hub, delivered } = setup([{ priority: 2 }, { priority: 4 }]);
  hub.requestEdit('s1', '/a.ts');
  const r = hub.requestEdit('s2', '/a.ts');
  assert.equal(r.ok, true);
  assert.equal(hub.holder('/a.ts'), 's2');
  assert.equal(delivered.at(-1)!.msg.to, 's1');
  // releasing wakes the bumped session
  hub.release('s2');
  assert.match(delivered.at(-1)!.msg.text, /free now/);
  assert.equal(delivered.at(-1)!.msg.to, 's1');
});

test('lower priority is blocked and queued', () => {
  const { hub, delivered } = setup([{ priority: 5 }, { priority: 1 }]);
  hub.requestEdit('s1', '/a.ts');
  const r = hub.requestEdit('s2', '/a.ts');
  assert.equal(r.ok, false);
  hub.release('s1', ['/a.ts']);
  assert.equal(delivered.at(-1)!.msg.to, 's2');
  assert.equal(delivered.at(-1)!.wake, true);
});

test('same priority negotiates, a yield settles it', () => {
  const { hub, delivered } = setup([{}, {}]);
  hub.requestEdit('s1', '/a.ts');
  const r = hub.requestEdit('s2', '/a.ts');
  assert.equal(r.ok, false);
  const negMsg = delivered.find((d) => d.msg.kind === 'negotiation')!;
  const negId = /Negotiation (\S+):/.exec(negMsg.msg.text)![1];
  hub.negotiate('s1', negId, 'yield', 'almost done anyway');
  assert.equal(hub.holder('/a.ts'), 's2');
});

test('both insisting past the round cap asks the user', () => {
  const { hub, delivered, prompts, closed } = setup([{}, {}]);
  hub.requestEdit('s1', '/a.ts');
  hub.requestEdit('s2', '/a.ts');
  const negId = /Negotiation (\S+):/.exec(delivered.find((d) => d.msg.kind === 'negotiation')!.msg.text)![1];
  hub.negotiate('s1', negId, 'insist', 'mine');
  hub.negotiate('s2', negId, 'insist', 'no mine');
  assert.equal(prompts.length, 0); // round 2 starts
  hub.negotiate('s1', negId, 'insist', 'mine');
  hub.negotiate('s2', negId, 'insist', 'no mine');
  assert.equal(prompts.length, 1);
  hub.decide(prompts[0].requestId, 's2');
  assert.equal(hub.holder('/a.ts'), 's2');
  assert.deepEqual(closed, [prompts[0].requestId]);
});

test('solo sessions skip negotiation and go to the user', () => {
  const { hub, prompts } = setup([{ awareness: 'solo' }, {}]);
  hub.requestEdit('s1', '/a.ts');
  hub.requestEdit('s2', '/a.ts');
  assert.equal(prompts.length, 1);
});

test('awareness limits the roster', () => {
  const { hub } = setup(
    [{ awareness: 'family', familyId: 'f1' }, { familyId: 'f1' }, { familyId: 'f2' }, {}],
    [{ id: 'l', a: 's1', b: 's4' }],
  );
  assert.deepEqual(hub.visibleTo('s1').map((s) => s.id), ['s2', 's4']);
  assert.equal(hub.visibleTo('s4').length, 3);
});

test('messages are capped and rate limited', () => {
  const { hub, delivered } = setup([{}, {}]);
  assert.equal(hub.send('s1', 's2', 'x'.repeat(200)).ok, true);
  assert.equal(delivered[0].msg.text.length, 50);
  hub.send('s1', 's2', 'a');
  hub.send('s1', 's2', 'b');
  assert.equal(hub.send('s1', 's2', 'c').ok, false);
  assert.equal(hub.inbox('s2').length, 3);
  assert.equal(hub.inbox('s2').length, 0);
});

test('forget hands negotiations to the survivor', () => {
  const { hub } = setup([{}, {}]);
  hub.requestEdit('s1', '/a.ts');
  hub.requestEdit('s2', '/a.ts');
  hub.forget('s1');
  assert.equal(hub.holder('/a.ts'), 's2');
});

test('releasing a negotiated file hands it to the other side', () => {
  const { hub, delivered } = setup([{}, {}]);
  hub.requestEdit('s1', '/a.ts');
  hub.requestEdit('s2', '/a.ts');
  hub.release('s1');
  assert.equal(hub.holder('/a.ts'), 's2');
  assert.match(delivered.at(-1)!.msg.text, /You got/);
  assert.equal(hub.openNegotiations().length, 0);
});

test('messages do not wake the receiver unless asked', () => {
  const { hub, delivered } = setup([{}, {}]);
  hub.send('s1', 's2', 'fyi');
  assert.equal(delivered.at(-1)!.wake, false);
  const r = hub.send('s1', 's2', 'do this', { wake: true, depth: 0 });
  assert.equal(r.woke, true);
  assert.equal(delivered.at(-1)!.wake, true);
  assert.equal(delivered.at(-1)!.msg.depth, 1);
});

test('wake chains stop after the limit (no ping-pong)', () => {
  const { hub, delivered } = setup([{}, {}]);
  // s1 (user turn, depth 0) wakes s2 -> depth 1, s2 wakes s1 -> depth 2, s1 tries again -> held
  assert.equal(hub.send('s1', 's2', 'a', { wake: true, depth: 0 }).woke, true);
  assert.equal(hub.send('s2', 's1', 'b', { wake: true, depth: 1 }).woke, true);
  const r = hub.send('s1', 's2', 'c', { wake: true, depth: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.woke, false);
  assert.equal(r.held, 'wake chain limit');
  assert.equal(delivered.at(-1)!.wake, false);
});

test('another workspace is out of sight, whatever the awareness, but files are still shared', () => {
  const { hub } = setup(
    [{ workspace: 'w1' }, { workspace: 'w1' }, { workspace: 'w2', familyId: 'f1' }, { workspace: 'w2', awareness: 'family', familyId: 'f1' }],
    [{ id: 'l', a: 's1', b: 's3' }],
  );
  assert.deepEqual(hub.visibleTo('s1').map((s) => s.id), ['s2']);
  assert.deepEqual(hub.visibleTo('s4').map((s) => s.id), ['s3']);
  // A link drawn before the switch doesn't reach across either.
  assert.equal(hub.send('s1', 's3', 'hi').ok, false);
  // Two boards editing one file still have to settle it.
  hub.requestEdit('s1', '/a.ts');
  assert.equal(hub.requestEdit('s3', '/a.ts').ok, false);
});
