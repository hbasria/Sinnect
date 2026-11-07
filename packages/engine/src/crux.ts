// Crux agents: role definitions in {crux}/agents/{id}/AGENT.md. A session can run
// as one of them, which adds the AGENT.md body to its system prompt.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CruxAgent } from './protocol.js';

/** Biggest AGENT.md body we put into a system prompt. */
const MAX_PROMPT = 40_000;

/** The folder set in Settings, else CRUX_HOME, else ~/.crux. */
export function cruxHome(setting: string | null | undefined): string {
  const raw = setting?.trim() || process.env.CRUX_HOME || path.join(os.homedir(), '.crux');
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

/** Every agent folder with an AGENT.md, sorted by name. Missing folder = empty list. */
export function listAgents(home: string): CruxAgent[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(path.join(home, 'agents'));
  } catch {
    return [];
  }
  const out: CruxAgent[] = [];
  for (const id of dirs) {
    const doc = readAgent(home, id);
    if (!doc) continue;
    const meta = frontmatter(doc).meta;
    out.push({ id, name: meta.name || id, description: meta.description || '', emoji: meta.emoji || '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** System prompt text for running as agent `id`, or null if it doesn't exist. */
export function agentPrompt(home: string, id: string): string | null {
  const doc = readAgent(home, id);
  if (!doc) return null;
  const body = frontmatter(doc).body.trim();
  return [
    `You are acting as the Crux agent "${id}". Its definition, from ${path.join(home, 'agents', id, 'AGENT.md')}, follows. Stay in this role for the whole session.`,
    body.length > MAX_PROMPT ? body.slice(0, MAX_PROMPT) + '\n…' : body,
  ].join('\n\n');
}

function readAgent(home: string, id: string): string | null {
  // Ids come from the UI, so never let one walk out of the agents folder.
  if (!/^[\w.-]+$/.test(id) || id.startsWith('.')) return null;
  try {
    return fs.readFileSync(path.join(home, 'agents', id, 'AGENT.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Just enough YAML for the fields we show: single-line `key: value` and folded
 * `key: >` blocks. Nested maps (tools, permission) are skipped.
 */
export function frontmatter(doc: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(doc);
  if (!m) return { meta: {}, body: doc };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      value = block.filter(Boolean).join(value.startsWith('|') ? '\n' : ' ');
    }
    meta[kv[1]] = value.replace(/^(["'])(.*)\1$/, '$2');
  }
  return { meta, body: doc.slice(m[0].length) };
}

/** First message of a company coordinator session. Short on purpose: the duties are in the system prompt. */
export const ONBOARDING_MESSAGE = 'Set up this folder as a Crux company, or resume its onboarding if it already is one.';

/** System prompt text for the coordinator session of a Sinnect workspace in company mode. */
export function coordinatorPrompt(home: string): string {
  const skill = (name: string) => path.join(home, 'skills', name, 'SKILL.md');
  return [
    `You are the coordinator of a Crux company that lives in your working folder (the company root). The Crux framework home is ${home}.`,
    `Before anything else read ${skill('crux-coordinator')} and ${skill('crux-team')}, then follow crux-team's Resolution and Boot.`,
    `- If .crux/COMPANY.md is missing here, run crux-team's Company Onboarding from step 1. Use ${path.join(home, 'scripts', 'company.sh')} where it has a command.`,
    `- If it exists, boot as the coordinator team and resume onboarding at the first unfinished step (its Pending items).`,
    `How to talk to the user in Sinnect:`,
    `- Ask every onboarding question with the AskUserQuestion tool: one step per call, your proposed default as the first option. The user answers in a pop-up, not in chat.`,
    `- Speak the user's language. Start by learning what the company is and does, then which units (departments) it needs.`,
    `- If there are no code repositories beside the company root yet, propose one team per unit, with roles from ${path.join(home, 'agents')} (first role = primary), each owning its own folder beside the company root (../{team-id}).`,
    `Starting teams: at the Hand-off step, do not just explain how to start each team. Start it yourself with hub_spawn, one call per team:`,
    `- name = team id, folder = its owned path, agent = its primary role id, family = team id,`,
    `- prompt = "Boot as Crux team {company}/{team}, give your boot report, then wait."`,
    `The user approves each hub_spawn in a pop-up. A no means leave that team for later.`,
    `After hand-off you stay the coordinator: route work to teams through the request board and hub messages, keep the board, do no domain work yourself.`,
  ].join('\n');
}
