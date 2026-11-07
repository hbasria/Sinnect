// Terminals: real shells (PTYs) the engine runs in a folder and streams to the UI.
// They live in the engine, so a UI reload, or a browser talking to an engine in
// a container, finds the same shells with their recent output.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { EngineMsg, TerminalInfo, TerminalSnapshot } from './protocol.js';

export interface Pty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type SpawnPty = (shell: string, args: string[], opts: { cwd: string; cols: number; rows: number; env: Record<string, string> }) => Pty;

/** Output kept per terminal so a reconnecting UI can redraw it. */
const SCROLLBACK = 200_000;
/** Output is collected this long before it goes out, so a busy shell sends a few messages, not thousands. */
const FLUSH_MS = 16;

/** node-pty, or why it can't be used. Loaded lazily so the engine still runs without it. */
export function loadNodePty(): { spawn: SpawnPty } | { error: string } {
  try {
    const require = createRequire(import.meta.url);
    const dir = path.dirname(require.resolve('node-pty/package.json'));
    // npm skips node-pty's install script by default, and that script is what makes
    // spawn-helper executable. Without it every spawn fails with "posix_spawnp failed".
    for (const sub of ['prebuilds', path.join('build', 'Release')]) {
      for (const file of findFiles(path.join(dir, sub), 'spawn-helper')) {
        try {
          if ((fs.statSync(file).mode & 0o111) === 0) fs.chmodSync(file, 0o755);
        } catch {
          /* read-only install: spawning will say so */
        }
      }
    }
    const pty = require('node-pty');
    return { spawn: (shell, args, opts) => pty.spawn(shell, args, { name: 'xterm-256color', ...opts }) };
  } catch (err) {
    return { error: `Terminals need node-pty: ${err instanceof Error ? err.message : err}` };
  }
}

function findFiles(dir: string, name: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => (e.isDirectory() ? findFiles(path.join(dir, e.name), name) : e.name === name ? [path.join(dir, e.name)] : []));
}

export function defaultShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') return { shell: 'powershell.exe', args: [] };
  // A login shell, so PATH and the user's profile are the same as in their own terminal.
  return { shell: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] };
}

interface Term {
  info: TerminalInfo;
  pty: Pty;
  buffer: string;
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Terminals {
  private terms = new Map<string, Term>();

  constructor(
    private deps: {
      /** null = terminals are off; `unavailable` says why. */
      spawn: SpawnPty | null;
      unavailable: string | null;
      send(msg: EngineMsg): void;
      shell?: () => { shell: string; args: string[] };
    },
  ) {}

  get unavailable() {
    return this.deps.unavailable;
  }

  open(id: string, cwd: string, cols: number, rows: number, title?: string) {
    if (this.terms.has(id)) return;
    if (!this.deps.spawn) {
      this.deps.send({ t: 'toast', level: 'error', text: this.deps.unavailable ?? 'Terminals are not available.' });
      return;
    }
    const wanted = cwd.trim().replace(/^~(?=$|[\\/])/, os.homedir()) || os.homedir();
    const dir = isDir(wanted) ? wanted : os.homedir();
    const { shell, args } = (this.deps.shell ?? defaultShell)();
    const env: Record<string, string> = { ...(process.env as Record<string, string>), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    // The engine's own secrets have no business in a user's shell.
    delete env.SINNECT_TOKEN;
    delete env.SINNECT_API_KEY;
    let pty: Pty;
    try {
      pty = this.deps.spawn(shell, args, { cwd: dir, cols: clampSize(cols, 80), rows: clampSize(rows, 24), env });
    } catch (err) {
      this.deps.send({ t: 'toast', level: 'error', text: `Could not start ${shell}: ${err instanceof Error ? err.message : err}` });
      return;
    }
    // A title named after a missing folder would be misleading once the shell opened somewhere else.
    const name = (dir === wanted && title?.trim()) || path.basename(dir) || dir;
    const info: TerminalInfo = { id, cwd: dir, title: name, alive: true };
    const term: Term = { info, pty, buffer: '', pending: '', timer: null };
    this.terms.set(id, term);
    this.deps.send({ t: 'term.opened', terminal: { ...info } });
    if (dir !== wanted) this.output(term, `\x1b[33m${wanted} doesn't exist, opened in ${dir}\x1b[0m\r\n`);
    pty.onData((data) => this.output(term, data));
    pty.onExit(({ exitCode }) => {
      this.flush(term);
      term.info.alive = false;
      term.info.exitCode = exitCode;
      if (this.terms.get(id) === term) this.deps.send({ t: 'term.exit', id, exitCode });
    });
  }

  input(id: string, data: string) {
    const t = this.terms.get(id);
    if (t?.info.alive) t.pty.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const t = this.terms.get(id);
    if (!t?.info.alive) return;
    try {
      t.pty.resize(clampSize(cols, 80), clampSize(rows, 24));
    } catch {
      /* the shell just exited */
    }
  }

  close(id: string) {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    if (t.timer) clearTimeout(t.timer);
    if (t.info.alive) {
      try {
        t.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.deps.send({ t: 'term.closed', id });
  }

  closeAll() {
    for (const id of [...this.terms.keys()]) this.close(id);
  }

  snapshot(): TerminalSnapshot[] {
    return [...this.terms.values()].map((t) => ({ ...t.info, buffer: t.buffer + t.pending }));
  }

  private output(t: Term, data: string) {
    t.pending += data;
    if (!t.timer) t.timer = setTimeout(() => this.flush(t), FLUSH_MS);
  }

  private flush(t: Term) {
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    if (!t.pending) return;
    const data = t.pending;
    t.pending = '';
    t.buffer = (t.buffer + data).slice(-SCROLLBACK);
    if (this.terms.get(t.info.id) === t) this.deps.send({ t: 'term.data', id: t.info.id, data });
  }
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function clampSize(n: number, fallback: number) {
  return Number.isFinite(n) && n > 0 ? Math.min(1000, Math.max(2, Math.round(n))) : fallback;
}
