import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeName, hasOwnFile, isOpenWorkspace } from '../src/workspace-file.ts';

// The list holds file names, as the engine writes them.
const saved = [{ name: 'Backend' }, { name: 'Çalışma alanı' }, { name: 'Q3_ plans' }, { name: '__autosave' }];

test('a saved board has its own file, matched through the file name', () => {
  assert.equal(hasOwnFile('Backend', saved), true);
  assert.equal(hasOwnFile('Çalışma alanı', saved), true);
  // Typed as "Q3/ plans", saved as "Q3_ plans".
  assert.equal(hasOwnFile('Q3/ plans', saved), true);
});

test('a never-saved board and the hidden autosave do not', () => {
  assert.equal(hasOwnFile('My workspace', saved), false);
  assert.equal(hasOwnFile('__autosave', saved), false);
  assert.equal(hasOwnFile('Backend', []), false);
});

test('isOpenWorkspace compares the listed file name with the typed name', () => {
  assert.equal(isOpenWorkspace('Q3_ plans', 'Q3/ plans'), true);
  assert.equal(isOpenWorkspace('Backend', 'Frontend'), false);
});

test('a file with another board id is another board', () => {
  const list = [{ name: 'My workspace', id: 'w_old' }, { name: 'legacy' }];
  assert.equal(hasOwnFile('My workspace', list, 'w_new'), false);
  assert.equal(hasOwnFile('My workspace', list, 'w_old'), true);
  // Saved before workspaces had ids: counts as this board's.
  assert.equal(hasOwnFile('legacy', list, 'w_any'), true);
});

test('freeName never takes another board\'s file name', () => {
  const list = [{ name: 'My workspace' }, { name: 'my workspace 2' }, { name: 'Q3_ plans' }];
  assert.equal(freeName('My workspace', list), 'My workspace 3');
  assert.equal(freeName('Q3/ plans', list), 'Q3/ plans 2');
  assert.equal(freeName('base9', list), 'base9');
  assert.equal(freeName('  ', []), 'My workspace');
});
