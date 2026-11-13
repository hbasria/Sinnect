import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionState } from '../../engine/src/protocol.ts';
import { liveByWorkspace, mergeFamilies, mergeLinks, onBoard, splitSessions } from '../src/workspace-scope.ts';

const st = (id: string, workspace: string | null, status = 'working') => ({ id, status, config: { workspace } }) as unknown as SessionState;

test('sessions split into the open board and the parked rest', () => {
  const { sessions, parked } = splitSessions([st('a', 'w1'), st('b', 'w2'), st('c', null)], 'w1');
  assert.deepEqual(Object.keys(sessions).sort(), ['a', 'c']);
  assert.deepEqual(Object.keys(parked), ['b']);
});

test('a session from before workspaces had ids belongs to the open board', () => {
  assert.equal(onBoard(st('c', null), 'anything'), true);
  assert.equal(onBoard(st('a', 'w1'), 'w2'), false);
});

test('opening a board adds its links and families and keeps the others', () => {
  const live = [{ id: 'l1', a: 'x', b: 'y' }];
  const saved = [{ id: 'l9', a: 'y', b: 'x' }, { id: 'l2', a: 'p', b: 'q' }];
  assert.deepEqual(mergeLinks(live, saved).map((l) => l.id), ['l1', 'l2']);
  const fl = [{ id: 'f1', name: 'ops', color: '#fff' }];
  assert.deepEqual(mergeFamilies(fl, [{ id: 'f1', name: 'ops', color: '#000' }, { id: 'f2', name: 'web', color: '#000' }]).map((f) => f.id), ['f1', 'f2']);
});

test('running sessions are counted per background workspace', () => {
  const parked = { a: st('a', 'w2'), b: st('b', 'w2'), c: st('c', 'w3', 'stopped'), d: st('d', 'w3') };
  assert.deepEqual(liveByWorkspace(parked), { w2: 2, w3: 1 });
});
