const { test } = require('node:test');
const assert = require('node:assert/strict');
const tm = require('../tmux-session');

test('sessionName prefixes sb_ and sanitizes unsafe chars', () => {
  assert.equal(tm.sessionName('abc123'), 'sb_abc123');
  assert.equal(tm.sessionName('a b/c.d'), 'sb_a_b_c_d');
});

test('socketPath joins baseDir and a sanitized handle deterministically', () => {
  assert.equal(tm.socketPath('/base/dir', 'abc123'), '/base/dir/sb-sock-abc123');
  assert.equal(tm.socketPath('/base/dir', 'abc123'), tm.socketPath('/base/dir', 'abc123'));
});

test('socketPath sanitizes unsafe characters in the handle', () => {
  assert.equal(tm.socketPath('/base', 'a b/c.d'), '/base/sb-sock-a_b_c_d');
});

test('socketPath strips trailing slashes from baseDir', () => {
  assert.equal(tm.socketPath('/base/dir/', 'x'), '/base/dir/sb-sock-x');
  assert.equal(tm.socketPath('/base/dir///', 'x'), '/base/dir/sb-sock-x');
});

test('newSessionArgs builds socket-prefixed attach-or-create argv with size, conf, command', () => {
  const args = tm.newSessionArgs({
    name: 'sb_x', cols: 120, rows: 30, confPath: '/tmp/sb.conf',
    socketPath: '/tmp/sb-sock-x',
    command: ['/bin/zsh', '-l', '-i', '-c', 'claude --session-id x'],
  });
  assert.deepEqual(args, [
    '-S', '/tmp/sb-sock-x',
    '-f', '/tmp/sb.conf',
    'new-session', '-A', '-s', 'sb_x',
    '-x', '120', '-y', '30',
    '/bin/zsh', '-l', '-i', '-c', 'claude --session-id x',
  ]);
});

test('newSessionArgs never includes -e (env rides the client environ, not argv)', () => {
  const args = tm.newSessionArgs({
    name: 'sb_x', cols: 80, rows: 24, confPath: '/c', socketPath: '/s',
    command: ['bash'],
  });
  assert.ok(!args.includes('-e'));
  assert.deepEqual(args.slice(-1), ['bash']);
});

test('hasSessionArgs targets the per-session socket', () => {
  assert.deepEqual(tm.hasSessionArgs('sb_x', '/tmp/sb-sock-x'), ['-S', '/tmp/sb-sock-x', 'has-session', '-t', 'sb_x']);
});

test('killServerArgs kills the per-session server on its socket', () => {
  assert.deepEqual(tm.killServerArgs('/tmp/sb-sock-x'), ['-S', '/tmp/sb-sock-x', 'kill-server']);
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
