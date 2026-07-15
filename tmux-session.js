// tmux-session.js — pure helpers for running sessions inside tmux.
// I/O (spawn/exec/fs) lives in main.js; this module only builds argv/config.

function sessionName(handle) {
  return 'sb_' + String(handle).replace(/[^A-Za-z0-9_-]/g, '_');
}

// argv for the `tmux` program (program itself excluded).
// -A: attach if the session exists, else create it (reattach == relaunch).
function newSessionArgs({ name, cols, rows, confPath, env, command }) {
  const args = ['-f', confPath, 'new-session', '-A', '-s', name,
    '-x', String(cols), '-y', String(rows)];
  for (const [k, v] of Object.entries(env || {})) {
    args.push('-e', `${k}=${v}`);
  }
  return args.concat(command || []);
}

function killArgs(name) { return ['kill-session', '-t', name]; }
function hasSessionArgs(name) { return ['has-session', '-t', name]; }
function listArgs() { return ['ls', '-F', '#{session_name}']; }

function parseSessionList(output) {
  return String(output || '')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.startsWith('sb_'));
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
  sessionName, newSessionArgs, killArgs, hasSessionArgs, listArgs,
  parseSessionList, confContent, isVersionOutput,
};
