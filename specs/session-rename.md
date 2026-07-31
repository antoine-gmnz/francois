---
id: session-rename
title: Session rename
status: shipped
created: 2026-07-31
depends_on: [session-engine, sessions-sidebar, command-palette, session-worktree]
reviewed_base: 872a3d39faf2838bb6677674a101bf2ba2c7cdc8
reviewed_digest: aa0a10c77bed871c
---

# Session rename

## 1. Summary

A session's display name is chosen once, in the New Session modal, and is never editable afterwards.
Names are picked before the work exists (`test`, `tmp`, `wip`), and the name is what identifies the
session in the sidebar, the main tab strip, the status bar and the overview rollup — so a stale name
degrades every surface at once. This feature makes `Session.name` mutable through a core-side
`session_rename` command, reachable from the sidebar row's right-click menu and from the ⌘K palette,
persisted to `sessions.json` and propagated by the existing `session.meta` event.

## 2. Goals & non-goals

- **Goals**
  - A core command that validates, mutates and persists a session's name, and emits `session.meta`.
  - One shared core-side name validator, used by **both** `session_create` and `session_rename`.
  - Two entry points — sidebar context menu and ⌘K palette — opening the same rename modal.
  - Rename allowed in any session state (idle, running, error): the name touches no process.
- **Non-goals**
  - **Renaming the git branch.** The worktree branch `feat/<slug>` is derived at creation
    (`src/features/sessions/worktree.ts:27`) and is **frozen there by decision** — rename never calls
    `git branch -m`, never touches the worktree path, and the worktree card keeps showing the real
    branch with no added hint. The branch may be pushed or carry an open PR. A future "also rename the
    branch" checkbox (mirroring the delete-confirm's "remove worktree" checkbox) is the natural
    follow-up if asked for.
  - Renaming the claude session id, the remote-control session title, or anything process-side.
  - Inline double-click-to-edit in the sidebar row (rejected for v1: the row already handles
    click-to-select and right-click-to-menu, and editing in place risks reflowing its status chips).
  - Renaming from the overview / fleet board.
  - Auto-naming a session from its first prompt; rename history; undo.
  - Backfilling past activity-feed entries. `contract/overview.ts:235` captures the name at record
    time and its comment already anticipates "a removed or renamed session" — historical entries
    keeping the old name is **intended behaviour**.
  - Enforcing unique names. Sessions are identified by uuid; duplicates are allowed.

## 3. User stories / flows

**Flow A — rename from the sidebar (mouse)**
1. User right-clicks a session row in pane [1]. The context menu opens with **"Rename session"** above
   "Remove session".
2. Click "Rename session" → the context menu closes and the rename modal opens, its input prefilled
   with the current name and fully selected.
3. User types a new name, presses **Enter** (or clicks **Rename**).
4. On `ok: true` the modal closes; the sidebar row, the main tab strip, the status bar and the overview
   rollup all show the new name (driven by the `session.meta` event).

**Flow B — rename from the palette (keyboard)**
1. With a session selected, user presses **⌘K**, types `ren`, and the **"Rename session"** command
   ranks up (glyph `✎`). Enter runs it.
2. The palette closes and the same rename modal opens for the **active** session. Continue at A.3.
3. With no session selected the command is **not listed at all** (`enabled` returns false ⇒ hidden,
   per command-palette FR-22/§7).

**Flow C — invalid name**
1. User clears the input and presses Enter. The **Rename** button is disabled and Enter does nothing
   while the trimmed name is empty — no IPC call is made.
2. A name the core rejects anyway (a race, or an over-cap paste) resolves `ok: false`; the modal stays
   open and renders `error.message` inline below the input.

**Flow D — cancel**
Escape, a click on **Cancel**, or a click outside the modal closes it with no IPC call. The name is
unchanged.

## 4. Functional requirements

**Core — validator**

- **FR-1**: The core exposes `validate_session_name(raw: &str) -> Result<String, (code, message)>`
  in `src-tauri/src/session/mod.rs`, applying in order:
  1. strip every C0/C1 control character (`U+0000`–`U+001F`, `U+007F`–`U+009F`), including `\n`/`\r`/`\t`;
  2. trim leading/trailing whitespace;
  3. reject an empty result with `INVALID_INPUT` / `"session name cannot be empty"`;
  4. reject a result longer than **80 Unicode scalar values** with `INVALID_INPUT` /
     `"session name cannot exceed 80 characters"` (count `chars()`, not bytes);
  5. return the cleaned name.
  All other Unicode (accents, emoji, CJK) is allowed.
- **FR-2**: `session_create` routes its `name` through `validate_session_name` **after** the
  `basename(&cwd)` fallback (`lifecycle.rs:215`), storing the cleaned result. A `name` of `None` or a
  name that trims to empty still falls back to `basename(&cwd)` — creation never fails for a blank
  name; it fails only for a non-blank name that is over the cap (returns `INVALID_INPUT`).

**Core — rename command**

- **FR-3**: `session_rename(session_id, name)` validates via FR-1, then looks up the session. An
  unknown id returns `SESSION_NOT_FOUND` / `"session not found"` and mutates nothing.
- **FR-4**: On success it sets `session.name` to the cleaned name, persists every session with the
  existing atomic temp+rename write (`persistence.rs:289`), emits `session.meta` carrying the full
  updated `SessionMeta`, and resolves `ok: true` with that same `SessionMeta`.
- **FR-5**: Rename is accepted in **every** session status — idle, running, error. It never returns
  `SESSION_NOT_RUNNING` and never touches the child process, the PTY, the claude session id, or the
  worktree.
- **FR-6**: Renaming to the name the session already has is a valid no-op-shaped success: it persists
  and emits normally (simpler than a divergent path, and the emission is idempotent).
- **FR-7**: Duplicate names across sessions are accepted with no warning.

**Frontend — modal**

- **FR-8**: `RenameSessionModal` (`src/features/sessions/RenameSessionModal.tsx`) is built from
  `Modal` in `src/ui/` and reuses **`NameField`** verbatim, so the input is literally the creation
  input. Title `RENAME SESSION`; actions `Cancel` / `Rename`.
- **FR-9**: On open the input is focused and its full contents **selected**, so typing replaces the
  old name.
- **FR-10**: **Enter** commits (when enabled), **Escape** cancels, an outside click cancels. The
  `Rename` button is disabled while the trimmed input is empty or exceeds 80 characters, and while a
  call is in flight.
- **FR-11**: Commit calls `sessionRename({ sessionId, name })` from `src/lib/api.ts`. On `ok: true`
  the modal closes and the store is **not** written directly — the `session.meta` event is the single
  update path (FR-13). On `ok: false` the modal stays open, re-enables its button, and renders
  `error.message` inline below the input.

**Frontend — entry points**

- **FR-12**: `SessionContextMenu` gains a **"Rename session"** item rendered above "Remove session" in
  the non-confirming state (`SessionContextMenu.tsx:66`), calling a new `onRename` prop. Choosing it
  closes the context menu and opens the modal for that row's session. The item is absent from the
  confirm and error states, which are unchanged.
- **FR-13**: No new store wiring: the existing `session.meta` handler in `sessionsStore` already
  replaces the cached `SessionMeta`, which is what the sidebar rows, `MainTabStrip`, the status bar
  and the overview rollup read.
- **FR-14**: `paletteCommands.ts` registers a ninth command
  `{ id: 'rename-session', glyph: '✎', name: 'Rename session', enabled: (ctx) => ctx.activeSessionId !== null }`.
  Its `run(ctx)` opens the rename modal for `ctx.activeSessionId` and returns `void` (closing the
  palette). It is **not** a `SecondaryStep` — it acts on the active session only.

## 5. API contract

Lives in `contract/session-rename.ts`. Imports `SessionId`, `SessionMeta`, `Result`, `SessionEvent`
from `./common`; redefines nothing.

```ts
// contract/session-rename.ts — session-rename.
// Physical Tauri binding: `francois:session:rename` → command `session_rename`,
// invoked as invoke('session_rename', { sessionId, name }).
// The event stream is francois://session/event (owned by session-engine).

import type { SessionId, SessionMeta, Result, SessionEvent } from './common';

/** francois:session:rename — frontend -> core. */
export interface SessionRenameRequest {
  sessionId: SessionId;
  /** The raw user input. The core trims it, strips control characters and caps it at 80 chars (FR-1). */
  name: string;
}

/**
 * Result<SessionMeta> — the full updated snapshot, identical to the one carried by
 * the `session.meta` emission that accompanies it (FR-4).
 *
 * ok:false error codes:
 *  - 'SESSION_NOT_FOUND' — no session with that id (FR-3)
 *  - 'INVALID_INPUT'     — name empty after cleaning, or over 80 chars (FR-1)
 *  - 'INTERNAL'          — unexpected core failure
 */
export type SessionRenameResponse = Result<SessionMeta>;

// ---------- consumed (owned by session-engine; pinned here for build-ability) ----------

/** The only event this feature emits; the frontend's single update path (FR-13). */
export type RenameHandledSessionEvent = Extract<SessionEvent, { type: 'session.meta' }>;
```

`src/lib/api.ts` gains:

```ts
export const sessionRename = (req: SessionRenameRequest): Promise<SessionRenameResponse> =>
  invoke('session_rename', req);
```

No new `ErrorCode` member — `SESSION_NOT_FOUND`, `INVALID_INPUT` and `INTERNAL` already exist in
`contract/common.ts`. No new event member: `session.meta` already carries a full `SessionMeta`.

## 6. Data & state

- **Core**: no new entity and no new field. `Session.name` (`src-tauri/src/session/mod.rs`) becomes
  mutable. It is already persisted in `sessions.json` alongside `id`/`cwd`/`modelId`/`effort`, so the
  on-disk schema is unchanged and older records load as before.
- **Frontend**: no new store slice. The rename modal's open/closed state and its in-flight/error state
  are local to the sessions feature (a `renaming: { sessionId, name } | null` alongside the existing
  `MenuState`), mirroring how the new-session modal is held today.
- **Derived**: the worktree branch stays derived-at-creation and is **not** recomputed. A renamed
  session showing branch `feat/<old-slug>` is expected, not drift.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| Empty / whitespace-only input | `Rename` disabled, Enter inert, no IPC (FR-10). A call that reaches the core anyway → `INVALID_INPUT`, message inline. |
| Name over 80 chars (typed) | `Rename` disabled with the same inline treatment. |
| Name over 80 chars (pasted then submitted in a race) | Core returns `INVALID_INPUT`; modal stays open, message inline. |
| Control characters / newlines pasted | Silently stripped by FR-1; the cleaned name is what persists and what the `session.meta` event carries — the modal closes showing the cleaned result everywhere. |
| Session removed while the modal is open | Commit resolves `SESSION_NOT_FOUND`; the modal stays open with `"session not found"`. Cancel is the only way out — there is nothing left to rename. |
| Session is running | Allowed (FR-5). Nothing about the turn is interrupted. |
| Renaming to the identical name | Succeeds, persists, emits (FR-6). |
| Two sessions given the same name | Allowed (FR-7). The sidebar shows both; they remain distinct by uuid. |
| `sessions.json` write fails | The existing atomic write is best-effort (`persistence.rs` swallows I/O errors, as every other mutation does). The rename still resolves `ok: true` and the in-memory/UI state is correct; the name reverts on next launch. Not made fallible here — that would diverge from every other persisted mutation in the core. |
| Palette run with no active session | Unreachable: `enabled` returns false, so the command is hidden (FR-14, command-palette FR-22). |

## 8. Design brief

Two touched surfaces, both small: the sidebar row's context menu gains a **"Rename session"** item
above "Remove session" (same `context-menu__item` styling, no glyph, no divider), and a new **rename
modal** — the smallest modal in the app: title `RENAME SESSION`, one `NameField` prefilled and
preselected, an inline error line, and a `Cancel` / `Rename` action row. The ⌘K palette gains one row
(glyph `✎`) with no visual change to the palette itself.

> full brief: `specs/design/session-rename.md`

## 9. Acceptance criteria

- [x] Right-clicking a sidebar row shows "Rename session" above "Remove session"; choosing it opens the
      modal prefilled and preselected with that session's name. (FR-8, FR-9, FR-12)
- [x] ⌘K → "Rename session" opens the same modal for the active session; with no session selected the
      command is absent from the palette list. (FR-14)
- [x] Typing a new name and pressing Enter updates the sidebar row, the main tab strip, the status bar
      and the overview rollup — without a reload. (FR-4, FR-11, FR-13)
- [x] The new name survives an app restart (it is in `sessions.json`). (FR-4)
- [x] Escape / Cancel / outside-click closes the modal and leaves the name unchanged. (FR-10)
- [x] An empty or whitespace-only input leaves `Rename` disabled and issues no IPC call. (FR-10)
- [x] `session_rename` on an unknown id returns `SESSION_NOT_FOUND` and mutates no state. (FR-3)
- [x] `session_rename` with an 81-character name returns `INVALID_INPUT`; with an 80-character one it
      succeeds. (FR-1)
- [x] A name containing `\n` or other control characters persists stripped and trimmed. (FR-1)
- [x] `session_create` rejects an over-cap name with `INVALID_INPUT`, and still falls back to
      `basename(cwd)` for a blank one. (FR-2)
- [x] Renaming a running session neither interrupts its turn nor changes its status. (FR-5)
- [x] A renamed session with a worktree still shows its original `feat/<old-slug>` branch, and no
      `git branch -m` is executed. (§2 non-goals)
- [x] Two sessions can carry the same name. (FR-7)
