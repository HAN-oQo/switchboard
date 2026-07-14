# Remote Control — design spec

**Status:** approved (brainstorming), ready for implementation planning
**Date:** 2026-07-14
**Branch:** `feat/remote-control` (based on `feat/remote-ssh-phase3`; rebase `--onto main` once the SSH phases land for a standalone PR)

## Summary

Let a user turn Claude Code's **native Remote Control** on and off for a session
directly from Switchboard, see at a glance which sessions are remote-controlled,
and grab the session's phone URL / QR code in one tap.

Switchboard builds **no networking of its own**. Claude Code's Remote Control
feature registers the session with Anthropic's API (outbound HTTPS only, no
inbound ports, short-lived credentials) and exposes it at claude.ai/code and in
the Claude mobile app. Switchboard's job is limited to: driving the toggle,
tracking and displaying state, and surfacing the URL/QR.

## Background: how Claude Code Remote Control works

Confirmed against Claude Code CLI v2.1.207 and the official docs
(<https://code.claude.com/docs/en/remote-control.md>), July 2026.

- **Enable from a running session:** the slash command `/remote-control`
  (alias `/rc`). Optional title: `/remote-control "My Project"`. Running it
  again toggles it **off**.
- **Enable at launch:** `claude --remote-control [name]`. A related flag
  `--remote-control-session-name-prefix <prefix>` sets the auto-name prefix.
- **When enabled**, Claude prints a **session URL** and a **QR code** to the
  terminal and shows a `/rc active` indicator in its footer. The session then
  appears at claude.ai/code and in the mobile app.
- **Requirements / limits** (documented; not enforced by Switchboard):
  Pro / Max / Team / Enterprise login via `/login`; must use
  `api.anthropic.com` (not Bedrock, Vertex, or a custom `ANTHROPIC_BASE_URL`
  gateway); one remote session per process; the local process must stay
  running; a ~10-minute network-outage timeout ends the session.

### The detection constraint

Claude Code exposes **no local state file, environment variable, or transcript
marker** that an external app can read to know a session is remote-controlled.
The only local signals are:

1. **Terminal output** — the printed session URL and the `/rc active` footer.
2. **Process arguments** — `--remote-control` / `--rc`, but only when the
   session was *launched* with the flag (not when toggled via the slash command
   mid-session).

This constraint is the reason the design tracks state optimistically and then
**corroborates** it by parsing terminal output, rather than relying on a clean
hook that does not exist.

## Goals

- Enable/disable Remote Control per session, both at launch and on a running
  session.
- A clear, glanceable indicator ("distinguisher") of which sessions are
  remote-controlled, in the sidebar and on the terminal card.
- One-tap access to the session URL (copy link) and a QR code, so the user can
  jump to their phone.
- Honest state: never show "on" when the feature actually failed to start.

## Non-goals (v1, YAGNI)

- Any custom relay, tunnel, or self-hosted networking. Claude's API transport is
  the whole mechanism.
- Remembering Remote Control state across app restarts (state is tied to the
  live process).
- Detecting/controlling Remote Control on sessions that Switchboard did not
  launch, beyond the same best-effort output parsing.
- Mobile push-notification configuration.
- Enforcing plan/login/base-URL requirements — we surface Claude's own failure,
  we do not pre-check.

## Architecture

Switchboard is an Electron app: `main.js` (main process, owns the node-pty
sessions in the `activeSessions` map), `preload.js` (contextBridge IPC), and
`public/` (renderer: `app.js`, `dialogs.js`, `index.html`, styles). Sessions are
spawned in `main.js` and their PTY output flows through a single
`ptyProcess.onData` handler that already parses OSC sequences for busy/idle
state and OSC 8 hyperlinks.

The feature adds one pure module plus focused edits to those existing layers.

### New module: `remote-control.js`

Pure, unit-tested, in the style of `remote-ide.js`. No I/O.

- `remoteControlArgs(name?) -> string`
  Returns the launch-command fragment: `--remote-control`, plus a
  shell-quoted name when provided (e.g. `--remote-control "My Project"`). Name
  quoting reuses the existing quoting approach used for other launch options.

- `remoteControlToggleInput() -> string`
  Returns the exact bytes written to the PTY to toggle at runtime
  (the `/remote-control` command followed by a carriage return).

- `parseRemoteControlSignal(text) -> { url?, active?, disabled? }`
  Scans a chunk of terminal output for:
  - the session URL (captured into `url`),
  - a signal that Remote Control became active (`active: true`),
  - a signal that it was turned off / is unavailable (`disabled: true`).

  **The exact match patterns are written test-first against real captured
  output during implementation** — this spec deliberately does not hardcode
  guessed strings. The unit tests own the sample snippets and the expected
  parse results; the regexes are derived to satisfy them.

### 1. Launch path — `main.js`

Add two fields to `sessionOptions`: `remoteControl` (boolean) and
`remoteControlName` (string, optional).

When `remoteControl` is set, append `remoteControlArgs(remoteControlName)` to:

- the **local** `claude` command builder (around `main.js:1447`), the same place
  `--ide`, `--worktree`, and `--permission-mode` are appended; and
- the **remote (SSH)** `cc` builder (around `main.js:1388`), so remote sessions
  support it too.

To keep this testable, extract the flag-appending into small pure helpers where
practical (the current builders concatenate strings inline); at minimum,
`remoteControlArgs` is unit-tested in isolation.

### 2. Runtime toggle — `main.js` + IPC

New IPC channel `session:toggle-remote-control` (handler in `main.js`, exposed in
`preload.js`). The handler:

1. Looks up the session in `activeSessions`; rejects for plain terminals and
   missing sessions.
2. Refuses to inject while the session is busy (reuse the existing
   `session._cliBusy` flag) so we never interrupt an in-flight prompt. The
   renderer also disables the control while busy; this is the backstop.
3. Writes `remoteControlToggleInput()` into the session's PTY.
4. Flips the optimistic state (see §3) and lets output parsing confirm.

### 3. State tracking + the "distinguisher" — `main.js` `onData`

Each live session gains `session.remoteControl = { enabled, name, url, since }`.

- Set **optimistically** to `enabled: true` when the session is launched with
  the flag or when the toggle is injected.
- **Corroborate** inside the existing `ptyProcess.onData` handler by feeding
  output chunks to `parseRemoteControlSignal`:
  - a captured `url` → confirmed on; store `url`, emit state.
  - a `disabled` signal → off; clear `url`, emit state.
- **Failure handling:** if the state is optimistically `enabled` but no `url`
  (or active signal) is observed within a short window (a few seconds) after
  enabling, revert to off and emit an `unavailable` note. This covers an old
  CLI, wrong plan, or a custom base URL. We never leave a fake "on".
- Emit `remote-control-state` (main → renderer) with
  `{ sessionId, enabled, name, url, unavailable? }` on every change.
- Clear the state on session exit.

### 4. Renderer UI — `public/`

- **New-session dialog** (`dialogs.js`): an "Enable Remote Control" checkbox plus
  an optional name field, alongside the existing worktree / permission-mode /
  IDE options. Feeds `sessionOptions.remoteControl` and `remoteControlName`.
- **Per-session toggle** (`app.js`): a control in the session header/toolbar (and
  reachable from the sidebar entry) that calls the toggle IPC. Hidden for plain
  terminals; disabled with a tooltip while the session is busy.
- **Badge / distinguisher** (`app.js`, styles): a phone/broadcast pill shown on
  both the sidebar session entry and the terminal card header (single-terminal
  and grid-overview views). **Green** when confirmed active (URL/active signal
  seen); **amber "enabling…"** while optimistic-but-unconfirmed; hidden when off.
- **URL / QR affordance** (`app.js`, styles): once a `url` is captured, show a
  "copy link" button and a "show QR" popover. The QR is rendered client-side
  from the captured URL using a small vendored QR encoder (no heavy runtime
  dependency). This popover is the lowest-priority, trimmable piece if it proves
  fiddly — copy-link alone still delivers the core value.

### IPC / preload surface (`preload.js`)

- `toggleRemoteControl(sessionId, { name? })` → invokes
  `session:toggle-remote-control`.
- Subscription to `remote-control-state` events (main → renderer), following the
  existing `cli-busy-state` event pattern.

### 5. Lifecycle & persistence

Remote Control state is **runtime-only**, held in `activeSessions` and cleared on
exit. No SQLite/`db.js` schema change in v1.

## Data flow

**Enable at launch:** new-session dialog → `sessionOptions.remoteControl` → IPC
start-session → `main.js` appends `--remote-control` → PTY spawns → `onData`
sees URL → main emits `remote-control-state {enabled, url}` → renderer shows
green badge + copy/QR.

**Runtime toggle:** renderer button → `toggleRemoteControl` IPC → main writes
`/remote-control\r` to the PTY → `onData` sees the URL (on) or a disabled signal
(off) → main emits state → renderer updates the badge.

## Error handling & edge cases

- **Toggle while busy:** control disabled in the renderer; handler refuses as a
  backstop.
- **Plain terminal / non-Claude session:** no checkbox, no toggle.
- **Remote (SSH) session:** the flag/toggle act on the remote host's `claude`.
  The same Anthropic-login and `api.anthropic.com` requirement applies to the
  remote CLI; Switchboard surfaces the remote CLI's own success/failure output
  the same way.
- **Feature unavailable** (old CLI, wrong plan, custom base URL): no URL appears;
  state reverts to off with an "unavailable" note. No fake success.
- **Output-parsing gaps:** the badge is best-effort. Optimistic state gives
  immediate feedback; observed output corrects it. We accept that a session
  toggled on *inside* the terminal by the user (not via our button) is only
  detected if its output matches the parser.

## Testing

`test/remote-control.test.js` (node:test + assert, matching the existing test
style):

- `remoteControlArgs`: flag present; name absent → no name arg; name present →
  correctly quoted; verified for both the local and remote command builders.
- `parseRemoteControlSignal`: captures the URL from a representative output
  snippet; recognizes the active signal; recognizes the disabled/unavailable
  signal; returns empty for unrelated output. Sample snippets captured from the
  real feature are the source of truth for the regexes.

Manual end-to-end (recorded in the plan): launch or toggle a real session →
confirm URL captured and badge turns green → open the URL/QR on a phone → toggle
off → confirm badge clears.

## Open items to confirm during implementation

- Exact terminal-output strings for the URL, the `/rc active` footer, and the
  off/unavailable message — captured live and encoded in the parser's tests.
- That `--remote-control` composes cleanly with `--session-id` / `--resume` /
  `--fork-session` on the launch path.
- The smallest acceptable QR encoder to vendor (or defer QR to copy-link only).
