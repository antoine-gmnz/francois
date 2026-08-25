---
id: response-mode
title: Response mode — tell any model how to write back
status: shipped
branch: feat/response-mode
created: 2026-08-23
depends_on: [session-engine, multi-provider-seam, durable-sessions, projects, session-profiles, app-shell]
reviewed_base: 9e11f1767bec7abf792a3a902f563d7eb2919c88
reviewed_digest: a5288ba7a8790f2c
design_files: []
---

# Response mode — tell any model how to write back

## 1. Summary

Every session gets whatever prose style its runtime happens to default to, and the only way to change
it is to say "be brief" in the message — once, in a thread that forgets. This feature adds a fourth
run setting beside model, effort and permission mode: a **response mode** (`default` · `concise` ·
`explanatory` · `learning`) that shapes how the model writes, is settable live on any session,
defaults per project, and works the same on all four `AgentRuntime`s — because a writing style is
pure instruction text, and every runtime can be handed instruction text. Mechanically it is the twin
of `session-permission-mode`: one mutation verb, one `session.meta`, next-turn semantics, one new
section in the run chip's panel.

## 2. Goals & non-goals

- **Goals**
  - One enum, one meaning, on `claude-code`, `francois`, `codex` and `grok`.
  - Change it mid-session without recreating the session; it applies from the **next turn**.
  - Persist it like every other `SessionMeta` field, and pre-fill it from `ProjectDefaults`.
  - Keep the instruction text out of the transcript and out of the IPC boundary.
- **Non-goals**
  - **User-authored modes** (a name + your own instruction text, in a registry like Profiles). The set
    is closed here. A follow-up feature would own it: `response-mode-custom`.
  - **Claude Code `outputStyle` interop.** The CLI has no `--output-style` flag; styles are a
    `settings.json` key. This feature never writes an account's `settings.json` — that file is
    `permission-guardrails`' — and never reads `/output-style`'s state.
  - **A per-message override.** No `/concise` prefix, no composer toggle. The setting is the session's.
  - **A response mode on a profile.** A profile says *who* the model is; the mode says *how it writes*.
    Two registries owning one value is what the 2026-08-17 `ui` rule forbids.
  - **New reach surfaces.** No palette entry, no slash command, no sidebar context menu, no roster row
    treatment. The run chip panel is the whole affordance.
  - Widening the enum, or gating it per runtime in `runtimeCapabilities()`.

## 3. User stories / flows

**Turning the volume down.** A session is answering a one-line question with four paragraphs. The user
clicks the run chip, scrolls past Model and Permissions to **Response**, picks `concise`. The panel's
existing *Applies from the next turn* line already says when. The next answer is two sentences.

**Making it teach.** Working through unfamiliar code, the user picks `explanatory`; from the next turn
the model states why it chose each non-obvious approach, inline with the choice.

**Setting it once per project.** With the mode on `concise`, the user clicks *Set as project default*
in the panel's foot — the same action that already writes model, effort and permission mode. Every new
session under that project opens on `concise`.

**Turning it back off, mid-thread, on codex.** A codex session has been running `concise` for six
turns; the instruction is sitting in the resumed thread's history. The user picks `default`. The next
turn carries one explicit line telling the model to disregard the earlier style instruction — after
which nothing further is prefixed.

## 4. Functional requirements

### Contract & state

- **FR-1** — `ResponseMode = 'default' | 'concise' | 'explanatory' | 'learning'` is added to
  `contract/common.ts` (it must live there: `SessionMeta` and `ProjectDefaults` both name it).
  `SessionMeta.responseMode: ResponseMode` is **required**; a persisted record without the key loads
  as `'default'`. `ProjectDefaults.responseMode?: ResponseMode` and
  `SessionCreateInput.responseMode?: ResponseMode` are optional, meaning inherit / default.
- **FR-2** — `francois:session:switchResponseMode` sets `SessionMeta.responseMode`, persists the
  registry with the existing atomic write, emits one `session.meta`, and resolves `Result<SessionMeta>`
  carrying the same snapshot. Semantics and code shape mirror `apply_model_switch`
  (`session/commands/lifecycle.rs`) and `session_switch_permission_mode`.
- **FR-3** — Errors: unknown session ⇒ `SESSION_NOT_FOUND`; terminal status (`done` | `error`) ⇒
  `SESSION_NOT_RUNNING`; a value outside `ResponseMode` ⇒ `INVALID_INPUT`, re-validated by the core
  and never trusted from the frontend's narrowing (2026-08-17 `security`); otherwise `INTERNAL`.
  Re-picking the mode the session already has is a **no-op success** — same `Result`, same
  `session.meta`, no special-casing.
- **FR-4** — Next-turn semantics, uniform across runtimes: the core signals no process and writes
  nothing to a running child. A turn keeps the mode it was spawned with.
- **FR-5** — `TurnContext` gains `response_mode: ResponseMode`, snapshotted with the rest at spawn
  (`adapter/mod.rs`). No adapter re-reads the session mid-turn.

### The directive

- **FR-6** — The instruction text is **core-owned** and lives in one new module
  `src-tauri/src/session/response_mode.rs` — one `&'static str` per non-default mode, plus one
  clearing string (FR-11). It never crosses the IPC boundary: the frontend receives the enum and the
  presentation table (FR-13), never prompt text. `'default'` has no directive at all.
- **FR-7** — `claude-code`: the directive is passed as `--append-system-prompt <text>` in
  `claude_code::turn_args`, on **every** turn including the `--resume` path. It **coexists** with a
  profile's replace-mode `--system-prompt` and is appended after it — a profile sets who the model is,
  the mode sets how it writes. `'default'` omits the flag entirely.
- **FR-8** — `francois` loop: the directive is prepended to the request's `messages` as a
  `role: "system"` message in `openai::blocks::build_request_messages`, after the skill block and
  before the thread's own messages. Like the skill block it is **never persisted** to the thread file
  and is rebuilt per request, so a mode change takes effect on the very next call. `'default'` pushes
  nothing.
- **FR-9** — `codex` and `grok` have no append-system-prompt seam, so the directive is prefixed to the
  **prompt bytes handed to the CLI** — codex's stdin write (`codex/runner.rs`), grok's `-p` argument
  (`grok/args.rs`). It is prefixed to a local copy and **never** to `ctx.text`: `turn.rs` buffers the
  transcript user block from that same string, so writing to it would put the directive in the
  transcript.
- **FR-10** — On `codex`/`grok` the prefix is emitted only when it can be needed: the turn starts a
  **fresh thread** (no resume anchor), **or** the mode differs from the session's `response_mode_sent`.
  `response_mode_sent: Option<ResponseMode>` is a core-private field on `Session`, persisted alongside
  the thread anchor, absent from `SessionMeta` and from every payload. It is written **after** the
  prompt reaches the child, and reset to `None` whenever the thread anchor is cleared (resume retry,
  fresh thread).
- **FR-11** — Returning to `'default'` on `codex`/`grok` is **not** silence: when `response_mode_sent`
  is `Some(non-default)`, the turn carries an explicit clearing directive telling the model to
  disregard the earlier style instruction, because that instruction is still in the thread's history.
  Once it lands, `response_mode_sent` is `Some('default')` and nothing further is prefixed. On
  `claude-code` and `francois` this case does not exist — the directive is rebuilt per turn/request,
  so `'default'` simply builds nothing.
- **FR-12** — No `runtimeCapabilities()` change and no capability gating: the verb is accepted on all
  four runtimes, and a test asserts the built argv / request / prompt bytes per runtime family.

### Frontend

- **FR-13** — `RESPONSE_MODE_OPTIONS` in `contract/response-mode.ts` is the single source for every
  `ResponseMode` presentation — `label`, `short`, `hint`. Display order is the array's order. No
  component maps a mode to a string on its own (2026-08-19 `ui`).
- **FR-14** — The run chip panel gains a third section, headed **Response**, under Permissions and
  separated by the existing `run-chip__rule`. Rows are radio in the same shape as the permission rows
  (dot marker, label, hint); the current one is marked. Picking one calls FR-2 and leaves the panel
  open, matching the model and permission sections.
- **FR-15** — The collapsed chip **face** shows the mode's `short` only when it is not `'default'` —
  the same rule the topbar already applies to the model chip. `'default'` adds nothing to the face, so
  the row does not grow for the common case.
- **FR-16** — `nextProjectDefaults` (`run-chip.ts`) also writes `responseMode`, and the foot action's
  `title` copy names it alongside model, effort and permission mode. `canSetProjectDefault` is
  unchanged.
- **FR-17** — The New Session modal gains a Response field, pre-filled from
  `ProjectDefaults.responseMode` (absent ⇒ `'default'`) and passed as `SessionCreateInput.responseMode`.
  It uses the same chip-group treatment as the permission mode chips and the same
  `RESPONSE_MODE_OPTIONS` table.
- **FR-18** — The frontend's only update path is the `session.meta` event; the panel never writes the
  store from the `Result`. On `ok: false` the panel stays open and renders the message inline
  (`useTimedError`); the face keeps showing what the store holds. No optimistic update.
- **FR-19** — Nothing is disabled while the session is busy: the panel's existing
  *Applies from the next turn* foot copy already states the timing, and no new busy-state line is added.

## 5. API contract

New file `contract/response-mode.ts`. Two existing files are amended: `contract/common.ts` gains
`ResponseMode`, `SessionMeta.responseMode` and `ProjectDefaults.responseMode`;
`contract/session-engine.ts` gains `SessionCreateInput.responseMode`. No new `ErrorCode` member.

```ts
// contract/common.ts — ADDED

/**
 * response-mode FR-1: how the model should WRITE, orthogonal to what it may do.
 * Closed set; user-authored modes are a stated non-goal. Every `match` on this in
 * the core is exhaustive with no wildcard arm.
 *
 * 'default' is the absence of an instruction, not an instruction saying "be
 * normal" — see FR-7/FR-8. (The one exception is the codex/grok clearing
 * directive, FR-11, which exists because those threads carry history.)
 */
export type ResponseMode = 'default' | 'concise' | 'explanatory' | 'learning';

// SessionMeta gains:
//   /** How this session's NEXT turn is told to write. A persisted record without
//    *  the key loads as 'default' (FR-1). */
//   responseMode: ResponseMode;

// ProjectDefaults gains:
//   /** Pre-fills the New Session modal; a SNAPSHOT, like every other default. */
//   responseMode?: ResponseMode;
```

```ts
// contract/session-engine.ts — SessionCreateInput gains:
//   /** omit for 'default'. Applied to every turn incl. --resume (response-mode FR-7). */
//   responseMode?: ResponseMode;
```

```ts
// contract/response-mode.ts — response-mode.
// Physical Tauri binding: `francois:session:switchResponseMode` → command
// `session_switch_response_mode`, invoked as
// invoke('session_switch_response_mode', { sessionId, mode }).
// The event stream is francois://session/event (owned by session-engine).

import type { Result, ResponseMode, SessionEvent, SessionId, SessionMeta } from './common';

/** francois:session:switchResponseMode — frontend -> core. */
export interface SessionSwitchResponseModeInput {
  sessionId: SessionId;
  /** The core re-validates this against ResponseMode; a value outside the union
   *  is INVALID_INPUT, never a silent fallback to 'default' (FR-3). */
  mode: ResponseMode;
}

/**
 * Result<SessionMeta> — the full updated snapshot, identical to the one carried by
 * the accompanying `session.meta` emission (FR-2).
 *
 * ok:false error codes:
 *  - 'SESSION_NOT_FOUND'   — no session with that id (FR-3)
 *  - 'SESSION_NOT_RUNNING' — status is terminal ('done' | 'error') (FR-3)
 *  - 'INVALID_INPUT'       — `mode` is not a ResponseMode member (FR-3)
 *  - 'INTERNAL'            — unexpected core failure
 */
export type SessionSwitchResponseModeResponse = Result<SessionMeta>;

/** The only event this feature emits; the frontend's single update path (FR-18). */
export type ResponseModeHandledSessionEvent = Extract<SessionEvent, { type: 'session.meta' }>;

/**
 * FR-13: the single source for every ResponseMode presentation — the run chip's
 * Response rows, the chip face, and the New Session chips. Display order is this
 * array's order. `label` is the full name, `short` the compact form the chip face
 * renders when the mode is non-default, `hint` the plain-language consequence.
 *
 * The DIRECTIVE TEXT is deliberately absent: it is core-owned (FR-6) and never
 * crosses the IPC boundary.
 */
export interface ResponseModeOption {
  mode: ResponseMode;
  label: string;
  short: string;
  hint: string;
}

export const RESPONSE_MODE_OPTIONS: ResponseModeOption[] = [
  { mode: 'default', label: 'default', short: 'default', hint: "the runtime's own style — no instruction added" },
  { mode: 'concise', label: 'concise', short: 'concise', hint: 'shortest useful answer; result first, no preamble' },
  { mode: 'explanatory', label: 'explanatory', short: 'explain', hint: 'says why it chose each non-obvious approach, inline' },
  { mode: 'learning', label: 'learning', short: 'learn', hint: 'leaves small pieces as TODO(human) and explains as it goes' },
];
```

**Directive text (core-owned, `src-tauri/src/session/response_mode.rs`)** — pinned here so the
implementer does not invent it, and by a Rust test so it does not drift:

- `concise` — *"Answer as briefly as the question allows. Lead with the result. No preamble, no
  restating the request, and no summary of what you just did unless asked."*
- `explanatory` — *"As you work, explain the reasoning behind non-obvious choices — why this approach
  over the alternatives, and what trade-off it makes. Keep each explanation attached to the decision it
  justifies rather than collected at the end."*
- `learning` — *"Work collaboratively rather than delivering finished work. Where a small,
  self-contained piece would teach the user something, leave it for them: mark the spot with
  `TODO(human)` and say what it needs to do and why. Explain the surrounding code as you go."*
- clearing (codex/grok only, FR-11) — *"Disregard the response-style instruction given earlier in this
  conversation. Write in your default style from now on."*

## 6. Data & state

- **Core, persisted on `SessionMeta`**: `response_mode: ResponseMode` — serialized with the rest of the
  session record, defaulting to `default` on a record that predates the field.
- **Core, persisted and private to `Session`**: `response_mode_sent: Option<ResponseMode>` (FR-10) —
  never serialized into any payload, never in `SessionMeta`, never in diagnostics. Only
  `codex`/`grok` read or write it; `claude-code` and `francois` leave it `None` forever.
- **Core, per-turn**: `TurnContext.response_mode`, snapshotted at spawn (FR-5).
- **Core, static**: the directive strings (FR-6). No state.
- **Projects registry**: `ProjectDefaults.responseMode` — a creation-time snapshot like every other
  default; editing it never touches an existing session (projects FR-24).
- **Frontend**: none of its own. The mode is read off `SessionMeta` in the sessions store and updated
  only by `session.meta` (FR-18). The New Session form holds it in its existing local form state.

## 7. Edge cases & errors

| case | behaviour |
|---|---|
| Switch while a turn is running | Accepted; the face updates at once; the running turn is unaffected (FR-4). The panel's standing *Applies from the next turn* line already says so. |
| Switch on a `done`/`error` session | `SESSION_NOT_RUNNING`; panel stays open with the message inline (FR-3/FR-18). |
| Re-pick the current mode | No-op success, with the `session.meta` emission (FR-3). |
| Session created from a profile with a replace-mode prompt | Both apply: `--system-prompt <profile>` then `--append-system-prompt <directive>` (FR-7). |
| Codex/grok, mode changed twice between turns | Only the final value is prefixed — the comparison is against `response_mode_sent`, not against a queue of changes (FR-10). |
| Codex/grok, back to `default` mid-thread | One clearing directive, then silence (FR-11). |
| Codex/grok, resume anchor cleared (resume retry) | `response_mode_sent` resets to `None`, so the next turn re-sends the directive on the fresh thread (FR-10). |
| A persisted session or project default carrying an unknown string | Loads as `'default'`; not an error, not a load failure (FR-1). |
| `switchResponseMode` with a bogus `mode` from a hand-crafted call | `INVALID_INPUT`; the session is untouched (FR-3). |
| The directive would appear in the transcript | Cannot: it is never written to `ctx.text`, which is what `turn.rs` buffers the user block from (FR-9). |

## 8. Design brief

The run chip's panel (design 11c) gains a third section under Permissions — heading **Response**, a
`run-chip__rule` above it, and four radio rows in the existing `run-chip__option` shape (dot marker,
label, hint). The collapsed chip face gains the mode's `short` only when it is non-default. The New
Session modal gains a Response chip group beside the existing permission chips. No new tokens, no new
component, no new topbar element — everything reuses `run-chip.css` and the modal's chip-group styles.

> full brief: `specs/design/response-mode.md`

`design_files: []` stays empty: this is a section added inside existing panel chrome, matching
`session-permission-mode`, `attach-to-worktree`, `multiple-shells` and `self-update`.

## 9. Acceptance criteria

- [ ] Picking `concise` on a live Claude Code session makes the next turn's answer terse, with no new
      session and no transcript entry mentioning the instruction. (FR-2, FR-4, FR-7)
- [ ] The same pick on a `francois`, `codex` and `grok` session has the same effect. (FR-8, FR-9, FR-12)
- [ ] A codex session switched `concise → default` mid-thread carries exactly one clearing directive,
      then none. (FR-11)
- [x] Switching mid-turn does not change the running turn's output style. (FR-4)
- [x] The mode survives quit/reopen; a session record written before this feature loads as `default`.
      (FR-1)
- [x] *Set as project default* writes the response mode, and a new session under that project opens on
      it. (FR-16, FR-17)
- [x] A profile session shows both `--system-prompt` and `--append-system-prompt` in its argv. (FR-7)
- [ ] Switching on a `done` session surfaces `SESSION_NOT_RUNNING` inline without closing the panel.
      (FR-3, FR-18)
- [x] The chip face shows nothing extra on `default` and the mode's `short` otherwise. (FR-15)
- [x] No `runtimeCapabilities()` entry changed. (FR-12)

## Remediation

(Empty until a review returns findings.)
