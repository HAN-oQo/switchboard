// tmux-session.js — pure helpers for running sessions inside tmux.
// I/O (spawn/exec/fs) lives in main.js; this module only builds argv/config.
//
// Per-session socket model (2026-07-15 amendment): each persistent session
// gets its own tmux server on a dedicated `-S <socketPath>`. Env rides the
// tmux client's environ (the `env` passed to pty.spawn), exactly like a
// plain pty.spawn(shell,args,{env}) — never via `-e`, which would put
// secrets into the tmux process argv (visible via `ps`). One server per
// session also means no cross-session env contamination.

function sessionName(handle) {
  return 'sb_' + String(handle).replace(/[^A-Za-z0-9_-]/g, '_');
}

// Deterministic pure string join — no fs, no I/O. The caller creates baseDir
// ahead of time; this just computes where a given handle's socket lives.
function socketPath(baseDir, handle) {
  return `${String(baseDir).replace(/\/+$/, '')}/sb-sock-${String(handle).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

// argv for the `tmux` program (program itself excluded).
// -S: dedicated per-session socket (one server per session).
// -A: attach if the session exists, else create it (reattach == relaunch).
// No env/-e handling: env rides the tmux client's environ via pty.spawn opts.
function newSessionArgs({ name, cols, rows, confPath, socketPath, command }) {
  return ['-S', socketPath, '-f', confPath, 'new-session', '-A', '-s', name,
    '-x', String(cols), '-y', String(rows)].concat(command || []);
}

function hasSessionArgs(name, socketPath) {
  return ['-S', socketPath, 'has-session', '-t', name];
}

// A per-session server hosts exactly one session, so killing the server ends it.
function killServerArgs(socketPath) {
  return ['-S', socketPath, 'kill-server'];
}

// Isolated config so we don't inherit the user's ~/.tmux.conf (status bars,
// prefix keybindings, mouse mode) which would fight xterm and the Claude TUI.
function confContent() {
  return [
    'set -g status off',
    'set -g history-limit 100000',
    'set -g default-terminal "xterm-256color"',
    'set -g escape-time 0',
    'set -g mouse off',
    'setw -g aggressive-resize on',
    'set -g destroy-unattached off',
  ].join('\n') + '\n';
}

function isVersionOutput(out) {
  return /^tmux \d/.test(String(out || '').trim());
}

module.exports = {
  sessionName, socketPath, newSessionArgs, hasSessionArgs, killServerArgs,
  confContent, isVersionOutput,
};
