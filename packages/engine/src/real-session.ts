// A session backed by the Claude Agent SDK (the same engine as Claude Code).

import { bundledClaude } from './auth.js';
import {
  query,
  getSessionMessages,
  createSdkMcpServer,
  tool,
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import path from 'node:path';
import { BaseSession, describeTool, sinnectPrompt, clip, newItemId, normalizePath } from './session.js';
import type { Question } from './protocol.js';

const HUB_TOOLS = ['hub_roster', 'hub_set_status', 'hub_send', 'hub_inbox', 'hub_claim', 'hub_release', 'hub_negotiate'];

/** Async queue that feeds user turns into the SDK's streaming input. */
class InputStream implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wait: ((v: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;
  push(text: string) {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage;
    if (this.wait) {
      const w = this.wait;
      this.wait = null;
      w({ value: msg, done: false });
    } else this.items.push(msg);
  }
  end() {
    this.done = true;
    this.wait?.({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => (this.wait = r));
      },
    };
  }
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export class RealSession extends BaseSession {
  private input = new InputStream();
  private q: Query | null = null;
  private abort = new AbortController();
  /** usage per assistant message id, so streamed duplicates are not double counted */
  private streamMsgId: string | null = null;
  private usageById = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
  /** streaming text block -> feed item */
  private streamItem: { index: number; itemId: string; kind: 'text' | 'thinking' } | null = null;
  private streamedText = false;

  start() {
    const cfg = this.config;
    const settings = this.host.settings();
    const hub = this.host.hub;
    const id = this.id;

    const env: Record<string, string | undefined> = { ...process.env };
    if (settings.authMode === 'apiKey') {
      const key = this.host.apiKey();
      if (key) env.ANTHROPIC_API_KEY = key;
    } else {
      // Local login mode: use whatever Claude Code login exists on this machine.
      delete env.ANTHROPIC_API_KEY;
    }

    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const reason = this.checkEdit(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      if (reason) {
        return {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
        };
      }
      return {};
    };
    const postToolUse: HookCallback = async () => {
      const notice = this.takeNoticeText();
      if (!notice) return {};
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notice } };
    };

    const options: Options = {
      cwd: cfg.cwd,
      model: cfg.model,
      abortController: this.abort,
      includePartialMessages: true,
      env,
      resume: cfg.resumeId ?? undefined,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: [this.rolePrompt(), sinnectPrompt(cfg, hub.roster(id))].filter(Boolean).join('\n\n') },
      settingSources: ['user', 'project', 'local'],
      hooks: {
        PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [preToolUse] }],
        PostToolUse: [{ hooks: [postToolUse] }],
      },
      canUseTool: this.canUseTool,
      stderr: (data: string) => {
        if (/error/i.test(data)) this.feed('system', clip(data, 400));
      },
    } as Options;
    const exe = settings.claudePath || bundledClaude();
    if (exe) options.pathToClaudeCodeExecutable = exe;

    if (cfg.permission === 'auto') {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
    } else if (cfg.permission === 'acceptEdits') {
      options.permissionMode = 'acceptEdits';
    } else {
      options.permissionMode = 'default';
    }

    if (cfg.awareness !== 'solo') {
      options.mcpServers = { sinnect: this.hubServer() };
      options.allowedTools = [...HUB_TOOLS, ...(cfg.coordinator ? ['hub_spawn'] : [])].map((t) => `mcp__sinnect__${t}`);
    }

    if (cfg.resumeId) this.loadHistory(cfg.resumeId).catch(() => {});
    this.q = query({ prompt: this.input, options });
    this.loop().catch((err) => this.fail(err));
    if (cfg.prompt.trim()) this.send(cfg.prompt);
    else this.setStatus('idle', 'Waiting for you');
  }

  private hubServer() {
    const hub = this.host.hub;
    const id = this.id;
    return createSdkMcpServer({
      name: 'sinnect',
      version: '0.1.0',
      tools: [
        tool('hub_roster', 'List the other Sinnect sessions you can see, one line each.', {}, async () => text(hub.roster(id))),
        tool(
          'hub_set_status',
          'Set your one-line goal so other sessions know what you are doing. Max 160 characters.',
          { goal: z.string().max(400) },
          async ({ goal }) => {
            this.setGoal(goal);
            return text('Status updated.');
          },
        ),
        tool(
          'hub_send',
          'Send a short message to another session (by id from hub_roster). Only when it changes what they should do. Never for thanks, acks or progress updates.',
          {
            to: z.string(),
            message: z.string(),
            wake: z
              .boolean()
              .optional()
              .describe('true = start a turn for them now (costs them a full turn). Only for a task or a blocking question. Default false: they see it on their next step.'),
          },
          async ({ to, message, wake }) => {
            const r = hub.send(id, to, message, { wake, depth: this.turnDepth });
            if (!r.ok) return text(r.error!);
            if (r.woke) return text('Sent, they are starting on it.');
            if (r.held) return text(`Sent. Not waking them (${r.held}), they'll see it on their next turn.`);
            return text("Sent. They'll see it on their next step.");
          },
        ),
        tool('hub_inbox', 'Read unread hub messages. You rarely need this, notices arrive by themselves.', {}, async () => {
          const box = hub.inbox(id);
          if (!box.length) return text('No unread messages.');
          return text(box.map((m) => `- ${m.from === 'hub' ? 'hub' : this.host.nameOf(m.from)}: ${m.text}`).join('\n'));
        }),
        tool(
          'hub_claim',
          'Claim files before a bigger change so others know. Edits claim files automatically, so this is optional.',
          { paths: z.array(z.string()).max(20), reason: z.string().max(160) },
          async ({ paths, reason }) => {
            const res = hub.claim(id, paths.map((p) => normalizePath(path.resolve(this.config.cwd, p))), reason);
            return text(res.map((r) => `${r.path}: ${r.result.ok ? 'claimed' : r.result.reason}`).join('\n'));
          },
        ),
        tool(
          'hub_release',
          'Release your file claims (all of them if no paths are given). Claims are also released when your turn ends.',
          { paths: z.array(z.string()).optional() },
          async ({ paths }) => {
            const done = hub.release(id, paths?.map((p) => normalizePath(path.resolve(this.config.cwd, p))));
            return text(done.length ? `Released ${done.length} file(s).` : 'Nothing to release.');
          },
        ),
        tool(
          'hub_negotiate',
          'Answer a file negotiation from a [Sinnect hub] notice.',
          { id: z.string(), choice: z.enum(['yield', 'insist']), note: z.string().max(200) },
          async (a) => text(hub.negotiate(id, a.id, a.choice, a.note)),
        ),
        ...(this.config.coordinator
          ? [
              tool(
                'hub_spawn',
                'Start a new Claude session on the Sinnect canvas, e.g. one per Crux team at hand-off. The user approves it first. It joins the family (created if new) and is linked to you.',
                {
                  name: z.string().max(60).describe('Card name, e.g. the team id'),
                  folder: z.string().describe('Working folder, relative to yours or absolute. Created if missing.'),
                  agent: z.string().optional().describe('Crux agent (role) id the session runs as'),
                  family: z.string().max(40).optional().describe('Family to put it in, e.g. the team id'),
                  prompt: z.string().max(4000).optional().describe('First message for the session'),
                },
                async (req) => text(await this.spawnSession(req)),
              ),
            ]
          : []),
      ],
    });
  }

  private canUseTool: CanUseTool = async (toolName, input, opts): Promise<PermissionResult> => {
    if (toolName.startsWith('mcp__sinnect__')) return { behavior: 'allow', updatedInput: input };

    if (toolName === 'AskUserQuestion') {
      const questions = ((input.questions as Question[]) ?? []).map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect,
        options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
      }));
      const prev = this.state.status;
      this.setStatus('waiting', 'Asking you something');
      const res = await this.host.ask({ kind: 'question', requestId: newItemId(), sessionId: this.id, questions });
      this.setStatus(prev === 'waiting' ? 'working' : prev, 'Got your answer');
      if (res.kind !== 'question' || res.skipped) return { behavior: 'deny', message: 'The user skipped the question.' };
      return { behavior: 'allow', updatedInput: { ...input, answers: res.answers } };
    }

    const title = (opts as { title?: string }).title || `${this.config.name} wants to use ${toolName}`;
    const detail = toolDetail(toolName, input);
    this.setStatus('waiting', `Needs your OK: ${toolName}`);
    const res = await this.host.ask({
      kind: 'tool',
      requestId: newItemId(),
      sessionId: this.id,
      toolName,
      title,
      detail,
      canAlwaysAllow: !!opts.suggestions?.length,
    });
    this.setStatus('working', describeTool(toolName, input));
    if (res.kind !== 'tool' || res.decision === 'deny') {
      return { behavior: 'deny', message: res.kind === 'tool' && res.message ? res.message : 'The user said no.' };
    }
    return {
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: res.decision === 'always' ? opts.suggestions : undefined,
    };
  };

  /** Fill the feed with an earlier conversation when resuming from a workspace. */
  private async loadHistory(sessionId: string) {
    const msgs = await getSessionMessages(sessionId, { dir: this.config.cwd, limit: 400 });
    for (const m of msgs) {
      if (m.parent_tool_use_id) continue;
      const content = (m.message as { content?: unknown })?.content;
      if (typeof content === 'string') {
        if (m.type === 'user') this.feed('user', content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content as any[]) {
        if (b.type === 'text' && b.text) this.feed(m.type === 'user' ? 'user' : 'text', b.text);
        else if (b.type === 'tool_use') this.feed('tool', describeTool(b.name, b.input ?? {}), { toolName: b.name, toolUseId: b.id, input: b.input });
      }
    }
    this.feed('system', 'Resumed from your workspace');
  }

  updateConfig(patch: Parameters<BaseSession['updateConfig']>[0]) {
    const before = this.config.permission;
    super.updateConfig(patch);
    if (patch.permission && patch.permission !== before && this.q) {
      const mode = patch.permission === 'auto' ? 'bypassPermissions' : patch.permission === 'acceptEdits' ? 'acceptEdits' : 'default';
      this.q.setPermissionMode(mode).catch((e) => this.feed('system', `Could not change permissions: ${e instanceof Error ? e.message : e}`));
    }
  }

  protected pushInput(t: string) {
    this.streamedText = false;
    this.input.push(t);
  }

  private async loop() {
    for await (const msg of this.q!) this.handle(msg);
    if (!this.closed) {
      this.busy = false;
      this.setStatus('stopped', 'Session ended');
    }
  }

  private handle(msg: SDKMessage) {
    switch (msg.type) {
      case 'system':
        if ('subtype' in msg && msg.subtype === 'init') {
          this.state.sdkSessionId = msg.session_id;
          this.state.config.model = msg.model || this.state.config.model;
          this.publish();
        }
        return;
      case 'stream_event':
        if (msg.parent_tool_use_id) return;
        return this.handleStream(msg.event as StreamEvent);
      case 'assistant': {
        const m = msg.message;
        if (msg.parent_tool_use_id) return; // subagent chatter stays out of the main feed
        if (m.usage && m.id) {
          const prev = this.usageById.get(m.id);
          this.usageById.set(m.id, {
            input: m.usage.input_tokens ?? 0,
            output: Math.max(prev?.output ?? 0, m.usage.output_tokens ?? 0),
            cacheRead: m.usage.cache_read_input_tokens ?? 0,
            cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
          });
          this.recount();
        }
        for (const block of m.content ?? []) {
          if (block.type === 'text' && !this.streamedText) this.feed('text', block.text);
          else if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>;
            const line = describeTool(block.name, input);
            this.feed('tool', line, { toolName: block.name, toolUseId: block.id, input });
            if (this.state.status !== 'blocked' && this.state.status !== 'waiting') this.setStatus('working', line);
          }
        }
        return;
      }
      case 'user': {
        if (msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type === 'tool_result') {
            const out = Array.isArray(block.content)
              ? block.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
              : String(block.content ?? '');
            this.feed('tool_result', clip(out, 4000), { toolUseId: block.tool_use_id, isError: !!block.is_error });
          }
        }
        return;
      }
      case 'result': {
        this.state.costUsd = msg.total_cost_usd ?? this.state.costUsd;
        if (msg.subtype === 'success') this.feed('result', `Done in ${Math.round(msg.duration_ms / 1000)}s`);
        else this.feed('error', `Turn ended: ${msg.subtype}`, { isError: true });
        this.publish();
        this.onTurnEnd(msg.subtype === 'success' ? msg.result : `Turn ended: ${msg.subtype}`);
        return;
      }
      default:
        return;
    }
  }

  private handleStream(ev: StreamEvent) {
    if (ev.type === 'message_start') {
      // The final output count only arrives in message_delta, so track usage from the stream.
      const m = ev.message;
      this.streamMsgId = m?.id ?? null;
      if (m?.id && m.usage) {
        this.usageById.set(m.id, {
          input: m.usage.input_tokens ?? 0,
          output: m.usage.output_tokens ?? 0,
          cacheRead: m.usage.cache_read_input_tokens ?? 0,
          cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
        });
        this.recount();
      }
      if (this.state.status === 'idle' || this.state.status === 'thinking') this.setStatus('thinking', 'Thinking');
    } else if (ev.type === 'content_block_start') {
      const b = ev.content_block;
      if (b?.type === 'text' || b?.type === 'thinking') {
        const kind = b.type;
        const item = this.feed(kind, '');
        this.streamItem = { index: ev.index, itemId: item.id, kind };
        if (kind === 'text') this.streamedText = true;
        if (kind === 'thinking') this.setStatus('thinking', 'Thinking');
      }
    } else if (ev.type === 'content_block_delta' && this.streamItem && ev.index === this.streamItem.index) {
      const d = ev.delta;
      const chunk = d?.type === 'text_delta' ? d.text : d?.type === 'thinking_delta' ? d.thinking : '';
      if (chunk) this.host.feedDelta(this.id, this.streamItem.itemId, chunk);
      if (this.streamItem.kind === 'text' && this.state.status === 'thinking') this.setStatus('working', 'Writing a reply');
    } else if (ev.type === 'message_delta' && ev.usage && this.streamMsgId) {
      const u = this.usageById.get(this.streamMsgId);
      if (u) {
        u.output = Math.max(u.output, ev.usage.output_tokens ?? 0);
        this.recount();
      }
    } else if (ev.type === 'content_block_stop' && this.streamItem && ev.index === this.streamItem.index) {
      this.streamItem = null;
    }
  }

  private recount() {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const u of this.usageById.values()) {
      t.input += u.input;
      t.output += u.output;
      t.cacheRead += u.cacheRead;
      t.cacheWrite += u.cacheWrite;
    }
    this.state.tokens = t;
    this.publish();
  }

  private fail(err: unknown) {
    if (this.closed) return;
    const msg = err instanceof Error ? err.message : String(err);
    this.state.error = msg;
    this.feed('error', msg, { isError: true });
    this.answerMatrix(`Error: ${msg}`);
    this.busy = false;
    this.setStatus('error', clip(msg, 80));
    this.publish(true);
  }

  async interrupt() {
    await this.q?.interrupt();
  }

  protected async shutdown() {
    this.input.end();
    try {
      await this.q?.interrupt();
    } catch {
      /* already done */
    }
    this.abort.abort();
  }
}

type StreamEvent = {
  type: string;
  index: number;
  content_block?: { type: string };
  delta?: { type: string; text?: string; thinking?: string };
} & Record<string, any>;

function toolDetail(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return String(input.command ?? '');
  if (name === 'Write') return `${input.file_path}\n\n${clip(String(input.content ?? ''), 600)}`;
  if (name === 'Edit') return `${input.file_path}\n\n- ${clip(String(input.old_string ?? ''), 280)}\n+ ${clip(String(input.new_string ?? ''), 280)}`;
  if (name === 'WebFetch') return String(input.url ?? '');
  return clip(JSON.stringify(input), 600);
}
