const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../session-store');
const nameFn = (h) => 'sb_' + h;

test('upsertEntry merges immutably', () => {
  const a = s.upsertEntry({}, 'h1', { projectPath: '/p', wasOpen: true });
  assert.deepEqual(a, { h1: { projectPath: '/p', wasOpen: true } });
  const b = s.upsertEntry(a, 'h1', { lastActiveAt: 5 });
  assert.deepEqual(b.h1, { projectPath: '/p', wasOpen: true, lastActiveAt: 5 });
  assert.notEqual(a, b); // new object
});

test('removeEntry deletes a handle', () => {
  const a = { h1: { x: 1 }, h2: { x: 2 } };
  assert.deepEqual(s.removeEntry(a, 'h1'), { h2: { x: 2 } });
});

test('pruneDead drops entries with no live tmux session', () => {
  const store = { h1: {}, h2: {} };
  assert.deepEqual(s.pruneDead(store, ['sb_h1'], nameFn), { h1: {} });
});

test('openEntries returns wasOpen entries newest-first', () => {
  const store = { a: { wasOpen: true, lastActiveAt: 1 }, b: { wasOpen: false }, c: { wasOpen: true, lastActiveAt: 9 } };
  assert.deepEqual(s.openEntries(store).map(e => e.handle), ['c', 'a']);
});

test('backgroundEntries excludes currently-open handles', () => {
  const store = { a: { lastActiveAt: 1 }, b: { lastActiveAt: 2 } };
  assert.deepEqual(s.backgroundEntries(store, new Set(['a'])).map(e => e.handle), ['b']);
});
