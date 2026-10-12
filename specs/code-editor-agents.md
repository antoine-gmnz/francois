---
id: code-editor-agents
feature_id: code-editor-agents
title: Code editor, agent-aware — send, see, review, and stay out of an agent's way
status: frozen
branch: feat/code-editor-agents
created: 2026-10-08
depends_on: [code-editor, session-engine, conversation-view, multi-provider-codex, open-in-vscode, wsl-filesystem, audio-cues]
reviewed_base:
reviewed_digest:
design_files:
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=256-26286   # 47 · Code / Agent editing — lock strip, flash, session chips
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=257-26518   # 48 · Send selection — target picker
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=257-27474   # 49 · Line comment + added confirmation
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=258-26974   # 50 · Review vs HEAD + hunk Revert
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=258-27906   # 51 · Session composer context chips
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=256-26807   # L47
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=257-27051   # L48
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=257-27989   # L49
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=258-27498   # L50
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=258-28310   # L51
---

# Code editor, agent-aware

## 1. Summary

The v1 Code tab (`specs/code-editor.md`) knows a file "changed on disk" but not *who* changed it.
This feature makes it aware of the sessions working in the same files: hand a selection or a line
comment to a session, see which lines an agent just changed and by whom, review a file against
`HEAD` and revert hunks, jump from a transcript tool row into the file, and stop the user's typing
from racing an agent's edits. All five capabilities sit on one piece of plumbing: a per-session
**touched-files record**, fed by a new core event `file.touched` normalised across Claude Code and
Codex.

## 2. Goals & non-goals

- **Goals**
  - One runtime-agnostic signal for "session S is editing file F" (`file.touched`, §5).
  - Selection / line comment → **context chips** above the target session's composer, sent only
    with the user's next message.
  - Changed lines flash; tabs and explorer rows show which session last touched a file.
  - Inline review vs `HEAD` with per-hunk **Revert**, which tells the session that wrote the file.
  - Edit/Write tool rows in the transcript open the file in the Code tab.
  - A buffer goes read-only while a session is mid-turn editing that file.
- **Non-goals**
  - Blocking the agent (no permission-gate deny on Edit/Write) — the lock is the user's side only.
  - Diff against a base branch / fork point — `HEAD` only.
  - Attributing Bash-driven edits (`sed -i`, formatters, codegen). They still reload via v1 FR-12,
    anonymously.
  - Locking on reads.
  - Hunk **accept** / staging — the DIFF tab owns staging; the editor only reverts.
  - Line-accurate attribution between two sessions in one checkout (§7 states the limit).
  - LSP bridging and format-on-save (separate follow-up spec).

## 3. User stories / flows

1. **Ask about a selection.** Select L12–40 in `src/auth.ts`, press `⌘L`. Exactly one live session
   runs on this root, so a chip `src/auth.ts:12–40` appears above that session's composer and a
   confirmation reads "Added to orbit-api · Open". The user stays in the Code tab.
2. **Comment a line.** Hover line 42, click the gutter `+`, type "this retry never backs off", `⏎`.
   A comment chip `src/auth.ts:42` with the note lands in the same place.
3. **Ambiguous target.** Two sessions run on this root (or none): `⌘L` opens a picker instead —
   same-root sessions first, then every other live session labelled with its root. Nothing is sent
   anywhere without a pick.
4. **Send.** In the session, the user types "why is this wrong?" and sends. The message text is the
   chips, serialised (FR-6), followed by what they typed. The chips clear.
5. **Watch an agent work.** `orbit-api` edits `src/auth.ts`, which is open and clean. The buffer
   reloads, the changed lines flash cyan and fade, and the tab and explorer row show an
   `orbit-api` chip.
6. **Locked.** While `orbit-api`'s turn runs, the `src/auth.ts` buffer is read-only under a strip:
   "orbit-api is working on this file · read-only until its turn ends · **Unlock anyway**".
7. **Review.** After the turn, the user clicks **Review** on the tab strip: an inline diff against
   `HEAD`. They hover a hunk and click **Revert**. The file saves, and `orbit-api`'s composer gets a
   chip "reverted src/auth.ts:40–52" with an editable note.
8. **Jump.** In the transcript, the user clicks the path in an `Edit src/auth.ts` row. The Code tab
   opens rooted at that session, on `src/auth.ts` at the first line that edit changed.
   `⌘`-click opens it in VS Code instead.

## 4. Functional requirements

### Plumbing

- **FR-1** The core emits `file.touched` (§5) on the session event stream whenever a session's
  runtime announces a file-mutating tool call:
  - Claude Code: `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, as soon as the `tool_use` block's
    input is complete (before approval or execution), path from `file_path` / `notebook_path`.
  - Codex: each path in a `file_change` item, on the first of item start / item complete;
    `add` → `write`, `update` → `edit`, `delete` → `delete`.
  - Deduped per `(blockId, path)`. Relative paths resolve against the session `cwd`. WSL sessions
    translate to the host form by the `wsl-filesystem` rules. Paths outside `cwd` are still
    emitted. Failed or denied calls are not retracted.
- **FR-2** `EditorFilesData` gains `rootDir` (§5). **Normalised form**: `\` → `/`, no trailing
  `/`, drive letter upper-cased. The core emits `rootDir` and `file.touched.path` in that form; the
  frontend applies the same pure `normPath()` to `SessionMeta.cwd` (which stays unchanged on the
  wire). A path is in a root when it starts with `rootDir + '/'`, compared case-insensitively when
  `rootDir` starts with a drive letter.
- **FR-3** The frontend keeps, in memory for the app's lifetime (§6):
  - **touched this turn** per session: path → kind + the block ids. Cleared when that session's
    status leaves `running`/`awaiting_approval`/`awaiting_input` for `idle`/`done`/`error`, and
    on `session.cleared` / `session.removed`.
  - **last toucher** per path: session id + time. Kept until that session is removed.
  It is fed by registering a sink on the existing session-event trigger source — never a second
  `onSessionEvent` subscription (decision 2026-08-17 audio-cues).

### Send to session (#1 + #5)

- **FR-4** `⌘L` (Ctrl+L off macOS) with a non-empty selection in the editor creates a
  `selection` chip. It overrides Monaco's own Ctrl+L binding. Lines hovered in the gutter show a
  `+`; clicking it opens an inline comment box (a Monaco view zone) under the line, where `⏎`
  creates a `comment` chip and `Esc` cancels. An empty note is refused (the `⏎` does nothing).
- **FR-5** Target: the live (non-archived) sessions whose `cwd` equals the editor's `rootDir`.
  Exactly one → it is the target, with no prompt. Zero or several → a picker lists same-root
  sessions first, then every other live session with its root label. The pick is remembered per
  root for the app's lifetime and pre-highlighted next time, never auto-applied. No live session
  at all → the inline hint "No session to send to". After adding, a 4s confirmation reads
  "Added to <session> · Open", where **Open** switches to that session.
- **FR-6** Chips live per session in `src/lib/context-chips.ts` (§6), shown as a strip above the
  composer. A chip shows `path:start–end` (or `path:line`), click expands it (snippet read-only,
  note editable), and `×` removes it. On send, the message text is each chip in order, then a blank
  line, then the typed text:
  ````
  `src/auth.ts` lines 12–40:
  ```ts
  <snippet>
  ```
  <note, if any>
  ````
  Paths are relative to the session `cwd` (absolute if outside it). Chips clear when the send is
  accepted, including when it is parked in the busy-turn queue. A failed send keeps them. An empty
  composer with chips is sendable.
- **FR-7** Caps: 20 chips per session — the 21st is refused with "Chip limit reached (20)". A
  selection over 400 lines keeps the first 400 and the chip and serialised text say "(first 400
  of N lines)".

### See agent edits (#2)

- **FR-8** When an open buffer reloads from disk (v1 FR-12 clean reload, or **Reload** on the bar)
  and its path is in some session's touched-this-turn, the lines that differ between the old and new
  text get a `--state-running` background that fades over 1.5s. Under `prefers-reduced-motion`
  it holds for 1.5s and disappears without a fade. The first flashed line is recorded against the
  block ids that touched the path (used by FR-15).
- **FR-9** A file with a last toucher **and** an entry in the root's `changes` shows a session chip
  on its tab and explorer row, beside the git letter and never replacing it. It is **cyan** while
  that session's turn is running and the path is in its touched-this-turn, **neutral** otherwise.
  The tooltip reads "<session> · edited <relative time>".

### Review vs HEAD (#3)

- **FR-10** A **Review** toggle on the tab strip switches the active tab to Monaco's inline diff
  editor: original `headText`, modified the live buffer, editable. It is hidden for untracked
  files (`headText === null`) and for read-only too-large files. The toggle state is per tab.
- **FR-11** Each hunk shows a **Revert** action on hover. Reverting replaces the hunk in the buffer
  with the `HEAD` lines. If the buffer was clean before, it saves at once through `editor_save` with
  the loaded `baseVersion`. If it was dirty, the change stays in the buffer, unsaved.
  `EDITOR_STALE` shows the v1 FR-12 bar with the reverted text kept as the dirty buffer. No new
  verb.
- **FR-12** After a successful revert, if the path has a last toucher that still exists, a
  `revert` chip is added to that session: `path:start–end` (the reverted range, in pre-revert buffer
  lines), with the note pre-filled as "I reverted this change." and editable. There is no picker.
  Attribution is file-level (§7).
- **FR-13** **Revert** is disabled while the buffer is locked (FR-16), with the tooltip "Locked
  while <session> is editing".

### Jump from transcript (#4)

- **FR-14** In the transcript, a tool row whose `blockId` has a `file.touched` shows its path as a
  link. Inline-code spans in assistant prose of the form `path` or `path:line` also link, when the
  path is in that session root's `editor_files` list. That list is fetched once per session root,
  the first time such a span renders, and cached like the explorer's.
- **FR-15** A click opens the Code tab with root `{ kind: 'session', sessionId }` and opens the
  file. The line is the `:line` suffix, or the first flashed line recorded for that block (FR-8), or
  1. `⌘`-click (Ctrl-click off macOS) calls `session_open_in_editor` with `file`/`line`, the
  existing external path. A missing file shows v1's `EDITOR_FILE_NOT_FOUND` handling.

### Read-only while an agent edits (#6)

- **FR-16** A buffer is **locked** when some session whose status is `running` /
  `awaiting_approval` / `awaiting_input` has the buffer's path in its touched-this-turn, and the user
  has not unlocked it for that turn. Locked = Monaco `readOnly`, plus a 32px strip above the
  editor: session chip · "<session> is working on this file · read-only until its turn ends" ·
  **Unlock anyway**. With several sessions, the strip names the latest toucher and adds "+N".
- **FR-17** **Unlock anyway** lifts the lock on that path until the turn of every session currently
  locking it ends. Further `file.touched` on that path in the same turn do not re-lock. An
  unlocked buffer behaves exactly like v1.
- **FR-18** A buffer that is dirty when the lock lands keeps its unsaved edits, read-only, and `⌘S`
  is disabled. When the agent's write lands, the v1 FR-12 bar appears. **Reload** discards the
  user's edits. **Keep mine** rebases the buffer but it stays locked. Saving is possible again
  after the turn ends or the user unlocks it.
- **FR-19** The lock also applies to files opened during the turn, and to the Review diff editor.

## 5. API contract

Amendments go **in place** in the files that own each domain (decision 2026-08-04 api). The new
frontend-only types live in `contract/code-editor-agents.ts`.

```ts
// contract/common.ts — SessionEvent gains one member
export type FileTouchKind = 'edit' | 'write' | 'delete';
//  | { type: 'file.touched'; sessionId: SessionId; blockId: BlockId;
//      path: string;        // absolute, normalised (FR-2), '/'-separated
//      kind: FileTouchKind;
//      at: number }         // epoch ms
// Not persisted, not replayed on transcript load (live signal only).

// contract/code-editor.ts — EditorFilesData gains
//   /** Absolute root directory, normalised by the same helper as file.touched.path (FR-2). */
//   rootDir: string;

// contract/code-editor-agents.ts — frontend-only shapes (no IPC)
import type { SessionId } from './common';

export type ContextChipKind = 'selection' | 'comment' | 'revert';
export interface ContextChip {
  id: string;                 // uuid v4
  kind: ContextChipKind;
  path: string;               // absolute, normalised (FR-2)
  startLine: number;          // 1-based
  endLine: number;            // inclusive; === startLine for a comment
  snippet?: string;           // selection only, LF, ≤ CONTEXT_CHIP_MAX_LINES lines
  totalLines?: number;        // set when snippet was cut (FR-7)
  language?: string;          // Monaco language id, for the fence
  note?: string;              // comment (required) / revert (prefilled) / selection (optional)
  createdAt: number;
}
export const CONTEXT_CHIPS_PER_SESSION = 20;
export const CONTEXT_CHIP_MAX_LINES = 400;
export const AGENT_FLASH_MS = 1500;
export type ChipTarget = { sessionId: SessionId };
```

No new verbs, no new error codes. Rust: mirror `FileTouchKind` and the `file.touched` variant in
the `SessionEvent` serde enum, and add `root_dir` to `EditorFilesData`. Round-trip tests cover
both.

## 6. Data & state

- **Core.**
  - Claude Code adapter: emit `file.touched` from the stream parser's completed `tool_use` input,
    reusing the tool→path-field table in `permissions/summarize.rs` rather than writing a third
    one.
  - Codex adapter: emit it from `file_change` items (`session/adapter/codex/`).
  - Path normalisation (FR-2): one core helper, shared by `editor_files.rootDir` and
    `file.touched.path`; its frontend twin `normPath()` has matching test vectors.
  - Stateless otherwise. Nothing is persisted.
- **Frontend.**
  - `src/features/code/agent-touch.ts`: the FR-3 record, the FR-8 first-line map
    (`blockId → line`), the per-turn unlock set, and the selectors `isLocked(path)`,
    `lockHolders(path)` and `chipFor(path)`. Fed through a registered session-event sink. Pure
    reducer + tests.
  - `src/lib/context-chips.ts`: per-session chips, as a module map with a subscriber set (the
    `pending-queue` / `composer-draft` shape), with the same lifetime as `composer-draft`.
    `serializeChips(chips, cwd)` is pure and tested. Conversation reads it, Code writes it — that
    is why it lives in `lib/`.
  - The last picked target per `rootDir` is held in `codeStore`.
  - The line diff for the flash reuses v1's gutter line-diff helper.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| Two sessions in one checkout edit the same file | Lock names the latest + "+N"; chip shows last toucher; a revert note goes to the last toucher — may be the wrong one (stated limit) |
| Edit via Bash / formatter | No `file.touched`: v1 reload, no flash/chip/lock |
| Edit tool denied or failed | Path stays touched for the turn (lock holds until turn end); no retraction |
| Turn ends while comment box is open | Unaffected — comment box isn't locked |
| Target session archived/removed with chips | Chips dropped with the session |
| Chip path deleted before send | Sent as-is (snippet is a snapshot) |
| Revert on untracked / too-large file | Review hidden (FR-10) |
| Revert while locked | Disabled (FR-13) |
| Revert → `EDITOR_STALE` | v1 FR-12 bar, reverted text kept dirty |
| `file.touched` path outside every open root | Recorded (feeds FR-14/15), no editor effect |
| WSL session | Path translated in core (FR-1); matching unchanged |
| App reload | Touched record, chips and locks are gone (in-memory) — no stale lock survives |
| `⌘L` with empty selection | No-op |

## 8. Design brief

New pieces drawn on the v1 frames 45 / L45 (Graphite & Signal; cyan = running, violet =
attention, neutral otherwise): the gutter `+` and inline comment box, the `⌘L` target picker, the
confirmation, the line flash, the session chip on tabs and explorer rows next to the git letter,
the Review toggle with the inline diff and the hunk Revert, the lock strip, and the composer's
context-chip strip (collapsed and expanded).

> full brief: specs/design/code-editor-agents.md

## 9. Acceptance criteria

- [ ] Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit` and Codex `file_change` each emit one `file.touched` per (block, path), normalised; serde round-trip test (FR-1, FR-2)
- [ ] Touched record clears on turn end / cleared / removed; registered as a sink (FR-3)
- [ ] `⌘L` and gutter comment create chips; single same-root session targets silently, else picker; nothing sent without a send (FR-4, FR-5)
- [ ] Chips serialise exactly per FR-6, clear on accepted send, survive a failed one; 20-chip and 400-line caps (FR-6, FR-7)
- [ ] Agent edit on an open clean buffer flashes the changed lines; reduced motion honoured (FR-8)
- [ ] Session chip on tab + explorer row next to the git letter, cyan only while that turn edits it (FR-9)
- [ ] Review shows inline diff vs HEAD; Revert on a clean buffer saves; stale shows the bar; a revert chip lands in the last toucher (FR-10–FR-12)
- [ ] Tool-row path and `path:line` inline code open the Code tab at the right root and line; ⌘-click goes external (FR-14, FR-15)
- [ ] Buffer locks from the session's first edit until its turn ends; Unlock anyway holds for the turn; dirty buffer keeps edits; Revert disabled while locked (FR-13, FR-16–FR-19)

## Remediation
