# Remote Control Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toggle Claude Code's native Remote Control per session from Switchboard, show which sessions are remote-controlled, and surface the session URL/QR.

**Architecture:** A new pure module (`remote-control.js`) builds the `--remote-control` launch fragment, the `/remote-control` PTY toggle bytes, and a terminal-output parser that captures the session URL. `main.js` appends the flag when launching (local + SSH), adds an IPC handler that injects the toggle into a running PTY, tracks per-session state in `activeSessions`, and emits `remote-control-state` events after parsing PTY output. The renderer (`dialogs.js`, `app.js`, `index.html`, `style.css`) adds a launch checkbox, a header toggle button, a sidebar/grid badge, and a copy-link/QR affordance.

**Tech Stack:** Electron (main + preload + renderer), node-pty, `node:test` + `node:assert` for unit tests. No new runtime networking. One small vendored QR encoder (last task, optional).

## Global Constraints

- Switchboard builds **no networking**; Claude Code's Anthropic-API transport is the entire mechanism.
- Remote Control state is **runtime-only** — held in `activeSessions`, cleared on session exit. No `db.js`/SQLite change.
- Never display "on" when the feature failed to start: an optimistic "enabling…" state must resolve to confirmed-on (URL seen) or revert to off/unavailable.
- Pure logic goes in `remote-control.js` and is unit-tested; `main.js` orchestration is verified manually (matches the repo's `remote-ide.js` convention).
- Match existing code style: string-concatenated `claude` command; double-quoted flag values; `ipcMain.handle`/`ipcRenderer.invoke` for request/response and `ipcMain.on`/`ipcRenderer.send` for fire-and-forget; renderer listeners named `on<Event>` in `preload.js`.
- Runtime toggle is **nameless** (`/remote-control` with no argument); a custom name is only offered on the launch checkbox. This keeps the header button a single click.
- Feature availability (Pro/Max login, `api.anthropic.com`) is **not** pre-checked — we surface Claude's own outcome (URL appears or it doesn't).

---

## File structure

- **Create** `remote-control.js` — pure helpers: `remoteControlArgs`, `remoteControlToggleInput`, `parseRemoteControlSignal`.
- **Create** `test/remote-control.test.js` — unit tests for the pure helpers.
- **Modify** `main.js` — append flag in the local (`~1450–1496`) and remote (`~1388–1405`) command builders; add `session.remoteControl` state + arm/clear the confirm timer near `activeSessions.set` (`~1544`); parse output + emit events in `ptyProcess.onData` (`~1546`); add the toggle IPC handler near `terminal-input` (`~1680`); clear state on exit.
- **Modify** `preload.js` — expose `toggleRemoteControl` (invoke) and `onRemoteControlState` (listener).
- **Modify** `public/dialogs.js` — Remote Control checkbox + optional name in the New Session dialog (`~314`), propagated through `permissionOptions()` (`~404`) and `launchRemoteSession`'s explicit options (`~249`).
- **Modify** `public/index.html` — toggle button + indicator in `#terminal-header-controls` (`~79`).
- **Modify** `public/app.js` — `sessionRcState` map + `onRemoteControlState` listener; badge injection on `.session-item` and grid cards; header button wiring; copy-link; QR.
- **Modify** `public/style.css` — badge, indicator, button, popover styles.
- **Create** `public/vendor/qrcode.js` — small vendored QR encoder (Task 8, optional).

---

## Task 1: Pure module `remote-control.js` + unit tests

**Files:**
- Create: `remote-control.js`
- Test: `test/remote-control.test.js`

**Interfaces:**
- Produces:
  - `remoteControlArgs(name?: string) -> string` — launch fragment, e.g. `--remote-control` or `--remote-control "My Project"`.
  - `remoteControlToggleInput() -> string` — bytes to write to a PTY to toggle at runtime (the `/remote-control` command + carriage return).
  - `parseRemoteControlSignal(text: string) -> { url?: string }` — returns the first Remote Control session URL found in a chunk of terminal output, else `{}`.

- [ ] **Step 1: Write the failing tests**

Create `test/remote-control.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');

const {
  remoteControlArgs,
  remoteControlToggleInput,
  parseRemoteControlSignal,
} = require('../remote-control');

// --- remoteControlArgs ---

test('remoteControlArgs with no name is the bare flag', () => {
  assert.strictEqual(remoteControlArgs(), '--remote-control');
  assert.strictEqual(remoteControlArgs(''), '--remote-control');
  assert.strictEqual(remoteControlArgs('   '), '--remote-control');
});

test('remoteControlArgs with a name double-quotes it', () => {
  assert.strictEqual(remoteControlArgs('My Project'), '--remote-control "My Project"');
});

test('remoteControlArgs escapes embedded double-quotes and backslashes', () => {
  assert.strictEqual(
    remoteControlArgs('a"b\\c'),
    '--remote-control "a\\"b\\\\c"'
  );
});

// --- remoteControlToggleInput ---

test('remoteControlToggleInput sends the /remote-control command then a carriage return', () => {
  assert.strictEqual(remoteControlToggleInput(), '/remote-control\r');
});

// --- parseRemoteControlSignal ---

test('parseRemoteControlSignal captures a claude.ai session URL from output', () => {
  const chunk = 'Remote Control enabled\nOpen: https://claude.ai/code/abc123DEF?x=1 on your phone\n';
  assert.deepStrictEqual(
    parseRemoteControlSignal(chunk),
    { url: 'https://claude.ai/code/abc123DEF?x=1' }
  );
});

test('parseRemoteControlSignal strips surrounding ANSI/whitespace and trailing punctuation', () => {
  const chunk = '\x1b[2m  https://claude.ai/code/xyz789.  \x1b[0m';
  assert.deepStrictEqual(
    parseRemoteControlSignal(chunk),
    { url: 'https://claude.ai/code/xyz789' }
  );
});

test('parseRemoteControlSignal returns {} when no URL is present', () => {
  assert.deepStrictEqual(parseRemoteControlSignal('just some normal output'), {});
  assert.deepStrictEqual(parseRemoteControlSignal(''), {});
  assert.deepStrictEqual(parseRemoteControlSignal(null), {});
});

test('parseRemoteControlSignal ignores non-claude URLs', () => {
  assert.deepStrictEqual(
    parseRemoteControlSignal('see https://example.com/code/abc'),
    {}
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -A2 remote-control`
Expected: FAIL — `Cannot find module '../remote-control'`.

- [ ] **Step 3: Implement `remote-control.js`**

Create `remote-control.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "remote-control|pass|fail" | head`
Expected: the `remote-control` tests PASS; no failures introduced.

- [ ] **Step 5: Commit**

```bash
git add remote-control.js test/remote-control.test.js
git commit -m "feat(remote-control): pure helpers for flag, toggle input, URL parse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Append `--remote-control` at launch (main.js, local + SSH)

**Files:**
- Modify: `main.js` (require the module near the other `remote-*` requires; local builder `~1450–1496`; remote builder `~1388–1405`)

**Interfaces:**
- Consumes: `remoteControlArgs` from Task 1; `sessionOptions.remoteControl` (boolean) and `sessionOptions.remoteControlName` (string, optional) — produced by the renderer in Task 5.
- Produces: sessions launched with the flag when `remoteControl` is set (local and remote).

- [ ] **Step 1: Require the module**

Near the top of `main.js`, alongside the existing `remote-hosts`/`remote-index`/`remote-ide` requires, add:

```js
const remoteControl = require('./remote-control');
```

- [ ] **Step 2: Append the flag in the LOCAL builder**

In the local `claude` command block, immediately after the Additional Directories loop (the `--add-dir` block ending around line 1477) and before the `--append-system-prompt` handling, add:

```js
        if (sessionOptions.remoteControl) {
          claudeCmd += ' ' + remoteControl.remoteControlArgs(sessionOptions.remoteControlName);
        }
```

- [ ] **Step 3: Append the flag in the REMOTE (SSH) builder**

In the remote `cc` builder, right before the `if (ideInfo) cc += ' --ide';` line (around line 1405), add:

```js
        if (sessionOptions?.remoteControl) {
          cc += ' ' + remoteControl.remoteControlArgs(sessionOptions.remoteControlName);
        }
```

- [ ] **Step 4: Verify manually (no automated test — spawn path)**

Run `npm run electron`, start a new LOCAL session with the flag by temporarily passing options — simplest check: add a `console.log(claudeCmd)` after the local builder, start a session with the dialog checkbox once Task 5 lands, and confirm `--remote-control` is present. For now, verify the code compiles and the app launches:

Run: `node -e "require('./remote-control'); console.log('module ok')"`
Expected: `module ok`. Then `npm run electron` launches without error.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(remote-control): append --remote-control at launch (local + ssh)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Runtime toggle IPC (main.js handler + preload)

**Files:**
- Modify: `main.js` (new handler near `terminal-input`, `~1685`)
- Modify: `preload.js` (invoke binding, `~23`)

**Interfaces:**
- Consumes: `remoteControlToggleInput` from Task 1; `session._cliBusy` (existing busy flag); `session.remoteControl` (initialized in Task 4 — guard with optional chaining so this task is safe if run first).
- Produces: IPC channel `session:toggle-remote-control` returning `{ ok: boolean, error?: string, enabling?: boolean }`; `api.toggleRemoteControl(sessionId)` in the renderer.

- [ ] **Step 1: Add the IPC handler**

In `main.js`, immediately after the `terminal-input` handler (ends at line 1685), add:

```js
// --- IPC: toggle Remote Control on a running session ---
ipcMain.handle('session:toggle-remote-control', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'session not running' };
  if (session.isPlainTerminal) return { ok: false, error: 'not a Claude session' };
  if (session._cliBusy) return { ok: false, error: 'Claude is busy — wait until it is idle' };

  const willEnable = !(session.remoteControl && session.remoteControl.enabled);
  try {
    session.pty.write(remoteControl.remoteControlToggleInput());
  } catch (err) {
    return { ok: false, error: err.message };
  }
  setRemoteControlState(session, sessionId, {
    enabled: willEnable,
    url: willEnable ? null : null,
    unavailable: false,
  }, willEnable /* armTimer */);
  return { ok: true, enabling: willEnable };
});
```

> `setRemoteControlState` is defined in Task 4. If implementing this task before Task 4, add a temporary no-op `function setRemoteControlState() {}` and remove it in Task 4. (Recommended order: do Task 4 first, then Task 3 — the handler references it.)

- [ ] **Step 2: Expose it in preload**

In `preload.js`, in the invoke group (after `openTerminal`, ~line 21), add:

```js
  toggleRemoteControl: (id) => ipcRenderer.invoke('session:toggle-remote-control', id),
```

- [ ] **Step 3: Verify**

Run: `node -e "require('./remote-control')" && npm run electron`
Expected: app launches; in DevTools console, `await window.api.toggleRemoteControl('nope')` returns `{ ok: false, error: 'session not running' }`.

- [ ] **Step 4: Commit**

```bash
git add main.js preload.js
git commit -m "feat(remote-control): IPC to toggle /remote-control on a running session

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: State tracking, output parsing, and events (main.js + preload)

**Files:**
- Modify: `main.js` (state helper + init near `activeSessions.set` `~1544`; parse in `onData` `~1546`; clear on exit)
- Modify: `preload.js` (listener binding, ~line 69)

**Interfaces:**
- Consumes: `parseRemoteControlSignal` from Task 1; `mainWindow.webContents.send` (existing event pattern); `sessionOptions.remoteControl` from Task 5.
- Produces:
  - `session.remoteControl = { enabled: boolean, name: string|null, url: string|null, unavailable: boolean }`.
  - `setRemoteControlState(session, sessionId, patch, armTimer?)` helper (used by Task 3 and here).
  - Event `remote-control-state` → renderer with `(sessionId, { enabled, url, name, unavailable })`.
  - `api.onRemoteControlState(cb)` in the renderer.

- [ ] **Step 1: Add the state helper**

In `main.js`, above the `open-terminal` handler (a module-level function), add:

```js
// Update + broadcast a session's Remote Control state. When enabling, arm a
// timer: if no session URL is observed shortly, the mode did not actually start
// (old CLI / wrong plan / non-anthropic base URL), so revert to off+unavailable.
const RC_CONFIRM_MS = 8000;
function setRemoteControlState(session, sessionId, patch, armTimer) {
  if (!session) return;
  session.remoteControl = Object.assign(
    { enabled: false, name: null, url: null, unavailable: false },
    session.remoteControl || {},
    patch
  );
  if (session._rcTimer) { clearTimeout(session._rcTimer); session._rcTimer = null; }
  if (armTimer) {
    session._rcTimer = setTimeout(() => {
      session._rcTimer = null;
      if (session.remoteControl && session.remoteControl.enabled && !session.remoteControl.url) {
        setRemoteControlState(session, sessionId, { enabled: false, unavailable: true });
      }
    }, RC_CONFIRM_MS);
    if (session._rcTimer.unref) session._rcTimer.unref();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-control-state', sessionId, session.remoteControl);
  }
}
```

- [ ] **Step 2: Initialize state at spawn (optimistic when launched with the flag)**

Just after `activeSessions.set(sessionId, session);` (line 1544), add:

```js
  if (sessionOptions?.remoteControl) {
    setRemoteControlState(session, sessionId, {
      enabled: true,
      name: sessionOptions.remoteControlName || null,
    }, true /* armTimer */);
  }
```

- [ ] **Step 3: Parse output in the onData handler**

Inside `ptyProcess.onData(data => { ... })` (starts line 1546), near the top of the handler body (after `const currentId = session.realSessionId || sessionId;`), add:

```js
    // Remote Control: capture the session URL to confirm the mode is active.
    if (data.includes('claude.ai/code/')) {
      const sig = remoteControl.parseRemoteControlSignal(data);
      if (sig.url && (!session.remoteControl || session.remoteControl.url !== sig.url)) {
        setRemoteControlState(session, currentId, { enabled: true, url: sig.url, unavailable: false });
      }
    }
```

- [ ] **Step 4: Clear the confirm timer on exit**

Find the process-exit handling (`ptyProcess.onExit` / where `process-exited` is sent, `~1228`). Add, right before the session is removed from `activeSessions`:

```js
    if (session._rcTimer) { clearTimeout(session._rcTimer); session._rcTimer = null; }
```

- [ ] **Step 5: Expose the listener in preload**

In `preload.js`, in the listeners group (after `onCliBusyState`, ~line 60), add:

```js
  onRemoteControlState: (callback) => {
    ipcRenderer.on('remote-control-state', (_event, sessionId, state) => callback(sessionId, state));
  },
```

- [ ] **Step 6: Manual verification (capture real output — critical)**

Run `npm run electron`, start a real Claude session (logged in, `api.anthropic.com`), and toggle Remote Control (via the terminal, typing `/remote-control`). In the main-process logs / DevTools, confirm:
- a `claude.ai/code/...` URL is captured and a `remote-control-state` event fires with `enabled: true` and the `url`.
If the URL host/path differs from `claude.ai/code/`, widen `URL_RE` in `remote-control.js` and update the Task 1 tests to match the real string. Re-run `npm test`.

- [ ] **Step 7: Commit**

```bash
git add main.js preload.js remote-control.js test/remote-control.test.js
git commit -m "feat(remote-control): track state, parse session URL, emit events

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Launch checkbox in the New Session dialog (dialogs.js)

**Files:**
- Modify: `public/dialogs.js` (dialog markup `~314`; `permissionOptions()` `~404`; `launchRemoteSession` options `~249`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sessionOptions.remoteControl` (boolean) and `sessionOptions.remoteControlName` (string) on both local and remote launches (Task 2 reads these).

- [ ] **Step 1: Add the checkbox markup (visible for local AND remote)**

In `showNewSessionDialog`'s `dialog.innerHTML`, immediately after the Permission Mode field (the `</div>` closing `#nsd-mode-grid`'s field, line 317) and before `<div id="nsd-local-only">`, insert:

```html
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Remote Control</span>
        <div class="settings-description">Control this session from your phone (claude.ai / mobile app)</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="nsd-remote-control-name" placeholder="name (optional)" value="" style="width:140px">
        <label class="settings-toggle"><input type="checkbox" id="nsd-remote-control"><span class="settings-toggle-slider"></span></label>
      </div>
    </div>
```

- [ ] **Step 2: Read the checkbox into shared options**

In `permissionOptions()` (line 404), before `return options;`, add:

```js
    if (dialog.querySelector('#nsd-remote-control').checked) {
      options.remoteControl = true;
      const rcName = dialog.querySelector('#nsd-remote-control-name').value.trim();
      if (rcName) options.remoteControlName = rcName;
    }
```

Because `permissionOptions()` feeds both the local path (`start()` line 423) and the remote path (`start()` line 418 spread), this covers local launches immediately.

- [ ] **Step 3: Propagate through the remote launch allowlist**

`launchRemoteSession` rebuilds an explicit options object for `openTerminal` (lines ~249–257) — add the two fields so they reach the remote spawn. After the `addDirs: options.addDirs,` line, add:

```js
    remoteControl: options.remoteControl,
    remoteControlName: options.remoteControlName,
```

- [ ] **Step 4: Verify**

Run `npm run electron`. Open New Session on a local project → the "Remote Control" toggle appears above Worktree. Check it, add a name, Start. In the terminal, confirm `claude … --remote-control "name"` launched (the session shows the RC URL). Repeat for a remote (SSH) project.

- [ ] **Step 5: Commit**

```bash
git add public/dialogs.js
git commit -m "feat(remote-control): New Session dialog checkbox (local + remote)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Sidebar + grid badge (app.js + style.css)

**Files:**
- Modify: `public/app.js` (state map + listener near `sessionBusyState` `~113` and `onCliBusyState` `~342`)
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `api.onRemoteControlState` from Task 4.
- Produces: `sessionRcState` map (`sessionId → { enabled, url, name, unavailable }`); `applyRcBadge(sessionId)` helper; a `.rc-badge` element on `.session-item` and grid cards.

- [ ] **Step 1: Add the state map and listener**

In `public/app.js`, near `const sessionBusyState = new Map();` (line 113), add:

```js
const sessionRcState = new Map(); // sessionId → { enabled, url, name, unavailable }
```

After the `onCliBusyState` listener (line 342-344), add:

```js
window.api.onRemoteControlState((sessionId, state) => {
  sessionRcState.set(sessionId, state);
  applyRcBadge(sessionId);
  updateRcHeader(sessionId); // defined in Task 7; safe no-op stub until then
});

// Inject/update/remove the Remote Control badge on the sidebar item and grid card.
function applyRcBadge(sessionId) {
  const state = sessionRcState.get(sessionId);
  const on = !!(state && state.enabled);
  const confirmed = on && !!state.url;
  document
    .querySelectorAll(`.session-item[data-session-id="${sessionId}"], .grid-card[data-session-id="${sessionId}"]`)
    .forEach(el => {
      el.classList.toggle('has-remote-control', on);
      let badge = el.querySelector('.rc-badge');
      if (!on) { if (badge) badge.remove(); return; }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'rc-badge';
        badge.title = 'Remote Control';
        badge.textContent = '📱';
        const target = el.querySelector('.session-item-name') || el.querySelector('.grid-card-header') || el;
        target.appendChild(badge);
      }
      badge.classList.toggle('rc-badge-confirmed', confirmed);
      badge.classList.toggle('rc-badge-pending', !confirmed);
    });
}
```

> If `updateRcHeader` is not yet defined (Task 7), add a temporary `function updateRcHeader() {}` at the top of the file and remove it when Task 7 lands.

- [ ] **Step 2: Re-apply badges after sidebar re-renders**

The sidebar list is rebuilt on refresh (the `document.querySelectorAll('.session-item')` sweep around line 544). At the end of that sweep function, add:

```js
  sessionRcState.forEach((_state, sid) => applyRcBadge(sid));
```

- [ ] **Step 3: Add CSS**

In `public/style.css`, add:

```css
.rc-badge {
  margin-left: 6px;
  font-size: 11px;
  line-height: 1;
  filter: grayscale(1) opacity(0.6);
}
.rc-badge-confirmed { filter: none; }
.rc-badge-pending { animation: rc-pulse 1.2s ease-in-out infinite; }
@keyframes rc-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
.session-item.has-remote-control { position: relative; }
```

- [ ] **Step 4: Verify**

Launch a session with Remote Control. The sidebar entry shows a pulsing 📱 while enabling, turning solid once the URL is captured. Toggle off (Task 7 button, or relaunch) → badge disappears. Confirm the grid overview card shows it too.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/style.css
git commit -m "feat(remote-control): sidebar + grid badge for remote-controlled sessions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Header toggle button + indicator (index.html + app.js + style.css)

**Files:**
- Modify: `public/index.html` (`#terminal-header-controls` `~79–82`)
- Modify: `public/app.js` (button wiring; `updateRcHeader`; per-session-switch refresh)
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `api.toggleRemoteControl` (Task 3); `sessionRcState` + `applyRcBadge` (Task 6); `activeSessionId`, `sessionBusyState`, `openSessions` (existing in app.js).
- Produces: `updateRcHeader(sessionId)` (replaces the Task 6 stub); a header button `#terminal-header-rc-btn`.

- [ ] **Step 1: Add the button to the header**

In `public/index.html`, inside `#terminal-header-controls`, before `#terminal-stop-btn` (line 81), add:

```html
          <button id="terminal-header-rc-btn" title="Toggle Remote Control" style="display:none;">📱</button>
```

- [ ] **Step 2: Wire the button + implement `updateRcHeader`**

In `public/app.js`, remove the temporary `updateRcHeader` stub (if added) and add near the other header element lookups (line 10-14 area) and setup code:

```js
const terminalHeaderRcBtn = document.getElementById('terminal-header-rc-btn');

if (terminalHeaderRcBtn) {
  terminalHeaderRcBtn.addEventListener('click', async () => {
    if (!activeSessionId) return;
    terminalHeaderRcBtn.disabled = true;
    const res = await window.api.toggleRemoteControl(activeSessionId);
    terminalHeaderRcBtn.disabled = false;
    if (!res || !res.ok) {
      setStatus((res && res.error) || 'Could not toggle Remote Control', 'error');
    }
  });
}

// Show/enable the header RC button + reflect state for the active session.
function updateRcHeader(sessionId) {
  if (!terminalHeaderRcBtn) return;
  if (sessionId && sessionId !== activeSessionId) return;
  const entry = activeSessionId ? openSessions.get(activeSessionId) : null;
  const isClaude = !!entry && !entry.isPlainTerminal;
  terminalHeaderRcBtn.style.display = isClaude ? '' : 'none';
  if (!isClaude) return;
  const state = sessionRcState.get(activeSessionId);
  const on = !!(state && state.enabled);
  const confirmed = on && !!state.url;
  const busy = sessionBusyState.get(activeSessionId) || false;
  terminalHeaderRcBtn.classList.toggle('rc-on', confirmed);
  terminalHeaderRcBtn.classList.toggle('rc-pending', on && !confirmed);
  terminalHeaderRcBtn.disabled = busy;
  terminalHeaderRcBtn.title = busy
    ? 'Wait until Claude is idle to toggle Remote Control'
    : (on ? 'Remote Control ON — click to turn off' : 'Turn on Remote Control');
}
```

> `setStatus`/`openSessions` already exist in app.js — confirm the exact `setStatus` name while wiring (the status helper used elsewhere) and match it. If the entry object does not expose `isPlainTerminal`, fall back to the existing "is this a Claude session" check used for the stop button.

- [ ] **Step 3: Refresh the header on session switch and busy change**

Where the active session changes (`setActiveSession`, line 57) and at the end of the `onCliBusyState` handler (line 342), call `updateRcHeader(activeSessionId)` so the button appears/updates. Add to `setActiveSession`:

```js
  updateRcHeader(id);
```

and inside the `onCliBusyState` callback, after `setActivity(...)`:

```js
  if (sessionId === activeSessionId) updateRcHeader(sessionId);
```

- [ ] **Step 4: Style the button states**

In `public/style.css`, add:

```css
#terminal-header-rc-btn.rc-on { color: #2ea043; }
#terminal-header-rc-btn.rc-pending { color: #d29922; animation: rc-pulse 1.2s ease-in-out infinite; }
#terminal-header-rc-btn:disabled { opacity: 0.4; cursor: default; }
```

- [ ] **Step 5: Verify**

Open a running Claude session → the 📱 button shows in the header. Click it → `/remote-control` is injected, button pulses amber, then turns green when the URL is captured, and the sidebar badge matches. Click again → toggles off. While Claude is busy, the button is disabled with the tooltip. On a plain terminal, the button is hidden.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat(remote-control): header toggle button + status indicator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Copy-link + QR affordance (app.js + index.html + style.css + vendored QR)

**Files:**
- Modify: `public/index.html` (a small popover container in the header)
- Modify: `public/app.js` (copy-link + QR render)
- Modify: `public/style.css`
- Create: `public/vendor/qrcode.js` (small MIT QR encoder; QR is the trimmable part — ship copy-link first)

**Interfaces:**
- Consumes: `sessionRcState` (the captured `url`); `api` clipboard/openExternal.
- Produces: a "copy link / show QR" popover anchored to the header button when a confirmed URL exists.

- [ ] **Step 1: Add the popover container**

In `public/index.html`, after `#terminal-header-rc-btn`, add:

```html
          <div id="rc-popover" style="display:none;">
            <div id="rc-popover-url"></div>
            <div id="rc-popover-actions">
              <button id="rc-copy-btn" type="button">Copy link</button>
              <button id="rc-open-btn" type="button">Open</button>
            </div>
            <div id="rc-qr"></div>
          </div>
```

- [ ] **Step 2: Copy-link + open (guaranteed value, no dependency)**

In `public/app.js`, add a helper that opens the popover for the active session's URL, and wire it to a long-press / right-click / secondary affordance on the RC button (simplest: show the popover automatically when a URL is first confirmed, and on button hover). Minimum viable wiring:

```js
const rcPopover = document.getElementById('rc-popover');
const rcPopoverUrl = document.getElementById('rc-popover-url');
const rcCopyBtn = document.getElementById('rc-copy-btn');
const rcOpenBtn = document.getElementById('rc-open-btn');

function showRcPopover() {
  const state = sessionRcState.get(activeSessionId);
  if (!state || !state.url) { rcPopover.style.display = 'none'; return; }
  rcPopoverUrl.textContent = state.url;
  rcPopover.style.display = '';
  renderRcQr(state.url); // Step 4
}
if (rcCopyBtn) rcCopyBtn.addEventListener('click', () => {
  const state = sessionRcState.get(activeSessionId);
  if (state && state.url) navigator.clipboard.writeText(state.url);
});
if (rcOpenBtn) rcOpenBtn.addEventListener('click', () => {
  const state = sessionRcState.get(activeSessionId);
  if (state && state.url) window.api.openExternal(state.url);
});
```

Call `showRcPopover()` from inside `updateRcHeader` when `confirmed` becomes true (guard so it only auto-opens on the transition, not every event).

- [ ] **Step 3: Vendor a QR encoder**

Download a small, self-contained, MIT-licensed QR generator (e.g. the single-file `qrcode-generator` by Kazuhiko Arase) into `public/vendor/qrcode.js`, and load it in `index.html` before `app.js`:

```html
    <script src="vendor/qrcode.js"></script>
```

- [ ] **Step 4: Render the QR from the URL**

In `public/app.js`:

```js
function renderRcQr(url) {
  const el = document.getElementById('rc-qr');
  if (!el || typeof qrcode === 'undefined') { if (el) el.innerHTML = ''; return; }
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    el.innerHTML = qr.createImgTag(4, 8); // cellSize, margin
  } catch { el.innerHTML = ''; }
}
```

- [ ] **Step 5: Style the popover**

In `public/style.css`, add:

```css
#rc-popover {
  position: absolute; z-index: 40; right: 8px; top: 40px;
  background: var(--panel-bg, #1e1e1e); border: 1px solid var(--border, #333);
  border-radius: 8px; padding: 10px; max-width: 260px;
}
#rc-popover-url { font-size: 11px; word-break: break-all; opacity: 0.8; margin-bottom: 8px; }
#rc-popover-actions { display: flex; gap: 6px; margin-bottom: 8px; }
#rc-qr img { display: block; }
```

(Use the project's existing CSS variables if the names differ — grep `style.css` for the panel/border tokens and match them.)

- [ ] **Step 6: Verify**

Enable Remote Control on a session; when it confirms, the popover shows the URL, a working "Copy link", "Open" (opens in the default browser), and a scannable QR. Scan it with a phone to confirm it reaches the session.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js public/style.css public/vendor/qrcode.js
git commit -m "feat(remote-control): copy-link + QR for the session URL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:**
- Toggle at launch → Tasks 2 (main.js) + 5 (dialog checkbox). ✅
- Toggle at runtime → Task 3 (IPC) + 7 (button). ✅
- Works local + SSH → Task 2 (both builders) + 5 (both launch paths). ✅
- Distinguisher / badge (sidebar + terminal card + grid) → Task 6 + 7. ✅
- Optimistic + corroborated state, unavailable fallback → Task 4. ✅
- Surface URL/QR → Task 8. ✅
- Runtime-only state, cleared on exit → Task 4 (timer clear) + state lives in `activeSessions`. ✅
- Unit tests for `remoteControlArgs` + `parseRemoteControlSignal` → Task 1. ✅
- Manual E2E → Tasks 4/5/7/8 verification steps. ✅
- No custom networking; no DB change → honored throughout. ✅

**Placeholder scan:** The only deferred item is the exact Remote Control URL host/path, which Task 4 Step 6 captures from real output and folds back into the Task 1 regex + tests — this is a verification step, not a code placeholder. All code steps contain real code. The two "temporary stub" notes (Task 3 `setRemoteControlState`, Task 6 `updateRcHeader`) are ordering aids with explicit removal instructions.

**Type consistency:** `remoteControlArgs`, `remoteControlToggleInput`, `parseRemoteControlSignal` are named identically across Tasks 1–4. `session.remoteControl` shape `{ enabled, name, url, unavailable }` is consistent in Tasks 3, 4, 6, 7. `sessionOptions.remoteControl` / `remoteControlName` consistent in Tasks 2 and 5. Event name `remote-control-state` and IPC channel `session:toggle-remote-control` consistent across main.js and preload.js. `sessionRcState` / `applyRcBadge` / `updateRcHeader` consistent in Tasks 6–8.

**Recommended execution order:** 1 → 2 → 4 → 3 → 5 → 6 → 7 → 8 (Task 4 before Task 3 so `setRemoteControlState` exists).
