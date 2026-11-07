import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentPrompt, coordinatorPrompt, frontmatter, listAgents } from '../src/crux.js';
import { parseTemplates } from '../src/templates.js';

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-crux-'));
  const add = (id: string, doc: string) => {
    fs.mkdirSync(path.join(dir, 'agents', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents', id, 'AGENT.md'), doc);
  };
  add(
    'backend-developer',
    [
      '---',
      'name: Backend Developer',
      'description: >',
      '  Backend software developer.',
      '  Use when: fixing backend bugs.',
      'tools:',
      '  write: true',
      'emoji: 🛠️',
      '---',
      '',
      '# Backend Developer',
      'Keep contracts stable.',
    ].join('\n'),
  );
  add('arif', '---\nname: "Arif"\n---\nBe pragmatic.\n');
  fs.mkdirSync(path.join(dir, 'agents', 'empty'));
  fs.writeFileSync(path.join(dir, 'agents', 'README.md'), '# agents');
  return dir;
}

test('frontmatter reads plain, quoted and folded values and skips nested maps', () => {
  const { meta, body } = frontmatter('---\nname: "X"\ndescription: >\n  one\n  two\ntools:\n  write: true\n---\nbody');
  assert.equal(meta.name, 'X');
  assert.equal(meta.description, 'one two');
  assert.equal(meta.write, undefined);
  assert.equal(body, 'body');
});

test('listAgents keeps folders with an AGENT.md, sorted by name', () => {
  const agents = listAgents(home());
  assert.deepEqual(
    agents.map((a) => a.id),
    ['arif', 'backend-developer'],
  );
  assert.equal(agents[1].name, 'Backend Developer');
  assert.equal(agents[1].emoji, '🛠️');
  assert.equal(agents[1].description, 'Backend software developer. Use when: fixing backend bugs.');
});

test('listAgents on a missing folder is empty', () => {
  assert.deepEqual(listAgents(path.join(os.tmpdir(), 'sinnect-no-such-crux')), []);
});

test('agentPrompt returns the body without frontmatter, null for unknown or unsafe ids', () => {
  const dir = home();
  const p = agentPrompt(dir, 'backend-developer')!;
  assert.match(p, /Crux agent "backend-developer"/);
  assert.match(p, /Keep contracts stable\./);
  assert.doesNotMatch(p, /emoji:/);
  assert.equal(agentPrompt(dir, 'nope'), null);
  assert.equal(agentPrompt(dir, '../agents/arif'), null);
  assert.equal(agentPrompt(dir, '..'), null);
});

test('templates keep their agent', () => {
  const base = { id: 't1', name: 'A', model: 'm', priority: 3, awareness: 'family', permission: 'ask', familyId: null, familyName: null, prompt: '', createdAt: 1 };
  assert.equal(parseTemplates([{ ...base, agent: 'arif' }])[0].agent, 'arif');
  assert.equal(parseTemplates([base])[0].agent, undefined);
});

test('coordinatorPrompt points at the skills and hub_spawn', () => {
  const p = coordinatorPrompt('/opt/crux');
  assert.match(p, /\/opt\/crux\/skills\/crux-team\/SKILL\.md/);
  assert.match(p, /Company Onboarding/);
  assert.match(p, /hub_spawn/);
});
