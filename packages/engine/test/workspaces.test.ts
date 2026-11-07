import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine, safeName } from '../src/engine.js';
import type { EngineMsg } from '../src/protocol.js';

test('safeName keeps letters of any language, replaces the rest', () => {
  assert.equal(safeName('Müşteri işleri'), 'Müşteri işleri');
  assert.equal(safeName('v1.2 / plan'), 'v1_2 _ plan');
  assert.equal(safeName('../../etc'), '_etc');
  assert.equal(safeName('???'), '_');
  assert.equal(safeName(''), 'workspace');
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
