# DESIGN BRIEF — Title-bar project switcher (`titlebar-project-switcher`)

> The "spec return". Paste into the design tool (see `PIPELINE.md` §design). This is §8 of the frozen
> spec, standalone.

**Goal:** from the always-visible title bar, the user reads which project the session board is scoped to —
by **name** — and switches that scope in one click.

**Design system:** the existing UI kit (`src/ui/`) and the tokens in `src/styles.css`. Visual source of
truth: `Claude Terminal.dc.html` (the mock's "clyde" branding reads as "francois") + `screenshots/`.
**Desktop-only app — not mobile-first.** There is one viewport class; the only responsive concern is window
width, covered under Responsive below.

## Screens / views

Exactly one screen: the **title bar** — `.usage-bar`, a fixed 38px strip between the native OS caption and
the content grid. No RBAC. Only its left cluster changes.

- **Title bar — brand cluster** (`.titlebar-brand`, left-aligned, `gap: --space-14`)
  - Elements, in order:
    1. `.titlebar-logo` — 9px accent diamond (45°-rotated square, `--radius-xs`). **Unchanged.**
    2. `.titlebar-wordmark` — "Francois", `--font-ui` 600, `--font-size-12-5`, `--text-strong`. **Unchanged.**
    3. **The switcher toggle** (replaces the old path button) — see below.
  - States: the cluster itself has none; it is always mounted.

- **Switcher toggle** (`.titlebar-path`, keeps its class names from design-refresh FR-4)
  - Shape: 24px tall, `--bg-hover` fill, 1px `--border-emphasis` outline, `--radius-lg`,
    `padding: 0 --space-9`, `gap: --space-7`, `max-width: 320px`, `min-width: 0`.
  - Contents: `[dot] [label] [caret]`
    - **dot** — 6px circle, `flex-shrink: 0`. **Three tones (new):** `--success` when the scoped project's
      root exists · `--danger` when it is missing · `--text-muted` on "All projects". This is the only
      always-visible signal that a project's checkout has gone.
    - **label** — the project **name**, or `All projects`. `--font-ui` (it names a thing now, not a path),
      `--font-size-11`, `--text-2`, truncating with `…`. It is the element that gives way when the bar is
      tight — never the usage meters.
    - **caret** — `▾`, `--font-size-9`, `--text-muted`, `flex-shrink: 0`.
  - States:
    - *default* — as above.
    - *hover* — fill goes `--bg-hover-2`. No other change.
    - *open* — dropdown below; the toggle itself keeps the hover fill.
    - *empty registry* — reads `All projects` with a muted dot; still opens (its dropdown is the only way
      to register a first project).
    - *no loading state and no error state* in the bar — a failed registry read leaves the last-known label.
  - Tooltip (native `title`): the full root of the scoped project, else the active session's `cwd`, else
    `home`. This is now the **only** always-reachable home for the path — a deliberate trade.

- **Dropdown** (`.pjsw-dropdown`, the existing panel, re-anchored)
  - Anchor: absolutely positioned under the toggle, `top: 100%`, **`left: 0`**, sized to its own content —
    min 260px, max 420px. (Previously it stretched `left: 0; right: 0` across a 26px sidebar strip; that is
    wrong in a title bar.) `z-index: 40`, above the usage meters and the grid below.
  - Surface: `--bg-panel`, 1px `--border-2`, `--radius-md`, `--shadow-card-sm`, `padding: --space-4 0`.
  - Contents, top to bottom:
    1. **Scope list** (`role="listbox"`, `max-height: 260px`, vertical scroll only) — 24px rows,
       `padding: 0 --space-12`, `gap: --space-7`, `--bg-hover` on hover:
       - `[✦ or blank, 8px, --accent] [name, flex 1, --text-11] [«missing» tag if absent] [abbreviated root,
         right-aligned, --text-faint, --font-size-10, max-width 52%]`
       - Row 1 is always **All projects** (no root, no tag). Then one row per project, in registry order.
       - The **name** takes the slack and truncates last; the root shrinks and ellipsizes first.
    2. **Divider** (`.pjsw-divider`, 1px `--border`).
    3. **`Manage projects…`** — an *action*, not a scope. Same 24px row, `--text-dim`, outside the listbox
       so a screen reader never announces it as a selectable option.
  - Motion: `dropIn 90ms ease-out` on the panel only. **The title bar itself must have zero motion** — no
    transition, no animation on the toggle (permanent chrome that animates repaints forever under software
    compositing).

## Flows

1. User glances at the bar → reads `● Francois ▾` (or `● All projects ▾`). Hover → full path in a tooltip.
2. Click the toggle → the dropdown opens under it, registry re-read in the background.
3. Click a project row → dropdown closes, label becomes that name, dot takes its tone, the session board
   filters to that project. **The main tab is left alone** — the user may be mid-conversation.
4. Click `All projects` → dropdown closes, board unfilters, every agent tab closes and the main pane
   switches to OVERVIEW. Widening scope is a zoom-*out*: there is no longer one project in view.
5. Click `Manage projects…` → dropdown closes, the Projects modal opens. On close the registry is re-read,
   so a rename or a new project shows up immediately in the label and the list.
6. `Escape` or a click anywhere outside → dropdown closes, scope unchanged.

Mouse-only by design: there is no keyboard shortcut and no palette command for switching scope.

## Data shown

Per spec §5 — no new contract. From `ProjectMeta` (`contract/projects.ts`):

| Where | Field |
|---|---|
| toggle label | `name` (or the literal `All projects`) |
| toggle dot | `rootExists` → tone |
| toggle tooltip | `root` (else active session `cwd`, else `home`) |
| row name | `name` |
| row `missing` tag | `!rootExists` |
| row root | `root`, abbreviated to `~\…` under `home` |
| row `✦` | `id === activeProjectId` |

Copy is **English** (`ui_language: English`), lowercase-leaning as elsewhere in the app: `All projects`,
`missing`, `Manage projects…`.

## Responsive

Desktop-only; one layout. The single width concern:

- **Narrow window** — the brand cluster shares the 38px bar with the usage meters. The toggle is capped at
  `max-width: 320px` and its label ellipsizes inside that cap. The meters must never be pushed, wrapped, or
  clipped by a long project name (names run up to 80 chars). Check at the narrowest supported window width.
- The dropdown sits at the far left, so a `left: 0` anchor cannot overflow the right edge. No flip logic.

## Notes / constraints

- **Accessibility**: toggle carries `aria-haspopup="listbox"` + `aria-expanded`; the scope list is
  `role="listbox"` with `role="option"` rows and real `aria-selected` on the active scope;
  `Manage projects…` is a `role="button"` sibling, never announced as an option.
- **Theming**: every value is a token — it must read correctly in both light and dark. Two known traps from
  the pane [1] version: `--bg-elevated` is near-invisible on `--bg-panel` in light theme (use `--bg-hover`
  for interactive rows), and `▾` (U+25BE) carries almost no ink in JetBrains Mono at small sizes — the
  dropdown's own glyph uses U+25BC. The toggle's caret stays `▾` at `--font-size-9` in `--font-ui`.
- **Not a focusable pane**: the title bar is chrome — no `tabIndex`, no focus ring, absent from the 1–5 pane
  cycle. The toggle is a real `<button>` and is reachable by Tab as a normal control.
- **No drag region**: the bar sits below the native OS caption and carries no `data-tauri-drag-region`, so
  nothing needs a drag exemption.
- **Deliberate omission**: no project-count badge on the toggle, and no second tier showing the path beside
  the name. Both were considered and dropped.
</content>
