---
id: session-permission-mode
title: Change permission mode during a session
status: shipped
branch: feat/session-permission-mode
created: 2026-08-19
depends_on: [session-engine, permission-guardrails, multi-provider-seam, durable-sessions, app-shell, projects]
reviewed_base: 6511b869d7fff0c8efb3b7f0c7258c6818a9d66a
reviewed_digest: ee589a91d69ff40e
design_files: []
---

# Change permission mode during a session

## 1. Summary

A session's `permissionMode` is chosen once, in the New Session modal, and is immutable for the
session's life — so wanting `acceptEdits` after starting in `default` (or dropping out of `bypass`
once the risky part is done) costs a whole new session: new thread, new context, re-explained task.
This feature makes the mode a live session setting. The session-row badge that already reports the
mode becomes the control that changes it: click it, pick a mode, the change is recorded and applies
to the session's **next turn**. No new engine concept is needed — every runtime already reads the
mode off its per-turn snapshot, so this is one mutation verb (the twin of
`francois:session:switchModel`) plus one popover.

## 2. Goals & non-goals

- **Goals**
  - Change a live session's `permissionMode` without recreating the session.
  - One uniform rule for when it takes effect — the next turn — true on every `AgentRuntime`.
  - The change persists and survives quit/reopen, like every other `SessionMeta` field.
  - Make the mode legible at all times: the badge renders in every mode, not only the non-default ones.
- **Non-goals**
  - **Mid-turn re-moding.** A running turn keeps the mode it was spawned with. No interrupt, no
    re-spawn, no argv rewrite, no control-channel message. (FR-6.)
  - **Writing project or profile defaults.** `ProjectDefaults` stays a creation-time snapshot
    (projects FR-24) and a profile carries no permission mode (session-profiles, 2026-08-17 `ui`).
    Changing a session changes that session only.
  - **Editing permission *rules*.** The allow/deny rule editor over `settings.json` is
    `permission-guardrails`; this feature moves one enum, nothing else.
  - **New reach surfaces.** No palette entry, no `/permissions` slash command, no sidebar context
    menu item in this feature — the session-row control is the whole affordance.
  - Widening `PermissionMode`. The four members in `contract/common.ts` are the set; `auto`/`dontAsk`
    stay excluded for the reasons that type's doc comment already gives.

## 3. User stories / flows

**Loosening mid-task.** A session started in `default` is three turns into a refactor and asking
before every edit. The user clicks the `default` badge in the session row; a popover lists the four
modes with their one-line consequences and a filled marker on the current one; they click
`accept edits`. The popover closes, the badge reads `edits-ok`, and the next message they send runs
with edits auto-approved. The transcript, the context and the thread are untouched.

**Tightening after the risky part.** A session running in `bypass` has finished its scaffolding. The
user clicks the `bypass` badge (rendered in the danger tone) and picks `default`. The gate is back on
from the next turn.

**Changing while a turn is running.** The user clicks the badge mid-turn. The popover renders
normally and the pick is accepted immediately, but a line under the list reads *"turn running —
applies to the next turn"*. The badge updates at once; the running turn finishes under the old mode.

**Escalating to bypass.** Selecting `bypass` is one click. The option carries the danger tone and the
consequence text (*"skip every permission check — full access"*); there is no confirm step, matching
the standing rule that risky-but-recoverable choices are annotated rather than blocked.

## 4. Functional requirements

- **FR-1** — `francois:session:switchPermissionMode` sets `SessionMeta.permissionMode` on the named
  session, persists the registry with the existing atomic write, emits one `session.meta`, and
  resolves `Result<SessionMeta>` carrying the same snapshot the event carries. Semantics and code
  shape mirror `apply_model_switch` (`session/commands/lifecycle.rs`).
- **FR-2** — Errors: unknown session ⇒ `SESSION_NOT_FOUND`; a session whose status is terminal
  (`done` | `error`) ⇒ `SESSION_NOT_RUNNING` (it cannot take a turn at all — `session_send` refuses
  it on the same test — so a mode that only affects the next turn is meaningless there); a `mode`
  outside `PermissionMode` ⇒ `INVALID_INPUT`. The core re-validates the enum itself and never trusts
  the frontend's narrowing (2026-08-17 `security`).
- **FR-3** — Setting the mode the session already has is a no-op success: the same `Result` and the
  same `session.meta` emission, no special-casing. (The frontend never has to compare first.)
- **FR-4** — The verb is accepted on every `AgentRuntime` — `claude-code`, `francois`, `codex`,
  `grok` — with no capability gating, because each already reads the mode per turn:
  `claude_code::permission_args` builds `--permission-mode` per invocation, `codex`/`grok`
  `sandbox_for` picks a sandbox per turn, and the Francois loop's `gate::evaluate` reads it per tool
  call. Nothing in `runtimeCapabilities()` changes.
- **FR-5** — No adapter changes. The next turn picks the new mode up because `TurnContext` is
  snapshotted from the session at spawn time (`adapter/mod.rs`). A test asserts the built argv /
  sandbox for a session whose mode was switched, one runtime per family.
- **FR-6** — A running turn is never affected. The core signals no process, writes nothing to a
  child's stdin, and does not interrupt. This holds on the Francois loop too, without new code: the
  runner destructures `permission_mode` out of the owned `TurnContext` at turn start
  (`adapter/openai/runner.rs`) and threads that value through every tool call, so a mid-turn switch
  cannot reach it. A test pins this — it is the one place where "next turn" could silently become
  "next tool call" if the runner were later changed to re-read the session.
- **FR-7** — Pending approval and question cards belong to the turn that raised them and are
  unaffected by a switch: switching to `bypassPermissions` does not auto-resolve an open approval,
  and switching to `plan` does not deny one. They are still decided by hand.
- **FR-8** — The mode option table (mode, label, hint, danger flag) moves out of
  `NewSessionModal.tsx` into `contract/session-permission-mode.ts` as `PERMISSION_MODE_OPTIONS`, and
  becomes the single source for the New Session chips, the popover and the badge label. No component
  maps a `PermissionMode` to a label or a hint on its own.
- **FR-9** — The session-row badge renders in **every** mode, including `default` (today it is hidden
  unless the mode is non-default). It shows the option's short label (`default` · `plan` ·
  `edits-ok` · `bypass`), carries the danger tone in `bypassPermissions`, and is a control: it opens
  the popover on click and shows a pointer affordance on hover.
- **FR-10** — The popover lists the four modes in `PERMISSION_MODE_OPTIONS` order, marks the current
  one, shows each option's hint, and tones `bypassPermissions` as danger. Picking a mode calls FR-1
  and closes the popover. It also closes on outside click and on `Escape` (`useDismiss`), and it is
  never opened by a bare-letter global key.
- **FR-11** — While the focused session's status is busy, the popover shows one line under the list —
  *"turn running — applies to the next turn"*. Options stay enabled; nothing is blocked.
- **FR-12** — The frontend's only update path for the new mode is the `session.meta` event, as with
  every other `SessionMeta` field. The popover does not write the store from the `Result`; it uses
  the `Result` only to surface a failure.
- **FR-13** — On `ok: false` the popover stays open and renders the error message inline
  (`useTimedError`); the badge keeps showing the mode the store holds. No optimistic badge update.
- **FR-14** — The badge is not rendered when no session is focused, matching the rest of the
  session-row right cluster.

## 5. API contract

New file `contract/session-permission-mode.ts`. It adds one verb to the existing `session` domain and
re-exports no shared type — `PermissionMode`, `SessionMeta`, `SessionId`, `Result` and `SessionEvent`
are imported from `contract/common.ts`.

```ts
// contract/session-permission-mode.ts — session-permission-mode.
// Physical Tauri binding: `francois:session:switchPermissionMode` → command
// `session_switch_permission_mode`, invoked as
// invoke('session_switch_permission_mode', { sessionId, mode }).
// The event stream is francois://session/event (owned by session-engine).

import type { PermissionMode, Result, SessionEvent, SessionId, SessionMeta } from './common';

/** francois:session:switchPermissionMode — frontend -> core. */
export interface SessionSwitchPermissionModeInput {
  sessionId: SessionId;
  /**
   * The new mode. The core re-validates it against PermissionMode and does NOT
   * trust the frontend's narrowing (FR-2); a value outside the union is
   * INVALID_INPUT, never a silent fallback to 'default'.
   */
  mode: PermissionMode;
}

/**
 * Result<SessionMeta> — the full updated snapshot, identical to the one carried by
 * the `session.meta` emission that accompanies it (FR-1).
 *
 * ok:false error codes:
 *  - 'SESSION_NOT_FOUND'   — no session with that id (FR-2)
 *  - 'SESSION_NOT_RUNNING' — status is terminal ('done' | 'error'); it cannot take
 *                            a turn, so a next-turn setting has nothing to act on (FR-2)
 *  - 'INVALID_INPUT'       — `mode` is not a PermissionMode member (FR-2)
 *  - 'INTERNAL'            — unexpected core failure
 */
export type SessionSwitchPermissionModeResponse = Result<SessionMeta>;

/** The only event this feature emits; the frontend's single update path (FR-12). */
export type PermissionModeHandledSessionEvent = Extract<SessionEvent, { type: 'session.meta' }>;

/**
 * FR-8: the single source for every PermissionMode presentation — the New Session
 * chips, the session-row badge label and the popover. Display order is this array's
 * order. Moved here from src/features/sessions/NewSessionModal.tsx; no component
 * maps a mode to a label, a short label or a hint on its own.
 *
 * `label` is the full name (popover, New Session chips); `short` is the badge's
 * compact form; `hint` is the plain-language consequence; `danger` drives the
 * danger tone on the chip, the option and the badge.
 */
export interface PermissionModeOption {
  mode: PermissionMode;
  label: string;
  short: string;
  hint: string;
  danger?: boolean;
}

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    mode: 'default',
    label: 'default',
    short: 'default',
    hint: 'inherit your Claude settings (~/.claude)',
  },
  {
    mode: 'plan',
    label: 'plan',
    short: 'plan',
    hint: 'read & plan only — never edits or runs commands',
  },
  {
    mode: 'acceptEdits',
    label: 'accept edits',
    short: 'edits-ok',
    hint: 'auto-approve file edits; other tools follow your settings',
  },
  {
    mode: 'bypassPermissions',
    label: 'bypass',
    short: 'bypass',
    hint: 'skip every permission check — full access',
  },
];
```

Rust mirror: `session_switch_permission_mode(app, engine, session_id: String, mode: String)
-> IpcResult<Value>` in `session/commands/lifecycle.rs`, registered in `main.rs` beside
`session_switch_model`. The enum re-validation is a small pure `parse_permission_mode(&str)
-> Option<&'static str>` unit-tested against all four members plus rejects.
Frontend wrapper: `sessionSwitchPermissionMode(sessionId, mode)` in `src/lib/api.ts`, beside
`sessionSwitchModel`.

## 6. Data & state

- **Core** — no new state. `Session.permission_mode` already exists and is already persisted by
  `durable-sessions`' registry write; this feature only adds a second writer to it (the first being
  session creation). Nothing new to migrate: a persisted session written before this feature loads
  with whatever mode it was created with.
- **Frontend** — no new store state. `sessionsStore` already carries `permissionMode` inside
  `SessionMeta` and already applies `session.meta`. The popover's open/closed flag is local component
  state in `src/features/permissions/`, not the store.
- **Derived** — the badge's label, short label, hint and danger tone all derive from
  `PERMISSION_MODE_OPTIONS` (FR-8). The "applies to the next turn" line derives from the focused
  session's status via the existing busy-status helper.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| Session removed while the popover is open | Pick returns `SESSION_NOT_FOUND`; error renders inline, popover stays open. The row disappearing on `session.removed` unmounts it. |
| Session reaches `done`/`error` while the popover is open | Pick returns `SESSION_NOT_RUNNING` with the message *"session has ended"*, rendered inline. |
| Picking the mode already set | Success, no-op, one `session.meta` (FR-3). Popover closes. |
| Switch lands between turns, with a queued/parked composer | The next turn sent uses the new mode — that is the whole point, not an edge case. |
| Switch lands while a turn is running | Recorded immediately, badge updates, running turn unaffected (FR-6). |
| Switch lands while an approval card is pending | Card is untouched and still needs a decision (FR-7). |
| Non-`PermissionMode` string reaches the command (older frontend, CLI, extension) | `INVALID_INPUT`; the session's mode is not written. |
| Session in a worktree / WSL runtime / cloud-adopted session | No interaction — the mode is one field on the snapshot each of those already carries. |
| Split panes, both showing the same session | Both badges update from the one `session.meta` (FR-12). |

## 8. Design brief

> full brief: `specs/design/session-permission-mode.md`

The session-row right cluster gains one always-present control. The existing `session-row__mode`
badge (today conditional, static) becomes a persistent, clickable chip sitting between the model chip
and the `wsl` badge, keeping its current geometry and its `--danger` variant for `bypass`. Clicking
it opens a small popover anchored under it: four rows, each a full label plus its hint in the muted
type role, the current one marked, `bypass` in the danger tone. A busy session adds one muted line
under the list. Acid stays reserved — the popover marks the current mode with the neutral marker
treatment, not the accent, since the badge is a repeatable surface (one per pane) rather than the
view's single live thing (2026-08-17 `ui`).

## 9. Acceptance criteria

- [ ] Clicking the session-row mode badge opens a popover listing all four modes with their hints
      and the current one marked (FR-9, FR-10).
- [ ] Picking a different mode updates the badge and `SessionMeta.permissionMode`, and the next turn
      sent runs under the new mode — verified on a `claude-code` session by the built argv (FR-1,
      FR-5).
- [ ] The badge renders for a `default`-mode session, where today it is hidden (FR-9).
- [ ] Switching mid-turn leaves the running turn's behaviour unchanged and shows the "applies to the
      next turn" line; a Francois-loop turn's remaining tool calls still use the old mode (FR-6,
      FR-11).
- [ ] A pending approval card survives a switch to `bypassPermissions` and still requires a decision
      (FR-7).
- [ ] Quitting and reopening the app shows the switched mode, not the creation-time one (FR-1
      persistence).
- [x] `switchPermissionMode` on an unknown id returns `SESSION_NOT_FOUND`, on a `done` session
      `SESSION_NOT_RUNNING`, and on a bogus mode string `INVALID_INPUT` — each asserted in
      `cargo test` (FR-2).
- [x] The session's project defaults and profile are unchanged after a switch (§2 non-goals).
- [x] `grep -rn "acceptEdits\|bypassPermissions" src/` shows no component mapping a mode to a label
      or hint outside `PERMISSION_MODE_OPTIONS` (FR-8).
- [x] `npx tsc --noEmit`, `npm test` and `cargo test` are green.

## Remediation

(Empty until a review returns findings.)
