---
id: multiple-shells
title: Multiple shells per session
status: shipped
branch: feat/multiple-shell
created: 2026-08-04
depends_on: [shell-terminal, session-engine, app-shell, wsl-filesystem, command-palette]
loop_pass: 0
loop_phase:
reviewed_base: 17087af4d93ce4d836c3b64a90ccff0fd02f77ad
reviewed_digest: 6eec6a8c7043ed53
design_files: [] # none by decision (2026-08-04): §8 brief + specs/design/multiple-shells.md is the design source
---

# Multiple shells per session

## 1. Summary

Today a session owns exactly one PTY: the core's registry is keyed by `sessionId`, so opening the
SHELL tab means one terminal, and running a dev server there costs you the ability to run anything
else. This feature lets a session own **up to six** shells, surfaced as a thin **sub-tab strip inside
the SHELL tab** (chips + a `+`), and re-keys the whole `shell` IPC domain from `sessionId` to a new
`ShellId`. Every shell keeps its own PTY, ring buffer, name, and alive/exited state; every terminal in
the session stays mounted while the SHELL tab is open, so switching chips is instant and keeps each
shell's full client scrollback. Nothing persists across an app restart — a session's shells are
rebuilt lazily, one shell on first open, exactly as before.

## 2. Goals & non-goals

- **Goals**:
  - Re-key the `shell` domain to `ShellId` (uuid-v4): `ensure`, `create`, `restart`, `rename`,
    `dispose`, `write`, `resize`, plus `shell.data`/`shell.exit` carrying `shellId` **and**
    `sessionId`.
  - Up to 6 shells per session, auto-named `<shellName> <n>`, renameable to a custom label owned by
    the core.
  - A sub-tab strip inside the SHELL tab body: one chip per shell (process dot, name, unread dot,
    close `✕`) plus a `+`; the existing footer follows the active chip.
  - Keep every shell of the active session mounted while the SHELL tab is; dispose them all on tab or
    session change and replay from the core ring on return (today's behaviour, at the tab boundary).
  - An unread dot on any chip whose PTY emitted output while it was not the displayed shell.
  - `⌘T`/`Ctrl+Shift+T` new shell, `⌘W`/`Ctrl+Shift+W` close, `⌃⇥`/`⌃⇧⇥` cycle — plus the same three
    as palette commands.
  - Restart an exited shell **in place** (same id, name, and strip position) instead of the current
    dispose+ensure dance that would lose all three.
- **Non-goals**:
  - Split panes / two terminals visible at once — one shell is displayed at a time, per chip.
  - Persisting the shell list, names, or scrollback across app restarts (`shell-terminal` §6:
    "Persistence: none" still holds).
  - Per-shell `cwd` selection: every shell of a session spawns in that session's `cwd` via the
    existing `shell_spawn_target` (so `wsl-filesystem`'s runtime resolution applies unchanged to all
    six). Tracking a running shell's live `cwd` (OSC 7) is out of scope.
  - Shells outside a session, or a shell strip in any tab other than SHELL.
  - Everything `shell-terminal` already froze and this spec does not restate: shell resolution
    (FR-6/FR-7), the ring buffer's caps (FR-9), xterm configuration and the ANSI mapping
    (FR-23/FR-24), the footer's content (FR-26), resize propagation (FR-27). They carry over per
    shell, unchanged.

## 3. User stories / flows

1. **First open.** User presses `t` (or clicks Shell). The frontend calls `shell_ensure({sessionId})`
   with no `shellId`; the session has no shells, so the core creates one and returns it as the only
   member of `shells`. The strip renders a single chip (`zsh 1`), the terminal mounts and focuses.
2. **Second shell.** User clicks `+` (or presses `⌘T`). `shell_create({sessionId})` spawns a second
   PTY in the same `cwd`, the chip `zsh 2` appears after `zsh 1` and becomes active, its terminal
   mounts and takes focus. `zsh 1`'s terminal stays mounted, hidden, still receiving output.
3. **Background build.** `zsh 1` is running `npm run dev`; while `zsh 2` is displayed, `zsh 1`'s chip
   gets an unread dot the first time new output arrives. Clicking `zsh 1` shows it instantly, with its
   full client scrollback intact, and clears the dot.
4. **Rename.** User double-clicks the `zsh 2` chip; it becomes an inline text input seeded with the
   current name. `⏎` commits via `shell_rename`, `Esc` cancels, and an empty value resets the chip to
   its auto name.
5. **Cycle and close.** `⌃⇥` moves to the next chip (wrapping), `⌃⇧⇥` to the previous. `⌘W` (or the
   chip's `✕`) disposes the displayed shell, kills its PTY, and activates the neighbour to its right,
   else its left.
6. **Exit and restart.** A shell's process exits: its chip's process dot goes red, the terminal shows
   the existing dim `process exited (code N) — press ⏎ to restart` line, and `⏎` calls `shell_restart`
   — same id, same name, same position, fresh PTY and empty ring.
7. **Leaving and returning.** Switching to SESSION/DIFF, or to another session, disposes every mounted
   xterm instance; the PTYs keep running. Returning calls `shell_ensure({sessionId, shellId})` with the
   remembered active shell, which returns the whole strip plus that shell's ring replay.
8. **Closing the last shell.** Allowed: the strip shows only `+` and an empty state. Leaving the tab
   and returning re-runs the create-if-none path (flow 1) and yields a fresh `zsh 1`.
9. **Session removed.** Every shell belonging to that session is killed and dropped in one core-side
   call, with no frontend round-trip.

## 4. Functional requirements

**Model & lifecycle (core)**

- **FR-1 Shell identity.** Every shell has a `ShellId` (uuid-v4) and belongs to exactly one
  `sessionId`. The core registry is keyed by `ShellId`; a session's shells are listed in **creation
  order** (a monotonic per-registry sequence number, stable across renames and closes).
- **FR-2 Cap.** A session holds at most **6** shells. `shell_create` beyond the cap returns
  `SHELL_LIMIT_REACHED` and spawns nothing. The create-if-none path of `shell_ensure` (FR-5) is never
  capped, since it only ever goes 0 → 1.
- **FR-3 Auto name.** On creation a shell's `name` is `<shellName> <n>`, where `<shellName>` is the
  resolved executable basename (`shell-terminal` FR-6) and `n` is the **smallest positive integer not
  currently used as an ordinal by that session's shells** — so closing `zsh 2` of three and adding one
  yields `zsh 2` again, not `zsh 4`.
- **FR-4 Rename.** `shell_rename({shellId, name})` sets a custom display name: trimmed, capped at 40
  characters, longer input truncated rather than refused. An empty or whitespace-only value **resets**
  the shell to its auto name (FR-3, re-deriving the ordinal from its position among the session's
  shells). The name is core-owned and returned in every `ShellInfo`.
- **FR-5 `ensure` semantics.** `shell_ensure({sessionId, shellId?})`:
  - with `shellId` → attaches to that shell (alive or exited), never spawns;
  - without `shellId` → attaches to the session's **first** shell in order, creating one if the session
    has none;
  - unknown `shellId`, or one belonging to another session → `SHELL_NOT_FOUND`;
  - returns `{shellId, shells, cols, rows, scrollbackReplay, exitCode?}` — the whole strip *and* the
    attached shell's replay in one round trip. Idempotent: concurrent calls attach, never duplicate.
- **FR-6 `create` semantics.** `shell_create({sessionId})` spawns a new PTY at `80×24` in the session's
  `cwd`, via the same `shell_spawn_target` resolution every existing shell uses (`wsl-filesystem`), and
  returns the new `ShellInfo`. `PTY_ERROR` on spawn failure, with no entry created.
- **FR-7 `restart` semantics.** `shell_restart({shellId})` kills the shell's process if it is somehow
  still alive, spawns a fresh PTY **under the same `ShellId`**, keeping the shell's `name` and its
  position in the session's order, clears its ring buffer, and returns `{cols, rows}` (the entry's last
  known size, so the restarted PTY comes up at the size the user is looking at).
- **FR-8 `dispose` semantics.** `shell_dispose({shellId})` kills the PTY if alive and removes the entry
  and its ring buffer. Disposing the last shell of a session is allowed and leaves the session with
  none.
- **FR-9 Session removal & quit.** `dispose_session_shells(app, sessionId)` (replacing today's
  single-shell `dispose_session_shell`) kills **every** shell of that session; it is what
  `session::session_remove` and `wsl-filesystem`'s runtime switch call. `kill_all_shells` continues to
  kill every shell of every session at app exit.
- **FR-10 Per-shell isolation.** `write`, `resize`, the ring buffer, and `shell.data`/`shell.exit`
  emission are all per `ShellId`; nothing is shared between two shells of the same session. Each shell
  keeps `shell-terminal` FR-9's caps (1 MiB / 2000 lines), so a full session costs at most 6 MiB of
  replay buffer.

**Strip & mounting (frontend)**

- **FR-11 Sub-tab strip.** The SHELL tab body renders, above the terminal area and above the existing
  footer, one chip per shell of the active session in core order, followed by a `+` button. The strip
  is hidden entirely when the session has 0 or 1 shells **and** the user has not opened a second one —
  i.e. it renders whenever `shells.length > 1`, and the `+` affordance is otherwise reachable from
  `⌘T` and the palette. *(Rationale: a one-shell session must look exactly as it does today.)*
- **FR-12 Chip content.** Each chip shows a process dot (green alive / red exited), the shell's `name`,
  an unread dot when applicable (FR-14), and a `✕`. The `+` is disabled (dimmed, non-interactive) at
  the 6-shell cap, with a title explaining why.
- **FR-13 All-mounted while open.** While the SHELL tab is the active main tab, **every** shell of the
  active session has a live `xterm.js` instance; the inactive ones are hidden with CSS
  (`display: none`), never unmounted. Leaving the SHELL tab, or switching sessions, unmounts all of
  them; the PTYs keep running. A shell whose xterm has just become visible runs one immediate
  `FitAddon.fit()` + `shell_resize` and takes focus.
- **FR-14 Unread dot.** A `shell.data` event for a shell that is not the currently *displayed* one
  (wrong chip, non-SHELL tab, or non-active session) marks that shell unread. Selecting/displaying it
  clears the mark. The store emits only on the `false → true` transition, so a flooding shell does not
  re-render the strip per chunk.
- **FR-15 Active shell memory.** The active `ShellId` is remembered per session in the frontend for the
  app's lifetime, so returning to a session's SHELL tab restores the chip the user left on (FR-5's
  `shellId` argument). A remembered id the core no longer knows falls back to the first shell.
- **FR-16 Footer follows the active shell.** The existing footer (`shell-terminal` FR-26) shows the
  **displayed** shell's process dot, `shellName`, and `cwd`; its `⌃C`/`⌃L` hints are unchanged.
- **FR-17 Exit & restart UI.** `shell-terminal` FR-15/FR-16's dim line and `⏎`-only input lock apply
  per shell; `⏎` calls `shell_restart` (FR-7) rather than dispose+ensure, and the chip keeps its name
  and position throughout.
- **FR-18 Inline rename.** Double-clicking a chip turns its label into an inline input seeded with the
  current name; `⏎` commits via `shell_rename`, `Esc` or blur cancels. The strip renders the name the
  core returns, never a local guess.

**Keyboard**

- **FR-19 New / close / cycle.** While `mainTab === 'shell'` and a session is active:
  `⌘T` / `Ctrl+Shift+T` → new shell (no-op at the cap, with the strip's `+` disabled state as the only
  feedback); `⌘W` / `Ctrl+Shift+W` → close the displayed shell; `⌃⇥` / `⌃⇧⇥` → next / previous chip,
  wrapping. All three call `preventDefault()` — on macOS `⌘W` would otherwise close the window, and
  `⌃⇥` is a webview-level binding on some platforms.
- **FR-20 PTY carve-outs.** These three combinations join `⌘K` (`shell-terminal` FR-20) as the only
  keys not forwarded to the PTY while a terminal has focus: `attachCustomKeyEventHandler` returns
  `false` for them and runs the action directly. Every other key still reaches the PTY verbatim
  (`shell-terminal` FR-19), and every forwarded key is still `stopPropagation`'d (FR-21).
- **FR-21 Reachable without terminal focus.** The same three combinations also work when focus is on
  the strip (e.g. right after clicking a chip), via a document-level listener this feature owns, gated
  on `mainTab === 'shell'`.
- **FR-22 Palette commands.** `command-palette` gains `Shell: new`, `Shell: close`, `Shell: next`,
  `Shell: rename`, each enabled only when a session is active; `Shell: new` also switches the main tab
  to SHELL first.

**Empty state**

- **FR-23 No shells.** With zero shells (only reachable by closing the last one, FR-8), the tab body
  shows an `EmptyPane` — "No shells · ⌘T to open one" — with the strip reduced to the `+`. Leaving and
  returning to the tab re-runs FR-5's create-if-none path.

## 5. API contract

Domain: `shell`. **The contract file `contract/shell-terminal.ts` is rewritten in place** — this
feature re-keys the same domain's types rather than introducing a parallel vocabulary, so no
`contract/multiple-shells.ts` is created. Two new `ErrorCode` members are added to
`contract/common.ts` (`SHELL_NOT_FOUND`, `SHELL_LIMIT_REACHED`), matching how `session-worktree` and
`session-attachments` extended it.

| Channel | Direction | Payload | Result data | Error codes |
|---|---|---|---|---|
| `francois:shell:ensure` | frontend → core | `ShellEnsurePayload` | `ShellEnsureData` | `SESSION_NOT_FOUND`, `SHELL_NOT_FOUND`, `PTY_ERROR` |
| `francois:shell:create` | frontend → core | `ShellCreatePayload` | `ShellInfo` | `SESSION_NOT_FOUND`, `SHELL_LIMIT_REACHED`, `PTY_ERROR` |
| `francois:shell:restart` | frontend → core | `ShellRestartPayload` | `ShellRestartData` | `SHELL_NOT_FOUND`, `PTY_ERROR` |
| `francois:shell:rename` | frontend → core | `ShellRenamePayload` | `ShellInfo` | `SHELL_NOT_FOUND` |
| `francois:shell:dispose` | frontend → core | `ShellDisposePayload` | `void` | `SHELL_NOT_FOUND` |
| `francois:shell:write` | frontend → core | `ShellWritePayload` | `void` | `SHELL_NOT_FOUND` |
| `francois:shell:resize` | frontend → core | `ShellResizePayload` | `void` | `SHELL_NOT_FOUND`, `INVALID_INPUT` |
| `francois:shell:event` | core → frontend | — | `ShellEvent` (tagged union) | n/a |

```ts
// contract/shell-terminal.ts — the `shell` domain, re-keyed by multiple-shells.
import type { SessionId, Result } from './common';

/** uuid-v4. A shell belongs to exactly one session for its whole life (FR-1). */
export type ShellId = string;

export interface ShellInfo {
  id: ShellId;
  sessionId: SessionId;
  /** Display label: auto `<shellName> <n>` (FR-3) or the custom name (FR-4). */
  name: string;
  /** Resolved executable basename, e.g. 'zsh', 'pwsh' (shell-terminal FR-6). */
  shellName: string;
  cwd: string;
  alive: boolean;
  /** Set once `alive === false`; cleared by a restart (FR-7). */
  exitCode?: number;
}

// ---------- ensure ----------
export interface ShellEnsurePayload {
  sessionId: SessionId;
  /** Omit to attach to the session's first shell, creating one if none (FR-5). */
  shellId?: ShellId;
}
export interface ShellEnsureData {
  /** The shell actually attached to — echoed because `shellId` may be omitted. */
  shellId: ShellId;
  /** The session's whole strip, in creation order (FR-1). */
  shells: ShellInfo[];
  cols: number;
  rows: number;
  /** Raw ring-buffer replay for `shellId`, oldest-first; '' on a fresh spawn. */
  scrollbackReplay: string;
  /** Present when the attached shell has already exited (drives FR-17). */
  exitCode?: number;
}
// invoke('shell_ensure', ShellEnsurePayload): Promise<Result<ShellEnsureData>>

// ---------- create / restart / rename / dispose ----------
export interface ShellCreatePayload { sessionId: SessionId }
// invoke('shell_create', ShellCreatePayload): Promise<Result<ShellInfo>>

export interface ShellRestartPayload { shellId: ShellId }
/** The entry's last known size — the restarted PTY comes up at it (FR-7). */
export interface ShellRestartData { cols: number; rows: number }
// invoke('shell_restart', ShellRestartPayload): Promise<Result<ShellRestartData>>

export interface ShellRenamePayload {
  shellId: ShellId;
  /** Trimmed, truncated to 40 chars; empty resets to the auto name (FR-4). */
  name: string;
}
// invoke('shell_rename', ShellRenamePayload): Promise<Result<ShellInfo>>

export interface ShellDisposePayload { shellId: ShellId }
// invoke('shell_dispose', ShellDisposePayload): Promise<Result<void>>

// ---------- write / resize ----------
export interface ShellWritePayload {
  shellId: ShellId;
  /** Raw bytes for the PTY's stdin, unmodified — includes '\x03', '\x0c'. */
  data: string;
}
// invoke('shell_write', ShellWritePayload): Promise<Result<void>>

export interface ShellResizePayload { shellId: ShellId; cols: number; rows: number }
// invoke('shell_resize', ShellResizePayload): Promise<Result<void>>

// ---------- francois:shell:event ----------
// `sessionId` rides along so the frontend can route unread marks (FR-14)
// without a shellId → session lookup.
export type ShellEvent =
  | { type: 'shell.data'; shellId: ShellId; sessionId: SessionId; data: string }
  | { type: 'shell.exit'; shellId: ShellId; sessionId: SessionId; exitCode: number };

export type { Result };
```

**Error semantics.** `SESSION_NOT_FOUND`: the `sessionId` is unknown to `session-engine`.
`SHELL_NOT_FOUND`: no entry for that `ShellId` (never created, already disposed, or belonging to a
different session than the one supplied). `SHELL_LIMIT_REACHED`: `shell_create` at 6 shells.
`PTY_ERROR`: spawn failed (`shell-terminal` FR-6/FR-18 treatment, unchanged). `INVALID_INPUT`:
non-positive or non-integer `cols`/`rows`.

**Internal (not IPC).** `shell::dispose_session_shells(&AppHandle, &str) -> usize` replaces
`dispose_session_shell`; `crate::dispose_session_shell`'s re-export in `main.rs` and its call site in
`session/commands/lifecycle.rs` are updated with it.

## 6. Data & state

**Core** — `Registry(Mutex<HashMap<ShellId, ShellEntry>>)`. `ShellEntry` gains `id`, `session_id`,
`name`, and `seq: u64` (a registry-wide monotonic counter that yields per-session creation order);
everything else (`master`, `writer`, `killer`, `shell_name`, `cwd`, `cols`, `rows`, `shared`) is
today's entry, unchanged. Nothing persists.

**Frontend** — `src/features/shell/shellStore.ts` grows from one `ShellUiState` per session to:

```ts
interface ShellStoreState {
  shells: Record<SessionId, ShellInfo[]>;   // core order (FR-1), refreshed by every ensure
  activeShellId: Record<SessionId, ShellId>; // FR-15
  unread: Record<ShellId, true>;             // FR-14
}
```

The single global `francois://shell/event` listener updates `alive`/`exitCode` on the matching
`ShellInfo` and sets unread marks; per-mount xterm rendering stays in `ShellTerminal`, now keyed by
`shellId` and taking a `visible` prop (FR-13). Feature-local per-mount state (terminal refs, last sent
`cols`/`rows`, the exited lock) is unchanged, just one copy per mounted shell.

**Also touched**: `src/app/ShellTabView.tsx` (strip + N terminals + footer), `src/app/App.tsx`
(`useShellState` call site), `src/demo/demo.ts` (the fake fleet stubs `shell_*` for the README capture
run and must answer the new shapes).

## 7. Edge cases & errors

- **Shell exits while its chip is not displayed** — the chip's dot goes red and it is marked unread;
  no dim line is written until its terminal is next visible (it is mounted, so the line is written by
  the same `shell.exit` handler and simply not on screen yet).
- **`shell_create` at the cap** — `SHELL_LIMIT_REACHED`; the strip already disables `+` (FR-12), so
  this is only reachable from a race or the palette; it surfaces as a transient inline error, no chip.
- **Closing the displayed shell** — activate the neighbour to its right, else to its left, else the
  empty state (FR-23).
- **`shell_ensure` with a `shellId` from another session** — `SHELL_NOT_FOUND`; the frontend clears its
  remembered active id for that session and retries once without a `shellId` (FR-15).
- **Rename to a name another shell already has** — allowed; names are labels, not identifiers, and the
  strip never dedupes them.
- **`write`/`resize` racing a `shell.exit`** — resolves `ok: true` and drops the bytes, as today.
- **Session removed while its SHELL tab is displayed** — all of its shells are killed in one core call
  (FR-9); the surrounding session teardown unmounts the tab; no error surfaces here.
- **Six shells flooding output at once** — each streams at full rate as today; the per-shell ring caps
  bound core memory at 6 MiB per session, and hidden xterm instances still process writes (that is the
  price of FR-13's instant switching, and is bounded by the same 10000-line client scrollback).
- **`⌘W` with zero shells** — no-op (nothing displayed to close).

## 8. Design brief

The SHELL tab body gains one row between the tab strip and the terminal: chips reusing the existing
`.app-tab-chip` vocabulary (28px, `--radius-card`, `--bg-hover-2`/`--border-focus` when active) at a
smaller scale, each with a 6px `StatusDot` (`--success` alive / `--error` exited), the name, a 5px
`--accent-2` unread dot, and the same `✕` treatment as agent tabs. The row is hidden at ≤1 shell
(FR-11) so a single-shell session is pixel-identical to today. The `+` is a bare chip with no dot,
dimmed to `--text-muted` at the cap. The footer below the terminal is unchanged.

> full brief: `specs/design/multiple-shells.md`

## 9. Acceptance criteria

- [x] The `shell` domain is keyed by `ShellId` end to end — commands, events, registry — and no call
      path addresses a PTY by `sessionId` alone (FR-1, §5).
- [ ] Opening SHELL on a session with no shells creates exactly one and renders no strip (FR-5, FR-11).
- [ ] `+` / `⌘T` adds a shell up to 6; the 7th is refused with `SHELL_LIMIT_REACHED` and a disabled `+`
      (FR-2, FR-12, FR-19).
- [x] New shells are auto-named `<shellName> <n>` with the smallest unused ordinal, and renaming to an
      empty value restores that name (FR-3, FR-4, FR-18).
- [ ] Switching chips is instant, preserves each shell's client scrollback, fits + focuses the newly
      visible terminal, and issues no ring replay (FR-13).
- [ ] Leaving the SHELL tab or switching sessions unmounts every terminal while the PTYs keep running;
      returning restores the remembered chip with its ring replay (FR-7 flow, FR-13, FR-15).
- [ ] A background shell's output marks its chip unread; displaying it clears the mark; a flooding
      shell re-renders the strip once, not per chunk (FR-14).
- [x] An exited shell restarts in place on `⏎` — same id, name, and strip position, fresh PTY, empty
      ring (FR-7, FR-17). _(Core semantics pinned by tests; the `⏎` keypath itself needs the app up.)_
- [ ] `⌘T`/`⌘W`/`⌃⇥`/`⌃⇧⇥` work both with the terminal focused and with the strip focused, are never
      forwarded to the PTY, and `preventDefault` (FR-19, FR-20, FR-21); every other key still reaches
      the PTY.
- [x] `Shell: new` / `close` / `next` / `rename` are in the palette and gated on an active session
      (FR-22).
- [x] Removing a session kills **every** shell it owned in one core call, and app quit still kills all
      shells across all sessions (FR-9). _(Core `dispose_session_shells`/`kill_all_shells` tested; the
      frontend `removeSession` call site is untested — parked as a LOW in the backlog.)_
- [ ] Closing the last shell leaves the empty state, and returning to the tab spawns a fresh shell
      (FR-8, FR-23).
- [x] Each shell spawns via `shell_spawn_target` in the session's `cwd`, so a WSL session's six shells
      are all WSL shells (FR-6, `wsl-filesystem`). _(Code path verified; not exercised against a real
      WSL distro.)_

> **Left open deliberately** — nothing in the pipeline runs the app, so the seven unticked criteria
> above (empty-state creation + no strip, the `+`/`⌘T` cap UI, chip switching, tab/session unmount +
> restore, the unread mark, keyboard capture with terminal vs. strip focus, and closing the last
> shell) need a manual pass in the running app before they can be ticked.

## Remediation

- 2026-08-04 — round 2 (REVISE, 7 findings: 2 CRITICAL, 2 MEDIUM, 3 LOW), all fixed — core:
  `Registry::ensure_first` per-session creation lock + `restart()` disposes the outgoing `Shared`;
  frontend: `ShellTabView.attach()` try/catch, `src/features/shell/shell.css`,
  `shellStore.removeSession()` wired into `useSessionFleetSync`, `ShellTerminal` `initialData` prop.
  (One LOW was a staging omission, resolved by the lead — no code change.)

- 2026-08-04 · round 1 (REVISE) — 7 findings, all fixed (1 CRITICAL, 4 MEDIUM, 2 LOW; report: `specs/reports/multiple-shells.md`). 4 further LOW findings were deferred out of scope by the review.
