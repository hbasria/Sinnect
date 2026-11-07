import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { ONBOARDING_MESSAGE } from '../src/crux.js';
import type { EngineMsg } from '../src/protocol.js';

function demoEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-company-'));
  const sent: EngineMsg[] = [];
  const engine = new Engine({ dataDir: dir, mock: true, broadcast: (m) => sent.push(m) });
  return { engine, sent };
}

const coordinator = { name: 'Coordinator', cwd: '/work/acme/company', model: 'm', prompt: '', priority: 5, awareness: 'everyone' as const, permission: 'ask' as const, coordinator: true };

test('a coordinator gets the onboarding message, but not when resumed', async () => {
  const { engine } = demoEngine();
  engine.createSession('c1', { ...coordinator });
  engine.createSession('c2', { ...coordinator, resumeId: 'sdk-1' });
  const byId = Object.fromEntries(engine.snapshot().sessions.map((s) => [s.id, s.config.prompt]));
  assert.equal(byId.c1, ONBOARDING_MESSAGE);
  assert.equal(byId.c2, '');
  await engine.shutdown();
});

test('spawn starts a linked session in its family, next to the company root', async () => {
  const { engine, sent } = demoEngine();
  engine.createSession('c1', { ...coordinator });

  const a = engine.spawn('c1', { name: 'software', folder: '../software', agent: 'no-such-role', family: 'software', prompt: 'Boot' });
  const b = engine.spawn('c1', { name: 'software', folder: '/abs/ops', family: 'Software' });
  assert.ok(a.ok && b.ok);
  assert.equal(b.name, 'software 2');

  const snap = engine.snapshot();
  const sa = snap.sessions.find((s) => s.id === a.id)!;
  const sb = snap.sessions.find((s) => s.id === b.id)!;
  assert.equal(sa.config.cwd, path.resolve('/work/acme/company', '../software'));
  assert.equal(sb.config.cwd, '/abs/ops');
  // Demo mode drops an agent it doesn't know instead of failing.
  assert.equal(sa.config.agent, null);
  assert.equal(sa.config.awareness, 'family');
  assert.equal(snap.families.length, 1, 'family names match case-insensitively');
  assert.equal(sa.config.familyId, snap.families[0].id);
  assert.equal(sb.config.familyId, snap.families[0].id);
  assert.ok(snap.links.some((l) => l.a === 'c1' && l.b === a.id));
  assert.ok(snap.links.some((l) => l.a === 'c1' && l.b === b.id));

  // The UI places the card on session.spawned, so it must come after the session's first state.
  const firstState = sent.findIndex((m) => m.t === 'session.state' && m.state.id === a.id);
  const spawned = sent.findIndex((m) => m.t === 'session.spawned' && m.id === a.id);
  assert.ok(firstState >= 0 && spawned > firstState);
  await engine.shutdown();
});

test('spawn fails cleanly for a missing parent or an empty name', async () => {
  const { engine } = demoEngine();
  engine.createSession('c1', { ...coordinator });
  assert.equal(engine.spawn('ghost', { name: 'x', folder: '.' }).ok, false);
  assert.equal(engine.spawn('c1', { name: '  ', folder: '.' }).ok, false);
  await engine.shutdown();
});
