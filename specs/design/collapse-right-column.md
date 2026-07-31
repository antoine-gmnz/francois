# DESIGN BRIEF — Collapsible right-column panels (`collapse-right-column`)

**Goal:** let the user fold any right-column card down to its header row so the cards they are
actually reading get the freed vertical space.

**Design system:** the existing UI kit (`src/`, tokens in `src/styles.css`). Visual source of truth:
`Claude Terminal.dc.html` + `screenshots/`. This is a **desktop app** (Tauri window), not a responsive
web page — the mock's `grid-template-columns: 276px 1fr 296px` shell is fixed.

## Screens / views

There is one screen: the app shell. Only the **right column** (`.app-col-right`, 296px, 12px gap,
three stacked cards) changes.

- **Right-column card — expanded (default)** — unchanged from today.
  - Elements: header row (`.panel-header`: uppercase 11.5px `--text-hint` title left, mono 10.5px
    `--text-dim` `N · [n]` right, 1px `--border` bottom rule) + scrollable body + `HintBar`.
  - New: a leading chevron `▾` in `--text-dim`, 6px before the title; the header row takes
    `cursor: pointer`.
  - States: focused (title flips to `--accent`, card border to `--border-focus`) · hovered header ·
    empty body · error body.

- **Right-column card — collapsed** — the whole card is the header row.
  - Elements: chevron `▸` · title · `N · [n]` count. Same padding (`--space-11` / `--space-12`), so
    the strip lands at ~34px. Card keeps its `--bg-panel` fill, `--border-2` 1px border and
    `--radius-xl` corners — it reads as a card that has been folded, not as a divider.
  - The bottom rule of `.panel-header` is **dropped** when collapsed (nothing sits below it).
  - MCP keeps its `+` attach affordance at the right of the strip, after the count.
  - States: default · hovered · (never focused — a collapsed card cannot own focus).

- **Right column — all three collapsed** — three 34px strips at the top of the column, separated by
  the usual 12px gap, `--bg-app` window background below them. The column keeps its 296px width.

## Flows

1. **Fold** — hover a card header: the row lifts to a subtle hover background. Click: the body
   disappears, the chevron rotates `▾ → ▸`, and the two remaining cards grow into the freed space
   (they keep their 1.3 / 0.95 / 1.05 ratios between themselves).
2. **Unfold** — click the collapsed strip. The body returns, the other cards shrink back.
3. **Keyboard fold** — `3`/`4`/`5` focuses a card (accent title + focus border), `c` folds it; the
   focus accent moves to the main pane in the same frame.
4. **Keyboard unfold** — `3`/`4`/`5` on a folded card unfolds *and* focuses it: the strip expands and
   its title picks up `--accent` together.
5. **Palette** — `⌘K` → `Toggle agents panel` / `Toggle MCP panel` / `Toggle skills panel`, glyph `▾`,
   hint flipping between `collapse · [3]` and `expand · [3]`.

## Motion

- Chevron: `▾`/`▸` swap, no rotation animation needed (the mock's glyph vocabulary is static text).
- Fold/unfold: the flex-basis change may be instant. If a transition is used, ≤120ms `ease-out` on
  `flex-grow`/`height` only — never on the border or background, and never a fade of the body content
  (the panels stay mounted; a fade would look like a reload).

## Responsive / resize

- Not a responsive layout. The three-column shell is fixed; the right column is always 296px.
- Vertical window resize: expanded cards absorb the change proportionally; collapsed strips keep
  their fixed 34px (`flex: 0 0 auto`).
- Very short window with all three expanded: unchanged from today's behavior (each card's body
  scrolls). Collapsing is precisely the user's escape hatch here.

## Data shown

Collapsed strip shows exactly what the expanded header shows, and it must stay **live**:

- `AGENTS` · agent count · `[3]`
- `MCP SERVERS` · server count · `[4]`
- `SKILLS` · skill count · `[5]`

Nothing new is displayed; no status dots, badges, or truncated previews are added to the strip.

## Notes / constraints

- **Copy**: English, lowercase hints, uppercase pane titles — matches the mock exactly. Palette
  command names sentence-case, as the existing `Toggle sessions column`.
- **Theming**: both light and dark themes; use only existing tokens (`--bg-panel`, `--bg-app`,
  `--border`, `--border-2`, `--border-focus`, `--text-hint`, `--text-dim`, `--accent`). The header
  hover background should come from an existing hover/row token rather than a new hard-coded value.
- **Accessibility**: the header row is a real click target — give it `title="collapse"` /
  `title="expand"` and keep the hit area the full row width, not just the chevron.
- **Do not** add a close/`×` glyph — collapse is reversible in place, and `×` reads as "remove".
- **Do not** show a "collapsed" count badge or ellipsis on the strip; the live count already carries
  the signal.
