# DESIGN BRIEF — Extensions (`extensions`)

> The "spec return". Paste into the design tool (see `PIPELINE.md` §design). This is §8 of
> `specs/extensions.md`, standalone.

**Goal:** the user reads cohorte, git and docker state without leaving Francois — three main-pane tabs
built entirely from Francois's own primitives, so three tools written by three teams look like one app.

**Design system:** the v2 identity in `Francois Design System v2.dc.html` + `Francois Redesign.dc.html`
(turn 4 is the current shell). Reuse `src/ui/` primitives — `PanelHeader`, `ListRow`, `Chip`,
`ChipGroup`, `StatusDot`, `BadgePill`, `EmptyPane`, `HintBar`, `Modal`, `Button`. **Desktop only** —
Francois is a native desktop window, not a responsive web app.

**Identity rule that governs this whole feature:** acid `#c3f53f` means *the live thing*, one per view.
In an extension tab that is the **streaming `log-tail`**, nothing else. Status tones (`ok` `#4fae86` ·
`warn` · `error` · `neutral` · `busy`) never borrow the accent — a green "running" container must not
read as the accent, which is exactly the mistake the v2 identity moved `#4fae86` to prevent.

## Screens / views

### 1. Extension tab (`ext:cohorte` · `ext:git` · `ext:docker`)

A main-pane tab sitting after SHELL and before any `agent:` / `workflow:` tab. Tab label is the
extension name in the strip's existing type role, with no status dot (extensions have no lifecycle the
strip should report).

Body: **one scrolling column of stacked sections**, in declaration order. Each section is:

- **Section header** — label left; right side carries, when relevant: a refresh indicator (for a
  section with `refreshMs`), and for `cohorte:health` only, the dashboard action button.
- **Section body** — one of the four primitives below.
- Sections are separated by the design system's divider, not by cards — the column should read as one
  continuous document, closer to the Overview tab's rollup than to the right rail's stacked cards.

**Tab header strip** (above the first section): the extension label, the project it is scoped to, and a
**`disable`** affordance on the right. `disable` is a quiet text control, not a destructive button — it
is reversible from the same modal that lists it.

Sections per tab (each needs a rendering, all four primitives appear):

- `ext:cohorte` — Health (`key-value`, + action) · Fleet (`table`) · Specs (`table`) · Loops
  (`table`, auto-refreshing) · Loop log (`log-tail`, file) · Cost (`stat-row`)
- `ext:git` — Branches · Stashes · Remotes (`table`) · Log (`table`, paginated)
- `ext:docker` — Containers (`table`, auto-refreshing) · Images (`table`) · Logs (`log-tail`, process)

### 2. The four primitives

- **`key-value`** — a two-column list. Key in the muted label role, value in the body role, and a leading
  **status glyph** driven by tone. Reuse `ListRow` + `StatusDot`. Keys left-aligned, values aligned to a
  shared column so the block reads as a table without table chrome.
- **`table`** — declared typed columns with a header row. Column kinds want distinct treatments:
  `text` (body role) · `status` (a tag — reuse `Chip` / `BadgePill`, toned) · `number` (tabular
  figures, right-aligned) · `time` (muted, relative — reuse the app's existing relative formatter) ·
  `path` (monospace, **truncated from the left** so the filename survives). Rows are selectable where the
  table is a `log-tail` token source (Loops, Containers) — selection needs a persistent visual state,
  because it drives the section below it.
  - **Paginated tables** end in a `Load more` row (a full-width quiet row, not a floating button), which
    becomes `showing first 2000 rows` — flat, non-interactive, muted — at the cap.
- **`stat-row`** — tiles that wrap. Value in the largest type role in the tab, label above in the muted
  role, optional sublabel below. Tiles must not compete with the accent; this is data at rest.
- **`log-tail`** — monospace, append-only, bottom-latched, on the design system's terminal surface.
  A dim leading row reads `… N earlier lines` when the ring buffer has dropped (same treatment as the
  agent transcript's `earlierBlocksNotice`). **While a stream is live, this is where the acid accent
  goes** — a single small live indicator in the section header, nothing else in the tab.

### 3. Extensions modal

⌘K → `Extensions`, and from the titlebar. `src/ui/Modal` in the `AccountsModal` idiom.

- One row per registry entry — **all three always, never filtered**. Row carries: extension label, a
  detection state, and a toggle.
- A **detected** row: toggle live, detection state reads the project it was detected in.
- An **undetected** row: rendered as `unavailable here` with the reason (`no .git directory` ·
  `docker daemon not reachable` · `not a cohorte project`) in the muted role. The toggle is still
  present and still works — the user can pre-disable something they haven't installed yet — but the row
  is visually recessed so the list explains itself at a glance.
- A **`Re-detect`** control in the modal footer.

### 4. Launch confirmation

A small confirm dialog in the `RemoveAccountConfirm` idiom — **not** the session permission card, which
belongs to a Claude Code tool call. It shows the **resolved command verbatim** in monospace on the
terminal surface, then `Cancel` / `Launch`. The command string is the point of the dialog: it must be
the most prominent thing in it.

## States

Every section renders exactly one of five states, and **empty and error must never be confusable**:

| State | Treatment |
| --- | --- |
| **loading** | Skeleton rows in the section's own shape (a table skeleton for a table), never a spinner — sections load independently and a column of spinners reads as a broken app |
| **empty** (validated zero rows) | The section's declared empty copy, muted, centred in the section body. Calm. Reuse `EmptyPane` |
| **error** | The cause on one line — `needs cohorte ≥ 2.4.0 · exited 1` · `timed out after 10s` · `output exceeded 4 MiB` · `unexpected output shape` · `cohorte not found on PATH` — over the **resolved command** in monospace muted, plus a `Retry` control. Toned `error`, never accent |
| **not available here** | `not available in <project>` — recessed, no error tone. This is not a failure; the tab is simply out of scope for the current session |
| **no selection** (log-tail with no token) | `select a row above`, muted, pointing back at its source table. Not an error tone |

The action button has its own three states: `Open dashboard` (enabled) · `Launch dashboard` (enabled) ·
disabled with `port 4317 is taken by something else` beneath it.

## Flows

1. Open the tab → every section shows its loading skeleton → each resolves independently into data,
   empty or error. A failing section leaves its siblings untouched.
2. Click a row in Containers → the row takes a selected state → the Logs section below leaves
   `select a row above` and begins streaming, its header showing the live indicator.
3. Leave the tab → after a grace period the live indicator goes out. Return later → the log block is
   **empty** and restarts. It must be visually obvious that this is a fresh stream, not a stall.
4. Scroll Log to the bottom → `Load more` → new rows append below without the viewport jumping.
5. Click `disable` in the tab header → the tab disappears from the strip and the main pane falls back to
   SESSION. No confirmation — it is reversible from ⌘K → Extensions.

## Data shown

Exactly the fields in `specs/extensions.md` §5: `KeyValueRow { key, value, tone }` ·
`TableRow { id, cells, tone }` against the panel's declared `ColumnDef { key, label, kind }` ·
`StatTile { label, value, sublabel? }` · log lines as plain strings. Every string arrives already
sanitized and truncated to 512 chars by the core — **the design must accommodate a trailing `…` on any
field**, including a column header's worth of it.

## Notes / constraints

- **Copy is English**, lowercase in the app's established voice (`select a session`, `select a row
  above`), sentence case in headers.
- **Per-feature CSS + classNames only.** `src/features/extensions/extensions.css`, BEM-lite
  (`ext-panel`, `ext-panel__section`, `ext-panel__section--error`). No inline `style={{}}` except for a
  value computed at runtime. No `font-weight` above 600.
- **Icons are `lucide-react`**, inheriting `currentColor`; tone set in CSS, never a `color` prop.
- **Hostile content is the normal case.** A branch name, a container name or an image tag may be 512
  characters of punctuation. Every text treatment must degrade to truncation, never to a broken layout
  and never to a horizontal scrollbar on the whole pane.
- **The tab strip will be crowded** — on a docker-using cohorte repo it reads SESSION · DIFF · SHELL ·
  ext:cohorte · ext:git · ext:docker before any agent tab opens. The strip's overflow behaviour at that
  width is a real thing to draw, not an afterthought.
- Accessibility: selection state in a token-source table must be conveyed by more than colour, since it
  drives what the section below streams.
