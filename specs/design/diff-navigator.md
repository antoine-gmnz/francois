# DESIGN BRIEF — Diff navigator (`diff-navigator`)

> The "spec return". Standalone copy of `specs/diff-navigator.md` §8. Francois is a **desktop
> Tauri app** — there is no mobile breakpoint; the responsive story is pane resize, not viewport.
> Design system: `Francois Design System v2.dc.html` + `Francois Redesign.dc.html` (turn 4 is the
> current shell); tokens in `src/styles.css`; UI kit in `src/ui/`.

**Goal:** make a 30-file changeset reviewable — find the file, see how much is left, and read what
actually changed on a line.

## Screens / views

Exactly one screen: the **DIFF tab body** of main pane `[2]` (`src/features/diff/DiffListBody.tsx`).
Two columns; the right column's chrome is unchanged.

### Left column — the navigator (replaces the flat file list)

- **Filter box** (new, pinned at the top of the column, above the header row)
  - A single-line input, `JetBrains Mono`, placeholder `filter files…`, with a `lucide-react`
    `Search` icon at 12px in `--text-faint`.
  - Idle: border `--border`, bg `--bg-elevated`, text `--text-2`.
  - Focused: border `--accent-soft-edge`, bg `--accent-soft-bg`. **No acid fill** — the accent slot
    belongs to the selected row.
  - Trailing keycap hint `/` in `--text-faint` when unfocused; it disappears on focus.
  - States: empty (placeholder) · typing · no-match (see below).
- **Header row** (existing `diff-filelist__header`, unchanged): select-all checkbox +
  `N of M selected`.
- **Folder row** (new)
  - Anatomy, left→right: indent guide (one 12px step per depth) · disclosure caret `▾` expanded /
    `▸` collapsed, `--text-faint` · roll-up mark · label.
  - Label is the **chain-collapsed** path segment(s), e.g. `src/features/diff` as one row.
    Colour `--text-muted`, weight 400. The final segment may render at `--text-dim` to give the row
    a readable tail; nothing brighter.
  - **Roll-up mark**: the same box glyph as the file checkbox, at ~55% opacity, no hover state, no
    pointer cursor. Checked = `✓`, mixed = dash, none = hollow. It is a *readout*, never a control —
    it must not look pressable.
  - Hover: bg `--bg-hover`. Cursor row (keyboard): a 1px `--border-strong` inset outline. Folder rows
    never take the acid marker.
- **File row** (existing `FileRow`, restyled)
  - Anatomy: indent guide · interactive checkbox · status glyph (`M`/`A`/`D`/`U`/`R`, existing
    colours) · **basename only** (the parent folder row now carries the directory) · `+N −M` counts.
  - Selected: unchanged — bg `#20222a`, left acid marker, bright name. **The only acid in the pane.**
  - **Filter match**: the matched substring inside the basename renders `--text-bright` at weight 600
    (the design-system ceiling). No background pill, no colour change, no acid.
- **No-match state**: a single non-interactive row reading `no file matches "<query>"` in
  `--text-faint`, italic-free, at the tree's normal row height.
- **Root-only changeset**: no folder rows at all — the column degenerates to today's flat list with
  no empty root row and no wasted indent.

### Right column — the diff body (chrome unchanged)

- **Intraline emphasis** (new): inline `<span>`s inside the existing `diff-row__text`.
  - On a `del` row: bg `color-mix(in srgb, var(--error) 22%, transparent)`, text `--error-bright`.
  - On an `add` row: bg `color-mix(in srgb, var(--success) 22%, transparent)`, text
    `--success-bright`.
  - **Hard constraint:** background-colour and colour only. No padding, border, margin, font-size,
    font-family or line-height change, and `white-space: pre` is preserved — the body is virtualized
    on a fixed 21px row and any of those would break the scroll math.

### Footer (existing commit bar)

- The stat line always counts **all** checked files. When a filter hides `k` checked files it appends
  ` · <k> hidden by filter` in `--warn` (`#d4c46f`). Plain text, no icon, no badge — a statement, not
  an alarm. Nothing is blocked.

## Flows

1. Open DIFF → tree renders expanded, first file in tree order selected, its diff loads.
2. `↑`/`↓` move a cursor outline through visible rows (folders included). `→` expands a collapsed
   folder or steps into an expanded one; `←` collapses or hops to the parent. The body never blanks
   while the cursor sits on a folder — it keeps the last selected file.
3. `Enter` on a file selects it; on a folder toggles the fold.
4. `/` focuses the filter; typing narrows rows and force-expands every folder on a matching path;
   `Esc` clears and returns focus to the tree, restoring the previous fold state exactly.

## Responsive

Desktop only. The navigator column keeps its current width behaviour; deep indentation must degrade
by **truncating the folder label with a middle ellipsis**, never by wrapping (rows are fixed-height).
File basenames truncate with a trailing ellipsis and keep their `+N −M` counts pinned right.

## Data shown

From the existing `DiffSummary.files` — nothing new crosses IPC:
`path` (tree structure + filter matching), `dir` (folder rows), `name` (file row label),
`status` (glyph), `additions` / `deletions` (counts). Intraline spans are computed in the view layer
from the existing `DiffHunk` / `DiffLine` payload.

## Notes / constraints

- **One acid per view.** Four new tone decisions land in this pane; only the selected file row is
  acid. Folder rows are chrome, filter matches use weight, intraline uses the
  row's own add/del family.
- **Weight ceiling 600.** Never 700 — it renders faux-bold off-system.
- Copy in English, lowercase terminal register (`filter files…`, `no file matches "…"`,
  `3 hidden by filter`).
- Icons from `lucide-react` inheriting `currentColor`; the `▸`/`▾` disclosure carets stay typographic
  glyphs per `PIPELINE.md` §Code layout.
- Styling is per-feature CSS in `src/features/diff/diff.css`, BEM-lite; inline `style` only for
  runtime-computed values (the depth indent).
- Accessibility: the roll-up mark is decorative (`aria-hidden`) since folders carry no selection
  semantics; folder rows expose `aria-expanded`; the cursor row is the tree's `aria-activedescendant`.
