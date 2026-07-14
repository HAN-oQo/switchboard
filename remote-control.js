// Native Claude Code "Remote Control" integration (pure helpers).
//
// Claude Code exposes Remote Control via `claude --remote-control [name]` at
// launch and the `/remote-control` slash command at runtime. When enabled it
// prints a claude.ai session URL. There is no local state file/env var to read,
// so Switchboard captures the URL from terminal output to confirm the mode.
//
// These pure functions are unit-tested; the orchestration (spawn, PTY write,
// output scanning, event emit) lives in main.js.

// Double-quote a value for the string-concatenated `claude` command, escaping
// backslashes and double-quotes (matches how other flag values are quoted).
function shellDoubleQuote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Launch fragment appended to the `claude` command. Bare flag, plus an
// optional session name.
function remoteControlArgs(name) {
  const trimmed = (name == null ? '' : String(name)).trim();
  return trimmed ? `--remote-control ${shellDoubleQuote(trimmed)}` : '--remote-control';
}

// Bytes written into a running session's PTY to toggle Remote Control. The
// carriage return submits the slash command inside the Claude REPL.
function remoteControlToggleInput() {
  return '/remote-control\r';
}

// The Remote Control session URL: a claude.ai URL under the /code path. We
// capture it (stripping trailing sentence punctuation) to confirm the mode is
// active and to offer copy-link / QR. NOTE: confirm the exact host/path against
// real output during Task 4's manual verification and widen this if needed.
const URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*claude\.ai\/code\/[^\s"'<>]+/i;

function parseRemoteControlSignal(text) {
  if (!text) return {};
  const m = String(text).match(URL_RE);
  if (!m) return {};
  const url = m[0].replace(/[.,)>\]]+$/, ''); // drop trailing punctuation
  return { url };
}

module.exports = {
  remoteControlArgs,
  remoteControlToggleInput,
  parseRemoteControlSignal,
};
