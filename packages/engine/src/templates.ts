// Session templates: validation, normalising and persistence helpers. No engine state.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SessionTemplate } from './protocol.js';

export const MAX_TEMPLATES = 100;
export const MAX_NAME = 80;
export const MAX_PROMPT = 20_000;

const schema = z.object({
  id: z.string().min(1),
  name: z.string().max(MAX_NAME),
  model: z.string(),
  priority: z.number().finite(),
  awareness: z.enum(['solo', 'family', 'everyone']),
  permission: z.enum(['ask', 'acceptEdits', 'auto']),
  familyId: z.string().nullable(),
  familyName: z.string().nullable(),
  prompt: z.string().max(MAX_PROMPT),
  agent: z.string().nullable().optional(),
  createdAt: z.number(),
});

/** Trims the name and clamps priority to an integer 1-5. */
export function normalizeTemplate(t: SessionTemplate): SessionTemplate {
  return { ...t, name: t.name.trim(), priority: Math.min(5, Math.max(1, Math.round(t.priority))) };
}

/** Parses raw JSON, drops invalid entries, duplicate ids and empty names, caps the count. */
export function parseTemplates(raw: unknown): SessionTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionTemplate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_TEMPLATES) break;
    const r = schema.safeParse(item);
    if (!r.success) continue;
    const t = normalizeTemplate(r.data);
    if (!t.name || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

export type UpsertResult = { ok: true; list: SessionTemplate[] } | { ok: false; error: string };

/** Insert, or overwrite in place when the id exists. */
export function upsertTemplate(list: SessionTemplate[], incoming: SessionTemplate): UpsertResult {
  const parsed = schema.safeParse(incoming);
  if (!parsed.success) return { ok: false, error: 'Invalid template.' };
  const t = normalizeTemplate(parsed.data);
  if (!t.name) return { ok: false, error: 'Template needs a name.' };
  const i = list.findIndex((x) => x.id === t.id);
  if (i < 0) {
    if (list.length >= MAX_TEMPLATES) return { ok: false, error: `Template limit reached (${MAX_TEMPLATES}).` };
    return { ok: true, list: [...list, t] };
  }
  const next = list.slice();
  next[i] = t;
  return { ok: true, list: next };
}

/**
 * Loads templates.json. Anything lossy gets a timestamped backup (templates.<ts>.bak) so the
 * next save cannot destroy it: unreadable JSON or a non-array is moved aside, a file that
 * loses entries (invalid, duplicate, over the cap) is copied.
 */
export function loadTemplates(dataDir: string): SessionTemplate[] {
  const file = path.join(dataDir, 'templates.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const bak = path.join(dataDir, `templates.${Date.now()}.bak`);
  try {
    const raw: unknown = JSON.parse(text);
    if (Array.isArray(raw)) {
      const list = parseTemplates(raw);
      if (list.length < raw.length) {
        try {
          fs.copyFileSync(file, bak);
          // Backup is safe, so rewrite the cleaned list: next launch loads clean, no new .bak.
          fs.writeFileSync(file + '.tmp', JSON.stringify(list, null, 2));
          fs.renameSync(file + '.tmp', file);
        } catch {
          /* best effort */
        }
      }
      return list;
    }
  } catch {
    /* fall through to backup */
  }
  try {
    fs.renameSync(file, bak);
  } catch {
    /* best effort */
  }
  return [];
}

/** Persists `next` with the given writer. On failure keeps `prev` so memory never differs from disk. */
export function commitTemplates(
  prev: SessionTemplate[],
  next: SessionTemplate[],
  write: (list: SessionTemplate[]) => void,
): { list: SessionTemplate[]; error?: string } {
  try {
    write(next);
    return { list: next };
  } catch (err) {
    return { list: prev, error: err instanceof Error ? err.message : String(err) };
  }
}

export function demoTemplates(): SessionTemplate[] {
  const now = Date.now();
  return [
    {
      id: 'demo-reviewer',
      name: 'Code reviewer',
      model: 'claude-sonnet-5-5',
      priority: 2,
      awareness: 'everyone',
      permission: 'ask',
      familyId: null,
      familyName: null,
      prompt: 'Review the latest changes for bugs and risky edits. Report short findings, do not edit files.',
      createdAt: now,
    },
    {
      id: 'demo-builder',
      name: 'Backend builder',
      model: 'claude-sonnet-5-5',
      priority: 3,
      awareness: 'family',
      permission: 'acceptEdits',
      familyId: null,
      familyName: 'Backend',
      prompt: 'Implement what Lead asks in this folder. Keep changes small and run the tests.',
      createdAt: now - 1,
    },
  ];
}
