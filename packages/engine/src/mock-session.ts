// Demo mode: a fake session that behaves like a real one (streams text, calls
// tools, asks permission, hits file conflicts) without spending any tokens.
// Used for UI work, screenshots and trying the app without a login.

import path from 'node:path';
import { BaseSession, describeTool, newItemId } from './session.js';
import type { HubMessage } from './protocol.js';

const FILES = ['src/app.tsx', 'src/api/client.ts', 'src/styles.css', 'src/auth/login.ts', 'README.md', 'src/db/schema.ts'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export class MockSession extends BaseSession {
  private run = 0;
  /** Last streamed text, the turn's answer for Matrix. */
  private lastText = '';
  private freed: (() => void) | null = null;

  start() {
    this.state.sdkSessionId = `mock-${this.id}`;
    this.rolePrompt();
    if (this.config.prompt.trim()) this.send(this.config.prompt);
    else this.setStatus('idle', 'Waiting for you');
  }

  protected pushInput(text: string) {
    const run = ++this.run;
    this.lastText = '';
    this.script(text, run).catch((e) => {
      this.feed('error', String(e), { isError: true });
      this.busy = false;
      this.setStatus('error', 'Mock crashed');
    });
  }

  private alive(run: number) {
    return !this.closed && run === this.run;
  }

  private tokens(input: number, output: number) {
    this.state.tokens.input += input;
    this.state.tokens.output += output;
    this.state.tokens.cacheRead += Math.round(input * 2.5);
    this.state.costUsd += (input * 3 + output * 15 + input * 2.5 * 0.3) / 1_000_000;
    this.publish();
  }

  private async stream(text: string, run: number) {
    const item = this.feed('text', '');
    this.setStatus('working', 'Writing a reply');
    this.lastText = text;
    const words = text.split(/(\s+)/);
    for (const w of words) {
      if (!this.alive(run)) return;
      this.host.feedDelta(this.id, item.id, w);
      if (w.trim()) this.tokens(0, 2);
      await sleep(18 + Math.random() * 40);
    }
  }

  private async useTool(name: string, input: Record<string, unknown>, result: string, run: number) {
    if (!this.alive(run)) return false;
    const line = describeTool(name, input);
    const toolUseId = newItemId();
    this.feed('tool', line, { toolName: name, toolUseId, input });
    this.setStatus('working', line);

    if (this.config.permission === 'ask' && name === 'Bash') {
      this.setStatus('waiting', `Needs your OK: ${name}`);
      const res = await this.host.ask({
        kind: 'tool',
        requestId: newItemId(),
        sessionId: this.id,
        toolName: name,
        title: `${this.config.name} wants to run a command`,
        detail: String(input.command),
        canAlwaysAllow: true,
      });
      if (!this.alive(run)) return false;
      if (res.kind === 'tool' && res.decision === 'deny') {
        this.feed('tool_result', 'The user said no.', { toolUseId, isError: true });
        this.setStatus('working', 'Changing plans');
        return false;
      }
      if (res.kind === 'tool' && res.decision === 'always') this.config.permission = 'acceptEdits';
      this.setStatus('working', line);
    }

    await sleep(500 + Math.random() * 900);
    if (!this.alive(run)) return false;
    this.feed('tool_result', result, { toolUseId });
    this.tokens(300 + Math.round(Math.random() * 900), 40);
    const notice = this.takeNoticeText();
    if (notice) this.feed('system', 'Read hub notices with the tool result');
    return true;
  }

  private async edit(file: string, run: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.alive(run)) return false;
      const abs = path.join(this.config.cwd, file);
      const reason = this.checkEdit('Edit', { file_path: abs });
      if (!reason) {
        await this.useTool('Edit', { file_path: abs, old_string: 'old', new_string: 'new' }, `Updated ${file}`, run);
        await sleep(1500 + Math.random() * 2500); // hold the claim a bit so conflicts can happen
        return true;
      }
      // Wait for a "free now" / "You got" notice, or give up after a while.
      await new Promise<void>((resolve) => {
        this.freed = resolve;
        setTimeout(resolve, 15000);
      });
      this.freed = null;
    }
    this.feed('text', `I'll leave ${file} for now since someone else is working on it.`);
    return false;
  }

  deliver(msg: HubMessage, wake: boolean) {
    super.deliver(msg, wake);
    if (/free now|You got/.test(msg.text)) this.freed?.();
    if (msg.kind === 'negotiation') {
      const m = /(neg_[a-z0-9]+)/.exec(msg.text);
      if (m) {
        const negId = m[1];
        setTimeout(() => {
          if (this.closed) return;
          const yieldIt = Math.random() < 0.5;
          const note = yieldIt ? "I'm nearly done there, go ahead" : 'I am mid-change, need a few more minutes';
          const toolUseId = newItemId();
          this.feed('tool', `Answering negotiation: ${yieldIt ? 'yield' : 'insist'}`, { toolName: 'mcp__sinnect__hub_negotiate', toolUseId, input: { id: negId, note } });
          const out = this.host.hub.negotiate(this.id, negId, yieldIt ? 'yield' : 'insist', note);
          this.feed('tool_result', out, { toolUseId });
          this.tokens(120, 30);
        }, 1200 + Math.random() * 1500);
      }
    }
  }

  private async script(prompt: string, run: number) {
    const isHub = prompt.startsWith('[Sinnect hub]');
    this.setStatus('thinking', 'Thinking');
    await sleep(700 + Math.random() * 900);
    if (!this.alive(run)) return;
    this.tokens(2400, 0);

    if (isHub) {
      await this.stream('Got the hub update. Picking things back up.', run);
      this.finish(run);
      return;
    }

    if (this.config.coordinator && this.state.turns === 0) {
      await this.onboard(run);
      this.finish(run);
      return;
    }

    const topic = prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt;
    await this.stream(`On it. I'll start by looking around the project, then work on: ${topic}`, run);
    if (this.config.awareness !== 'solo') {
      this.setGoal(topic);
      await this.useTool('mcp__sinnect__hub_set_status', { goal: topic }, 'Status updated.', run);
    }
    if (this.state.turns === 0 && Math.random() < 0.4) {
      this.setStatus('waiting', 'Asking you something');
      this.feed('tool', 'Asking you something', { toolName: 'AskUserQuestion' });
      const res = await this.host.ask({
        kind: 'question',
        requestId: newItemId(),
        sessionId: this.id,
        questions: [
          {
            question: 'Which styling approach should I use?',
            header: 'Styling',
            options: [
              { label: 'Tailwind', description: 'Utility classes, fast to iterate' },
              { label: 'CSS modules', description: 'Plain CSS scoped per component' },
            ],
          },
        ],
      });
      if (!this.alive(run)) return;
      const answer = res.kind === 'question' && !res.skipped ? Object.values(res.answers)[0] : null;
      await this.stream(answer ? `Got it, going with ${answer}.` : "No worries, I'll pick something sensible.", run);
    }
    const files = [...FILES].sort(() => Math.random() - 0.5);
    await this.useTool('Glob', { pattern: 'src/**/*.ts*' }, files.join('\n'), run);
    await this.useTool('Read', { file_path: path.join(this.config.cwd, files[0]) }, '(file contents)', run);
    await this.useTool('Bash', { command: 'npm test', description: 'run the tests' }, '12 passing', run);

    await this.edit(files[0], run);
    if (Math.random() < 0.6) await this.edit(files[1], run);

    const peers = this.host.hub.visibleTo(this.id);
    if (peers.length && Math.random() < 0.7 && this.alive(run)) {
      const peer = pick(peers);
      const text = `Heads up: I changed ${files[0]}, re-read it before you touch it.`;
      const r = this.host.hub.send(this.id, peer.id, text);
      const toolUseId = newItemId();
      this.feed('tool', `Messaging ${peer.name}`, { toolName: 'mcp__sinnect__hub_send', toolUseId, input: { to: peer.id, message: text } });
      this.feed('tool_result', r.ok ? 'Sent.' : r.error!, { toolUseId });
      this.tokens(200, 40);
    }

    await this.stream(
      [
        `## Done`,
        ``,
        `I updated \`${files[0]}\`${files[1] ? ` and looked at \`${files[1]}\`` : ''}. Here's the short version:`,
        ``,
        `| File | Change |`,
        `| --- | --- |`,
        `| \`${files[0]}\` | **edited** |`,
        files[1] ? `| \`${files[1]}\` | read only |` : '',
        ``,
        `- Kept the change small`,
        `- Nothing else touched`,
        ``,
        `Tell me if you want me to keep going.`,
      ].join('\n'),
      run,
    );
    this.finish(run);
  }

  /** Demo company onboarding: ask what the company is and which units it needs, then start one session per unit. */
  private async onboard(run: number) {
    await this.stream("Let's set up your company. I'll ask a couple of questions, then start a session for each team.", run);
    const ask = async (question: string, header: string, options: { label: string; description?: string }[], multiSelect = false) => {
      this.setStatus('waiting', 'Asking you something');
      this.feed('tool', 'Asking you something', { toolName: 'AskUserQuestion' });
      const res = await this.host.ask({ kind: 'question', requestId: newItemId(), sessionId: this.id, questions: [{ question, header, multiSelect, options }] });
      this.setStatus('working', 'Got your answer');
      return res.kind === 'question' && !res.skipped ? Object.values(res.answers)[0] ?? '' : '';
    };
    const what = await ask('What is the company and what does it do?', 'Company', [
      { label: 'A software studio', description: 'Builds apps for clients' },
      { label: 'An online shop', description: 'Sells products on the web' },
    ]);
    if (!this.alive(run)) return;
    const units = await ask(`Which units should ${what || 'the company'} have?`, 'Units', [
      { label: 'Software', description: 'backend-developer' },
      { label: 'Finance', description: 'ledger-finance-manager' },
      { label: 'Operations', description: 'team-operations-coach' },
      { label: 'Security', description: 'ciso-advisor' },
    ], true);
    if (!this.alive(run)) return;
    const roles: Record<string, string> = { software: 'backend-developer', finance: 'ledger-finance-manager', operations: 'team-operations-coach', security: 'ciso-advisor' };
    const picked = units.split(',').map((u) => u.trim()).filter(Boolean);
    if (!picked.length) {
      await this.stream('No units yet. Tell me when you know which teams you need.', run);
      return;
    }
    for (const unit of picked) {
      if (!this.alive(run)) return;
      const team = unit.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const req = { name: team, folder: `../${team}`, agent: roles[team] ?? null, family: team, prompt: `Boot as Crux team demo/${team}, give your boot report, then wait.` };
      const toolUseId = newItemId();
      this.feed('tool', `Starting ${team}`, { toolName: 'mcp__sinnect__hub_spawn', toolUseId, input: req });
      this.feed('tool_result', await this.spawnSession(req), { toolUseId });
      this.tokens(300, 60);
    }
    await this.stream(`Your teams are up: ${picked.join(', ')}. I'll stay here as the coordinator and route work between them.`, run);
  }

  private finish(run: number) {
    if (!this.alive(run)) return;
    this.feed('result', 'Done');
    this.onTurnEnd(this.lastText);
  }

  async interrupt() {
    this.run++;
    this.feed('system', 'Interrupted');
    this.onTurnEnd();
  }

  protected async shutdown() {
    this.run++;
  }
}
