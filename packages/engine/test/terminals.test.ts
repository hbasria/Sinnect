import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadNodePty, Terminals, type Pty, type SpawnPty } from '../src/terminals.js';
import type { EngineMsg } from '../src/protocol.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A shell that echoes input, so tests see the whole round trip. */
function fakeShell() {
  const spawned: { shell: string; cwd: string; cols: number; rows: number; env: Record<string, string> }[] = [];
  const ptys: (Pty & { emit(d: string): void; exit(code: number): void; size: [number, number]; killed: boolean })[] = [];
  const spawn: SpawnPty = (shell, _args, opts) => {
    spawned.push({ shell, ...opts });
    let onData = (_: string) => {};
    let onExit = (_: { exitCode: number }) => {};
    const p = {
      size: [opts.cols, opts.rows] as [number, number],
      killed: false,
      onData: (cb: (d: string) => void) => void (onData = cb),
      onExit: (cb: (e: { exitCode: number }) => void) => void (onExit = cb),
      write: (d: string) => onData(`echo:${d}`),
      resize: (c: number, r: number) => void (p.size = [c, r]),
      kill: () => void (p.killed = true),
      emit: (d: string) => onData(d),
      exit: (code: number) => onExit({ exitCode: code }),
    };
    ptys.push(p);
    return p;
  };
  return { spawn, spawned, ptys };
}

function terminals(spawn: SpawnPty | null = fakeShell().spawn) {
  const sent: EngineMsg[] = [];
  const t = new Terminals({ spawn, unavailable: spawn ? null : 'off', send: (m) => sent.push(m), shell: () => ({ shell: '/bin/sh', args: [] }) });
  return { t, sent, of: <T extends EngineMsg['t']>(k: T) => sent.filter((m) => m.t === k) as Extract<EngineMsg, { t: T }>[] };
}

test('opens a shell in the folder, streams batched output, echoes input', async () => {
  const shell = fakeShell();
  const { t, of } = terminals(shell.spawn);
  t.open('t1', os.tmpdir(), 100, 30);
  t.open('t1', os.tmpdir(), 100, 30); // same id again: ignored
  assert.equal(shell.spawned.length, 1);
  assert.equal(shell.spawned[0].cwd, os.tmpdir());
  assert.equal(shell.spawned[0].env.TERM, 'xterm-256color');
  assert.equal(of('term.opened')[0].terminal.alive, true);

  shell.ptys[0].emit('a');
  shell.ptys[0].emit('b');
  t.input('t1', 'ls\r');
  await wait(40);
  assert.deepEqual(
    of('term.data').map((m) => m.data),
    ['abecho:ls\r'],
  );
  assert.equal(t.snapshot()[0].buffer, 'abecho:ls\r');
});

test('a missing folder opens in the home folder, says so, and is named after where it opened', async () => {
  const shell = fakeShell();
  const { t, of } = terminals(shell.spawn);
  t.open('t1', '/no/such/folder', 80, 24, 'folder');
  assert.equal(shell.spawned[0].cwd, os.homedir());
  await wait(40);
  assert.match(of('term.data')[0].data, /no\/such\/folder doesn't exist/);
  assert.equal(of('term.opened')[0].terminal.title, path.basename(os.homedir()));
});

test('resize, exit and close', async () => {
  const shell = fakeShell();
  const { t, of } = terminals(shell.spawn);
  t.open('t1', '~', 80, 24);
  assert.equal(shell.spawned[0].cwd, os.homedir());
  t.resize('t1', 120, 0);
  assert.deepEqual(shell.ptys[0].size, [120, 24]);

  shell.ptys[0].exit(3);
  assert.deepEqual(of('term.exit'), [{ t: 'term.exit', id: 't1', exitCode: 3 }]);
  assert.equal(t.snapshot()[0].alive, false);

  t.close('t1');
  assert.equal(shell.ptys[0].killed, false, 'an exited shell is not killed again');
  assert.deepEqual(of('term.closed'), [{ t: 'term.closed', id: 't1' }]);
  assert.deepEqual(t.snapshot(), []);
});

test('without a backend, opening says why instead of crashing', () => {
  const { t, of } = terminals(null);
  t.open('t1', '~', 80, 24);
  assert.equal(of('toast')[0].text, 'off');
  assert.deepEqual(t.snapshot(), []);
});

test('real node-pty: runs a command in the folder', { skip: process.platform === 'win32' }, async () => {
  const pty = loadNodePty();
  assert.ok('spawn' in pty, 'error' in pty ? pty.error : '');
  const sent: EngineMsg[] = [];
  const t = new Terminals({ spawn: pty.spawn, unavailable: null, send: (m) => sent.push(m), shell: () => ({ shell: '/bin/sh', args: ['-c', 'pwd; tput cols'] }) });
  t.open('t1', os.tmpdir(), 77, 20);
  const end = Date.now() + 5000;
  while (!sent.some((m) => m.t === 'term.exit') && Date.now() < end) await wait(20);
  const out = t.snapshot()[0].buffer;
  assert.match(out, /77/);
  assert.ok(out.includes(os.tmpdir().replace(/^\/private/, '')) || out.includes(os.tmpdir()), out);
  t.closeAll();
});
