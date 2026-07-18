---
id: shell-terminal
title: Shell terminal
status: frozen
created: 2026-07-18
depends_on: [session-engine, app-shell]
---

# Shell terminal

## 1. Summary

The shell terminal is the SHELL tab of main pane **[2]** (`Claude Terminal.dc.html` lines 145–171, the `isShell` block): a real, PTY-backed shell in the active session's working directory — "the normal terminal option" so the user never has to leave Francois to run commands by hand. Each session gets exactly one real pseudo-terminal (`portable-pty` (Rust) in the core, `xterm.js` in the frontend), spawned lazily the first time that session's SHELL tab is opened, kept alive and buffering output for the life of the session regardless of which tab or session is currently visible, and torn down only on session removal or app quit. While the terminal has keyboard focus it captures every key — including digits and letters that are global hotkeys elsewhere in the app — and forwards them byte-for-byte to the shell, with a single carve-out for the command palette.

## 2. Goals & non-goals

- **Goals**:
  - Lazily spawn and own exactly one real PTY per session (`portable-pty`, Rust), in the session's `cwd`, using the correct platform shell.
  - Keep a session's PTY alive and its output buffering for the life of the session, independent of which tab or which session is currently visible in the UI.
  - Render PTY output live via `xterm.js`, styled with the app's tokens: font, theme, a full 16-color ANSI mapping, 10000-line client scrollback, thin `.scz`-style scrollbar.
  - Reconstruct the terminal screen on remount (tab switched away and back, or session switched away and back) via a core-side ring buffer replay, without requiring every session's `xterm.js` instance to stay mounted simultaneously.
  - Capture all keyboard input while the terminal has focus and forward it verbatim to the PTY, with the single exception of ⌘K/Ctrl+K (which must reach the command palette instead).
  - Handle process exit gracefully: a dim inline notice plus an Enter-to-restart flow, without breaking the one-PTY-per-session invariant.
  - Own the `shell` IPC domain end to end: `francois:shell:ensure` / `write` / `resize` / `dispose`, and the `francois:shell:event` stream (`shell.data`, `shell.exit`).
  - Define the footer bar (shell name, tilde-abbreviated cwd, alive/exited indicator dot, static interrupt/clear hints) and resize propagation (`FitAddon` → PTY resize) with a specified debounce.
- **Non-goals** (out of scope here, live elsewhere):
  - The main pane's tab bar and `mainView` (`session`/`diff`/`shell`) switching state, and the global `d`/`t` hotkeys that flip to DIFF/SHELL — `app-shell`. This spec owns everything *inside* the SHELL tab body once `mainView === 'shell'`.
  - The SESSION tab's conversation transcript and the DIFF tab's git view — `conversation-view`, `diff-view`.
  - Session lifecycle (spawn/stop Claude Code, `SessionMeta`, `session.meta`/`session.status`/`session.removed` emission) — `session-engine`. This spec only consumes `session.removed` as a trigger to kill a PTY, and reads `SessionMeta.cwd` to know where to spawn.
  - The global pane-focus model, the `1`–`5` pane-switch keys, and the shared "which pane is focused" state — `app-shell`. This spec only depends on the terminal's own DOM focus (see §4) to gate keyboard capture, not on the pane-level focus ring.
  - The ⌘K command palette itself (modal shell, registry, fuzzy filter) — `command-palette`. This spec defines only the one carve-out (⌘K/Ctrl+K is never forwarded to the PTY) and contributes no palette commands of its own.
  - The CLI companion (`francois agents --status` and similar, shown as example output in `PROJECT.md`) — that's just literal text a user typed into a real shell; the app-side listener such a CLI talks to is `cli-companion`'s concern, unrelated to PTY rendering.
  - Any interpretation, syntax highlighting, or structured parsing of shell output beyond raw ANSI/SGR rendering — this is a plain terminal, not a smart one.
  - Persisting or replaying shell history across app restarts, and multiple simultaneously visible terminals — out of scope per `PROJECT.md`'s "session persistence/restore… out of scope" and "one active session's detail at a time."

## 3. User stories / flows

1. **First open (mouse).** User clicks the main pane, then clicks the `SHELL` tab label (or clicks it directly while the main pane already has focus). `app-shell` sets `mainView = 'shell'` and mounts this feature's content. It calls `francois:shell:ensure`; since no PTY exists yet for this session, the core spawns one in the session's `cwd` with the platform's default shell and a `80×24` starting size. The response's `scrollbackReplay` is empty. The freshly created `xterm.js` instance mounts, the shell's own startup prompt appears, a `ResizeObserver` immediately fits the terminal to its container and (if the fit differs from `80×24`) sends one `francois:shell:resize`. The terminal auto-focuses.
2. **First open (keyboard).** User presses `t` from anywhere in the app (per `PROJECT.md`'s keyboard model, routed by `app-shell`). Same effect as above: main pane focuses, `mainView` becomes `'shell'`, the same `ensure()` flow runs.
3. **Typing commands.** User clicks inside the terminal region if it isn't already focused. Every keystroke — including `1`–`5`, `d`, `t`, `n`, `a`, `/`, `⏎`, `Esc`, arrow keys, and control combinations — is captured by `xterm.js`'s hidden textarea and forwarded verbatim via `francois:shell:write`. The PTY's own echo comes back as `shell.data` events and is written straight into the terminal.
4. **Interrupt and clear.** User presses `⌃C` mid-command; the raw byte `\x03` is forwarded to the PTY like any other keystroke (no special-casing), and the foreground process receives `SIGINT`. `⌃L` is forwarded the same way and clears the screen via the shell's own native handling — this feature does not intercept either combination.
5. **Opening the palette from inside the terminal.** User presses ⌘K/Ctrl+K while the terminal has focus. This one combination is not forwarded to the PTY; the keydown is allowed to bubble to `app-shell`'s global document-level handler, which opens the command palette. The terminal loses DOM focus as the palette's own input takes it. Closing the palette does not automatically refocus the terminal — the user clicks it again or presses `t`.
6. **Leaving the terminal.** User clicks anywhere outside the terminal (another pane, the input bar of another tab, etc.). The terminal's textarea blurs; global keyboard routing resumes immediately — this is native DOM focus/blur, no explicit "restore" action is needed from any other feature.
7. **Switching tabs away and back (same session).** User clicks `SESSION` or `DIFF`, or presses `d`. The mounted `xterm.js` instance for SHELL is disposed client-side; the PTY itself keeps running headless in the core, and its output keeps accumulating in the core's ring buffer. User switches back to SHELL (click or `t`); `francois:shell:ensure` is called again, returns the current `cols`/`rows` plus the full ring buffer as `scrollbackReplay`; a fresh `xterm.js` instance is created, the replay is written in one shot, and then live `shell.data` events resume rendering.
8. **Switching sessions.** User selects a different session in the sidebar. The previous session's PTY (if any) keeps running untouched in the background. If the newly active session's SHELL tab was opened before, reattaching works exactly like flow 7; if never opened, flow 1 applies (lazy creation, per-session).
9. **The shell process exits.** The user types `exit`, or the shell process crashes. The Rust core emits `shell.exit`; the frontend writes a dim inline line — `process exited (code N) — press ⏎ to restart` — directly into the terminal buffer, flips the footer dot to red, and puts the terminal into an "exited" input mode where only `⏎` is handled locally. Pressing `⏎` disposes the dead entry and calls `ensure` again, spawning a fresh PTY in the same `cwd`; the terminal is reset and normal input resumes with the footer dot back to green.
10. **Spawn failure.** `ensure` resolves `ok: false` with `PTY_ERROR` (e.g. the resolved shell binary can't be spawned). The frontend shows the same dim-line/Enter-to-retry treatment as flow 9, substituting the `AppError.message` for the exit line's text (no `exitCode` in this case).
11. **Session removed.** A session is deleted (sidebar action, out of this spec's scope) and `session.removed` fires. This feature's Rust-core manager kills that session's PTY (if any) and frees its ring buffer, without any frontend round-trip. If that session's SHELL tab happened to be the one mounted, the surrounding session teardown (owned by `app-shell`/`sessions-sidebar`) unmounts this feature's content as part of leaving the removed session.
12. **App quit.** App exit (Tauri `RunEvent::Exit`) triggers this feature's Rust-core manager to kill every still-alive PTY across every session before the app is allowed to exit.
13. **Resizing.** User resizes the app window. A `ResizeObserver` on the terminal container re-runs `FitAddon.fit()`; if the computed `cols`/`rows` differ from the last value sent to the core, a debounced `francois:shell:resize` call updates the PTY's TTY size so wrapping reflows correctly.

## 4. Functional requirements

**Lifecycle & shell resolution**

- **FR-1 Lazy creation.** A PTY for a session is created no earlier than the first time that session's SHELL tab becomes the active tab of the focused main pane (i.e. the first `francois:shell:ensure` call for that `sessionId`). Opening only SESSION or DIFF, or never opening SHELL, never creates a PTY for that session.
- **FR-2 Persistence across tab/session switches.** Once created, a session's PTY keeps running and buffering output for as long as the session exists, regardless of which main-pane tab or which session is currently active in the UI. Switching the main pane away from SHELL disposes only the frontend's `xterm.js` instance — never the PTY.
- **FR-3 One PTY per session, idempotent `ensure`.** At most one PTY process exists per `sessionId` at a time. A second (or Nth) `ensure` call for a session whose PTY is still alive attaches to the existing process — it never spawns a duplicate — and returns that entry's current `cols`/`rows` and full ring-buffer replay.
- **FR-4 Kill on session removal.** On `session.removed` — this feature's Rust-core manager subscribes directly to session-engine's session-lifecycle signal in-process (not via the IPC `francois:session:event` channel, since both live in the core) — the PTY for that `sessionId`, if any, is killed and its ring buffer discarded.
- **FR-5 Kill on app quit.** Before app exit is allowed to proceed (Tauri `RunEvent::Exit`), every still-alive PTY across every session is killed.
- **FR-6 Shell resolution.** Resolved once per PTY creation, per platform:

  | Platform | Executable resolution | Spawn args | `name`/`TERM` |
  |---|---|---|---|
  | Windows | `pwsh.exe` if resolvable on `PATH`, else `powershell.exe` | none (both default to an interactive shell) | `xterm-256color` |
  | macOS / Linux | `$SHELL` if it points to an existing executable, else `/bin/zsh` if it exists, else `/bin/bash` | `['-il']` (interactive login, so `.zshrc`/`.bashrc`/`.zprofile` etc. load and PATH/tooling like `nvm` behave as in a normal terminal) | `xterm-256color` |

  The footer's `<shellName>` (FR-26) is the resolved executable's basename without extension (e.g. `pwsh`, `powershell`, `zsh`, `bash`, or whatever `$SHELL` resolves to, e.g. `fish`).
- **FR-7 cwd & env.** The PTY spawns with `cwd` = the session's `SessionMeta.cwd` (from `session-engine`) and `env` = the Rust core's own process environment, with `TERM` overridden to `xterm-256color`. No other environment mutation is performed.

**IPC & ring buffer**

- **FR-8 `ensure` semantics.** `francois:shell:ensure({ sessionId })` creates a PTY if `sessionId` has no entry yet (FR-1), or attaches to the existing entry if one exists — whether it is alive or has exited (FR-3). It never auto-restarts an exited PTY on its own (see FR-17 for the explicit restart path). Response data: `{ cols, rows, scrollbackReplay }`, plus `exitCode` when attaching to an entry whose process has already exited and has not since been restarted.
- **FR-9 Ring buffer.** Each PTY entry owns an in-memory ring buffer of its own raw output, appended chunk-for-chunk (never split mid-chunk, so multi-byte ANSI/SGR escape sequences are never corrupted) in the order received. It is capped at **2000 buffered lines** (counted by `\n` occurrences across buffered chunks) **or 1,048,576 bytes (1 MiB) total, whichever limit is reached first** — whole chunks are evicted from the front until both caps are satisfied again. `scrollbackReplay` (FR-8) is the buffer's current contents, concatenated in order. This buffer is independent of `xterm.js`'s own 10000-line client-side scrollback (FR-23): the ring buffer's smaller budget only has to reconstruct the visible screen + a little history on remount, since once mounted the live `xterm.js` instance builds up its own much larger scrollback locally.
- **FR-10 `write` passthrough.** `francois:shell:write({ sessionId, data })` forwards `data` to the PTY's stdin exactly as received — no escaping, no interpretation, no batching by this feature.
- **FR-11 `resize` semantics.** `francois:shell:resize({ sessionId, cols, rows })` calls the PTY's native resize and updates the stored `cols`/`rows` on that entry, so a later `ensure` (remount) reports the current size, not the original `80×24`.
- **FR-12 `dispose` semantics.** `francois:shell:dispose({ sessionId })` kills the PTY if alive and removes the entry (including its ring buffer). This is the same underlying routine used internally by FR-4 and FR-5, and is also called explicitly by the frontend as the first half of the restart flow (FR-17).
- **FR-13 `shell.data` emission.** Every chunk the PTY emits on its own data callback is, in order: (a) appended to the ring buffer (FR-9), then (b) broadcast immediately as `{ type: 'shell.data', sessionId, data }` on `francois:shell:event` — no batching or delay is introduced by this feature.
- **FR-14 `shell.exit` emission.** When the PTY process exits, the entry is marked not-alive, its `exitCode` recorded, and exactly one `{ type: 'shell.exit', sessionId, exitCode }` event is broadcast. The ring buffer is preserved (not cleared) until `dispose`.

**Process exit & restart**

- **FR-15 Exit UI.** On receiving `shell.exit` for the currently mounted session (or on an `ensure` response that already carries `exitCode`, e.g. remounting after an exit that happened while unmounted), the frontend writes a dim line directly into the `xterm.js` buffer: `process exited (code {exitCode}) — press ⏎ to restart`, and sets the footer dot to red (FR-26).
- **FR-16 Exited input lock.** While a session's terminal is in the exited state, `⏎` is the only key handled locally (triggers FR-17); every other keystroke is swallowed client-side and never sent to `francois:shell:write` (the PTY is dead — there is nothing to send it to).
- **FR-17 Restart flow.** Pressing `⏎` while exited calls `francois:shell:dispose` for the session, then immediately `francois:shell:ensure` again — which, since the entry is now gone, creates a brand-new PTY (FR-1/FR-8) with a fresh ring buffer. The frontend clears the terminal (`xterm.js` reset) before writing the (empty) new `scrollbackReplay`, resumes normal input handling (FR-19), and returns the footer dot to green.
- **FR-18 Spawn-failure parity.** An `ensure` call that resolves `ok: false` with `PTY_ERROR` (FR-6/FR-8 spawn attempt failed) is rendered with the same dim-line/Enter-to-retry treatment as FR-15/FR-16, using the response's `AppError.message` as the line text in place of `process exited (code N)`; pressing `⏎` retries via the same FR-17 path (`dispose` is a no-op here since no entry was created, then `ensure` is retried).

**Keyboard capture**

- **FR-19 Forward all keys while focused.** While the terminal's `xterm.js` textarea has DOM focus, every keydown is forwarded to the PTY via `francois:shell:write`, with no exceptions and no special-casing, other than FR-20 — this explicitly includes `1`–`5`, `d`, `t`, `n`, `a`, `/`, `⏎`, `Esc`, arrow keys, and control sequences such as `⌃C` (`\x03`) and `⌃L` (`\x0c`).
- **FR-20 ⌘K/Ctrl+K carve-out.** This one combination is intercepted before it reaches the PTY: `xterm.js`'s `attachCustomKeyEventHandler` returns `false` for it (so `xterm.js` neither sends it to the PTY nor calls `preventDefault`), and — unlike every other key (FR-21) — this feature does **not** call `stopPropagation()` on it, so the keydown bubbles to `app-shell`'s global handler and opens the command palette.
- **FR-21 Propagation stopped for every forwarded key.** Every keydown that is forwarded to the PTY under FR-19 has `stopPropagation()` called on it (in addition to being handed to `xterm.js`), so it can never also be picked up by `app-shell`'s global hotkey listener while the terminal has focus. This assumes `app-shell`'s global listener is registered on `document` in the bubble phase (the standard approach) — recorded as a cross-feature requirement for `app-shell` (see Cartograph note).
- **FR-22 Native focus/blur, no explicit restore.** Clicking inside the terminal region focuses its `xterm.js` textarea (enabling FR-19/FR-20/FR-21); clicking anywhere else in the app, or the command palette opening, blurs it and restores global key handling — this is ordinary DOM focus/blur behavior; no store flag, IPC call, or explicit "restore global keys" action is needed from this feature or from `app-shell`.

**Rendering (`xterm.js`)**

- **FR-23 Terminal configuration.** The mounted `xterm.js` `Terminal` is constructed with exactly:
  ```ts
  {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12.5,
    fontWeight: '400',
    fontWeightBold: '700',
    lineHeight: 1.35,      // approximates the mock's airy 1.85 CSS line-height as an xterm cell-height multiplier
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    theme: { /* see FR-24 */ background: '#0f1015', foreground: '#dfe2e8', cursor: '#c8a15a', cursorAccent: '#0f1015', selectionBackground: 'rgba(200,161,90,0.25)' },
  }
  ```
  A `FitAddon` (`@xterm/addon-fit`) is attached and used for all sizing (FR-27); no other `xterm.js` addon is required by this spec.
- **FR-24 ANSI 16-color mapping.** The terminal `theme`'s 16 indexed colors are exactly the table in §8's Visual notes — this is the sole mechanism for coloring raw shell output; no client-side text parsing/recoloring is layered on top of what the shell itself emits via SGR codes.
- **FR-25 Scrollbar.** The terminal's internal scroll viewport (`.xterm-viewport`) is styled with the app's `.scz` thin-scrollbar rule (`8px`, thumb `#2a2c33`, transparent track) instead of the platform default scrollbar.

**Footer**

- **FR-26 Footer content.** A fixed footer row below the terminal shows, left-aligned: a status dot (`#7fa07a` green while the PTY is alive, `#c46b62` red once exited — no dot color exists for "PTY_ERROR/never spawned," which reuses the exited/red treatment) + `<shellName>` (FR-6) + `·` + the session's `cwd` with the user's home directory abbreviated to `~` when resolvable (else the raw absolute path — mirrors the `~`-abbreviation contract already needed by `sessions-sidebar`, see Cartograph note). Right-aligned, two static hints: `⌃C interrupt` and `⌃L clear` (documentation only — see flow 4; this feature does not intercept either combination itself).

**Resize**

- **FR-27 Resize propagation.** A `ResizeObserver` on the terminal's container calls `FitAddon.fit()` on every size change (un-debounced — this is cheap local layout math). If the resulting `cols`/`rows` differ from the last value this feature sent to the core, a `francois:shell:resize` call is issued, **debounced 120ms (trailing edge)** against further resize activity, to avoid flooding the IPC bridge during a continuous window-resize drag. `fit()` is also run once, immediately, whenever the SHELL tab becomes newly visible (mount or remount), independent of the debounce.

## 5. API contract

Domain: `shell`. Contract file: `contract/shell-terminal.ts` (authored at `/build` time from this spec; not created here). All types import from `contract/common.ts` and never redefine its members.

### Channels owned by this feature

| Channel | Direction | Payload | Result data | Error codes |
|---|---|---|---|---|
| `francois:shell:ensure` | frontend → core (`invoke`) | `ShellEnsurePayload` | `ShellEnsureData` | `SESSION_NOT_FOUND`, `PTY_ERROR` |
| `francois:shell:write` | frontend → core (`invoke`) | `ShellWritePayload` | `void` | `SESSION_NOT_FOUND` |
| `francois:shell:resize` | frontend → core (`invoke`) | `ShellResizePayload` | `void` | `SESSION_NOT_FOUND`, `INVALID_INPUT` |
| `francois:shell:dispose` | frontend → core (`invoke`) | `ShellDisposePayload` | `void` | `SESSION_NOT_FOUND` |
| `francois:shell:event` | core → frontend (event) | — | payload is `ShellEvent` (tagged union, this feature's own — not a member of `contract/common.ts`'s `SessionEvent`) | n/a (event channel) |

### Internal dependency (not IPC)

This feature's Rust-core manager subscribes directly to `session-engine`'s in-process session-lifecycle signal for `session.removed` (FR-4) — a same-process event subscription, not a round-trip through `francois:session:event`. The exact emitter shape is `session-engine`'s to define; this spec only requires "some way to be notified, in the core, when a session is removed."

### `contract/shell-terminal.ts`

```ts
// contract/shell-terminal.ts — shell-terminal (SHELL tab, main pane [2]).
// Imports shared vocabulary from common.ts; never redefines it.

import type { SessionId, Result } from './common';

// ---------- francois:shell:ensure ----------

export interface ShellEnsurePayload {
  sessionId: SessionId;
}

export interface ShellEnsureData {
  cols: number;
  rows: number;
  /**
   * Raw buffered PTY output (core-side ring buffer, FR-9), oldest-first,
   * to replay verbatim into a freshly (re)mounted xterm.js instance.
   * Empty string on first-ever creation for this session.
   */
  scrollbackReplay: string;
  /**
   * Present only when attaching to an entry whose process has already
   * exited and has not since been restarted (dispose + ensure, FR-17).
   * Drives the same dim-line UI as a live 'shell.exit' event (FR-15).
   */
  exitCode?: number;
}
// invoke('shell_ensure', req: ShellEnsurePayload): Promise<Result<ShellEnsureData>>

// ---------- francois:shell:write ----------

export interface ShellWritePayload {
  sessionId: SessionId;
  /** Raw bytes to forward to the PTY's stdin, unmodified — includes control bytes, e.g. '\x03', '\x0c'. */
  data: string;
}
// invoke('shell_write', req: ShellWritePayload): Promise<Result<void>>

// ---------- francois:shell:resize ----------

export interface ShellResizePayload {
  sessionId: SessionId;
  cols: number;
  rows: number;
}
// invoke('shell_resize', req: ShellResizePayload): Promise<Result<void>>

// ---------- francois:shell:dispose ----------

export interface ShellDisposePayload {
  sessionId: SessionId;
}
// invoke('shell_dispose', req: ShellDisposePayload): Promise<Result<void>>

// ---------- francois:shell:event (core -> frontend) ----------

export type ShellEvent =
  | { type: 'shell.data'; sessionId: SessionId; data: string }
  | { type: 'shell.exit'; sessionId: SessionId; exitCode: number };
```

### Error semantics specific to this feature

- `SESSION_NOT_FOUND` (`ensure`, `write`, `resize`, `dispose`): for `ensure`, `sessionId` does not match any session known to `session-engine`. For `write`/`resize`/`dispose`, it additionally covers "no shell entry exists for this `sessionId`" (i.e. `ensure` was never called, or the entry was already disposed) — a well-behaved frontend always calls `ensure` before `write`/`resize`, so reaching either without a live entry indicates a stale `sessionId` or a client bug, and both are reported identically.
- `PTY_ERROR` (`ensure`): the platform shell (FR-6) could not be spawned (missing binary, permissions, a `cwd` that no longer exists, etc.). No entry is created; see FR-18.
- `INVALID_INPUT` (`resize`): `cols` or `rows` is not a positive integer.

This feature introduces **no new `ErrorCode` members** — it only ever returns `SESSION_NOT_FOUND`, `PTY_ERROR`, and `INVALID_INPUT`, all already defined in `contract/common.ts`.

**Frontend dependencies**: `@xterm/xterm`, `@xterm/addon-fit`. **Core dependency**: `portable-pty` (Rust).

## 6. Data & state

**Rust core** — a single in-memory registry, keyed by `SessionId`, owned entirely by this feature:

```ts
interface ShellEntry {
  sessionId: SessionId;
  pty: PtyHandle;      // portable-pty (Rust) child handle
  shellName: string;   // resolved executable basename, e.g. 'zsh', 'pwsh' (FR-6)
  cwd: string;
  cols: number;
  rows: number;
  alive: boolean;
  exitCode?: number;   // set once alive === false
  ring: RingBuffer;    // FR-9: append-only, capped at 2000 lines / 1 MiB
}
```

Entries are created by `ensure` (FR-1/FR-8), mutated by `write`/`resize`/PTY data/exit callbacks, and removed by `dispose` (FR-4/FR-5/FR-12/FR-17). Nothing here is persisted; it is rebuilt from scratch (i.e. starts empty) on every app launch.

**Frontend** — a small zustand slice, keyed by `SessionId`, updated by a single global listener on `francois:shell:event` (registered once, independent of mount state, so footer/exit state stays correct even while a session's SHELL tab isn't the mounted one):

```ts
interface ShellUiState {
  alive: boolean;
  exitCode?: number;
  shellName: string;
  cwd: string;         // as returned/known from ensure(); used for the footer's ~-abbreviated cwd
}
```

Plus feature-local, per-mount state (not shared cross-feature, discarded on unmount): the `Terminal`/`FitAddon` instance refs, the last `cols`/`rows` sent to the core (for FR-27's change-detection), and the boolean "input locked, exited-mode" flag (FR-16).

**Derived state**: the footer dot color (`ShellUiState.alive` → green/red, FR-26); the tilde-abbreviated `cwd` (client-side string substitution against a `homeDir` value — see §7 for the fallback when unavailable).

**Read-only dependency (not owned here)**: a `homeDir: string` value, expected to be exposed by `app-shell` via a Tauri command for `cwd` abbreviation — the same requirement already recorded for `sessions-sidebar`'s path display; this spec reuses it rather than defining a second mechanism. Exact mechanism is `app-shell`'s to define.

**Persistence**: none. Every PTY, its ring buffer, and all frontend-side shell UI state are in-memory only, consistent with `PROJECT.md`'s "session persistence/restore… out of scope."

## 7. Edge cases & errors

- **`ensure` with an unknown `sessionId`** — `SESSION_NOT_FOUND`; no terminal instance mounts; the SHELL tab area shows a plain inline error line instead (reusing the terminal's own dim-line text style, no `xterm.js` instance created).
- **`ensure` spawn failure** (`PTY_ERROR`) — see FR-18; rendered identically to a post-spawn exit, just without an `exitCode`.
- **`write`/`resize`/`dispose` for a `sessionId` with no shell entry** — `SESSION_NOT_FOUND` (see §5's error semantics); a correctly behaving frontend never triggers this.
- **`write` racing a `shell.exit`** — if a keystroke was in flight when the process exited, the core receives a `write` for an already-not-alive entry; this resolves `ok: true` and silently drops the bytes (not treated as an error — it's a benign timing race that FR-16 already guards against on the frontend side going forward).
- **`resize` with non-positive or non-integer `cols`/`rows`** — `INVALID_INPUT`.
- **`resize` for an exited PTY** — resolves `ok: true` as a no-op on the process (nothing to resize), but still updates the entry's stored `cols`/`rows` so the next restart (FR-17) spawns at the latest known size.
- **Duplicate/concurrent `ensure` calls for the same session** (e.g. a fast tab-flap, or a double-invoke from React StrictMode in dev) — idempotent per FR-3: the second call attaches to the same entry, never spawns a second PTY, and returns the same live scrollback/size state.
- **`session.removed` fires while that session's SHELL tab is the one currently mounted** — the PTY is killed and the ring buffer freed (FR-4); the `xterm.js` instance is torn down as part of the surrounding session-teardown owned by `app-shell`/`sessions-sidebar` — this feature surfaces no error of its own for this case.
- **App quit while PTYs are alive** — all are killed synchronously during app exit (Tauri `RunEvent::Exit`, FR-5) before the app is allowed to exit; no data-loss concern since terminal state is never persisted (§6).
- **Output floods** (e.g. `yes`, a large `cat`) — forwarded at full rate (FR-13); the ring buffer's eviction (FR-9) bounds the Rust core's memory; `xterm.js`'s own renderer is responsible for paint throttling — this feature adds none of its own.
- **Non-UTF-8 / binary PTY output** — `portable-pty` (Rust) decodes output as UTF-8 strings by default; this feature does not attempt binary-safe transport (it is a text-oriented shell terminal, not a raw byte pane).
- **Restart into a `cwd` that no longer exists** (the working directory was deleted while the shell was open) — the FR-17 `dispose` + `ensure` retry attempts to spawn in the same `session.cwd`; if the OS spawn fails, this resolves as the FR-18 spawn-failure case again (`PTY_ERROR`, same dim-line/Enter-to-retry UI).
- **Home directory unresolvable for the footer's `cwd` abbreviation** — the raw absolute `cwd` is shown instead, unabbreviated (mirrors `sessions-sidebar`'s identical fallback, §6).

## 8. Design brief

### Screens / regions

Main pane `[2]`'s SHELL tab body, `Claude Terminal.dc.html` lines 145–171 (the `isShell` block) and the footer row immediately below it (lines 164–169); see also `screenshots/shell3.png`. This feature owns everything inside that `<div>` (background, terminal surface, footer) once `mainView === 'shell'`; the tab bar above it (`SESSION | DIFF | SHELL`, lines 71–87) and the pane's own focus-ring border belong to `app-shell`.

**Known deviation from the mock**: the mock's shell content (`shData`/`shellLines`, lines 408–431) is illustrative static text with a hand-styled fake prompt (`acme-api ❯`) and per-line "roles" (`cmd`/`out`/`ok`/`err`/`mod`/`new`). The real feature renders a genuine PTY's raw output through `xterm.js`, so the actual prompt text/color comes from the user's own shell configuration, not from this app — there is no equivalent of the mock's per-line role system to reimplement. Fidelity to the mock here means: the same background, padding, font, footer, and overall "airy monospace terminal" feel — realized through the ANSI 16-color mapping below, not through literal recreation of the mock's synthetic lines.

### Components

- **Terminal surface** — the `xterm.js` canvas, filling the tab body.
- **Restart overlay line** — not a floating DOM element; a dim line written directly into the terminal's own text buffer (FR-15/FR-18), scrolling with the rest of the content like any other terminal output.
- **Footer bar** — status dot, shell name + cwd (left), static `⌃C`/`⌃L` hints (right).

### States

- **Terminal — alive**: normal rendering; footer dot `#7fa07a` (green), no overlay line present.
- **Terminal — exited**: last line in the buffer is the dim restart message (FR-15); footer dot `#c46b62` (red); input locked to `⏎` only (FR-16).
- **Terminal — spawn error**: same visual treatment as exited, with the `AppError.message` substituted for the message text (FR-18); footer dot `#c46b62` (red).
- **Terminal — focused**: no additional terminal-internal chrome change; focus is communicated by the surrounding pane's existing accent ring (`app-shell`'s `ring`/`title` convention, `Claude Terminal.dc.html` lines 305–306: focused → `#c8a15a` border/title, unfocused → `#2a2c33` border / `#868a93` title) — this feature does not duplicate that ring.
- **Footer — alive**: dot `#7fa07a`, remaining text `#6b7079` (container default), separator `·` in `#565a63`, hint keys `⌃C`/`⌃L` in `#a9adb6`.
- **Footer — exited**: identical layout, dot swapped to `#c46b62`; all other colors unchanged.

### Interactions

- **Mouse**: click anywhere in the terminal region focuses it (enables keyboard capture, FR-19–22); click elsewhere in the app blurs it. No other mouse affordances are defined by this feature (no context menu, no clickable footer elements) beyond whatever native text-selection `xterm.js` provides by default.
- **Keyboard**: while focused, every key is forwarded to the PTY (FR-19), except ⌘K/Ctrl+K which opens the command palette instead (FR-20) and is the only key not `stopPropagation`'d (FR-21). While exited, only `⏎` is handled (restart, FR-16/FR-17); every other key is swallowed. `⌃C`/`⌃L` are ordinary passthrough, documented only (footer hints), not special-cased in code.
- **Transitions**: alive → exited happens instantly on `shell.exit`/an `exitCode`-bearing `ensure` response (no animation — a line simply appears, matching the rest of the mock's instant `sc-if`-driven state changes). exited → alive (restart) similarly resets the terminal and resumes rendering with no transition effect.

### Visual notes

Exact tokens, from the mock (`Claude Terminal.dc.html` lines 145–171, 300–303) and `PROJECT.md`'s Visual design system:

- Terminal surface background: `#0f1015` (distinct from the main pane's own `#131419`, used only for SESSION/DIFF content — the tab bar row above stays `#131419`/`#24262d` border regardless of the active tab).
- Content padding: `14px 16px` (mock line 147).
- Font: JetBrains Mono, `12.5px`, weight `400` (bold `700` where the shell itself emits bold SGR); `lineHeight: 1.35` as the `xterm.js` cell-height multiplier (an approximation of the mock's `line-height: 1.85` prose spacing — see FR-23).
- Foreground `#dfe2e8`, cursor `#c8a15a` blinking block, cursor accent (glyph-under-cursor) `#0f1015`, selection `rgba(200,161,90,0.25)`.
- Scrollback: `10000` lines client-side (`xterm.js` `scrollback` option); separate from and larger than the core's 2000-line/1 MiB replay ring buffer (FR-9) — see FR-9 for why the two differ.
- Scrollbar: `.scz` pattern applied to `.xterm-viewport` — `8px`, thumb `#2a2c33`, track transparent (mock lines 22–24).
- Restart/error line: written using a 24-bit foreground escape for the faint token, `\x1b[38;2;86;90;99m` (`#565a63`) + `process exited (code {exitCode}) — press ⏎ to restart` (or the error message) + `\x1b[0m`, preceded by a blank line (`\r\n`) so it visually separates from the last real output.
- **ANSI 16-color mapping** — the mock's palette has no true blue/magenta/cyan tokens; slots 4–6 (and their bright variants) are proposed extensions in the same muted, desaturated family as the rest of the palette, everything else reuses existing app tokens verbatim:

  | # | Name | Hex | Source |
  |---|---|---|---|
  | 0 | black | `#1a1c22` | raised-row surface token — kept above pure black so black-on-black content stays visible against the `#0f1015` background |
  | 1 | red | `#c46b62` | status `error` |
  | 2 | green | `#7fa07a` | status `done`/ok |
  | 3 | yellow | `#c8a15a` | accent |
  | 4 | blue | `#a9adb6` | closest existing cool-gray token to blue (used for hint glyphs in the mock's status bar); the palette has no true blue |
  | 5 | magenta | `#a97fa0` | **proposed** — muted mauve blended between accent and error, kept desaturated to match the rest of the palette |
  | 6 | cyan | `#6f9c9a` | **proposed** — muted teal blended between green and the blue slot |
  | 7 | white | `#c4c7ce` | text `primary` |
  | 8 | bright black | `#6b7079` | status `idle` gray — used for dim/comment-style bright-black text |
  | 9 | bright red | `#d68f86` | lightened red |
  | 10 | bright green | `#9dbb98` | lightened green |
  | 11 | bright yellow | `#d0a45c` | status `running` amber |
  | 12 | bright blue | `#c3c6cf` | lightened blue slot |
  | 13 | bright magenta | `#c29fbb` | lightened magenta slot |
  | 14 | bright cyan | `#8fbab8` | lightened cyan slot |
  | 15 | bright white | `#dfe2e8` | text `bright` |

- Footer: `padding: 10px 14px`, top border `1px solid #24262d`, `display: flex; align-items: center; gap: 14px`, base text `11px #6b7079` (mock lines 164–169). Dot: `7px` circle (matches the title bar's agent-running dot size, mock line 41), color per state above. Hint keys (`⌃C`, `⌃L`) in `#a9adb6`; the `·` separator between shell name and cwd in `#565a63`; everything else inherits the footer's base `#6b7079`.
- Motion: cursor blink `1s step-end infinite` (`xterm.js`'s own `cursorBlink`, matching the mock's `@keyframes blink`); no other animation is introduced by this feature (no pulse — the alive/exited dot is a flat color swap, not a pulsing one, since pulse in this app's vocabulary means "in progress," not "connected").

### Resize / responsive

The SHELL tab body always fills the main pane's content area below the tab bar (`flex: 1; min-height: 0`, mock line 146) — its size is entirely a function of the app window (the grid's `264px 1fr 336px` columns are fixed and owned by `app-shell`; there is no independent pane-resize handle in v1). A `ResizeObserver` on the terminal container drives `FitAddon.fit()` on every size change (FR-27); the footer bar is fixed-height and never participates in the fit calculation (`xterm.js` only measures the terminal surface above it). No text in the terminal itself wraps except however the shell's own output naturally wraps at the current `cols` — this feature performs no client-side text reflow of its own.

## 9. Acceptance criteria

- [ ] Opening a session's SHELL tab for the first time creates a PTY in that session's `cwd`; opening SESSION/DIFF first, or never opening SHELL, creates none (FR-1).
- [ ] A session's PTY keeps running (and buffering) when the SHELL tab is switched away from, and when a different session is selected in the sidebar (FR-2).
- [ ] A second `ensure` call for a still-alive session attaches to the same PTY rather than spawning a duplicate (FR-3).
- [ ] `session.removed` kills that session's PTY and frees its ring buffer without a frontend round-trip (FR-4).
- [ ] Quitting the app kills every still-alive PTY before exit (FR-5).
- [ ] The correct shell is resolved per platform (`pwsh`/`powershell.exe` on Windows, `$SHELL`/`zsh`/`bash` on macOS/Linux) with `TERM=xterm-256color` and the session's `cwd` (FR-6, FR-7).
- [ ] Switching away from SHELL and back replays the full ring-buffer contents into a freshly mounted `xterm.js` instance, visually restoring the prior screen (FR-8, FR-9, flow 7).
- [ ] Keystrokes typed while focused are forwarded byte-for-byte via `francois:shell:write`, and PTY output arrives live via `shell.data` with no added delay (FR-10, FR-13, FR-19).
- [ ] Resizing the window updates the PTY's TTY size via a debounced `francois:shell:resize` call once `FitAddon.fit()` reports a changed `cols`/`rows` (FR-11, FR-27).
- [ ] `francois:shell:dispose` kills the PTY and removes its entry, and is reused (via dispose+ensure) as the restart mechanism (FR-12, FR-17).
- [ ] A shell process exit renders the dim `process exited (code N) — press ⏎ to restart` line, flips the footer dot red, and locks input to `⏎`-only until restarted (FR-14, FR-15, FR-16).
- [ ] Pressing `⏎` while exited spawns a fresh PTY in the same `cwd`, clears the terminal, and restores normal input + a green footer dot (FR-17).
- [ ] A `PTY_ERROR` spawn failure renders the same dim-line/Enter-to-retry treatment, using the error's message text (FR-18).
- [ ] Every key reaches the PTY while focused — including `1`–`5`, `d`, `t`, `n`, `a`, `/`, `⏎`, `Esc` — except ⌘K/Ctrl+K, which opens the command palette instead and is never forwarded (FR-19, FR-20, FR-21).
- [ ] Clicking outside the terminal (or the palette opening) restores global key handling with no explicit action from any other feature (FR-22).
- [ ] The terminal renders with JetBrains Mono 12.5px, the exact background/foreground/cursor/selection tokens, `scrollback: 10000`, and the 16-color ANSI mapping table in §8 (FR-23, FR-24).
- [ ] The terminal's scroll viewport uses the app's 8px thin-scrollbar treatment (FR-25).
- [ ] The footer shows a correctly colored alive/exited dot, `<shellName> · <cwd>` (tilde-abbreviated when resolvable), and the static `⌃C interrupt` / `⌃L clear` hints (FR-26).
- [ ] `ensure`/`write`/`resize`/`dispose` all resolve `Result<T>` and never throw across the IPC bridge; every documented error code (`SESSION_NOT_FOUND`, `PTY_ERROR`, `INVALID_INPUT`) is reachable and handled per §7.

## Remediation

(Empty until a review returns findings.)
