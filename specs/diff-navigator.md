---
id: diff-navigator
title: Diff navigator (folder tree, filter) + intraline word diff
status: shipped
branch: feat/diff-navigator
created: 2026-08-18
depends_on: [diff-view, app-shell]
loop_pass: 0
loop_phase:
reviewed_base: 206f50dcdab809934a0667a3c8425d07b60b80cb
reviewed_digest: 67a87364874c2468
design_files: []
---

# Diff navigator (folder tree, filter) + intraline word diff

## 1. Summary

The DIFF tab's file list renders only `file.name`, eliding `dir` into a hover `title` — so three
`mod.rs` rows are indistinguishable, and a 30-file changeset is an undifferentiated wall with no
sense of progress. This feature replaces that flat list with a **collapsible folder tree** carrying a
**filter box**, and adds **dependency-free word-level intraline
emphasis** to the diff body so a one-character rename no longer reads as a whole red line beside a
whole green one. It is an **amendment to `diff-view`**, not a new domain: **zero contract change,
zero Rust**, entirely inside `src/features/diff/`.

## 2. Goals & non-goals

- **Goals**
  - A folder tree derived from `DiffFileSummary.dir`, with **single-child chains collapsed** to one row.
  - A filter box that narrows rows by path substring, reachable with `/`.
  - A read-only tri-state roll-up mark on folder rows.
  - Tree keyboard traversal replacing the flat `←`/`→` file cycle.
  - Pure, unit-testable word-level intraline diffing with **no new dependency**.
- **Non-goals**
  - **Syntax highlighting / any tokenizer.** Declined: Shiki/Prism/hljs each add bundle weight to a
    package whose selling point is `npm i -g francois`, and each parses untrusted repo content
    (including large minified files) inside the webview. Stays a `diff-view` §2 non-goal.
  - **Multi-file continuous-scroll body.** The body still renders exactly one file. *(**Superseded by
    `diff-review`** FR-18: the body became one scroll containing every changed file.)*
  - **Side-by-side view.** Unchanged non-goal.
  - **Any new git verb** — no discard, revert, stage-hunk, unstage. `stageAll` + `commit(paths)`
    remain the only mutations; the rest belongs to SHELL. *(`stageAll` was since deleted by
    `diff-review` FR-43; `commit(paths)` — plus amend — is the only mutation now.)*
  - **Folder-level checkboxes.** The selection model stays a flat leaf `deselected: Set<string>`;
    folder marks are display-only and never write. *(**Superseded by `diff-review`** FR-7: directory
    checkboxes are writable and the model became `inCommit: Set<string>`.)*
  - **Viewed/read-state dimming.** Dropped after first use: dimming rows the user had merely
    clicked through obscured the changeset more than it tracked progress. *(**Superseded by
    `diff-review`** FR-28: read is inferred from scroll rather than from a click, which is what makes
    it track progress.)*
  - **Persisting fold-state across restarts.**
  - **Windowing the tree.** Accepted limit (FR-3): a 500-file changeset renders 500+ rows unwindowed,
    as today. Folds are the mitigation.
  - **Any backend/core change.**

## 3. User stories / flows

1. **Read the changeset.** DIFF opens; the left column is a tree. `src/features/diff` renders as one
   row (chain-collapsed), its three changed files nested under it. The first *file* in tree order is
   selected and its diff loads.
2. **Fold away what you've done.** Click a folder row (or press `←` on it): it collapses; its
   children vanish from the tree; its roll-up mark still shows whether its children are checked.
3. **Find a file.** Press `/`; the filter box focuses; typing `middleware` hides non-matching rows
   and expands every folder on a matching path. `Esc` clears the filter and returns focus to the tree.
4. **Traverse with the keyboard.** `↑`/`↓` move the cursor through visible rows, folders included.
   `→` expands a collapsed folder or steps into an expanded one; `←` collapses an expanded folder or
   hops to the parent. Landing on a folder never blanks the body — it keeps showing the last
   selected file.
5. **Read what actually changed.** A renamed identifier shows the del row and the add row with only
   the differing words emphasized, in a deeper tint of each row's own add/del colour.
6. **Commit under a filter.** Files are checked for commit; a filter hides three of them. The footer
   reads `commit 7 files · 3 hidden by filter` — the commit still takes all 7, and says so.

## 4. Functional requirements

**Tree**

- **FR-1 (build).** Derive the tree frontend-side from `DiffSummary.files` (already sorted by `path`
  ascending) using each file's existing `dir` / `name` / `path`. Tree order is that path order.
  Within a folder, subfolders sort before files, each alphabetically.
- **FR-2 (chain collapse).** A folder node whose only child is a folder merges with that child; the
  merged row's label is the joined segments (`features/diff`). Applied transitively, so an
  arbitrarily deep single-child chain is one row. **This is load-bearing** — without it the tree is a
  regression against the flat list on the common 3–15-file changeset.
- **FR-3 (no windowing).** Tree rows render unwindowed. The known limit is stated, not mitigated.
- **FR-4 (fold state).** Folders start expanded. Fold state is a `Set` of folder keys held in
  frontend memory, **keyed per session**, and is not persisted.
- **FR-5 (roll-up mark).** ~~A folder row shows a tri-state mark in the checkbox column reflecting its
  descendant files' checked state (all → checked, none → empty, mixed → dash). It is rendered dimmed,
  has **no click handler**, and never writes to `deselected`.~~ **Superseded by `diff-review` FR-7**:
  the mark stayed tri-state, but the checkbox became **writable** — clicking it sets every descendant
  file — and `deselected` was replaced by `inCommit`.
- **FR-6 (selection is leaf-only).** Only a file row can be the selected path. Clicking or pressing
  `Enter` on a folder row toggles its fold and changes nothing else.
- **FR-7 (cursor vs selection).** The keyboard cursor may sit on a folder row; the diff body keeps
  rendering the last selected **file** and never blanks.

**Filter**

- **FR-8 (matching).** Case-insensitive substring match against the file's full `path`. A file row is
  visible iff it matches; a folder row is visible iff any descendant file matches.
- **FR-9 (auto-expand).** While the filter is non-empty, fold state is **ignored** and every visible
  folder renders expanded. Clearing the filter restores the stored fold state unchanged.
- **FR-10 (keys).** `/` focuses the filter input. `Esc` while it has focus clears the query and
  returns focus to the tree. `/` is scoped to `mainTab === 'diff'` and is inert while the commit bar
  is open or any other text input has focus — the same guard `s` and `c` already use.
- **FR-11 (empty result).** A non-empty filter matching nothing renders an inline
  `no file matches "<query>"` row in the tree column. The body is untouched.
- **FR-12 (filter never mutates).** Filtering changes visibility only — never `deselected`, never
  the selected path, never fold state.

**Keyboard**

- **FR-17 (replaces the flat cycle).** The `←`/`→` flat file cycle in `useDiffKeyboard.ts` is
  **removed** and replaced by tree traversal. `s`, `c`, `Esc`, `Enter` semantics are unchanged.
- **FR-18 (traversal).** With DIFF visible and the main pane focused: `↑`/`↓` move the cursor one
  visible row. `→` on a collapsed folder expands it; on an expanded folder moves to its first child;
  on a file does nothing. `←` on an expanded folder collapses it; on a collapsed folder or a file
  moves the cursor to its parent folder row (no-op at the root).
- **FR-19 (activate).** `Enter` on a file selects it (loads its diff); on a folder toggles the fold.
  The cursor auto-scrolls into view on every move.

**Intraline word diff**

- **FR-20 (pairing).** Within a hunk, find each maximal run of consecutive `del` lines immediately
  followed by a maximal run of consecutive `add` lines. If the two runs have **equal length N**, pair
  `del[i]` with `add[i]`. Runs of unequal length produce **no emphasis** for any of their lines.
- **FR-21 (similarity floor).** For a pair, compute the common character prefix length `p` and common
  suffix length `s` (non-overlapping). If `(p + s) / max(len(del), len(add)) < 0.5`, the pair gets
  **no emphasis** — both lines render plain. This is what stops two unrelated rewritten lines from
  being confetti'd.
- **FR-22 (span computation).** For a surviving pair, trim the common prefix and suffix, tokenize
  each remaining middle into words (maximal `[A-Za-z0-9_]+` runs; every other character is its own
  token), take the LCS of the two token sequences, and emit emphasis spans over the tokens **not** in
  the LCS — deletions on the `del` line, insertions on the `add` line. Trimmed prefix/suffix are
  always unemphasized.
- **FR-23 (pure + tested).** The computation is a pure exported function taking the hunk's lines and
  returning per-line spans. No new dependency. Unit-tested for: equal-run pairing, unequal-run
  bail-out, the similarity floor, prefix/suffix-only edits, whole-line rewrites, empty lines, and a
  line that is pure whitespace change.
- **FR-24 (row height is invariant).** Spans are inline `<span>`s inside the existing
  `diff-row__text`, with `white-space: pre` preserved and **no** padding, border, margin, font-size or
  font-family change — background-colour and colour only. `ROW_H = 21` and the body's windowing math
  must remain exactly correct.

**Footer**

- **FR-25 (commit counts everything).** The footer's file count and the `commit(paths)` payload
  always cover **all** checked files, never the filtered subset.
- **FR-26 (hidden warning).** When a filter is active and `k > 0` checked files are hidden by it, the
  footer appends `· <k> hidden by filter` in `--warn`. Nothing is blocked.

**Amendment to `diff-view`**

- **FR-27.** In the same change, fix `specs/diff-view.md`'s internal contradiction: §1's
  "syntax-tinted unified diff" becomes "kind-tinted" (the add/del/ctx row tinting it actually means),
  and §2's syntax-highlighting non-goal records *why* it was declined (bundle weight in an
  `npm i -g` package + a third-party grammar engine parsing untrusted repo content in the webview).
  §2's "word-level intraline diffing" non-goal is amended to point at this spec.

## 5. API contract

**No contract change. `contract/diff-view.ts` is not edited, and no `contract/diff-navigator.ts` is
created.** This feature is pure `src/features/diff/`.

- `DiffFileSummary` already carries `path`, `dir`, `name` — the tree is derived entirely from
  `DiffSummary.files`.
- `DiffLine` is **not** extended. Intraline spans are computed in the view layer from the existing
  `DiffHunk` / `DiffLine` payload and never cross IPC.
- Consumed unchanged: `francois:diff:getSummary`, `francois:diff:getFileDiff`,
  `francois:diff:stageAll`, `francois:diff:commit` (with the existing `paths: string[]`), and the
  `diff.changed` member of `DiffEvent`.

Frontend-internal types (in `src/features/diff/`, **not** the contract):

```ts
export type DiffTreeNode =
  | { kind: 'folder'; key: string; label: string; children: DiffTreeNode[] }
  | { kind: 'file'; key: string; file: DiffFileSummary };
// folder.key = full joined path of the collapsed chain; file.key = file.path

export interface IntralineSpan { start: number; end: number; emphasis: boolean } // char offsets into DiffLine.text
```

## 6. Data & state

Frontend only; all in memory, all per session, none persisted.

- `folded: Set<string>` — collapsed folder keys (FR-4).
- `filter: string` — the filter query (FR-8).
- `cursorKey: string | null` — the keyboard cursor's row key; distinct from `selectedPath`, which
  stays the existing leaf-only selection (FR-7).

Derived (memoized): the tree from `summary.files`; the flattened **visible row list** from the tree ×
`folded` × `filter` — the single source for both rendering and `↑`/`↓` traversal; intraline spans per
rendered file diff.

Unchanged: `deselected`, `selectedPath`, `summary`, `fileDiff` and every existing core-side state.

## 7. Edge cases & errors

- **Session switch** — `folded`, `filter` and `cursorKey` are per session; switching resets
  the view to that session's own state (all expanded, no filter).
- **All files at repo root** (`dir === ''`) — no folder rows at all; the tree degenerates to today's
  flat list. No empty root row is rendered.
- **`getFileDiff` fails** — the existing inline `GIT_ERROR` row still replaces the body; the tree
  stays intact. The failure never gates the footer's `[s]`/`[c]` actions (see `diff-view` FR-22/23).
- **Binary file** — the placeholder row renders as today; no intraline pass runs on it.
- **Selected file filtered out** — it stays selected and its diff stays in the body; only its tree row
  is hidden (FR-12).
- **Selected file vanishes from the summary** — existing `diff-view` behaviour is unchanged.
- **Cursor row becomes invisible** (its folder collapsed, or a filter hid it) — the cursor moves to
  the nearest still-visible ancestor, or to the first visible row if there is none.
- **Working tree clean / not a git repo** — the tree column and the filter box render nothing; the
  existing empty states are unchanged.
- **Del/add run split across hunks** — hunk boundaries end a run; no pairing across hunks (FR-20).
- **A pair of identical lines** — `p + s` covers the whole line, LCS middle is empty, so no spans are
  emitted; the rows render plain.

## 8. Design brief

> full brief: `specs/design/diff-navigator.md`

The DIFF tab's left column becomes a filter box above a folder tree; the right column is the
unchanged windowed diff body, now with intraline spans. **Tone discipline (one acid per view):** the
selected row keeps the existing acid marker and is the *only* acid in the pane. Folder rows are
chrome — label `--text-muted`, a `▸`/`▾` disclosure caret, and the dimmed non-interactive roll-up
mark. Filter matches emphasize with `--text-bright` and weight (≤ 600), never colour. Intraline emphasis is a deeper tint of the row's own add/del
family (`--success` / `--error`), never acid, never a border or padding (FR-24). Hidden-checked
warning in `--warn`. Desktop only; per-feature CSS in `src/features/diff/diff.css`, BEM-lite, no
inline `style` except runtime-computed values. Icons from `lucide-react`; the disclosure caret stays
a typographic glyph per PIPELINE.md.

## 9. Acceptance criteria

- [x] A changeset touching `src/features/diff/a.tsx` and `src/features/diff/b.tsx` renders **one**
      `src/features/diff` folder row with two children (FR-1, FR-2).
- [ ] Clicking a folder row collapses it; its files disappear; the selected file's diff still shows
      (FR-6, FR-7).
- [ ] `/` focuses the filter; typing narrows the tree and auto-expands matching folders; `Esc` clears
      it and restores the previous fold state exactly (FR-8, FR-9, FR-10).
- [ ] A filter matching nothing shows `no file matches "<query>"` and leaves the body untouched (FR-11).
- [ ] Clicking through several files never disables the footer's `[s] stage all` / `[c] commit`
      hints — only a stage/commit mutation or a summary reload gates them (`diff-view` FR-22/23).
- [x] A folder whose children are partly checked shows a dash mark; clicking that mark does nothing
      (FR-5).
- [ ] `↑`/`↓` traverse folders and files; `→`/`←` expand/collapse and hop to parent; the old flat
      `←`/`→` cycle is gone (FR-17, FR-18, FR-19).
- [x] Renaming one identifier on a line emphasizes only the changed words on both rows; two unrelated
      rewritten lines get no emphasis; unequal del/add run lengths get no emphasis (FR-20, FR-21, FR-22).
- [ ] Diff body rows are still exactly 21px tall with intraline spans present, and scrolling a 5k-line
      diff is unchanged (FR-24).
- [ ] With 7 files checked and a filter hiding 3, the footer reads the 7-file count plus
      `· 3 hidden by filter`, and committing takes all 7 (FR-25, FR-26).
- [x] `npx tsc --noEmit` and `npm test` are green; unit tests cover tree build, chain collapse, the
      visible-row flattening, filter matching, and every FR-23 intraline case.
- [x] `contract/` is untouched and `src-tauri/` is untouched by this feature's diff.
- [x] `specs/diff-view.md` §1 no longer says "syntax-tinted" and §2 records why the tokenizer was
      declined (FR-27).

## Remediation

- 2026-08-18 — review #2, 4 findings (0 blocking, verdict SHIP). Both MEDIUMs fixed: initial
  selection now uses `firstFilePathInTreeOrder` (tree order, not `files[0]` — spec §3 story 1), and
  the `/` filter hint now hides on focus per the design brief. One LOW (indentation) fixed inline;
  the remaining LOW (decorative `role="tree"` ARIA) parked in `specs/refactor-backlog.md`.
- 2026-08-18 — review #1, 5 findings, all fixed. Auto-scroll added (`DiffTree.tsx` ref +
  `scrollIntoView`), stale-diff viewed-mark race closed (`useDiffFeed` now exposes `fileDiffPath`),
  FR-13/FR-14 logic extracted to pure functions and covered by new `useDiffNavigator.test.ts` (10
  cases), unused `tree`/`folded` dropped from the returned `DiffNavigator`, redundant `Set` re-wrap
  in `onCursorRight`/`onCursorLeft` removed.
