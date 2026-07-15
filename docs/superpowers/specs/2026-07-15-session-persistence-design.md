# Session Persistence Across App Restarts (tmux-backed)

**Date:** 2026-07-15
**Status:** Design — awaiting review
**Branch:** `feat/session-persistence` (off `fork/main`)

## Problem

Switchboard sessions are `node-pty` child processes of the Electron main process.
On app quit (`before-quit`) every PTY is killed, so any work in progress — a running
build, a long training run, an in-flight Claude conversation — is lost when the app
closes. The user wants sessions to **keep running in the background while the app is
closed**, and to **reattach to the live process (with scrollback)** when the app reopens.

## Goal

- A session's underlying process **keeps running** even while the Switchboard app is
  fully closed.
- On reopen, the app **reattaches to the same live process**, showing its current
  state and scrollback.
- Works for **both local and remote (SSH) sessions**. Remote persistence additionally
  survives SSH disconnects.
- Degrades gracefully where the mechanism is unavailable.

## Non-Goals

- Reworking the sidebar/session model beyond what persistence requires.
- Multi-window / multi-client simultaneous attach polish (single client assumed).
- Bundling a tmux binary in v1 (system tmux + graceful fallback; bundling is a later option).

## Why tmux

An interactive session needs a tty master held open for its child to survive. When the
app exits, the PTY master closes and the child gets `SIGHUP`. `detached`/`nohup` alone
does not preserve an interactive tty session — something must keep owning the master.
The two realistic options are a terminal multiplexer (tmux) or a custom PTY daemon;
the daemon path is effectively reimplementing tmux (scrollback buffering, reconnection,
crash recovery, cleanup). **tmux** is chosen: mature, native reattach + scrollback, and
running tmux on the remote host also makes remote sessions survive SSH drops.

## Architecture

### Session handle

Each persistent session gets a self-generated stable handle `sb_<uuid>` used as the tmux
session name. This is **independent of the Claude session id** (which arrives later and
re-keys the app's session), so the tmux name never has to be renamed. The app keeps a
mapping from handle to session metadata.

### Persistence store (settings)

New settings key `persistentSessions`: a map of

```
handle -> {
  projectPath,           // local path or ssh://<label>/<dir>
  remote: bool,
  hostId, remoteDir,     // remote only
  claudeSessionId,       // once detected (for display / cross-ref)
  mode,                  // 'claude' | 'shell'
  lastActiveAt,
  wasOpen: bool          // was this session's tab open at last quit?
}
```

Written when a persistent session is created / re-keyed / closed and on app quit.
Used at startup together with a live-liveness probe.

### Spawn flow — local

Instead of `pty.spawn(shell, shellArgs(shell, claudeCmd, ...), {cwd, env})`, wrap in tmux:

```
tmux -f <sbConf> new-session -A -s sb_<handle> -x <cols> -y <rows> <shell + command>
```

- `-A` → attach if the session exists, otherwise create it (reattach == relaunch).
- The tmux **server is a detached daemon**, not a child of the app, so it and its
  sessions survive app quit.
- MCP/IDE env (`CLAUDE_CODE_SSE_PORT`, `x-claude-code-ide-authorization`, etc.) is
  injected into the command tmux runs (same env plumbing as today, moved inside).

### Spawn flow — remote

```
ssh <opts> -t '<host>' 'tmux -f <conf> new-session -A -s sb_<handle> -x C -y R <cd dir && cmd>'
```

- Remote tmux keeps the remote process alive across SSH disconnects; reconnect =
  ssh + `tmux ... new -A` (attach).
- Extends the existing `buildRemoteCommand` (which already does `cd <dir> && <preExec> &&
  exec <inner>`) to run the inner command inside remote tmux.

### Dedicated tmux config

Ship a minimal `sb.tmux.conf` (referenced with `-f`) so we don't inherit the user's
`~/.tmux.conf`:

- `status off` (no status bar stealing a row)
- `set -g history-limit 100000` (large scrollback)
- `set -g default-terminal "xterm-256color"`
- prefix/keybindings neutralized to avoid conflicts with app + Claude keys
- `set -g escape-time 0`, mouse off (xterm handles selection), `aggressive-resize on`

### Lifecycle

| Trigger | Action |
|---|---|
| **App quit** (`before-quit`) | Detach only — kill the tmux **client** (the node-pty), never `kill-session`. Persist `persistentSessions` with `wasOpen`. |
| **Tab close** | **Detach → keep running in background** (per decision). The session moves to a "background" state, tmux session stays alive. |
| **Explicit "End session"** | `tmux kill-session -t sb_<handle>` (local) / `ssh host tmux kill-session` (remote), then remove from store. New menu/action distinct from tab close. |
| **Process exits on its own** | tmux session ends; app detects via `tmux has-session` failing → mark ended, clean up store. |

### Startup restoration

1. Probe liveness: `tmux ls` (local) and, per known host, `ssh host tmux ls` — collect
   live `sb_*` names.
2. Cross-reference with `persistentSessions`.
3. **Auto-reattach** sessions that had `wasOpen: true` (restore the working set) by
   opening their tabs via `tmux new -A -s ...`.
4. Other live-but-not-open background sessions appear in the sidebar with a **"running"
   badge** (● background). Clicking reattaches.
5. The most-recently-active session is highlighted (also satisfies the secondary
   "show what I was last working on" ask).
6. Store entries with no live tmux session are pruned.

### tmux availability + fallback

- Detect local tmux (`command -v tmux`) at startup; detect per-remote-host on connect.
- If missing: persistence disabled for that scope, fall back to **current behavior**
  (kill on quit; `claude --resume` on reopen). Show a one-time notice suggesting
  `brew install tmux` (local) / installing tmux on the host.
- Setting `persistSessions` (default **on** when tmux is present) to opt out.

### Scrollback

tmux preserves history (`history-limit`). On reattach tmux redraws the current screen.
For full history continuity in xterm, optionally `tmux capture-pane -p -S -` before
attach and write it into xterm (Phase 3 polish); v1 relies on tmux's own redraw.

### Management

Background sessions can accumulate. Provide a way to list live background sessions and
end them (surface `sb_*` from `tmux ls` / remote `tmux ls`) — a lightweight management
affordance (Phase 3).

## Key Decisions (confirmed)

1. **Mechanism:** tmux (not custom daemon).
2. **Scope:** local **and** remote in v1.
3. **Tab close = keep running in background**; explicit "End session" kills it.
4. **Startup = auto-reattach previously-open sessions + badge** for other live background sessions.
5. **Fallback:** graceful degrade to resume/kill when tmux absent.

## Risks & Mitigations

- **tmux key/resize/escape conflicts** → dedicated isolated conf; `-x/-y` + aggressive-resize;
  escape-time 0. Test cursor keys, IME, Claude TUI redraw, resize.
- **Env plumbing (MCP/IDE) into tmux command** → carry the existing env into the inner
  command; verify IDE-over-SSH + remote-control flags still attach.
- **Claude session-id detection** still works (output flows through tmux) — verify re-key.
- **Orphaned/accumulating background sessions** → management/cleanup UI + startup pruning.
- **tmux not installed** (esp. macOS default, remote hosts) → detection + fallback + notice.
- **Multiple clients / window size** → single-client assumption; aggressive-resize.
- **Large blast radius** → phase the implementation.

## Suggested Phasing

- **Phase 1 — Local persistence:** tmux wrap for local sessions, detach-on-quit,
  auto-reattach on start, badge, fallback, setting. Ship + verify.
- **Phase 2 — Remote persistence:** remote tmux, survives SSH drop, remote liveness probe.
- **Phase 3 — Polish:** full scrollback capture on reattach, background-session
  management UI, edge cases.

## Testing Strategy

- Unit: pure helpers (tmux arg builders, handle generation, `persistentSessions`
  diff/prune, remote-tmux command builder) under the existing `electron --test` harness.
- Manual/e2e: start a long-running command, quit app, reopen → process still running,
  reattached with scrollback; tab-close keeps it alive; "End session" kills it; tmux-absent
  fallback; remote SSH drop + reconnect; Claude re-key; IME/cursor/resize sanity.

## Open Questions

- Bundle tmux vs require system install (v1 = require + fallback).
- Should auto-reattach be capped (e.g., if 20 background sessions were open)? Propose a
  cap with the rest shown as badges.
