---
id: diff-view
title: Diff view (DIFF tab)
status: frozen
created: 2026-07-18
depends_on: [session-engine, app-shell]
---

# Diff view (DIFF tab)

## 1. Summary

The DIFF tab is the second tab of main pane `[2]`: a git-review surface for the selected session's working tree. It shows which files changed since the last commit (via a horizontal file-chip strip), a syntax-tinted unified diff for the selected file, and a footer with aggregate stats plus stage/commit actions. The backend half of this feature is the `diff` domain in the Rust core: it drives the system `git` CLI against the session's `cwd` to compute summaries and per-file diffs, stages changes, commits, and pushes change notifications (including the changed-file count that feeds the DIFF tab's badge) to the frontend over a dedicated event channel. This feature owns the git backend and the DIFF tab's body; the tab strip chrome itself (label, badge pill, tab-switch keys) belongs to `app-shell`, which consumes this feature's `fileCount`.

## 2. Goals & non-goals

- **Goals**:
  - Compute an accurate changed-file summary (staged + unstaged + untracked, respecting `.gitignore`) for a session's `cwd` via the system `git` CLI.
  - Render a per-file unified diff with hunk/add/del/ctx rows, gutter line numbers, and binary-file handling.
  - Stage all changes and commit staged changes from the UI.
  - Keep the changed-file count live via fs-watch + `tool.done` (Edit/Write) + manual refresh, broadcast on `francois:diff:event`, so `app-shell`'s DIFF tab badge and this tab's own chip strip stay in sync without polling.
  - Full keyboard operability: chip cycling, stage, commit, cancel.
- **Non-goals**:
  - The DIFF tab's label, its badge pill chrome, and tab-switch behavior (`d` key, mouse click on the tab header) — owned by `app-shell` (see `specs/app-shell.md`); this spec only supplies the `fileCount` value.
  - The SESSION and SHELL tabs — `conversation-view` and `shell-terminal` respectively.
  - Merge-conflict UI (git status `U` / unmerged paths) — conflicted files fall back to being reported with status `'modified'` using git's raw diff output; a dedicated conflict-resolution UI is future work.
  - Multi-file / side-by-side diff view, syntax highlighting inside diff lines, word-level intraline diffing, and diff of binary content — out of scope for v1 (binary files get a placeholder row, see §7).
  - Any git operations beyond stage-all and commit (branch switching, push/pull, reset, discard) — those belong to `shell-terminal` (the user runs `git` directly there).
  - Persisting commit-message drafts across sessions/restarts.

## 3. User stories / flows

1. **Open the DIFF tab and review changes.** User presses `d` (app-shell brings main pane's `mainTab` to `'diff'` and focuses main pane). The DIFF tab requests a fresh summary; the file-chip strip renders one chip per changed file; the first chip is selected by default; the diff body loads and renders that file's hunks.
2. **Cycle files with the keyboard.** Main pane is focused and DIFF is the active tab. User presses `→`/`←`; the selection moves to the next/previous chip (wrapping at the ends); the diff body reloads for the newly selected file. Arrow keys are ignored for chip cycling while the commit-message input has focus (they move the text caret instead).
3. **Select a file with the mouse.** User clicks a chip; it becomes selected (bg `#20222a`, left accent marker, bright name); the diff body reloads.
4. **Stage everything.** DIFF tab is visible and no text input has focus. User presses `s`. `francois:diff:stageAll` runs `git add -A` in the session's `cwd`. Chip strip and footer stats are unaffected (staged vs. unstaged is not distinguished in the summary — see §6), but a fresh summary is still fetched to reflect any watcher-visible changes.
5. **Commit staged changes.** User presses `c`; the footer swaps to an inline commit bar (text input, placeholder `commit message…`). User types a message and presses `Enter`. `francois:diff:commit` runs; on success the bar shows a transient `committed <shortHash>` line (green), then reverts to the normal footer and the summary refreshes (now possibly empty). On failure (e.g. nothing staged) the bar stays open with the typed message intact and shows an inline red error line; user can fix (e.g. switch to SHELL tab and `git add`) and retry, or press `Esc` to cancel.
6. **Cancel a commit.** Commit bar is open; user presses `Esc`. The bar closes, the footer reverts to stats + `[s]`/`[c]` hints, nothing is committed, the typed message is discarded.
7. **Live updates while Claude Code works.** A running session's agent edits a file (`Edit`/`Write` tool). As soon as session-engine emits `tool.done` for that tool, diff-view recomputes the summary and broadcasts `diff.changed`; if the DIFF tab is currently open for that session, the chip strip and footer stats update without user action; regardless of which tab is open, `app-shell`'s badge updates.
8. **External edits.** User edits a tracked file from the SHELL tab or an external editor. The fs watcher on the session's `cwd` picks up the change, debounces 300ms, recomputes, and broadcasts `diff.changed` the same way.
9. **Non-git session.** User opens the DIFF tab for a session whose `cwd` is not inside a git working tree. Empty state: `NOT_A_GIT_REPO` with the hint "not a git repository — initialize with `git init` in the shell". Chip strip is empty; footer shows no stage/commit hints (nothing actionable).
10. **Clean tree.** User opens the DIFF tab for a session with zero changes. Empty state: "working tree clean". Chip strip empty; footer still visible but stats read `+0 −0 across 0 files` and `[s]`/`[c]` hints are inert (see FR-14).
11. **Diff load failure.** A file is selected but `getFileDiff` fails (e.g. git error, file vanished mid-read). An inline `GIT_ERROR` row replaces the diff body for that file; the chip strip stays intact so the user can pick another file.
12. **Binary file.** User selects a chip for a binary file (e.g. a `.png` added to the repo). The diff body shows a single "binary file" placeholder row instead of hunks.

## 4. Functional requirements

**Backend / git integration**

- **FR-1 (repo detection).** On every `getSummary` call, run `git rev-parse --is-inside-work-tree` in the session's `cwd`. Non-zero exit (or spawn failure because `git` isn't on `PATH`) → `Result` fails with `NOT_A_GIT_REPO` (spawn-not-found also maps to `NOT_A_GIT_REPO` for UI purposes; there is no separate "git not installed" state in v1).
- **FR-2 (diff base).** Determine the comparison base: run `git rev-parse --verify -q HEAD`. If it succeeds, base = `HEAD`. If it fails (repo has no commits yet), base = the well-known empty-tree object `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (constant across all git repos), so a brand-new repo's tracked/staged files still show as fully-added diffs.
- **FR-3 (summary — tracked files).** Run `git status --porcelain=v1 -z --untracked-files=all --renames` in `cwd` to get the authoritative file list, respecting `.gitignore` (ignored files never appear). Parse the NUL-delimited records; for renamed entries (`XY` starting with `R`) the record carries the original path as an extra NUL-terminated field per porcelain `-z` rename encoding — use only the new path for `path`/`dir`/`name`. Map the two-letter status code to `DiffFileSummary.status`:
  - contains `A` (staged add) → `'added'`
  - contains `D` → `'deleted'`
  - starts with `R` → `'renamed'`
  - is `??` → `'untracked'` (handled separately, FR-4)
  - anything else with a tracked change (`M` in either position, or combinations like `MM`) → `'modified'`
  - Precedence when a code combines statuses (e.g. `AM`): the "file identity" status wins — `added` > `renamed` > `deleted` > `modified`.
- **FR-4 (summary — tracked counts).** Run `git diff <base> -M -z --numstat` in `cwd` to get `additions`/`deletions` per tracked path (paths from FR-3, excluding `??`). A numstat line of `-\t-\t<path>` (git's marker for a binary file) yields `additions: 0, deletions: 0` for the summary; binary-ness is re-derived by `getFileDiff` (FR-7).
- **FR-5 (summary — untracked counts, exact commands).** For every path with status `??` from FR-3: run `git diff --no-index --numstat -- /dev/null "<path>"` in `cwd`. This treats the untracked file as "added" against an empty file, so numstat reports `<N>\t0\t<path>` — `additions = N`, `deletions = 0`, `status: 'untracked'`. If the output is `-\t-\t<path>` (binary), `additions: 0, deletions: 0`. This is the exact untracked-additions mechanism — no `git add -N` / intent-to-add is used, so the index is never mutated by a read (`getSummary`) call.
- **FR-6 (summary — assembly).** `path`/`dir`/`name` are derived from git's forward-slash-separated relative path (`dir` = everything before the last `/`, or `''` at repo root; `name` = basename) — always forward slashes, even on Windows, because git itself always emits `/`. `files` is the FR-3–FR-5 union, sorted by `path` ascending. `totalAdd`/`totalDel` are the sums of `additions`/`deletions` across `files`.
- **FR-7 (file diff — tracked).** `getFileDiff` for a tracked path runs `git diff <base> -M -- "<path>"` (base per FR-2, recomputed fresh — not cached from a prior summary call). If the output contains a `Binary files … differ` line, respond `{ hunks: [], binary: true }`. Otherwise parse the unified diff into `DiffHunk[]` per FR-9.
- **FR-8 (file diff — untracked).** `getFileDiff` for a path whose current status is `'untracked'` runs `git diff --no-index -- /dev/null "<path>"` (same command family as FR-5, without `--numstat`, to get the full patch). Binary detection identical to FR-7. Exit code 1 from `--no-index` (meaning "files differ") is expected/success, not an error; only exit codes ≥2 or stderr indicating a real failure map to `GIT_ERROR`.
- **FR-9 (hunk parsing).** Each `@@ -oldStart,oldLines +newStart,newLines @@ …` line starts a new `DiffHunk` with `header` set to that full line verbatim (including any trailing function-context text git appends; excluding any per-file suffix — one file is shown at a time so no filename is appended, unlike the illustrative flattened `dlData` list in the mock). Initialize `oldNo = oldStart`, `newNo = newStart`. For each following line until the next `@@` or EOF:
  - leading space → `kind: 'ctx'`, `oldNo`, `newNo` both set to current counters, then increment both counters.
  - leading `-` (and not `---`) → `kind: 'del'`, `oldNo` = current old counter (then increment old only), `newNo` undefined.
  - leading `+` (and not `+++`) → `kind: 'add'`, `newNo` = current new counter (then increment new only), `oldNo` undefined.
  - a line starting with `\` (git's "No newline at end of file" marker) is dropped, not emitted as a `DiffLine`.
  - `text` is the line content with the leading marker character stripped.
- **FR-10 (stage all).** `stageAll` runs `git add -A` in `cwd`. Succeeds (returns `Result` ok, no data) even when there is nothing to stage — this is never an error condition.
- **FR-11 (commit — precheck).** `commit` first runs `git diff --cached --quiet` in `cwd`. Exit code `0` (nothing staged) → fails with `GIT_ERROR`, message `"nothing staged to commit — stage changes first"`. A blank/whitespace-only `message` (after trim) is rejected client-side before the IPC call is made at all (see §6) — the IPC layer itself does not special-case empty messages beyond what `git commit` would reject.
- **FR-12 (commit — execute).** On a non-empty staged diff, run `git commit -m "<message>"` in `cwd`. On success, run `git rev-parse HEAD` for the full `commitHash` (and, for the UI's transient toast only, `git rev-parse --short HEAD` for the abbreviated hash — the short hash is not part of the `Result` payload, the UI derives its own display abbreviation from `commitHash` if it prefers, or the frontend may call `getSummary`'s side effects; see §5 for the exact payload). Any non-zero exit from `git commit` (e.g. a rejecting pre-commit hook) maps to `GIT_ERROR` with git's stderr surfaced in `detail`.
- **FR-13 (process safety).** Every git invocation uses `spawn`/`execFile` with an argv array (never a shell-interpolated string), so file paths and commit messages containing spaces, quotes, or shell metacharacters are passed safely.
- **FR-14 (concurrency).** Git operations for a given `sessionId` are serialized (a simple per-session queue) in the Rust core, so a `stageAll` and a `commit` (or two rapid `getSummary` calls triggered by watcher + `tool.done` at once) cannot interleave and corrupt the index.

**Change detection & events**

- **FR-15 (fs watcher).** For every session known to the Rust core (created on first `session.meta` for that `sessionId`, disposed on `session.removed`), diff-view starts a recursive watcher on the session's `cwd` that ignores `.gitignore`-matched paths and `.git/` itself (this ignore list is a performance optimization to avoid processing noise from `node_modules` etc. — it never changes what counts as "changed"; the authoritative file list always comes from the git commands in FR-3–FR-6, re-run on every trigger). On any filesystem event, debounce 300ms (reset the timer on each new event within the window); when the window elapses, recompute the summary and broadcast `diff.changed` (FR-17) regardless of whether `fileCount` differs from the previous broadcast.
- **FR-16 (tool.done trigger).** diff-view subscribes to `francois:session:event`. On every `{ type: 'tool.done', sessionId, meta }` event where the corresponding `tool.start` for that `blockId` had `tool === 'Edit'` or `tool === 'Write'`, recompute that session's summary and broadcast `diff.changed` immediately (independent of the fs-watcher debounce — this path is not debounced, since it is already a single discrete event per tool call).
- **FR-17 (event contract).** Every summary recomputation — whether triggered by the fs watcher (FR-15), a `tool.done` (FR-16), or a direct `getSummary` invoke from the frontend (manual refresh) — results in exactly one broadcast on `francois:diff:event` with `{ type: 'diff.changed', sessionId, fileCount }`, where `fileCount = files.length` from that computation. There is no separate "refresh" IPC channel; `getSummary` itself is idempotent and serves both automatic and user-initiated refreshes, and both paths keep the event channel authoritative for anyone (e.g. `app-shell`'s badge) that isn't also holding the full summary.
- **FR-18 (badge integration).** `app-shell` renders the DIFF tab badge using the `fileCount` from the most recent `diff.changed` event for the currently-selected session, seeded by an initial `getSummary` call when a session is first selected; badge is hidden when `fileCount === 0`. (Badge chrome itself — pill shape, colors — is specified in `app-shell`'s own design brief; diff-view only guarantees the count is correct and current.)

**UI — chip strip**

- **FR-19 (default selection).** On first load of a session's summary, the first file in `files` (by the FR-6 sort) is selected. On every subsequent summary refresh, if the currently-selected path is still present in the new `files`, selection is preserved; otherwise selection falls back to the new first file, or to no selection if `files` is empty.
- **FR-20 (mouse selection).** Clicking a chip selects it and triggers a `getFileDiff` load for its path.
- **FR-21 (keyboard cycling).** While main pane is focused, the DIFF tab is active, and no text input inside the DIFF tab has focus: `→` selects the next chip (wrapping from last to first); `←` selects the previous chip (wrapping from first to last). Each move triggers a `getFileDiff` load.

**UI — footer & commit bar**

- **FR-22 (stage hotkey).** `s` runs `stageAll` when the DIFF tab is visible and no text input anywhere in the app has focus. It is a no-op (key is ignored, no IPC call) when `files.length === 0` or the session is `NOT_A_GIT_REPO` or a summary/diff request is in flight.
- **FR-23 (commit hotkey — open).** `c` opens the inline commit bar when the DIFF tab is visible and no text input has focus. `c`'s inert conditions are narrower than `stageAll`'s (FR-22): it is inert only when the session is `NOT_A_GIT_REPO` or a request is in flight — not when `files.length === 0`, because staged content can exist even with an empty/clean summary (e.g. the user staged everything via `s` and the working tree is otherwise clean, or staged specific files from the SHELL tab). A genuine "nothing staged" attempt is reported inline once `commit` is actually invoked, per FR-11/FR-26.
- **FR-24 (commit bar — input).** The commit bar renders a real text `<input>` (not a decorative span) with placeholder `commit message…`. `Enter` with a non-blank (post-trim) message calls `commit`; `Enter` with a blank message is a no-op (no IPC call, input keeps focus). `Esc` at any time discards the draft and reverts to the normal footer.
- **FR-25 (commit bar — success).** On a successful `commit` response, the bar shows `committed <shortHash>` (green) for 1800ms, then reverts to the normal footer; a `getSummary` is triggered immediately (not waiting for the 1800ms) so stats/chips reflect the post-commit state as soon as possible.
- **FR-26 (commit bar — failure).** On a failed `commit` response, the bar stays open, the typed message is preserved, and an inline error line renders below the input using `error.message` (red `#c46b62`). The user may edit and resubmit, or press `Esc` to cancel.

## 5. API contract

Exact contents intended for `contract/diff-view.ts` (imports from `contract/common.ts`, never redefines its types).

```ts
// contract/diff-view.ts
import type { Result, SessionId } from './common';

// ---------- domain types ----------

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';

export interface DiffFileSummary {
  path: string;   // repo-relative, forward-slash separated, e.g. 'src/auth/middleware.ts'
  dir: string;     // everything before the last '/', '' at repo root
  name: string;    // basename
  additions: number;
  deletions: number;
  status: DiffFileStatus;
}

export interface DiffSummary {
  files: DiffFileSummary[]; // sorted by path ascending
  totalAdd: number;
  totalDel: number;
}

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  oldNo?: number; // set for 'del' and 'ctx'
  newNo?: number; // set for 'add' and 'ctx'
  text: string;   // line content, marker character stripped; full '@@ ... @@' text for 'hunk'
}

export interface DiffHunk {
  header: string;      // the raw '@@ -a,b +c,d @@ ...' line
  lines: DiffLine[];
}

export interface FileDiff {
  hunks: DiffHunk[];
  /** True when git reports the file as binary; hunks is [] and the UI shows the
   *  binary-file placeholder row instead of trying to render hunks. */
  binary: boolean;
}

export interface CommitResult {
  commitHash: string; // full 40-char SHA from `git rev-parse HEAD`
}

// ---------- request payloads ----------

export interface DiffGetSummaryRequest {
  sessionId: SessionId;
}

export interface DiffGetFileDiffRequest {
  sessionId: SessionId;
  path: string; // DiffFileSummary.path
}

export interface DiffStageAllRequest {
  sessionId: SessionId;
}

export interface DiffCommitRequest {
  sessionId: SessionId;
  message: string; // non-blank after trim; enforced by the frontend before invoke (FR-24)
}

// ---------- IPC channels (frontend -> core, invoke/Result) ----------
// 'francois:diff:getSummary'   (DiffGetSummaryRequest)  -> Promise<Result<DiffSummary>>
// 'francois:diff:getFileDiff'  (DiffGetFileDiffRequest)  -> Promise<Result<FileDiff>>
// 'francois:diff:stageAll'     (DiffStageAllRequest)     -> Promise<Result<void>>
// 'francois:diff:commit'       (DiffCommitRequest)       -> Promise<Result<CommitResult>>

// ---------- event channel (core -> frontend) ----------
// 'francois:diff:event', payload:
export type DiffEvent =
  | { type: 'diff.changed'; sessionId: SessionId; fileCount: number };
```

**Error codes per channel** (all from `ErrorCode` in `contract/common.ts` — no feature-specific codes are added):

| Channel | Codes | When |
|---|---|---|
| `francois:diff:getSummary` | `SESSION_NOT_FOUND`, `NOT_A_GIT_REPO`, `GIT_ERROR`, `INTERNAL` | unknown `sessionId`; `cwd` not a git work tree (FR-1); git spawn/parse failure |
| `francois:diff:getFileDiff` | `SESSION_NOT_FOUND`, `NOT_A_GIT_REPO`, `INVALID_INPUT`, `GIT_ERROR`, `INTERNAL` | as above; `path` not present in the current summary (stale selection) → `INVALID_INPUT`; git failure → `GIT_ERROR` |
| `francois:diff:stageAll` | `SESSION_NOT_FOUND`, `NOT_A_GIT_REPO`, `GIT_ERROR`, `INTERNAL` | `git add -A` failure (e.g. permissions) → `GIT_ERROR` |
| `francois:diff:commit` | `SESSION_NOT_FOUND`, `NOT_A_GIT_REPO`, `INVALID_INPUT`, `GIT_ERROR`, `INTERNAL` | blank message reaching the backend (defense in depth) → `INVALID_INPUT`; nothing staged (FR-11) or `git commit` non-zero exit (FR-12) → `GIT_ERROR` |

## 6. Data & state

**Rust core (per session, keyed by `sessionId`):**
- A file-watcher handle + debounce timer (FR-15), started on first `session.meta` for that session, disposed on `session.removed`.
- A serialization queue for git operations (FR-14) — not persisted, in-memory only.
- No cached `DiffSummary`/`FileDiff` — every `getSummary`/`getFileDiff` call re-runs git fresh (git's own object/index reads are fast enough that a cache would only add invalidation risk). The only thing kept in memory across calls is the watcher/queue plumbing above.

**Frontend (zustand, scoped to the currently-displayed session's DIFF tab):**
- `summary: DiffSummary | null` and `summaryError: AppError | null` (mutually exclusive with the empty/clean states derived from `summary`).
- `selectedPath: string | null` (FR-19).
- `fileDiff: FileDiff | null`, `fileDiffError: AppError | null`, `fileDiffLoading: boolean` — for the currently-selected path.
- `commitBar: { open: boolean; message: string; error: string | null; success: { shortHash: string } | null }`.
- No persistence — all state is refetched from the Rust core on session switch / DIFF tab activation; nothing survives an app restart.

**Derived / cross-feature:**
- `fileCount = summary?.files.length ?? 0` is the value `app-shell` reads (via `diff.changed` events + the seeding `getSummary` call, FR-18) to render the DIFF tab badge; diff-view does not push this into any shared store beyond emitting the event — `app-shell` owns subscribing/deriving it.
- `totalAdd`/`totalDel` and per-chip `additions`/`deletions` are always taken directly from the latest `DiffSummary`, never recomputed client-side.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| `cwd` is not a git work tree | `getSummary` → `NOT_A_GIT_REPO`. UI: empty state, hint "not a git repository — initialize with `git init` in the shell". Chip strip empty, footer stage/commit hints hidden (nothing actionable — see FR-22/23 note, but a non-repo has no session to stage/commit against at all so both are simply not rendered here). |
| Working tree clean (`files.length === 0`, no error) | UI: "working tree clean" empty state. Footer still shows `+0 −0 across 0 files`; `[s]`/`[c]` hints render but are inert per FR-22/23. |
| Selected file's diff fails to load (git error, or file removed between summary and diff fetch) | Chip strip stays as-is; diff body area shows a single inline `GIT_ERROR` row with `error.message`; selecting a different chip retries independently. |
| Selected file is binary | `getFileDiff` returns `{ hunks: [], binary: true }`; diff body shows one "binary file" placeholder row, no gutter/sign columns. |
| Selected file has `hunks: []` and `binary: false` (e.g. a pure rename with no content change) | Diff body shows a single dim "no content changes" placeholder row (same visual slot as the binary placeholder, different text). |
| `path` requested in `getFileDiff` is stale (not in the latest summary — e.g. user staged/reverted between summary and click) | `INVALID_INPUT`; UI treats it the same as a load failure (inline `GIT_ERROR`-style row, using the returned message) and triggers a background `getSummary` refresh so the chip strip catches up. |
| `commit` called with nothing staged | `GIT_ERROR`, message `"nothing staged to commit — stage changes first"`; commit bar shows this inline (FR-26), stays open. |
| `commit` message blank/whitespace only | Frontend never calls the IPC (FR-24); if it somehow does (defense in depth), backend returns `INVALID_INPUT`. |
| `stageAll` with nothing to stage | Succeeds (`Result` ok) — never an error (FR-10). |
| Session removed while its DIFF tab is open (e.g. session killed elsewhere) | In-flight/future `getSummary`/`getFileDiff`/`stageAll`/`commit` calls for that `sessionId` return `SESSION_NOT_FOUND`; the watcher for that session is disposed (FR-15); UI falls back to whatever `app-shell`'s session-removed handling shows (out of scope here). |
| Merge conflict present (git status `U`) | Falls back to `status: 'modified'`; the raw conflict-marker diff renders as ordinary hunks. No dedicated conflict UI in v1 (non-goal). |
| Renamed file with content changes | `status: 'renamed'`, `path`/`dir`/`name` from the new path; `getFileDiff` renders the rename's hunks normally (git's `-M` diff already includes them). |
| `git` executable missing from `PATH` | Spawn failure surfaces as `NOT_A_GIT_REPO` (v1 does not distinguish "not a repo" from "no git installed" — same empty-state hint tells the user to check the shell). |
| Very large file / huge line-number values | Gutter is a fixed 34px right-aligned column (FR from §8); numbers are not clipped (no `overflow:hidden` on the gutter span) — wide numbers simply push into the sign column visually; not specially handled in v1. |

## 8. Design brief

### Screens / regions

Owns the DIFF-tab body inside main pane `[2]` (`Claude Terminal.dc.html` lines 117–144, the `isDiff` block) and its data source (`dfData`/`dlData`/`dstyle`, lines 433–477). Does **not** own the tab header row (lines 72–79) beyond supplying the badge's number — that chrome (the pill at line 76: bg `#26282f`, text `#a9adb6`, `font-size:9px`, `padding:1px 5px`, `border-radius:8px`) is `app-shell`'s to render.

### Components

**1. File-chip strip** (mock lines 119–127) — horizontal row, `display:flex;gap:6px;padding:9px 12px;border-bottom:1px solid #24262d;overflow-x:auto` (class `scz`, 8px thin scrollbar). One chip per `DiffFileSummary`:
- Chip container: `display:flex;align-items:center;gap:8px;padding:6px 11px;border-radius:4px;cursor:pointer;flex-shrink:0` (no truncation — chip width fits its content; the strip scrolls horizontally on overflow).
  - **Default (unselected)**: `background:transparent`, `border-left:2px solid transparent`, name color `#c4c7ce`.
  - **Selected**: `background:#20222a`, `border-left:2px solid #c8a15a`, name color `#dfe2e8` (bright).
  - **Hover** (unselected, mouse only): treat like a lighter default — no distinct hover token is specified in the mock; use the same transparent background with a `cursor:pointer` affordance only (no new color introduced).
- Name span: `font-size:11.5px`, color per selection state above.
- `+N` span: `font-size:10px`, color `#7fa07a` (only rendered when `additions > 0`).
- `−N` span: `font-size:10px`, color `#c46b62` (only rendered when `deletions > 0`).
- Empty strip (clean tree or `NOT_A_GIT_REPO`): the whole strip row renders nothing (0px content) rather than an empty placeholder bar — the empty state lives in the diff body below.

**2. Diff body** (mock lines 128–136) — scroll container `class="scz"`, `flex:1;overflow:auto;padding:8px 0;font-size:12px;line-height:1.75`. Each `DiffLine` (plus a synthetic leading row per `DiffHunk.header`) renders as one row: `display:flex;background:{rowBg};padding:0 12px`, containing:
- Line-number gutter: `width:34px;flex-shrink:0;text-align:right;padding-right:12px;font-size:10.5px;user-select:none;color:{numFg}`. Content is `newNo` for `add`/`ctx` rows, `oldNo` for `del` rows, blank for `hunk` rows.
- Sign column: `width:12px;flex-shrink:0;user-select:none;color:{signFg}`. Content: `+` for add, `-` for del, ` ` (space) for ctx, blank for hunk.
- Text: `white-space:pre;color:{textFg}`. Content: `DiffLine.text` for add/del/ctx rows; `DiffHunk.header` for the hunk row.

Exact per-kind tokens (from `dstyle`, lines 465–470):

| kind | row `background` | text `color` | sign char | sign `color` | line-no `color` |
|---|---|---|---|---|---|
| `hunk` | `#1b1d23` | `#c8a15a` | *(none)* | *n/a* | *(blank)* |
| `add` | `rgba(127,160,122,0.09)` | `#a7c2a2` | `+` | `#7fa07a` | `#5f7a5b` |
| `del` | `rgba(196,107,98,0.09)` | `#d5a39d` | `-` | `#c46b62` | `#8a5751` |
| `ctx` | `transparent` | `#868a93` | ` ` | `#565a63` | `#565a63` |

**3. Binary / no-changes placeholder row** — single row in the diff body area, no gutter/sign columns: `padding:16px 14px;font-size:12px;color:#565a63`. Text: `binary file` (binary case) or `no content changes` (empty-hunks, non-binary case, e.g. pure rename).

**4. Inline error row** (diff-load failure) — same padding/position as the placeholder row, text color `#c46b62`, content = the `AppError.message`.

**5. Footer** (mock lines 137–142) — `padding:10px 14px;border-top:1px solid #24262d;display:flex;align-items:center;gap:14px;font-size:11px;color:#6b7079`.
- Stats span: `+{totalAdd}` in `#7fa07a`, a space, `−{totalDel}` in `#c46b62`, then ` across {N} files` in the base `#6b7079`.
- Spacer: `flex:1`.
- `[s] stage all` — `color:#a9adb6` (uniform, matching the mock's literal styling — not split into an accent bracket + dim label like the global status bar).
- `[c] commit…` — `color:#a9adb6`.
- Both hint spans render dimmed (`color:#3a3d45`, no pointer cursor) — but remain in the DOM — in the inert conditions of FR-22 (stage) and the `NOT_A_GIT_REPO` case (both).

**6. Inline commit bar** (replaces the footer's right-hand hints while open; stats span stays visible on the left) — same footer row container:
- Prompt glyph `›`, `font-size:13px`, `color:#c8a15a` (matches the SESSION tab's input-bar prompt, mock line 111).
- Real `<input>` element, `flex:1`, `font-size:12.5px`, text color `#dfe2e8` while non-empty, placeholder `commit message…` in `#565a63`, no background/border (transparent, matching the surrounding footer), native caret (no fake blinking-block cursor — that decoration in the mock is only used for read-only demo text, not a live input).
- Right-aligned hints: `⏎ commit` and `esc cancel`, `color:#a9adb6`, same `11px` as the rest of the footer.
- **Success state**: input row replaced by `committed {shortHash}` in `#7fa07a`, shown 1800ms, then the bar closes and the normal footer returns.
- **Error state**: an additional line below the input, `color:#c46b62`, `font-size:10.5px`, showing the error message; input and hints stay visible/interactive.

### States

- Chip: default / selected / (implicit hover via `cursor:pointer`, no dedicated color) / strip-empty (nothing rendered).
- Diff body: loaded-with-hunks / binary-placeholder / no-changes-placeholder / inline-error / loading (no dedicated spinner token in the mock — reuse the existing row layout with dim `#565a63` text "loading…" for any request taking long enough to be perceptible) / not-a-git-repo empty state / clean-tree empty state.
- Footer: normal (stats + hints) / hints-inert (dimmed, `NOT_A_GIT_REPO` or clean-tree-with-nothing-actionable per FR-22/23) / commit-bar-open / commit-bar-success / commit-bar-error.
- Badge (rendered by `app-shell`, referenced here only for traceability): visible with `fileCount` / hidden at `fileCount === 0`.

### Interactions

- Click a chip → select + load diff (FR-20).
- `←`/`→` while main pane focused, DIFF active, no text input focused → cycle chips, wrapping (FR-21).
- `s` while DIFF visible, no text input focused, not inert → `stageAll` (FR-22).
- `c` while DIFF visible, no text input focused, not inert → open commit bar, focus the input (FR-23).
- Inside commit bar: type to edit message; `Enter` → commit (if non-blank); `Esc` → cancel/close (FR-24).
- No drag/resize interactions specific to this feature beyond the panel's own resize handling (owned by `app-shell`).

### Visual notes

- Typeface: JetBrains Mono throughout, weights 400/500 (no bold text introduced by this feature beyond what's listed above).
- Diff body rows: `font-size:12px`, `line-height:1.75`.
- Chip name: `font-size:11.5px`; chip +/− counts: `font-size:10px`.
- Footer text: `font-size:11px`; commit-bar error line: `font-size:10.5px`.
- Motion: no pulse/blink animation is introduced by this feature (the commit-bar input uses the OS-native caret, not the mock's decorative `blink 1s step-end infinite` block — that keyframe remains reserved for read-only streaming text elsewhere in the app). The commit-success message uses a plain 1800ms hold, no fade transition specified (implementer may add a short opacity fade on exit at their discretion since no token is prescribed here).
- Scrollbars: `.scz` convention — 8px, thumb `#2a2c33`, transparent track — applies to both the chip strip (horizontal) and the diff body (vertical, and horizontal for long lines given `white-space:pre`).

### Resize / responsive

- Chip strip: fixed height, horizontal overflow scrolls (no wrapping to multiple rows); chips never truncate their name.
- Diff body: vertical scroll for line count; individual long lines (`white-space:pre`) can exceed the container width and cause horizontal scroll on the same `.scz` container — no line wrapping.
- Line-number gutter is fixed at 34px regardless of pane width; sign column fixed at 12px; text column takes remaining space.
- Footer never wraps — stats truncate is not specified (footer content is short by construction: a count and two hints) — no ellipsis handling needed.
- Narrowing the main pane does not hide the badge or truncate chip names; it only changes how much of the chip strip / diff line is visible before requiring horizontal scroll.

## 9. Acceptance criteria

- [ ] Opening the DIFF tab for a git-backed session with changes shows one chip per changed file with correct `+`/`−` counts and the first file selected by default (FR-3–FR-6, FR-19).
- [ ] Untracked files appear with `status: 'untracked'` and additions equal to their full line count, computed via `git diff --no-index --numstat -- /dev/null "<path>"` (FR-5).
- [ ] Selecting a file (click or `←`/`→`) loads and renders its unified diff with correct hunk/add/del/ctx row colors and correct single-column line numbers (`oldNo` for del, `newNo` for add/ctx) (FR-7–FR-9, FR-20–FR-21, §8 table).
- [ ] A binary file selection renders the "binary file" placeholder instead of hunks (FR-7/FR-8, §7).
- [ ] `s` runs `git add -A` and is a no-op when nothing changed or focus is in a text input (FR-10, FR-22).
- [ ] `c` opens the commit bar; `Enter` with a message commits staged changes and shows `committed <shortHash>` for 1800ms before reverting and refreshing (FR-12, FR-24–FR-25).
- [ ] Committing with nothing staged returns `GIT_ERROR` with the exact message `"nothing staged to commit — stage changes first"`, shown inline without closing the bar (FR-11, FR-26).
- [ ] `Esc` cancels the commit bar without committing and discards the typed message (FR-24).
- [ ] Editing a file via the session's `Edit`/`Write` tool triggers a `diff.changed` broadcast (with correct `fileCount`) immediately after the corresponding `tool.done`, independent of the fs-watcher debounce (FR-16).
- [ ] An external filesystem change to a tracked/untracked file triggers a `diff.changed` broadcast within roughly 300ms of the last change in a burst (debounced), and ignored (`.gitignore`) paths never trigger it (FR-15).
- [ ] A non-git `cwd` shows the `NOT_A_GIT_REPO` empty state with the exact hint text "not a git repository — initialize with `git init` in the shell" (FR-1, §7).
- [ ] A clean working tree shows "working tree clean" with a `+0 −0 across 0 files` footer and inert `[s]`/`[c]` hints (§7).
- [ ] `app-shell`'s DIFF tab badge reflects `fileCount` from the latest `diff.changed` event (or the seeding `getSummary`) and is hidden at `fileCount === 0` (FR-18).

## Remediation

(Empty until a review returns findings.)
