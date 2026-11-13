import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { safeName, type EngineMsg, type SessionState } from '../src/protocol.js';

test('safeName keeps letters of any language, replaces the rest', () => {
  assert.equal(safeName('Müşteri işleri'), 'Müşteri işleri');
  assert.equal(safeName('v1.2 / plan'), 'v1_2 _ plan');
  assert.equal(safeName('../../etc'), '_etc');
  assert.equal(safeName('???'), '_');
  assert.equal(safeName(''), 'workspace');
});

test('safeName does not change a name it already produced', () => {
  for (const name of ['Müşteri işleri', 'v1.2 / plan', '../../etc', '???', '']) assert.equal(safeName(safeName(name)), safeName(name));
});

test('Engine: save, list and delete workspaces by the listed name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-ws-'));
  const sent: EngineMsg[] = [];
  const engine = new Engine({ dataDir: dir, mock: true, broadcast: (m) => sent.push(m) });
  const listed = () => (sent.findLast((m) => m.t === 'workspace.list') as Extract<EngineMsg, { t: 'workspace.list' }>).items.map((i) => i.name).sort();

  for (const name of ['hello', 'Müşteri işleri', 'v1.2 plan']) await engine.handle({ t: 'workspace.save', name, data: { sessions: [] } });
  assert.deepEqual(listed(), ['Müşteri işleri', 'hello', 'v1_2 plan']);

  for (const name of listed()) await engine.handle({ t: 'workspace.delete', name });
  assert.deepEqual(listed(), []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'workspaces')), []);
  await engine.shutdown();
});

test('Engine: the workspace list carries each file\'s board id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-ws-'));
  const sent: EngineMsg[] = [];
  const engine = new Engine({ dataDir: dir, mock: true, broadcast: (m) => sent.push(m) });
  await engine.handle({ t: 'workspace.save', name: 'base9', data: { id: 'w_a', sessions: [] } });
  await engine.handle({ t: 'workspace.save', name: 'old', data: { sessions: [] } });
  const items = (sent.findLast((m) => m.t === 'workspace.list') as Extract<EngineMsg, { t: 'workspace.list' }>).items;
  assert.equal(items.find((i) => i.name === 'base9')!.id, 'w_a');
  assert.equal(items.find((i) => i.name === 'old')!.id, null);
  await engine.shutdown();
});

test('Engine: helpers join their boss\'s workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-ws-'));
  const states = new Map<string, SessionState>();
  const engine: Engine = new Engine({
    dataDir: dir,
    mock: true,
    broadcast: (m) => {
      if (m.t === 'session.state') states.set(m.state.id, m.state);
      if (m.t === 'prompt.open') {
        const p = m.prompt;
        setTimeout(() => engine.handle({ t: 'prompt.respond', response: p.kind === 'question' ? { requestId: p.requestId, kind: 'question', answers: {}, skipped: true } : { requestId: p.requestId, kind: 'tool', decision: 'allow' } }), 5);
      }
    },
  });
  await engine.handle({ t: 'settings.set', patch: { memoryEnabled: false } });
  await engine.handle({
    t: 'session.create',
    id: 'boss',
    config: { name: 'Lead', cwd: '/tmp/shop', model: 'claude-opus-5-5', prompt: 'Split this up with helpers: fix checkout totals', priority: 4, awareness: 'family', permission: 'auto', workspace: 'w_shop' },
  });
  for (let t = 0; t < 40_000 && (states.get('boss')?.turns ?? 0) < 1; t += 50) await new Promise((r) => setTimeout(r, 50));
  const helpers = [...states.values()].filter((s) => s.config.parentId === 'boss');
  assert.ok(helpers.length > 0, 'the boss spawned helpers');
  for (const h of helpers) assert.equal(h.config.workspace, 'w_shop');
  await engine.shutdown();
});
