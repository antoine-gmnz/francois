---
id: diff-review
title: Diff tab rework — one scroll, tree rail, commit form
status: frozen
branch: feat/rework-diff-tab
created: 2026-08-20
depends_on: [diff-view, diff-navigator, app-shell, session-engine, open-in-vscode, session-worktree, wsl-filesystem]
loop_pass: 0
loop_phase:
reviewed_base:
reviewed_digest:
design_files:
  - https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html
---

# Diff tab rework — one scroll, tree rail, commit form

## 1. Summary

The DIFF tab is a file browser wearing a review surface's clothes. Design turn 14 names four faults
that compound: the rail is a **viewport switch** (one file at a time, so a 7-file change is 7 clicks
with no memory of what you read), a row means two things at once (**check** = goes in the commit,
**click** = show me this), `[s] stage all` runs `git add -A` against a `commit(paths)` that takes an
explicit list — **two staging models that can disagree and neither is shown** — and nothing records
that a file has been *read*, which is the actual job.

This rebuilds the tab to **14b (body) + 14d (rail)**. The body becomes **one scroll containing every
file**, with a sticky header per file carrying its status, path, counts, `↗ editor` and an
`in commit` checkbox; scrolling a file past the viewport marks it **read**. The rail becomes a
**tree** (single-child chains collapsed, `⌗`/`▤` toggle, **writable directory checkboxes**) that
jumps rather than switches, with the branch's **commit list** at its foot — selecting a commit
re-renders the body as that commit's diff, read-only. `stageAll` is deleted from the contract and the
core; commit always takes an explicit path list, gains an optional body and **amend**, and stops
being a 320px footer input in favour of a **form** across the bottom of the pane.

Touches all three surfaces: `contract/diff-view.ts` (rewritten in place) + a one-field amendment to
`contract/open-in-vscode.ts`; `src-tauri/src/diff/`; `src/features/diff/`.

## 2. Goals & non-goals

- **Goals**
  - One scroll containing every changed file, sticky header per file, cross-file windowing.
  - **Read** as first-class state, inferred from scroll, surfaced in the rail, the file header and a
    progress bar.
  - **One** staging set with two affordances that cannot disagree: the tree checkbox (including a
    **writable** directory roll-up) and the file header's `in commit`.
  - `git add -A` gone for good — one staging model, always an explicit path list.
  - A tree rail with a `⌗`/`▤` toggle and fold state persisted per session.
  - The branch's commits ahead of its base, HEAD tagged; selecting one shows its diff read-only;
    ⌥-clicking HEAD arms `amend`.
  - A commit **form**: subject with a 50-character meter, optional extended description, the manifest
    of what goes in, an explicit line naming what stays behind, and amend.
  - `⋯ N unchanged lines` folds between hunks, expandable; `↗ editor` per file.
- **Non-goals**
  - **Side-by-side / split view** (14c's `▥`). Unchanged non-goal from `diff-view` §2.
  - **Hunk-level staging** (14c). Declined, not deferred: it means synthesising patches and
    `git apply --cached`, which is a larger feature than this whole rework.
  - **Syntax highlighting / any tokenizer.** Unchanged, and for the same two reasons
    (`diff-navigator` §2, decision 2026-08-18 `deps`).
  - **Grouping the rail by review state** (14c) — a file moving out from under the cursor the moment
    you mark it is worse than the ordering it buys.
  - **`⇥` next-unread jump.** Dropped: `↑`/`↓` and the rail already move you, and `⇥` is the focus key.
  - **A new collapsed-header treatment for binary/rename/too-large files.** They render the existing
    `diff-view` placeholder under their header; no reason-on-the-right chrome.
  - **Per-gap context expansion.** A fold row expands **its whole file's** context (FR-26), not just
    that gap. Accepted imprecision; per-gap needs a line-range verb.
  - **Per-file scroll memory.** One scroll container has one position. Stated by the mock as its own
    cost.
  - **Persisting read state, fold state or the commit draft across restarts.** All per session, all
    in memory.
  - **Any git verb beyond commit/amend** — no discard, revert, reset, push, branch, unstage. Still
    SHELL's job (`diff-view` §2).
  - Merge-conflict UI. Unchanged.

## 3. User stories / flows

1. **Read the change.** DIFF opens on a 7-file working tree. The rail is a tree; the body is one
   document. You scroll from the top; each file you pass dims in the rail and gains a tick. The foot
   bar reads `3/7 read`.
2. **Stage a directory.** `src/features/diff` holds four files, three of which belong in this commit.
   You tick the directory checkbox (all four in), then untick one — the directory mark becomes a
   dash. The three file headers in the body show `in commit` ticked, in sync.
3. **Jump.** You click `DiffFileRail.tsx` in the tree; the body scrolls to that file's header, which
   sticks to the top of the scroll container. Nothing else changes — no file was unloaded.
4. **Read the commit you just made.** The rail's COMMITS block shows `4 ahead of main`. You click
   `7b30de`; the body becomes that commit's files, read-only — no checkboxes, no commit form, and a
   `viewing 7b30de · back to working tree` strip. Clicking that strip returns you.
5. **Commit.** `c` opens the form across the bottom: subject (`37/50`), an optional description, the
   manifest of the 5 files going in with their counts, and the line
   `diff-view.md and review-icons.png stay in the working tree`. `⌘⏎` commits exactly those 5.
6. **Amend.** ⌥-clicking the `HEAD` row ticks `amend last commit` in the form and pre-fills the
   subject and body from that commit. If HEAD is already on a remote-tracking ref, the form says so
   in `--warn` — and still lets you do it.

## 4. Functional requirements

### Layout & top bar

- **FR-1.** The tab is four regions: a 34px **top bar**, then a two-column grid — a resizable
  **rail** (default 220px) and the **body** — then the **commit block** across the full width.
- **FR-2 (top bar).** Left: `⑂ <branch>` then `vs HEAD` (or `vs <ref>` when a commit is selected).
  Right: `+<totalAdd> −<totalDel>`, a `⊟ collapse read` action, and `⟳` refresh. The old file-count
  chip, `[s] stage all` and the chip strip are gone.
- **FR-3 (`⊟ collapse read`).** Collapses every file currently marked read to its header. It is a
  one-shot action, not a mode: a file marked read afterwards does not auto-collapse (FR-30).
- **FR-4 (detached / no branch).** `⑂ <shortHash> (detached)`; the COMMITS block still lists commits
  ahead of the base if one resolves, and renders its empty state otherwise (FR-17).

### Tree rail

- **FR-5 (tree).** The tree is `diff-navigator`'s: derived from `DiffSummary.files`, path order,
  subfolders before files, **single-child chains merged into one row** (`features/diff`). FR-1/FR-2
  of `diff-navigator` are carried over unchanged.
- **FR-6 (row content).** A **directory** row: caret, checkbox, label, descendant **file count** —
  never a `+/−` sum. A **file** row: checkbox, one-letter status (`M`/`A`/`D`/`U`/`R`), name, a read
  tick when read, `+n`/`−n`. A read file's name and counts render in the dimmed tone.
- **FR-7 (directory checkbox writes).** Clicking a directory checkbox sets **every descendant file**
  to that state. It shows checked / empty / **dash** by roll-up. This **supersedes `diff-navigator`
  FR-5** (display-only) and its "folder-level checkboxes" non-goal.
- **FR-8 (jump, not switch).** Clicking a file row scrolls the body to that file's header and marks
  nothing. There is no "selected file" — the rail has a **cursor**, and the body renders all files
  always. Clicking a directory row toggles its fold.
- **FR-9 (`⌗`/`▤` toggle).** A two-segment control in the rail header switches tree ↔ flat. Flat is
  `diff-navigator`'s list without folders, same rows. The choice is per session, in memory.
- **FR-10 (fold state).** Folders start expanded; fold state is a `Set` of folder keys **per
  session**, in memory, not persisted across restarts. Ignored while a filter is active.
- **FR-11 (ignored/unchanged directories).** A directory row for a path with no changed descendants
  is never rendered. The mock's `src-tauri/src · 2 ign` row is **not** built — the summary carries no
  ignored-file data and inventing one is a new git call per refresh.
- **FR-12 (filter).** `diff-navigator` FR-8 through FR-12 are carried over. `/` replaces the rail
  header's contents with the filter input; `Esc` clears it and restores the header and the stored
  fold state.

### Commits block

- **FR-13 (list).** A collapsible `COMMITS` block sits between the tree and the foot bar, listing the
  commits on the current branch **not reachable from its merge-base with the repo's default branch**,
  newest first, capped at 50. Each row: short hash, subject, and either the `HEAD` tag (first row) or
  a relative age.
- **FR-14 (expander).** At most 3 rows render; the rest sit behind a
  `<n> more · <baseBranch>` expander that reveals the whole list in place.
- **FR-15 (select).** Clicking a row loads that commit's summary and diffs into the body in
  **read-only** mode: no checkboxes anywhere, the commit block replaced by a
  `viewing <shortHash> · back to working tree` strip, and the top bar reading `vs <shortHash>^`.
  Read state is tracked separately per ref (FR-31).
- **FR-16 (⌥click HEAD).** ⌥/Alt-clicking the HEAD row opens the commit form with `amend last commit`
  ticked and the subject + body pre-filled from that commit (FR-38). It does **not** switch the body
  into read-only commit view.
- **FR-17 (empty / no base).** No commits ahead, or no default branch to compare against: the block
  renders one dim line (`nothing ahead of <base>` / `no base branch`) and no rows. It never blocks
  the rest of the tab.

### One-scroll body

- **FR-18 (one container).** The body is a single scroll container holding, in tree order, every file
  in the summary: a **header row** followed by that file's diff rows.
- **FR-19 (sticky header).** A file's header sticks to the top of the container while any of its rows
  are in view. Content: caret, one-letter status, `<dir>/` in the dim tone + `<name>` in the bright
  tone, `+n`/`−n`, spacer, `↗ editor`, and the `in commit` checkbox **labelled in words**.
- **FR-20 (header is the second staging affordance).** The header's `in commit` checkbox writes the
  same state as the tree's (FR-7). One set, two views; they can never disagree.
- **FR-21 (collapse).** The caret collapses a file to its header alone. Collapsed headers drop to the
  recessed surface. Collapse is independent of read (FR-30).
- **FR-22 (cross-file windowing).** Windowing spans the **whole stacked document**, not one file:
  rows are the concatenation of every expanded file's header + body rows, and the window is computed
  from a **prefix-sum offset table** because header rows (32px) and diff rows (`ROW_H = 21`) have
  different heights. A collapsed file contributes exactly its header.
- **FR-23 (big-file guard).** A file whose diff exceeds **800 rendered rows** starts **collapsed**,
  its header carrying `<n> lines · expand`. Expanding it is permitted and unwindows nothing — FR-22
  still applies.
- **FR-24 (order is the tree's).** Body order equals visible tree order. Folding a directory in the
  rail does **not** remove its files from the body; the rail's folds are navigation, the body is the
  whole change.
- **FR-25 (intraline).** `diff-navigator`'s word-level intraline emphasis (FR-20..FR-24) is unchanged
  and still runs per file.
- **FR-26 (context folds).** The gap between two hunks is rendered as a clickable
  `⋯ <n> unchanged lines` row, `n` derived from the hunk headers' line arithmetic. Clicking it
  re-fetches **that file's** diff with a larger `context` (FR-43) and removes **every** fold row in
  that file. The label stays per-gap accurate; the action is per-file (§2 non-goal).
- **FR-27 (`↗ editor`).** Opens that file in the first available editor from
  `EDITOR_ORDER` — no menu. Inert (hidden) for a deleted file or a read-only commit view.

### Read state

- **FR-28 (inferred from scroll).** A file becomes **read** when its last row has scrolled above the
  top of the viewport. Marking is one-way — a file never becomes unread by scrolling back.
- **FR-29 (manual toggle).** Clicking the tick in a rail row toggles read for that file, both ways.
- **FR-30 (read never collapses on its own).** Becoming read dims the rail row and adds the tick; it
  does **not** collapse the file. Collapsing is FR-3 or FR-21 only. *(Deliberate departure from
  14b's "collapses behind you" — auto-collapse moves the document under a scroll in progress.)*
- **FR-31 (scope).** Read state is a `Set<path>` keyed by **(session, ref)** — the working tree and
  each viewed commit keep their own — in memory, never persisted. Reset when a path leaves the
  summary.
- **FR-32 (progress).** The rail's foot bar shows a progress bar and `<r>/<n> read`.

### Commit block

- **FR-33 (closed).** Closed, it is one 26px strip: `<k> of <n> in commit` and the `[c] commit` hint.
- **FR-34 (open).** `c` (or clicking the strip) opens the form across the bottom of the pane; `Esc`
  closes it and keeps the draft. It never squeezes into one row.
- **FR-35 (form).** Header: `COMMIT`, `<k> of <n> files`, the read progress bar with `<r> of <n>
  read`, an `amend last commit` checkbox, `esc`. Then a **subject** input with a `<len>/50` meter
  (over 50 the meter goes `--warn`; nothing is blocked), an optional **extended description**
  textarea, and beside it the **manifest**: up to 3 checked files with status letter and counts, then
  `+ <m> more` with the aggregate.
- **FR-36 (stays-behind line).** Above the buttons, an explicit line naming the unchecked files —
  `<a> and <b> stay in the working tree`, truncated to `<a>, <b> and <m> more` past three. Nothing
  checked ⇒ the commit button is disabled and the line reads `nothing selected`.
- **FR-37 (commit).** `Commit <k> files` / `⌘⏎` invokes `francois:diff:commit` with the checked paths,
  the trimmed subject as `message`, the description as `body`, and `amend`. A blank subject disables
  the button. On success the form closes, the draft clears, read state for committed paths is
  dropped, and the summary + commit list refresh.
- **FR-38 (amend).** With `amend` ticked the commit runs `git commit --amend`. Ticking it for the
  first time pre-fills the subject and body from HEAD **only if both are empty**; unticking never
  clears what the user typed.
- **FR-39 (amend warning, not block).** If HEAD is reachable from any remote-tracking ref, the form
  shows `already pushed — amending needs a force-push` in `--warn`. It is **not** blocked
  (decision 2026-08-13 `ui`). Amend with no commit on the branch is refused by the core
  (`DIFF_NOTHING_TO_AMEND`).

### Keyboard

- **FR-40.** `diff-navigator` FR-17/18/19 traversal is kept: `↑`/`↓` move the rail cursor, `→`/`←`
  expand/collapse/hop to parent, `Enter` on a file **jumps the body** to it (FR-8) and on a directory
  toggles the fold. `Space` on a cursor row toggles its checkbox.
- **FR-41.** `s` is **unbound** (FR-45). `c` opens the commit form. `/` focuses the filter. `Esc`
  closes the form, then clears the filter, then does nothing.
- **FR-42.** All of the above are scoped to `mainTab === 'diff'` on the focused pane and inert while
  a text input has focus — the existing guard.

### Amendments to shipped specs

- **FR-43 (contract).** `contract/diff-view.ts` is rewritten in place per §5. `stageAll` is deleted
  from the contract, `src-tauri/src/diff/commands.rs`, `src/lib/api.ts` and the palette.
- **FR-44 (`open-in-vscode`).** `OpenInEditorRequest` gains `path?: string` (repo-relative). Absent ⇒
  today's behaviour exactly. `specs/open-in-vscode.md` gains one FR recording it.
- **FR-45 (spec edits, same change).** `specs/diff-view.md` §2 drops "Stage all changes and commit
  staged changes" for "Commit an explicit set of paths, or amend the last commit" and records that
  `stageAll`/`git add -A` were removed here; its "Multi-file / side-by-side diff view" non-goal splits
  — multi-file is superseded by this spec, side-by-side stays a non-goal.
  `specs/diff-navigator.md` §2 records that "multi-file continuous-scroll body", "folder-level
  checkboxes" and "viewed/read-state dimming" are superseded here, and FR-5 is marked superseded by
  FR-7.

## 5. API contract

`contract/diff-view.ts` — **rewritten in place**, same domain, same file (decision 2026-08-04 `api`).

```ts
// ---------- domain types ----------
export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';

export interface DiffFileSummary {   // unchanged
  path: string; dir: string; name: string;
  additions: number; deletions: number; status: DiffFileStatus;
}

export interface DiffSummary {
  files: DiffFileSummary[];          // sorted by path ascending
  totalAdd: number;
  totalDel: number;
  branch: string | null;             // NEW — current branch, null when detached
  headShort: string | null;          // NEW — short HEAD hash, for the detached label (FR-4)
  baseBranch: string | null;         // NEW — the default branch we count ahead of, null if none
}

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx';
export interface DiffLine { kind: DiffLineKind; oldNo?: number; newNo?: number; text: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface FileDiff { hunks: DiffHunk[]; binary: boolean }
export interface CommitResult { commitHash: string }

export interface DiffCommitSummary {  // NEW
  hash: string;        // full 40-char
  shortHash: string;   // git's own abbreviation
  subject: string;     // first line
  body: string;        // remainder, '' when none — feeds the amend pre-fill (FR-38)
  authoredAt: number;  // epoch ms
  isHead: boolean;     // true for exactly one row, the first
  pushed: boolean;     // reachable from any remote-tracking ref (FR-39)
}

export interface DiffCommitList {     // NEW
  commits: DiffCommitSummary[];       // newest first, capped at 50
  baseBranch: string | null;
  truncated: boolean;                 // true when the branch is >50 ahead
}

// ---------- request payloads ----------
export interface DiffGetSummaryRequest {
  sessionId: SessionId;
  commit?: string;      // NEW — full hash; summary of that commit vs its first parent (FR-15)
}

export interface DiffGetFileDiffRequest {
  sessionId: SessionId;
  path: string;
  commit?: string;      // NEW — same ref semantics as above
  context?: number;     // NEW — `git diff -U<n>`; default 3, clamped to [0, 10000] (FR-26)
}

export interface DiffListCommitsRequest { sessionId: SessionId }   // NEW

export interface DiffCommitRequest {
  sessionId: SessionId;
  message: string;      // subject; non-blank after trim, re-validated by the core
  body?: string;        // NEW — extended description, passed as a second -m
  paths: string[];      // MUST be non-empty unless amend is true; [] no longer means "the index"
  amend: boolean;       // NEW — `git commit --amend`
}

// ---------- feature-specific error codes ----------
export type DiffErrorCode =
  | 'DIFF_COMMIT_NOT_FOUND'    // the ref in `commit` does not resolve in this repo
  | 'DIFF_NOTHING_TO_AMEND';   // amend requested with no commit on the branch
```

**Channels** (`francois:diff:<verb>` → `diff_<verb>`, every one resolving to `Result<T>`):

| logical | command | request | response |
|---|---|---|---|
| `francois:diff:getSummary` | `diff_get_summary` | `DiffGetSummaryRequest` | `Result<DiffSummary>` |
| `francois:diff:getFileDiff` | `diff_get_file_diff` | `DiffGetFileDiffRequest` | `Result<FileDiff>` |
| `francois:diff:listCommits` | `diff_list_commits` | `DiffListCommitsRequest` | `Result<DiffCommitList>` |
| `francois:diff:commit` | `diff_commit` | `DiffCommitRequest` | `Result<CommitResult>` |
| ~~`francois:diff:stageAll`~~ | — | **deleted** (FR-43) | — |

`francois:diff:event` / `DiffEvent` is **unchanged** (`diff.changed` with `fileCount`).

**Core behaviour, normative:**

- `diff_commit` with `amend: false` runs `git add -- <paths>` then
  `git commit -m <message> [-m <body>] -- <paths>`. With `amend: true` it runs the same `add`, then
  `git commit --amend -m <message> [-m <body>] [-- <paths>]`; empty `paths` + `amend` amends the
  message alone. `paths` empty with `amend: false` ⇒ `INVALID_INPUT`.
- `diff_list_commits` resolves the base with the existing `diff_base` helper, then
  `git log --format=… <base>..HEAD -n 50`, and marks `pushed` from
  `git branch --remotes --contains <hash>` (one call for HEAD is enough — a commit reachable from a
  remote implies its ancestors are).
- Every git call routes through `git_routed`/`git_program`, so WSL path translation is inherited
  untouched (`wsl-filesystem`).
- `commit` on `getSummary`/`getFileDiff` is compared against `git rev-parse --verify <ref>^{commit}`
  before use; anything else is `DIFF_COMMIT_NOT_FOUND`. It is a hash from `listCommits`, never
  user-typed, but it is re-validated at the entry point regardless (decision 2026-08-17 `security`).

`contract/open-in-vscode.ts` — `OpenInEditorRequest` gains `path?: string` (FR-44). Nothing else in
that file changes.

## 6. Data & state

**Core:** stateless. No new persisted state, no new registry, no new event.

**Frontend**, all per session, all in memory, none persisted:

| state | meaning |
|---|---|
| `inCommit: Set<string>` | checked paths. Replaces `deselected` — an inverted set cannot express a directory write cleanly. Seeded to every path on each summary load. |
| `read: Map<string, Set<string>>` | keyed by ref (`'worktree'` or a commit hash) → read paths (FR-31) |
| `collapsed: Set<string>` | file paths collapsed in the body (FR-21/23) |
| `folded: Set<string>` | folded directory keys in the rail (FR-10) |
| `railMode: 'tree' \| 'flat'` | FR-9 |
| `filter: string` | FR-12 |
| `cursorKey: string \| null` | rail keyboard cursor (FR-40) |
| `viewingCommit: string \| null` | FR-15; null = working tree |
| `expandedContext: Map<string, number>` | per-file `context` override (FR-26) |
| `draft: { subject, body, amend }` | commit form draft, survives `Esc`, cleared on success |
| `commits: DiffCommitList \| null`, `commitsExpanded: boolean` | FR-13/14 |

Derived, memoized: the tree; the visible rail row list; the **body row model** (per-file header +
rows + fold rows) and its **prefix-sum offset table** (FR-22); the roll-up mark per directory; the
manifest and stays-behind line.

Removed: `selectedPath` and `deselected` (both from `diff-view`/`diff-navigator`).

## 7. Edge cases & errors

- **Not a git repo / clean tree** — the existing empty states, unchanged. The commit block renders
  its closed strip disabled; the COMMITS block renders FR-17.
- **`getFileDiff` fails for one file** — that file's body is replaced by the existing inline
  `GIT_ERROR` row under its header. The rest of the scroll, the rail and the commit block are
  unaffected.
- **`listCommits` fails** — the COMMITS block shows one dim error line. Never gates the tab.
- **Binary / deleted / renamed / untracked** — the existing `diff-view` placeholder renders under the
  header. No intraline pass, no context folds, no `↗ editor` for a deleted file.
- **A path leaves the summary** (committed, reverted, stashed) — dropped from `inCommit`, `read`,
  `collapsed` and the body. If it was the cursor, the cursor moves to the next visible row.
- **A path enters the summary** while the tab is open — appended in tree order, checked (FR-1
  seeding), unread. The scroll position is preserved by anchoring to the top visible file, not the
  pixel offset.
- **Every file read, then a file changes on disk** — that file becomes unread again (it left and
  re-entered the summary).
- **A 6,000-line file** — starts collapsed (FR-23); expanding it is allowed and windowed.
- **A commit is selected and the working tree changes** — `diff.changed` refreshes the summary but
  **not** the body: a read-only commit view is a snapshot and does not move under the user. The strip
  gains `working tree changed` and returning re-fetches.
- **Amend on a branch with no commits** — `DIFF_NOTHING_TO_AMEND`, shown inline in the form.
- **Commit with a subject over 50 chars** — allowed; the meter is a warning, not a gate (FR-35).
- **Session switch / pane switch** — every entry in §6 is per session; the tab rebuilds from that
  session's own state.
- **Worktree sessions** — the rail's branch, base and commit list come from that worktree's own HEAD,
  which `repo_info` already resolves (`session-worktree`).
- **Filter hides checked files** — the commit still takes all of them and the form says so, carried
  over from `diff-navigator` FR-25/FR-26.

## 8. Design brief

> full brief: `specs/design/diff-review.md`
> mock: `Francois Redesign.dc.html` turns **14b** (body, commit form, commits block) and **14d**
> (tree rail). 14a and 14c are **rejected alternatives** — do not implement from them, except the
> commit form, which 14b takes from 14c verbatim.

Four regions, flush and full-bleed per design turn 9a: 34px top bar (`#12161c`), a rail (`#12161c`)
beside the body (`#0a0b0e`), and the commit block (`#12161c`) across the foot. **One acid per view**
— olive `#9cb45f` marks the rail cursor (a 2px inset left rule + `#1b2029` fill) and the checked
checkbox, and nothing else. Read is **green-dim, never acid** (`#5f8a6d` tick, row text drops to
`#6b7385`). File headers are `#101319` expanded, `#0e1116` collapsed — a tonal step, no rule.
Directory rows carry a **file count** in `#414958`, never a `+/−` sum. Tree indent is 20px per level
with a `#1a1f27` left rule. Status letters are toned by kind (`A` `#7fa07a`, `M` `#9aa2b1`, `D`/`U`
per the mock). The commit button is the one filled control (`#2b3a16` / `#d6fa7e`); Cancel is
`#1f242d`. Per-feature CSS in `src/features/diff/diff.css`, BEM-lite, no inline `style` except
runtime-computed offsets (the window's `transform`/`height`). Icons `lucide-react`; the disclosure
caret, `⌗`/`▤`, `⋯` and `⊟` stay typographic glyphs. Desktop only; the rail is the shrinking column
and the body has a floor, per `resizable-sidebar`.

## 9. Acceptance criteria

- [ ] A 7-file working tree renders **one** scroll containing all 7 files; scrolling from top to
      bottom never issues a viewport switch and leaves `7/7 read` (FR-18, FR-28, FR-32).
- [ ] Ticking the `src/features/diff` directory checkbox checks its 4 files in both the rail and
      their body headers; unticking one turns the directory mark to a dash (FR-7, FR-20).
- [ ] Clicking a rail file row scrolls the body to that file's sticky header and changes no other
      state — no file is unloaded, nothing is marked (FR-8).
- [ ] The COMMITS block lists the commits ahead of the base with HEAD tagged; 3 rows plus an
      `<n> more · <base>` expander; clicking a row renders that commit's diff with **no** checkbox
      anywhere and a `back to working tree` strip that returns (FR-13, FR-14, FR-15).
- [ ] ⌥-clicking HEAD opens the form with `amend` ticked and the subject/body pre-filled; unticking
      does not clear typed text; a pushed HEAD shows the `--warn` line and still commits (FR-16,
      FR-38, FR-39).
- [ ] `c` opens the form; with 5 of 7 checked it reads `5 of 7 files`, shows the 3-file manifest plus
      `+ 2 more`, and names the 2 files that stay behind; `⌘⏎` commits exactly the 5 (FR-35, FR-36,
      FR-37).
- [ ] `grep -r stageAll` returns nothing in `contract/`, `src/` or `src-tauri/`, and `s` is unbound
      in the DIFF tab (FR-41, FR-43).
- [ ] A file with a 1,200-line diff starts collapsed with `1200 lines · expand`; expanding it keeps
      every row 21px and every header 32px, and scrolling the full document stays smooth (FR-22,
      FR-23).
- [ ] A `⋯ 46 unchanged lines` row appears between two hunks with the count derived from the hunk
      headers; clicking it removes every fold row in that file (FR-26).
- [ ] `↗ editor` on a file header opens that exact file, not the session directory (FR-27, FR-44).
- [ ] `↑`/`↓`/`→`/`←` traverse the rail, `Enter` on a file jumps the body, `Space` toggles the
      checkbox, `/` filters and `Esc` unwinds form → filter (FR-40, FR-41).
- [ ] `npx tsc --noEmit`, `npm test` and `cargo test` are green. Unit tests cover: the prefix-sum
      offset table and cross-file window slice, the directory roll-up write, read-marking from a
      scroll offset, the fold-row count arithmetic, the manifest/stays-behind strings, and the
      commit-argv builder (amend × paths × body) as a serde round-trip.
- [ ] `specs/diff-view.md` and `specs/diff-navigator.md` carry their FR-45 amendments.

## Remediation
