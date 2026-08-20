# DESIGN BRIEF — Diff tab rework, one scroll + tree rail (`diff-review`)

> `design.direction` is **design-to-code**: the mock already exists and is authoritative. This brief
> does not commission new mockups — it names which turns to build from, the deltas the spec
> deliberately takes against them, and the tone rules that must hold. §8 of `specs/diff-review.md` is
> its summary.

**Goal:** read a whole changeset as one document, know what you have already read, and commit an
explicit set of files without ever wondering what is staged.

**Source of truth:** `Francois Redesign.dc.html`, turn **14** ("A review surface, not a file
browser") — <https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html>

- **14b — "One scroll, every file"**: the body, the file headers, the commits block, the commit form.
- **14d — "The rail as a tree"**: the rail, replacing 14b's flat 196px rail.
- **14a** (directory headers) and **14c** (split view, per-hunk staging) are **rejected
  alternatives**. Do not build from them — with one exception: 14b's commit form *is* 14c's, and
  14c's rendering of it is the fuller reference.

**Design system:** the existing UI kit (`src/ui/`) and tokens (`src/styles.css`), design turn 9a
(flat) — no 1px strokes, no shadows in flow, separation by tonal step. Desktop only; this project has
no mobile surface.

## Screens / views

Only one screen: **main pane tab DIFF**. Four regions, flush, full-bleed, no window padding.

- **Top bar** (34px, `#12161c`) — `⑂ <branch>` · `vs HEAD` · spacer · `+296` `−171` ·
  `⊟ collapse read` · `⟳`.
  - States: detached (`⑂ a1f9c2 (detached)`) · viewing a commit (`vs 7b30de^`) · clean tree (counts
    absent).
- **Rail** (`#12161c`, default 220px, resizable per `resizable-sidebar`) — header, tree, COMMITS
  block, read foot bar.
  - **Header**: checked-all checkbox · `IN COMMIT` (10px, `.12em` tracking, `#8b93a3`) · `5/7` in
    olive · spacer · the `⌗ / ▤` segmented toggle (`#1c212a` track, `#2a323e` active).
    Pressing `/` replaces the header's contents with the filter input; `Esc` restores it.
  - **Tree**: 26px rows, 20px indent per level with a `#1a1f27` left rule. Directory row = caret
    (`▾`/`▸`, 8px, `#6b7385`) · checkbox · label (JetBrains Mono 11.5px, `#c3c9d4`) · file count
    (`#414958`). File row = checkbox · status letter (9.5px mono, 9px wide) · name (IBM Plex 12px) ·
    read tick · `+n` `−n`.
  - **COMMITS**: `#0f1217`, collapsible header (`COMMITS` · `4 ahead of main`), 24px rows of
    `a1f9c2` (`#6b7385`) · subject (`#c3c9d4`) · `HEAD` pill (`#1c212a`) or age (`#414958`), then a
    hairline + `1 more · main` expander.
  - **Foot bar**: `#0b0d11`, a 3px progress track (`#1f242d` / `#5f8a6d`) and `3/7 read`.
  - States: empty tree · filter with no match (`no file matches "<q>"`) · no commits ahead ·
    `listCommits` failed.
- **Body** (`#0a0b0e`) — one scroll of per-file blocks.
  - **File header** (32px, sticky): caret · status letter · `src/features/diff/` in `#6b7385` +
    `DiffListBody.tsx` in `#f2f4f8` · `+88` `−140` · spacer · `↗ editor` · `☑ in commit` **labelled
    in words**. Expanded surface `#101319`; collapsed drops to `#0e1116` with the path and counts
    stepping down a tone.
  - **Diff rows**: unchanged from `diff-view` + `diff-navigator` — 38px gutter, 12px marker column,
    `ROW_H = 21`, hunk header rows on `#14171d` with the header text in olive, intraline spans as a
    deeper tint of the row's own family.
  - **Context fold row**: `⋯ 46 unchanged lines`, indented past the gutter, on `#0d1014`, hovering
    to olive.
  - States per file: expanded · collapsed · read · big-file guard (`1200 lines · expand`) · binary
    placeholder · `GIT_ERROR` row · read-only (commit view: no checkbox).
- **Commit block** (`#12161c`, full width, foot of the pane).
  - **Closed**: one 26px strip — `5 of 7 in commit` · spacer · `[c] commit`.
  - **Open**: header row (`COMMIT` olive · `5 of 7 files` · read progress + `3 of 7 read` · spacer ·
    `☐ amend last commit` · `esc`), then the subject field (`#0f1217`, olive `›` prompt, blinking
    caret, `37/50` meter at the right), then a row pairing the extended-description textarea with a
    252px manifest column, then the stays-behind line and the buttons.
  - Buttons: `Cancel` (`#1f242d` / `#c3c9d4`) and `Commit 5 files` (`#2b3a16` / `#d6fa7e`) with a
    `⌘⏎` hint. The commit button is the **only** filled control in the tab.
  - States: closed · open · nothing selected (button disabled, `nothing selected`) · blank subject
    (disabled) · over 50 chars (meter in `--warn`, not blocked) · amend on a pushed HEAD (`--warn`
    line) · commit failed (inline error above the buttons).

## Flows

1. Open DIFF → tree rail, body scrolled to top, first file expanded, `0/7 read`.
2. Scroll down → each file's rail row dims and gains its tick as its last line leaves the viewport;
   the foot bar fills. **Nothing collapses on its own.**
3. Click a rail row → the body scrolls that file's header to the top of the container and it sticks.
4. Tick a directory checkbox → every descendant file's checkbox and every matching body header flip
   together; untick one child → the directory shows a dash.
5. Press `c` → the commit block expands upward across the pane; type a subject; `⌘⏎` commits; the
   block closes, the summary and the commits list refresh.
6. Click a COMMITS row → the body becomes that commit's diff, every checkbox disappears, and a
   `viewing 7b30de · back to working tree` strip replaces the commit block.
7. ⌥-click the `HEAD` row → the commit form opens with `amend` ticked and pre-filled; the body stays
   on the working tree.

## Responsive

Desktop only — no mobile or tablet breakpoint exists in this app.

- The **rail** is the shrinking column and the **body** has a floor (`resizable-sidebar`); below the
  floor the rail collapses rather than the body cropping.
- The **file header** is the only element allowed to crop: the `<dir>/` prefix ellipsises first, the
  basename never. `↗ editor` drops before `in commit`.
- The **commit form**'s manifest column (252px) collapses under the description textarea below
  ~700px of pane width.
- Under ~700px the COMMITS block collapses to its header only.

## Data shown

Every value below comes from spec §5 and nowhere else.

| on screen | field |
|---|---|
| `⑂ feat/diff-review` | `DiffSummary.branch`, else `headShort` + `(detached)` |
| `+296 −171` | `DiffSummary.totalAdd` / `totalDel` |
| tree row label, indent | `DiffFileSummary.dir` / `name` / `path` |
| status letter | `DiffFileSummary.status` → `M A D U R` |
| `+88` `−140` | `DiffFileSummary.additions` / `deletions` |
| directory `4` | count of descendant files — **never** a `+/−` sum |
| `a1f9c2`, subject, `HEAD`, `4h` | `DiffCommitSummary.shortHash` / `subject` / `isHead` / `authoredAt` |
| `4 ahead of main` | `commits.length` + `DiffCommitList.baseBranch` |
| pushed warning | `DiffCommitSummary.pushed` |
| `⋯ 46 unchanged lines` | derived from consecutive `DiffHunk.header` line arithmetic |
| `1200 lines · expand` | rendered row count of that file's `FileDiff` |
| `5/7`, `3/7 read` | frontend `inCommit` / `read` (spec §6) — not on the wire |

## Notes / constraints

- **One acid per view.** Olive `#9cb45f` marks the rail **cursor** and the **checked** checkbox, and
  nothing else. Read is green-dim (`#5f8a6d`), never acid. The hunk header keeps its olive text — it
  is typography, not a marker.
- **Read is an annotation, never a resize.** Dimming and the tick are the whole treatment; a file
  becoming read must not collapse, reorder or unmount anything (spec FR-30). This is the one
  deliberate departure from 14b's prose, which says a read file "collapses behind you".
- **Two more deliberate departures from the mock**, both recorded in the spec: the `src-tauri/src ·
  2 ign` row is not built (FR-11 — the summary carries no ignored-file data), and `⇥ next unread` is
  dropped (`⇥` is the focus key).
- **Row geometry is load-bearing.** `ROW_H = 21` and the 32px header height feed the cross-file
  window's prefix-sum offset table (FR-22). No padding, border, margin or font-size change on a diff
  row — background and colour only.
- **Copy is English, lowercase, terse.** `in commit`, `3 of 7 read`, `nothing selected`,
  `diff-view.md and review-icons.png stay in the working tree`, `already pushed — amending needs a
  force-push`. Never sentence-case a control label.
- **Styling** is per-feature CSS + classNames in `src/features/diff/diff.css`, BEM-lite. Inline
  `style` only for the window's runtime-computed `transform`/`height`.
- **Icons** are `lucide-react` (`ExternalLink`, `RefreshCw`, `ChevronsDownUp`). The disclosure caret
  (`▾`/`▸`), `⌗`, `▤`, `⋯`, `⊟`, `✓`, `⑂` and `›` stay typographic glyphs per PIPELINE.md.
- **Font weight ceiling is 600** (decision 2026-08-04 `ui`).
- **Accessibility**: the checkbox column is real `role="checkbox"` with `aria-checked="mixed"` on a
  dashed directory; the rail's cursor is `aria-activedescendant`; the sticky file header carries
  `aria-expanded`. The tree's decorative `role="tree"` gap parked in `specs/refactor-backlog.md`
  should be closed here rather than re-parked.
