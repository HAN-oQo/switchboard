# Session Persistence — Phase 1 (Local, tmux-backed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make **local** Switchboard sessions keep running in the background when the app closes, by running each session inside a local `tmux` session, and auto-reattach to the live process (with scrollback) on reopen.

**Architecture:** Wrap the shell/Claude command in `tmux new-session -A -s sb_<handle>` so the process is owned by tmux's detached server (survives app quit). The app spawns/attaches the tmux client via `node-pty`. On quit we detach (kill the client, never the tmux session); "End session" kills the tmux session. On startup we probe `tmux ls`, auto-reattach previously-open sessions, and badge other live background sessions. If tmux is absent, fall back to today's behavior (kill on quit, `--resume` on reopen).

**Tech Stack:** Electron, node-pty, better-sqlite3 settings store, tmux (system binary), `node:test`.

**Scope:** LOCAL sessions only (Claude + plain terminal). Remote (SSH) persistence is Phase 2 — a separate plan. Full-scrollback capture and a background-session management UI are Phase 3.

## Global Constraints

- Tests run under Electron's node ABI: `npm test` == `ELECTRON_RUN_AS_NODE=1 electron --test`. Pure helpers must be plain CommonJS requambleable without Electron APIs.
- Pure logic lives in a standalone module (`tmux-session.js`) mirroring `remote-hosts.js` / `remote-ide.js`; impure calls (spawn/exec/fs) stay in `main.js`.
- New settings via existing `getSetting(key)` / `setSetting(key, value)` (db.js) — no schema/migration needed for settings keys.
- tmux session name = `sb_<handle>` where `<handle>` is a self-generated stable id, independent of the Claude session id (which re-keys later).
- Never break the no-tmux path: everything is gated on `persistEnabled = persistSessions setting !== false && tmuxAvailable`.
- Branch: `feat/session-persistence` (off `fork/main`). Commit after every green step.

---

### Task 1: Pure `tmux-session.js` module (arg builders + parsing + config)

**Files:**
- Create: `tmux-session.js`
- Test: `test/tmux-session.test.js`

**Interfaces:**
- Produces (all pure, no I/O):
  - `sessionName(handle: string) -> string` — returns `"sb_" + sanitized(handle)`; sanitize replaces any char not `[A-Za-z0-9_-]` with `_`.
  - `newSessionArgs({ name, cols, rows, confPath, env, command }) -> string[]` — argv for `tmux` (excluding the `tmux` program itself). `command` is a string[] (program + args) run inside the session. `env` is an object → each key becomes `-e KEY=VALUE`.
  - `killArgs(name) -> string[]` → `['kill-session', '-t', name]`
  - `hasSessionArgs(name) -> string[]` → `['has-session', '-t', name]`
  - `listArgs() -> string[]` → `['ls', '-F', '#{session_name}']`
  - `parseSessionList(output: string) -> string[]` — split lines, trim, drop empties, keep only names starting with `sb_`.
  - `confContent() -> string` — the isolated tmux config text.

- [ ] **Step 1: Write the failing test**

```javascript
// test/tmux-session.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep tmux-session`
Expected: FAIL — `Cannot find module '../tmux-session'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
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

module.exports = {
  sessionName, newSessionArgs, killArgs, hasSessionArgs, listArgs,
  parseSessionList, confContent,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -5`
Expected: all tests pass, fail 0.

- [ ] **Step 5: Commit**

```bash
git add tmux-session.js test/tmux-session.test.js
git commit -m "feat(tmux): pure helpers for tmux-backed sessions (args, parse, conf)"
```

---

### Task 2: tmux availability detection + config file materialization (main.js)

**Files:**
- Modify: `main.js` (near other module requires ~line 29-73, and app init)
- Test: `test/tmux-session.test.js` (extend for the pure `parseTmuxVersionAvailable` helper)

**Interfaces:**
- Consumes: `tmux-session.js`.
- Produces (in `main.js`, module-scope):
  - `tmuxAvailable: boolean` — set once at startup via `spawnSync('tmux', ['-V'])`.
  - `TMUX_CONF_PATH: string` — path under `app.getPath('userData')`/`sb.tmux.conf`, written once from `confContent()`.
  - `persistEnabled(projectPath?) -> boolean` — `tmuxAvailable && settingsPersistOn()`.
- Produces (in `tmux-session.js`): `isVersionOutput(out: string) -> boolean` — true iff output matches `/^tmux \d/`.

- [ ] **Step 1: Write the failing test**

```javascript
test('isVersionOutput recognizes a tmux -V banner', () => {
  assert.equal(tm.isVersionOutput('tmux 3.4\n'), true);
  assert.equal(tm.isVersionOutput('tmux next-3.5'), false); // no digit right after space
  assert.equal(tm.isVersionOutput('command not found'), false);
  assert.equal(tm.isVersionOutput(''), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -i version`
Expected: FAIL — `tm.isVersionOutput is not a function`.

- [ ] **Step 3: Implement `isVersionOutput` in tmux-session.js**

```javascript
function isVersionOutput(out) { return /^tmux \d/.test(String(out || '').trim()); }
```
Add `isVersionOutput` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -5`
Expected: pass.

- [ ] **Step 5: Wire detection + conf file in main.js**

Near the top requires (after line 29's shell-profiles require), add:
```javascript
const tmuxSession = require('./tmux-session');
```
In the app startup path (where other init runs; after `app.whenReady()` resolves is fine — use the same place the DB/window are set up), add:
```javascript
const { spawnSync } = require('child_process');
let tmuxAvailable = false;
try {
  const r = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  tmuxAvailable = r.status === 0 && tmuxSession.isVersionOutput(r.stdout);
} catch { tmuxAvailable = false; }

const TMUX_CONF_PATH = path.join(app.getPath('userData'), 'sb.tmux.conf');
try { fs.writeFileSync(TMUX_CONF_PATH, tmuxSession.confContent()); } catch (e) { log.warn(`[tmux] conf write failed: ${e.message}`); }

function settingsPersistOn() {
  const g = getSetting('global') || {};
  return g.persistSessions !== false; // default on
}
function persistEnabled() { return tmuxAvailable && settingsPersistOn(); }
log.info(`[tmux] available=${tmuxAvailable} persistDefault=${settingsPersistOn()}`);
```

- [ ] **Step 6: Manual verify + commit**

Run: `npm start` then check the log for `[tmux] available=...`. Confirm `sb.tmux.conf` exists under the userData dir.
```bash
git add main.js tmux-session.js test/tmux-session.test.js
git commit -m "feat(tmux): detect tmux availability and materialize isolated conf"
```

---

### Task 3: `persistentSessions` store helpers (pure) + wiring

**Files:**
- Create: `session-store.js`
- Test: `test/session-store.test.js`
- Modify: `main.js` (read/write the store)

**Interfaces:**
- Produces (pure, in `session-store.js`):
  - `upsertEntry(store, handle, fields) -> newStore` — immutable merge of `fields` into `store[handle]`.
  - `removeEntry(store, handle) -> newStore`
  - `pruneDead(store, liveNames, sessionNameFn) -> newStore` — drop entries whose `sessionNameFn(handle)` is not in `liveNames`.
  - `openEntries(store) -> Array<{handle, ...entry}>` — entries with `wasOpen === true`, sorted by `lastActiveAt` desc.
  - `backgroundEntries(store, openHandles) -> Array<{handle, ...entry}>` — live entries whose handle is not in `openHandles`.
- Store shape: `{ [handle]: { projectPath, mode, claudeSessionId, lastActiveAt, wasOpen } }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/session-store.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep session-store`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// session-store.js — pure transforms over the persistentSessions map.
function upsertEntry(store, handle, fields) {
  return { ...store, [handle]: { ...(store[handle] || {}), ...fields } };
}
function removeEntry(store, handle) {
  const next = { ...store };
  delete next[handle];
  return next;
}
function pruneDead(store, liveNames, sessionNameFn) {
  const live = new Set(liveNames);
  const next = {};
  for (const [h, e] of Object.entries(store)) {
    if (live.has(sessionNameFn(h))) next[h] = e;
  }
  return next;
}
function openEntries(store) {
  return Object.entries(store)
    .filter(([, e]) => e.wasOpen === true)
    .map(([handle, e]) => ({ handle, ...e }))
    .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
}
function backgroundEntries(store, openHandles) {
  return Object.entries(store)
    .filter(([h]) => !openHandles.has(h))
    .map(([handle, e]) => ({ handle, ...e }))
    .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
}
module.exports = { upsertEntry, removeEntry, pruneDead, openEntries, backgroundEntries };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -5`
Expected: pass.

- [ ] **Step 5: Wire read/write helpers in main.js**

Add near the tmux init (Task 2):
```javascript
const sessionStore = require('./session-store');
function readPersistStore() { return getSetting('persistentSessions') || {}; }
function writePersistStore(store) { setSetting('persistentSessions', store); }
```

- [ ] **Step 6: Commit**

```bash
git add session-store.js test/session-store.test.js main.js
git commit -m "feat(tmux): pure persistentSessions store transforms + main wiring"
```

---

### Task 4: Spawn local sessions inside tmux (Claude + plain terminal)

**Files:**
- Modify: `main.js` — `open-terminal` handler local branches (`else if (isPlainTerminal)` ~1453-1478 and the final `else` Claude branch ~1479-1556), and the session object (~1563-1580).

**Interfaces:**
- Consumes: `tmuxSession.sessionName/newSessionArgs`, `TMUX_CONF_PATH`, `persistEnabled()`, `readPersistStore/writePersistStore`, `sessionStore.upsertEntry`.
- Produces: session object gains `tmuxName: string | null` and `handle: string | null`; `persistentSessions[handle]` upserted with `{ projectPath, mode, wasOpen: true, lastActiveAt }`.

- [ ] **Step 1: Add a helper that wraps a local spawn in tmux (main.js)**

Add near tmux init:
```javascript
const crypto = require('crypto');
// Spawn a local session, wrapped in tmux when persistence is enabled.
// shell/args/opts are the existing pty.spawn inputs; env is opts.env.
// Returns { ptyProcess, tmuxName, handle }.
function spawnLocalSession({ shell, args, opts, envForTmux }) {
  if (!persistEnabled()) {
    return { ptyProcess: pty.spawn(shell, args, opts), tmuxName: null, handle: null };
  }
  const handle = crypto.randomUUID();
  const tmuxName = tmuxSession.sessionName(handle);
  const tmuxArgs = tmuxSession.newSessionArgs({
    name: tmuxName, cols: opts.cols, rows: opts.rows,
    confPath: TMUX_CONF_PATH, env: envForTmux || {},
    command: [shell, ...args],
  });
  // env passed to the tmux CLIENT; the -e flags carry per-session env into the server.
  const ptyProcess = pty.spawn('tmux', tmuxArgs, { ...opts });
  return { ptyProcess, tmuxName, handle };
}
```

- [ ] **Step 2: Use it in the Claude branch (replace the `pty.spawn` at ~1547)**

Replace:
```javascript
      ptyProcess = pty.spawn(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color', cols: 120, rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: ptyEnv,
      });
```
with:
```javascript
      {
        const spawnOpts = {
          name: 'xterm-256color', cols: 120, rows: 30,
          cwd: isWsl ? os.homedir() : projectPath, env: ptyEnv,
        };
        // Only CLAUDE_CODE_SSE_PORT must cross the tmux server boundary (-e).
        const envForTmux = ptyEnv.CLAUDE_CODE_SSE_PORT
          ? { CLAUDE_CODE_SSE_PORT: ptyEnv.CLAUDE_CODE_SSE_PORT } : {};
        const r = spawnLocalSession({
          shell, args: shellArgs(shell, claudeCmd, shellExtraArgs), opts: spawnOpts, envForTmux,
        });
        ptyProcess = r.ptyProcess; var _tmuxName = r.tmuxName; var _handle = r.handle;
      }
```
(WSL never reaches persistence in practice — WSL is Windows-only and tmux detection will be false there; the fallback path handles it.)

- [ ] **Step 3: Same wrap for the plain-terminal branch (~1457)**

Apply the identical pattern to the plain-terminal `pty.spawn`, passing `envForTmux: {}` (no MCP port). Capture `_tmuxName`/`_handle` in the outer scope (declare `let tmuxName = null, handle = null;` before the `try` at ~1382 and assign inside each branch instead of `var`).

- [ ] **Step 4: Persist into the session object + store (~1563)**

In the `session` object literal add:
```javascript
    tmuxName, handle,
```
After `activeSessions.set(sessionId, session);` add:
```javascript
  if (handle) {
    writePersistStore(sessionStore.upsertEntry(readPersistStore(), handle, {
      projectPath, mode: isPlainTerminal ? 'shell' : 'claude',
      wasOpen: true, lastActiveAt: session._openedAt,
    }));
  }
```

- [ ] **Step 5: Manual verify**

Run `npm start`. Open a local Claude session. In a separate terminal run `tmux ls` → expect an `sb_<uuid>` session. Confirm the Claude session works normally (typing, IME, resize). Check the settings store has a `persistentSessions` entry (log it or inspect DB).

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat(tmux): run local Claude/terminal sessions inside tmux when enabled"
```

---

### Task 5: Lifecycle — detach on quit, kill on End-session

**Files:**
- Modify: `main.js` — `before-quit` (~1951-1969), `stop-session` (~1136-1142).

**Interfaces:**
- Consumes: session.tmuxName, session.handle, `readPersistStore/writePersistStore`, `sessionStore.removeEntry/upsertEntry`, `tmuxSession.killArgs`.

- [ ] **Step 1: before-quit — detach tmux-backed sessions instead of killing**

Replace the kill loop in `before-quit`:
```javascript
  for (const [, session] of activeSessions) {
    if (!session.exited) {
      try { session.pty.kill(); } catch {}
    }
  }
```
with:
```javascript
  // Persist which sessions were open so we can auto-reattach next launch.
  let store = readPersistStore();
  for (const [, session] of activeSessions) {
    if (session.exited) continue;
    if (session.tmuxName) {
      // tmux-backed: detach only (kill the client pty). The tmux server keeps
      // the session + its process running in the background.
      if (session.handle) store = sessionStore.upsertEntry(store, session.handle, {
        wasOpen: true, lastActiveAt: Date.now(),
      });
      try { session.pty.kill(); } catch {} // kills the tmux *client*, not the session
    } else {
      try { session.pty.kill(); } catch {} // non-persistent: end it
    }
  }
  writePersistStore(store);
```

- [ ] **Step 2: stop-session — treat as "End session": kill the tmux session too**

Replace `stop-session`:
```javascript
ipcMain.handle('stop-session', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'not running' };
  if (session.tmuxName) {
    try { spawnSync('tmux', tmuxSession.killArgs(session.tmuxName)); } catch {}
    if (session.handle) writePersistStore(sessionStore.removeEntry(readPersistStore(), session.handle));
  }
  session.pty.kill();
  return { ok: true };
});
```

- [ ] **Step 3: close-terminal — mark not-open in the store (still no kill)**

In `close-terminal` (~1792), after `session.rendererAttached = false;` add:
```javascript
    if (session.handle) {
      writePersistStore(sessionStore.upsertEntry(readPersistStore(), session.handle, { wasOpen: false, lastActiveAt: Date.now() }));
    }
```
(Per decision, closing a tab keeps the tmux session alive in the background; it just stops being auto-reattached and shows as a background badge.)

- [ ] **Step 4: Manual verify**

- Start a local session, run `sleep 600` inside it, **quit the app**. In a shell: `tmux ls` → session still present; `ps` shows the sleep still running.
- Relaunch (Task 6 does auto-reattach; until then, `tmux ls` confirms survival).
- "End session" (stop-session) on a session → `tmux ls` no longer lists it.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(tmux): detach on quit, kill tmux session on End-session"
```

---

### Task 6: Startup — reattach open sessions + IPC to list background sessions

**Files:**
- Modify: `main.js` — add `list-persistent-sessions` IPC; prune dead on startup.
- Modify: `preload.js` — expose `listPersistentSessions()`.
- Modify: `public/app.js` — init/restore block (~1201-1211) to reattach + surface background sessions.

**Interfaces:**
- Produces IPC `list-persistent-sessions` → `{ open: Array<entry>, background: Array<entry> }` where entry = `{ handle, sessionName, projectPath, mode, claudeSessionId, lastActiveAt }`. Uses live `tmux ls` cross-referenced with the store; prunes dead entries.
- Consumes in renderer: `window.api.listPersistentSessions()`.

- [ ] **Step 1: main.js — startup prune + IPC**

Add:
```javascript
function liveTmuxNames() {
  if (!tmuxAvailable) return [];
  try {
    const r = spawnSync('tmux', tmuxSession.listArgs(), { encoding: 'utf8' });
    return r.status === 0 ? tmuxSession.parseSessionList(r.stdout) : [];
  } catch { return []; }
}

ipcMain.handle('list-persistent-sessions', () => {
  const live = liveTmuxNames();
  let store = sessionStore.pruneDead(readPersistStore(), live, tmuxSession.sessionName);
  writePersistStore(store);
  const openHandles = new Set(sessionStore.openEntries(store).map(e => e.handle));
  const withName = (e) => ({ ...e, sessionName: tmuxSession.sessionName(e.handle) });
  return {
    open: sessionStore.openEntries(store).map(withName),
    background: sessionStore.backgroundEntries(store, openHandles).map(withName),
  };
});
```

- [ ] **Step 2: preload.js — expose it**

Add to the api object (near `closeTerminal` ~line 58):
```javascript
  listPersistentSessions: () => ipcRenderer.invoke('list-persistent-sessions'),
```

- [ ] **Step 3: renderer — reattach open sessions on startup**

In `public/app.js`, extend the `loadProjects().then(...)` block (~1201). After the existing active-session restore, add:
```javascript
  (async () => {
    const persisted = await window.api.listPersistentSessions();
    if (!persisted) return;
    for (const entry of persisted.open) {
      // Reattach: open a session whose sessionId resumes the Claude transcript.
      const session = sessionMap.get(entry.claudeSessionId) || {
        sessionId: entry.claudeSessionId || entry.handle,
        projectPath: entry.projectPath,
        type: entry.mode === 'shell' ? 'terminal' : 'session',
      };
      if (!openSessions.has(session.sessionId)) openSession(session);
    }
    // Background (live but not auto-opened): mark for a sidebar badge.
    window.__backgroundSessions = new Set(persisted.background.map(e => e.claudeSessionId || e.handle));
    loadProjects();
  })();
```

Note for implementer: reattach must resolve to the SAME tmux session. Because `open-terminal` generates a fresh handle, a follow-up refinement (Task 6b, below) passes the existing `handle` through so `spawnLocalSession` reuses `sb_<handle>` via `new-session -A` instead of creating a new one.

- [ ] **Step 4: Task 6b — thread the existing handle through reattach**

- Modify `openSession` (app.js ~925) to accept `customOptions.reattachHandle` and pass it in `resumeOptions`.
- Modify `open-terminal` (main.js): if `sessionOptions.reattachHandle` is set and `persistEnabled()`, use it instead of `crypto.randomUUID()` in `spawnLocalSession` (add a `handle` param to `spawnLocalSession`, default random). Then `new-session -A -s sb_<handle>` reattaches the live session.
- In Step 3's reattach loop, pass `openSession(session, { reattachHandle: entry.handle, resume: entry.claudeSessionId })`.

- [ ] **Step 5: Manual verify (the headline behavior)**

- Start a local Claude session; run a long command (`sleep 600`); quit the app.
- Relaunch → the session tab reappears and **reattaches to the still-running process** (the `sleep` is still counting; scrollback shown by tmux redraw).
- `tmux ls` shows the session throughout.

- [ ] **Step 6: Commit**

```bash
git add main.js preload.js public/app.js
git commit -m "feat(tmux): reattach open sessions on startup; list background sessions"
```

---

### Task 7: Sidebar background badge + setting toggle + tmux-missing notice

**Files:**
- Modify: `public/sidebar.js` — render a "● background" badge for `window.__backgroundSessions`.
- Modify: `public/settings-panel.js` — add a `persistSessions` toggle (global, default on).
- Modify: `main.js` — one-time notice when `tmuxAvailable === false` and the user opens a session (suggest install).

**Interfaces:**
- Consumes: `window.__backgroundSessions` (Task 6), `getSetting/setSetting('global').persistSessions`.

- [ ] **Step 1: Sidebar badge**

In `public/sidebar.js` `buildSessionItem` (near the SSH/RC badge injection ~724), add:
```javascript
  if (window.__backgroundSessions && window.__backgroundSessions.has(session.sessionId)) {
    const b = document.createElement('span');
    b.className = 'bg-badge';
    b.title = 'Running in the background (tmux) — click to reattach';
    b.textContent = '● bg';
    summary.prepend(b);
  }
```
Add `.bg-badge` CSS in `public/style.css` (small, muted green) mirroring the existing `.remote-badge` style.

- [ ] **Step 2: Setting toggle**

In `public/settings-panel.js`, add a global checkbox `#sv-persist-sessions` bound to `global.persistSessions` (default checked). Mirror the existing `#sv-remote-ide` toggle wiring.

- [ ] **Step 3: tmux-missing notice (main.js)**

In `open-terminal`, when `!tmuxAvailable && settingsPersistOn()` and it's a local session, send a one-time renderer toast:
```javascript
  if (!tmuxAvailable && !global.__warnedNoTmux) {
    global.__warnedNoTmux = true;
    mainWindow.webContents.send('terminal-notification', sessionId,
      'tmux not found — background session persistence is off. Install tmux (brew install tmux) to enable it.');
  }
```

- [ ] **Step 4: Manual verify**

- With tmux installed: background badge appears for closed-but-live sessions; toggling the setting off makes new sessions spawn without tmux (verify `tmux ls` doesn't grow); toggling on resumes wrapping.
- Simulate no tmux (temporarily rename tmux on PATH or force `tmuxAvailable=false`): open a session → notice appears once, sessions still work (fallback).

- [ ] **Step 5: Commit**

```bash
git add public/sidebar.js public/style.css public/settings-panel.js main.js
git commit -m "feat(tmux): background badge, persistSessions setting, no-tmux notice"
```

---

## Self-Review

**Spec coverage:**
- tmux mechanism → Tasks 1, 2, 4. ✓
- Session handle + persistence store → Tasks 1 (name), 3 (store), 4 (write). ✓
- Local spawn flow → Task 4. ✓ (Remote = Phase 2, out of scope by design.)
- Lifecycle (quit=detach, tab-close=background, end=kill) → Task 5. ✓
- Startup auto-reattach + badge → Tasks 6, 7. ✓
- tmux-absent fallback + setting → Tasks 2 (gate), 7 (toggle + notice). ✓
- Scrollback (full capture) → Phase 3, explicitly out of scope; Task 6 relies on tmux redraw. Noted.
- Dedicated tmux conf → Tasks 1 (`confContent`), 2 (materialize). ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete code. Task 6b is a concrete refinement with named params, not a placeholder.

**Type consistency:** `sessionName` used consistently (Tasks 1,3,6). `handle`/`tmuxName` fields consistent (Tasks 4,5,6). Store shape `{projectPath,mode,claudeSessionId,wasOpen,lastActiveAt}` consistent (Tasks 3,4,5,6). `newSessionArgs` signature identical where consumed (Tasks 1,4).

**Known risk to validate during execution:** tmux env propagation for `CLAUDE_CODE_SSE_PORT` via `-e` requires tmux ≥ 3.2. If the installed tmux is older, fall back to prefixing the command with `env CLAUDE_CODE_SSE_PORT=... ` inside `command`. Verify tmux version in Task 2 and branch if `< 3.2`.

## Out of Scope (later plans)
- **Phase 2:** remote (SSH) persistence via remote-host tmux; remote liveness probe; extends `buildRemoteCommand`.
- **Phase 3:** full scrollback capture on reattach (`tmux capture-pane`), background-session management UI (list/kill), auto-reattach cap.

---

## AMENDMENT (2026-07-15): per-session tmux socket model

Supersedes the shared-server / `-e` env approach in Tasks 1, 4, 5, 6. Reason:
passing the full env via `-e KEY=VAL` puts secrets into the tmux process argv
(visible via `ps`). A **dedicated tmux socket per session** avoids this: env is
inherited naturally through the tmux client's environ (like a plain
`pty.spawn(shell,args,{env})`), so no `-e`, no secrets in argv, and no
cross-session env contamination (each session has its own server).

**Revised global constraint:** each persistent session runs on its own tmux
socket `-S <socketPath>` (one server per session). Env is passed via the tmux
client's environ (the `env` in `pty.spawn` opts) — never via `-e`. The socket
path is derived deterministically from the handle, so it need not be stored.

**Revised `tmux-session.js` API (Task 1):**
- `socketPath(baseDir, handle) -> string` — deterministic file path, e.g.
  `<baseDir>/sb-sock-<sanitizedHandle>` (pure string join; no fs).
- `newSessionArgs({ name, cols, rows, confPath, socketPath, command }) -> string[]`
  → `['-S', socketPath, '-f', confPath, 'new-session', '-A', '-s', name, '-x',
  String(cols), '-y', String(rows), ...command]`. **No `env`/`-e` handling.**
- `hasSessionArgs(name, socketPath) -> string[]` → `['-S', socketPath,
  'has-session', '-t', name]`.
- `killServerArgs(socketPath) -> string[]` → `['-S', socketPath, 'kill-server']`
  (a per-session server hosts exactly one session, so killing the server ends it).
- **Remove** `listArgs` and `parseSessionList` (and their tests) — replaced by
  per-handle `has-session` probing.
- Keep `sessionName`, `confContent`, `isVersionOutput` unchanged.
- Update Task-1 tests: drop the `-e`/list tests; add tests for `socketPath`,
  the socket-prefixed `newSessionArgs`, `hasSessionArgs`, `killServerArgs`.

**Revised Task 4 (`spawnLocalSession`):**
- Signature `{ shell, args, opts, handle: handleIn }` (no `envForTmux`).
- When enabled: `const sock = tmuxSession.socketPath(TMUX_SOCKET_DIR, handle);`
  then `pty.spawn('tmux', tmuxSession.newSessionArgs({ name, cols:opts.cols,
  rows:opts.rows, confPath:TMUX_CONF_PATH, socketPath:sock, command:[shell,...args] }),
  { ...opts })`. The full env rides in `opts.env` → tmux client environ → the
  fresh per-session server → the shell. Return `{ ptyProcess, tmuxName, handle, socketPath: sock }`.
- Add `TMUX_SOCKET_DIR = path.join(app.getPath('userData'), 'sb-sockets')` near
  `TMUX_CONF_PATH`, `fs.mkdirSync(TMUX_SOCKET_DIR, { recursive: true })` once at init.
- `session` object gains `socketPath`.

**Revised Task 5 (lifecycle):**
- before-quit: detach only (kill the client pty); the per-session tmux server
  (detached daemon) keeps running. Persist `wasOpen`.
- stop-session ("End session"): `spawnSync('tmux', tmuxSession.killServerArgs(session.socketPath))`
  then `session.pty.kill()`; remove the store entry.
- close-terminal: mark `wasOpen:false` (unchanged from original plan).

**Revised Task 6 (startup):**
- Liveness is per-handle: for each stored handle, `spawnSync('tmux',
  tmuxSession.hasSessionArgs(tmuxSession.sessionName(handle),
  tmuxSession.socketPath(TMUX_SOCKET_DIR, handle)))` and treat `status===0` as live.
  Build the set of live session names, then `sessionStore.pruneDead(store, liveNames, sessionName)`.
- `list-persistent-sessions` returns `{ open, background }` as before (open =
  wasOpen entries; background = live-but-not-open). Each entry includes its
  `sessionName`.
- Reattach threads the existing `handle` through `openSession` → `open-terminal`
  → `spawnLocalSession({ handle })` so `new-session -A -s sb_<handle>` on that
  handle's socket reattaches the SAME live session.
