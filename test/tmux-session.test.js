const { test } = require('node:test');
const assert = require('node:assert/strict');
const tm = require('../tmux-session');

test('sessionName prefixes sb_ and sanitizes unsafe chars', () => {
  assert.equal(tm.sessionName('abc123'), 'sb_abc123');
  assert.equal(tm.sessionName('a b/c.d'), 'sb_a_b_c_d');
});

test('newSessionArgs builds attach-or-create argv with size, conf, env, command', () => {
  const args = tm.newSessionArgs({
    name: 'sb_x', cols: 120, rows: 30, confPath: '/tmp/sb.conf',
    env: { CLAUDE_CODE_SSE_PORT: '4517' },
    command: ['/bin/zsh', '-l', '-i', '-c', 'claude --session-id x'],
  });
  assert.deepEqual(args, [
    '-f', '/tmp/sb.conf',
    'new-session', '-A', '-s', 'sb_x',
    '-x', '120', '-y', '30',
    '-e', 'CLAUDE_CODE_SSE_PORT=4517',
    '/bin/zsh', '-l', '-i', '-c', 'claude --session-id x',
  ]);
});

test('newSessionArgs omits env flags when env empty', () => {
  const args = tm.newSessionArgs({ name: 'sb_x', cols: 80, rows: 24, confPath: '/c', env: {}, command: ['bash'] });
  assert.ok(!args.includes('-e'));
  assert.deepEqual(args.slice(-1), ['bash']);
});

test('kill/has/list arg builders', () => {
  assert.deepEqual(tm.killArgs('sb_x'), ['kill-session', '-t', 'sb_x']);
  assert.deepEqual(tm.hasSessionArgs('sb_x'), ['has-session', '-t', 'sb_x']);
  assert.deepEqual(tm.listArgs(), ['ls', '-F', '#{session_name}']);
});

test('parseSessionList keeps only sb_ names, trimmed', () => {
  const out = 'sb_a\nother\n  sb_b \n\nmisc';
  assert.deepEqual(tm.parseSessionList(out), ['sb_a', 'sb_b']);
});

test('confContent disables status bar and sets large history', () => {
  const c = tm.confContent();
  assert.match(c, /status off/);
  assert.match(c, /history-limit 100000/);
  assert.match(c, /escape-time 0/);
});

test('isVersionOutput recognizes tmux version output', () => {
  assert.equal(tm.isVersionOutput('tmux 3.4\n'), true);
  assert.equal(tm.isVersionOutput('command not found'), false);
  assert.equal(tm.isVersionOutput(''), false);
});
