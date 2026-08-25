---
id: session-settings-sheet
title: Session settings sheet — one form, two modes
status: shipped
branch: feat/rework-session-parameters
created: 2026-08-24
depends_on: [sessions-sidebar, session-engine, durable-sessions, projects, multi-account, session-profiles, session-worktree, session-rename, session-permission-mode, response-mode, command-palette, app-shell]
reviewed_base: 9e11f1767bec7abf792a3a902f563d7eb2919c88
reviewed_digest: 1e82436bc4fbe2a4
design_files: ["https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html"]
---

# Session settings sheet — one form, two modes

## 1. Summary

The New Session modal is the only place a session's run settings are ever laid out together. The
moment the session exists they scatter: model / effort / permissions / response into the run chip's
popover, the name into a bespoke rename dialog, and three of them — `allowGit`, the account, the
runtime — into no surface at all (`allowGit` is not even on `SessionMeta`). This feature makes the
modal the session's **settings sheet**: one component, one field order, two headers. Create mode
opens on a session that does not exist yet; edit mode opens on one that may be mid-turn. What
changes between them is not the layout but which rows are still decidable — a checkout, a worktree,
an account, a profile and a runtime are decided at spawn, so in edit mode they collapse into one
read-only `▣ FIXED AT SPAWN` block carrying the one action that *can* change them: **New session
from these ↗**. Everything below stays live, applied in one atomic batch by a new
`francois:session:updateSettings` verb. Design source: turn **15a**.

## 2. Goals & non-goals

- **Goals**
  - One component renders both modes, in one field order, from one contract.
  - Edit reads as a **diff**: a changed row gets a lit label, a dot and a `was …` line; the footer
    counts the changes and states the timing once.
  - Every mutable run setting is reachable in one place — including `allowGit`, which has no UI today.
  - Apply is **atomic**: one verb, one validation pass, one persist, one `session.meta`.
  - Nothing is disabled while the session is busy — the turn in flight keeps what it was spawned with.
- **Non-goals**
  - **A live account switch.** `agentRuntime`/`protocol` are derived from the account's kind at
    creation and never re-derived (2026-08-12 `data`), so `ACCOUNT` is read-only in edit mode.
  - **A live profile switch.** A profile is a creation-time snapshot (session-profiles FR-16).
  - **Moving a session's checkout, worktree or runtime.** Those are spawn facts; the escape hatch is
    *New session from these ↗*, which reopens the sheet in create mode with every value carried over.
  - **Editing project defaults beyond the snapshot the foot writes.** The Projects modal still owns
    the full `ProjectDefaults` editor.
  - **Retiring the single-setting verbs.** `session_switch_model` et al. stay — the palette's
    `/model` and `CommandCard` call them, and they are the interactive-commands path.
  - Re-designing the run chip's **collapsed** readout in the session row. Only its popover goes.

## 3. User stories / flows

**Turning off the gate mid-refactor.** Three turns into a session the user clicks the run chip. The
sheet opens in edit mode, headed by the session's status dot, its name and `ses_8f3a`. `PERMISSIONS`
reads `ask`; they click `accept edits`, then `RESPONSE` `concise`. Two rows light up with a dot and a
`was …` line; the foot reads *2 changes · permissions and response apply from the next turn*. They
click **Apply**. The sheet closes, the run chip's collapsed readout updates, the running turn is
untouched.

**Letting it commit.** A session keeps parking on `git commit`. The user opens the sheet, flips
`GIT` on, applies. The foot says *1 change* with **no** next-turn line, because `allowGit` is read
live by the control channel — the very next permission request auto-approves.

**Renaming.** Right-click a roster row → **Settings…**. The sheet opens, the user edits `NAME`,
applies. There is no rename dialog any more.

**Same settings, new checkout.** A session is on `feat/context-count` and the user wants the same
model, account and permissions on `main`. They open the sheet, click **New session from these ↗**:
the sheet swaps to create mode pre-filled with the project, name, model, effort, account, profile,
runtime, permissions, response and git toggle carried over — worktree fields reset. `⏎` creates it.

**Pinning it for the project.** With the session on `concise` + `accept edits`, the user clicks
*Set as project default* in the foot. Every new session under that project opens on those values.

## 4. Functional requirements

### Contract & state

- **FR-1** — `SessionMeta.allowGit: boolean` is added to `contract/common.ts`, **required**; a
  persisted record without the key loads as `false` (the core already persists it under that name —
  `session/persistence.rs`). It is emitted on every `session.meta` like any other field.
- **FR-2** — `francois:session:updateSettings` (Tauri `session_update_settings`) takes a
  `SessionSettingsPatch` of **changed keys only** and applies them in one pass: validate all → write
  all → persist once → emit **one** `session.meta` → resolve `Result<SessionMeta>` with the same
  snapshot. If any key fails validation **nothing** is written (§5, §7).
- **FR-3** — An **empty patch** is a no-op success: the current `SessionMeta`, no persist, no emit.
  Re-sending a value the session already has is likewise a success and still persists+emits, matching
  `session_rename` FR-6's idempotent path.
- **FR-4** — `permissionMode` in a patch stamps `permissionModeSince` exactly as
  `session_switch_permission_mode` does — including on a no-op re-pick.
- **FR-5** — Timing is per field and stated by the core's own semantics, not re-derived by the
  frontend: `name` and `allowGit` take effect **immediately**; `modelId`, `effort`, `permissionMode`
  and `responseMode` take effect from the session's **next turn** (2026-08-19 `api`, in the
  `TurnContext` snapshot). No verb reaches into a running turn.
- **FR-6** — The core **re-validates** every enum and every string it accepts here; it never trusts
  the frontend's narrowing (2026-08-17 `security`). `name` goes through the existing
  `validate_session_name`.

### The sheet — both modes

- **FR-7** — One component renders both modes. Field order is identical and fixed:
  `PROJECT` · `NAME` · `MODEL` · `EFFORT` · `ACCOUNT` · `PROFILE` · `RUNTIME` — rule —
  `PERMISSIONS` · `RESPONSE` · `GIT` — rule — worktree block. Edit mode renders the first group as
  the `FIXED AT SPAWN` block plus a live `NAME`, `MODEL` and `EFFORT`, and omits the worktree block.
- **FR-8** — `PROJECT`+`NAME` share a row, and `MODEL`+`EFFORT` share a row (effort right, fixed
  width). `EFFORT` renders no track at all when the selected model advertises none — the run chip's
  existing `effortLevels` rule, reused.
- **FR-9** — The selected chip's consequence renders as a hint line under its group, for
  `PERMISSIONS` and `RESPONSE` alike, read from `PERMISSION_MODE_OPTIONS` / `RESPONSE_MODE_OPTIONS`.
  `GIT`'s hint is static.
- **FR-10** — Nothing in the sheet is disabled because the session is busy, running, or parked on an
  approval. The only disabled control is **Apply** with zero changes.

### Edit mode

- **FR-11** — The header carries the session's status dot (its roster tone), its name, its short id
  and the word `settings`.
- **FR-12** — `▣ FIXED AT SPAWN` is a **read-only block**, not disabled inputs: one recessed panel of
  monospace `label / value` lines — `project` · `worktree` (branch + `from <base>`) · `path`
  (middle-ellipsised, full value in `title`) · `runtime` (+ distro when `wsl`) · `account` ·
  `profile`. A line whose value is absent is **omitted**, not rendered empty; a session with none of
  them still renders the block for `path` and `runtime`.
- **FR-13** — The block's foot reads *"The checkout and the runtime are decided when the session
  starts."* beside **New session from these ↗**, which closes the sheet and opens it in **create**
  mode pre-filled from this session: project, name, model, effort, account, profile, runtime,
  permission mode, response mode, `allowGit`. Worktree controls reset to their create-mode defaults.
- **FR-14** — A row whose value differs from the session's current one is **changed**: its label
  lights to `--text-hint`, a 5px accent dot sits beside it, the control takes an accent-tinted inset
  edge, and a monospace `was <old value>` line renders under it. Reverting to the original value
  clears all four.
- **FR-15** — The foot states `<n> change(s)` in the accent; beside it, one line naming **only the
  changed fields that are next-turn** — e.g. *"model and response apply from the next turn"*. When
  every change is immediate the line is **absent**, never a blanket claim.
- **FR-16** — **Apply** sends one patch of the changed keys, then closes on success. **Cancel** and
  `Escape` discard; with unsaved changes `Escape` and a backdrop click ask for confirmation once
  rather than discarding silently.
- **FR-17** — *Set as project default* sits in the foot beside Apply. It writes `modelId`, `effort`,
  `permissionMode`, `responseMode` and `allowGit` — **the sheet's current values, including unapplied
  edits** — into the session's `ProjectDefaults` via `francois:project:update`, reusing the run chip's
  `nextProjectDefaults` / `canSetProjectDefault` helpers (moved out of `run-chip.ts` with them).
  Absent when the session has no `projectId`.
- **FR-18** — A live `session.meta` for this session while the sheet is open updates the **baseline**
  (what `was …` compares against) and any field the user has **not** touched; a touched field keeps
  the user's pending value.

### Reach & retirement

- **FR-19** — Edit mode opens from: the run chip in the session row; **Settings…** in the roster
  context menu (replacing **Rename**); a `Session settings…` palette entry; and `⌘,` / `Ctrl+,` on
  the focused session (a modified key — the bare-letter globals of 2026-08-04 `ui` are untouched).
- **FR-20** — The run chip **keeps** its collapsed readout in the session row and **loses its
  popover**: clicking it opens the sheet. `RunChip.tsx`'s panel, its readout-stacking `bare` variant
  and the panel half of `run-chip.css` go; `run-chip.ts`'s parts/effort/bypass helpers stay.
- **FR-21** — `RenameSessionModal.tsx` and `rename-session-modal.css` are deleted. The
  `francois:session:rename` verb, its contract and its tests stay — the palette's rename entry and the
  CLI still use it.
- **FR-22** — Create mode is behaviour-identical to today's modal apart from the field order (FR-7)
  and `PROFILE` moving after `ACCOUNT`: same validation, same `⏎ create`, same worktree group, same
  project/runtime auto-suggest. `RUNTIME` stays Windows-only in create mode; the `FIXED AT SPAWN`
  `runtime` line renders on every platform.

## 5. API contract

`contract/session-settings-sheet.ts` — imports shared vocabulary from `common.ts`, never redefines it.

```ts
import type { PermissionMode, ResponseMode, Result, SessionId, SessionMeta } from './common';

/** The changed keys only. An absent key means "leave alone"; no key is ever null. */
export interface SessionSettingsPatch {
  /** Trimmed, 1–80 chars — the same rule session_rename enforces (`validate_session_name`). */
  name?: string;
  /** Must be a model id the session's ACCOUNT advertises. */
  modelId?: string;
  /** '' clears back to the model's own default, mirroring session_switch_effort. */
  effort?: string;
  permissionMode?: PermissionMode;
  responseMode?: ResponseMode;
  allowGit?: boolean;
}

/** francois:session:updateSettings — frontend → core. Tauri: `session_update_settings`. */
export interface SessionUpdateSettingsRequest {
  sessionId: SessionId;
  patch: SessionSettingsPatch;
}

/**
 * Result<SessionMeta> — the post-write snapshot, identical to the one carried by the single
 * `session.meta` this verb emits. ok:false codes: 'SESSION_NOT_FOUND' | 'SESSION_NOT_RUNNING'
 * | 'INVALID_INPUT' | 'INTERNAL'.
 */
export type SessionUpdateSettingsResponse = Result<SessionMeta>;

/** Which patch keys take effect only from the session's next turn (FR-5, FR-15). */
export const NEXT_TURN_KEYS = ['modelId', 'effort', 'permissionMode', 'responseMode'] as const;
export type NextTurnKey = (typeof NEXT_TURN_KEYS)[number];

/** Label used in the foot's timing line, keyed by patch key (FR-15). */
export const SETTING_LABELS: Record<keyof SessionSettingsPatch, string> = {
  name: 'name',
  modelId: 'model',
  effort: 'effort',
  permissionMode: 'permissions',
  responseMode: 'response',
  allowGit: 'git',
};
```

Amendment to `contract/common.ts` (FR-1):

```ts
export interface SessionMeta {
  // …existing fields…
  /** Francois auto-approves direct `git`/`gh` Bash calls for this session
   *  (session-settings-sheet FR-1). Read LIVE by the control channel, so a change
   *  applies to the very next permission request. Pre-feature records load `false`. */
  allowGit: boolean;
}
```

No new event. The feature consumes `session.meta` (already in `SessionEvent`) and reuses
`francois:project:update` (projects) and `francois:session:create` (session-engine) unchanged.

## 6. Data & state

- **Core** — no new owned state. `Session.allow_git` already exists and is already persisted under
  `allowGit`; FR-1 only widens `Session::meta()` to project it. `session_update_settings` lives beside
  the single-setting verbs in `session/commands/lifecycle.rs` and shares their apply helpers.
- **Frontend** — the sheet owns, per open: the working draft (one field per patch key plus the
  create-only fields), a `baseline: SessionMeta` snapshot for FR-14's `was …` and FR-18's rebase, and
  a `touched` key set. Nothing persists; `⌘,` needs no stored state. `dirtyKeys` and the timing
  sentence are **derived** (pure, in `session-settings.ts`, unit-tested).

## 7. Edge cases & errors

| # | Case | Behaviour |
|---|---|---|
| 1 | Unknown `sessionId` | `SESSION_NOT_FOUND`; the sheet renders the message in its foot and stays open. |
| 2 | Session is `done` / `error` and the patch touches a **run** key | `SESSION_NOT_RUNNING`, whole patch rejected. A **name-only** patch is accepted, matching `session_rename`. |
| 3 | Enum value outside `PermissionMode` / `ResponseMode` | `INVALID_INPUT`, nothing written. |
| 4 | `modelId` the session's account does not advertise | `INVALID_INPUT`, nothing written — the picker cannot produce it, so this is the tampered-payload path. |
| 5 | Blank / over-long `name` | `INVALID_INPUT` from `validate_session_name`; the whole patch is rejected, so a valid model change beside it is **not** silently applied. |
| 6 | Persist fails after the in-memory write | `INTERNAL`; the emitted `session.meta` still reflects memory. Same behaviour as every other switch verb. |
| 7 | Sheet open, the session is removed | The `session.removed` event closes the sheet. |
| 8 | Sheet open, `session.meta` arrives | FR-18: baseline rebases, untouched fields follow, touched fields hold. |
| 9 | Escape / backdrop with unsaved changes | One confirm; Cancel always discards without one. |
| 10 | *Set as project default* while `projectUpdate` fails | The sheet's own edits are unaffected; a timed error renders in the foot (the run chip's existing `useTimedError` pattern). |
| 11 | Model catalog still loading in edit mode | `MODEL` renders the session's current model as a disabled-looking value with the picker unopenable; every other row is live. |
| 12 | *New session from these ↗* when the project was removed | Create mode opens with `PROJECT` unset and the session's `cwd` pre-filled in `DIRECTORY`. |

## 8. Design brief

Design turn **15a** (`Francois Redesign.dc.html`) — "One form, two modes". 480-wide modal shell, the
existing `Modal`/`ModalBody`/`ModalFooter` chrome. Create is headed `› new session` with
*defaults from `<project>`*; edit is headed by the status dot, the name, `ses_xxxx` and `settings`.
`FIXED AT SPAWN` is a `--bg-deep` block of monospace `label / value` lines (62px label column,
`--text-faint` labels, `--text-hint` values), footed by a hairline and the accent
*New session from these ↗*. A changed row: label at `--text-hint`, a 5px `--accent` dot, an
`inset 0 0 0 1px var(--accent-soft-edge)` on the control, and a `--text-dim` monospace `was …` line.
The foot pairs `<n> changes` (accent, monospace) over the timing line (`--text-faint`) against
Cancel + the accent-filled Apply. Colours are the repo's **tokens**, not the mock's raw hex — 15a is
drawn in pre-9a acid `#c3f53f`; the shipped accent is `--accent: #9cb45f`.

> full brief: `specs/design/session-settings-sheet.md`

## 9. Acceptance criteria

- [x] `SessionMeta.allowGit` round-trips through create, persist, reload and `session.meta` (FR-1).
- [x] `session_update_settings` with 4 changed keys persists once and emits exactly one `session.meta` (FR-2).
- [x] A patch with one invalid key writes **none** of its keys (FR-2, §7 cases 3–5).
- [x] An empty patch resolves ok with the current meta and emits nothing (FR-3).
- [x] `permissionMode` in a patch moves `permissionModeSince`, including on a no-op re-pick (FR-4).
- [x] A name-only patch succeeds on a `done` session; adding `modelId` to it returns `SESSION_NOT_RUNNING` (§7 case 2).
- [x] Create and edit render the same field order from the same component (FR-7).
- [x] Changing then reverting a field clears the dot, the lit label, the tint and the `was …` line (FR-14).
- [x] Flipping only `GIT` shows `1 change` with **no** next-turn line; adding `RESPONSE` shows *"response applies from the next turn"* (FR-15).
- [ ] Every control stays enabled while the session is `working` (FR-10).
- [ ] *New session from these ↗* opens create mode carrying all ten values, worktree fields reset (FR-13).
- [x] *Set as project default* writes the sheet's current values, unapplied edits included (FR-17).
- [x] The run chip opens the sheet; `⌘,`, the context menu's **Settings…** and the palette entry all reach it (FR-19, FR-20).
- [x] `RenameSessionModal.tsx` no longer exists and `session_rename` still passes its own tests (FR-21).

## Remediation

### 2026-08-24 — review round 1 (REVISE)

- 2026-08-24 — 5 findings (1 CRITICAL, 1 HIGH, 1 MEDIUM, 2 LOW), all fixed. Enter no longer bypasses the discard-confirm strip; the apply error moved into the sheet foot; `useAppShortcuts.test.ts` added for the FR-19 `⌘,` shortcut; spec §5 name cap aligned to 1–80; `Clone` dropped from `SessionSettingsPatch`. Full report: `specs/reports/session-settings-sheet.md`.

Deferred (not re-dispatched, tracked for awareness): `src-tauri/src/session/commands/lifecycle.rs:296-304` · quality · switch verbs can never surface `INTERNAL` on a persist failure because `persistence::persist()` returns `()` — pre-existing signature shared by every switch verb, out of scope for this feature.

### 2026-08-24 — review round 2 (REVISE)

- 2026-08-24 — 4 findings (2 CRITICAL, 1 MEDIUM, 1 LOW), all fixed. `accountsSeenRef`/`profilesSeenRef` in `useProjectDefaults.ts` now seed from `seeded` like `appliedRef`, so a carried-over `accountId`/`profileId` (and downstream `modelId`) survives "New session from these ↗" instead of being clobbered on mount (FR-13); `PermissionsRow`/`ResponseRow`/`GitRow` extracted to de-duplicate `CreateSheet`/`EditSheet` markup; the name-length hint now uses `nameLength()` (Unicode scalar values) matching `canApply`'s gate. Full report: `specs/reports/session-settings-sheet.md`.

Deferred (not re-dispatched, already parked in `specs/refactor-backlog.md:313` under `deferred:session-settings-sheet`): `src-tauri/src/session/commands/lifecycle.rs:296` · quality · `session_update_settings` can never produce `INTERNAL` on persist failure since `persistence::persist()` returns `()` — pre-existing, shared by every switch verb.

### 2026-08-24 — review round 3 (REVISE)

- 2026-08-24 — 1 finding (1 HIGH), fixed. `EditSheet`'s model-swap `onChange` now clears an incompatible `draft.effort` in the same update via a new `onModelChange` handler + pure helper `effortSupportedByModel()` in `session-settings.ts` (unit-tested), mirroring `CreateSheet`'s own reset effect. Full report: `specs/reports/session-settings-sheet.md`.

Deferred (not re-dispatched, already parked in `specs/refactor-backlog.md:313-315` under `deferred:session-settings-sheet`): the two LOW findings at `src/app/useAppShortcuts.ts:83-84` and `src/features/sessions/SessionSettingsSheet.tsx:607,701` from this round's report, plus the recurring `lifecycle.rs:942` persist-`INTERNAL` LOW — all pre-existing/out of scope.

### 2026-08-24 — preflight block (round 4, no review report — `npm run quality` failed before dispatch)

- 2026-08-24 — 1 finding, fixed. `src/lib/split-by-4.test.ts` (1006 lines, over the CLAUDE.md 1000-line cap, not in `oversized-baseline.json`) split by concern into `split-by-4.test.ts` (501 lines, store slice), `split-by-4-selectors.test.ts` (422 lines, new — pure PaneSlot selectors), and `split-by-4-persistence.test.ts` (140 lines, new — `parseSplitState`/`initialLastFocusedSessionId`); every test moved verbatim. `npm run quality` verified green end-to-end (0 errors).
