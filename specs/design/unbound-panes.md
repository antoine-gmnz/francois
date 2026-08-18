# DESIGN BRIEF — Unbound panes (`unbound-panes`)

> §8 of `specs/unbound-panes.md`, standalone. Base: `Francois Redesign.dc.html` **turn 5b — Split**
> and **turn 5d — Quad**, 1280×800. Everything not named here is unchanged from those turns.

**Goal:** keep the 1–4 pane split when the scope widens to All projects, tell two same-named
sessions from different repos apart at a glance, and put a project-rooted terminal into a pane.

**Design system:** the shipped UI kit (`src/ui/`) + the tokens in `src/styles.css`. Desktop app, not
mobile-first. Icons are `lucide-react`, inheriting `currentColor`.

## Screens / views

- **Pane header — session pane** (existing) · gains the project marker
  - Elements: 1-based index (grid only, monospace `--text-3`) · status dot · **project marker** ·
    session name · `focus` chip when focused / status label otherwise · context tokens · `⤢` · `✕`.
  - The marker sits immediately left of the session name so the name reads as `‹repo› name`.
  - States: focused (2px `--accent` top rule, `--border-focus`, `--bg-panel`) · unfocused
    (`--border-2`, `--bg-elevated`, `--text-disabled` footer).

- **Pane header — shell pane** (new)
  - Elements: index (grid only) · terminal glyph (`Terminal`, `--text-2`) · **project marker** ·
    project name · `✕`. **No** `⤢`, no status dot, no context tokens, no tab strip.
  - Focused/unfocused treatment identical to a session pane, so the grid reads as one system.
  - States: spawning (centred `--text-3` `starting shell…`) · live (terminal + the existing shell
    footer) · exited (the shipped exit strip) · error (see below).

- **Project marker** (new, used in three places)
  - A 2–3 character monospace tag derived from the project name, `--text-2` on `--bg-app`, 10px,
    1px `--border-2`, 3px radius. **Never `--accent`** — acid marks the one focused surface; a
    repeatable surface gets a neutral marker (`session-profiles` rule).
  - Appears in: the pane header (both shapes), the 30px grid rail tile (bottom-left corner, under
    the two-character session initials and the 7px status dot), and the roster's pane badge row.
  - `title` carries the full project name.

- **Empty pane — two-choice affordance** (replaces the single *New session* prompt)
  - Centred stack: `pane <n> is empty` (`--text-3`) then two ghost buttons side by side —
    **Pick a session** and **Open a shell here**. Each 1px `--border-2`, hover `--border-focus`.
  - *Open a shell here* opens the project picker (the shipped project list popover) unless exactly
    one project is registered, in which case it spawns straight away.
  - States: empty (above) · picking (popover open, the pane keeps focus) · error (below).

- **Grid session rail** (existing, FR-6) · now spans the fleet
  - Same 46px track, same 30px tiles. Tiles for sessions **currently in a pane** are pinned to the
    top, separated from the rest by a 1px `--border-2` hairline; the remainder follow by
    `lastActivityAt` desc. The track scrolls vertically (no scrollbar chrome, overscroll contained).
  - `+` and `»` stay pinned at the foot, outside the scroll area.

- **Roster pane badge** (existing, FR-22) · a session in two panes renders both indices as `1·3`.

## Flows

1. Scope switcher → *All projects*: the roster widens, the panes do not move. Project markers were
   already there, so nothing appears or disappears in the main pane.
2. Empty pane → *Open a shell here* → project popover → pick `acme-api` → the pane swaps to the
   shell header + a `starting shell…` line → the terminal paints. ~120ms fade, no layout shift.
3. Click into the shell pane: the accent rule and the `focus` chip move there; the titlebar quota,
   the right column and the status bar **do not change** — they keep the last focused session.
4. Pane header menu (`⋯` on hover) → *Convert to shell…* / *Open a shell pane beside* → same picker.
5. `✕` on a shell pane: the PTY is disposed and the grid compacts, identically to a session pane.

## Responsive

Desktop only; the window is resizable. `single` `276|1fr|296` → `split` `238|1fr|(296|46)` →
`grid` `(238|46)|1fr|—`, main pane `1fr 1fr / 1fr 1fr`, 12px gaps — all unchanged. A shell pane
resizes its PTY on every pane resize (debounced, as the SHELL tab already does). Below the width
where four panes are cramped, nothing collapses automatically — the panes simply get narrower.

## Data shown

Matching `specs/unbound-panes.md` §5:

- Session pane: `SessionMeta` (name, status, `lastActivityAt`, context tokens) + its project's
  `ProjectMeta.name` for the marker.
- Shell pane: `ProjectMeta.name` + `ShellInfo` (`shellName`, `alive`, `exitCode`) for the footer.
- Rail tile: session initials, status dot, project marker.
- Roster badge: the pane indices holding that session.

## Notes / constraints

- Copy in **English**, lowercase in footers and hints (`starting shell…`, `pane 3 is empty`), as
  shipped.
- Errors render **in place**, never as a toast: `PROJECT_ROOT_MISSING` → `project root is gone`
  + *Retry*; `SHELL_LIMIT_REACHED` → `6 shells already open for this project`;
  `PROJECT_NOT_FOUND` → `this project is no longer registered` + *Close pane*. All `--danger` text
  on the pane's own background, with the header intact so the pane stays closable.
- One acid per view still holds: exactly one pane carries the `--accent` top rule and the `focus`
  chip. The project marker, the rail's pinned hairline and every badge stay neutral.
- Cap feature CSS at `font-weight: 600` (the design mirror's ceiling); only xterm's `fontWeightBold`
  may use 700.
- A shell pane shows no `⤢` and no tab strip in any regime — do not draw one for symmetry.
