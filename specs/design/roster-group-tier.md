# DESIGN BRIEF — Roster group tier (`roster-group-tier`)

> Standalone copy of spec §8. Source: `specs/roster-group-tier.md`.

**Goal:** inside a state band of pane [1], a family of related projects (`ODO`, `Perso`) reads
together under one quiet heading, without giving up the state-first ordering design 12b established.

**Design system:** existing UI kit (`src/`), tokens in `src/styles.css`, flat treatment (design turn
9a). This is a **desktop app** — no mobile-first, no breakpoints below the window's 720px `minWidth`.
No fresh mockups are expected: the heading reuses `roster-state__head`'s established metrics.

## Screens / views

- **Pane [1] roster body** — the only surface this feature touches (`StateRosterBody.tsx`,
  `sidebar.css`). Nothing else in the app changes.
  - Existing elements, unchanged: the four state headings (WAITING ON YOU · RUNNING · IDLE ·
    ARCHIVED) with their status dot, label tint and count; all three row shapes; the row's project
    marker, account badge and pane tag.
  - New element: **group heading**, one thin row per group inside a band.
    - Caret `▾` (expanded) / `▸` (collapsed) · group name · session count.
    - **Neutral** roster-label tone. No accent, no status dot, no tint, no card surface, no `+`,
      no context menu. The state heading above owns the band's colour; a second coloured heading
      would break "one accent per view".
    - Weight sits **between** the state heading and a row's own name — the tier reads by weight and
      by the space above the heading, never by a rule or a surface.
    - **Indent: none.** The heading sits at the rows' own indent and rows do **not** step further in
      (`project-groups` FR-24 caps the roster at three levels — a fourth indent is what turns the
      pane into a staircase).
  - States per heading: expanded (caret down, rows beneath) · collapsed (caret right, no rows, count
    unchanged) · **suppressed** (not rendered at all — see below).
  - No loading state, no empty state, no error state: every input degrades to `elsewhere` or to
    expanded, and no call in this feature can fail.

## Flows

1. Band holds sessions from more than one group → headings paint, ordered by name (case-insensitive),
   `elsewhere` always last. Two groups sharing a name paint two adjacent headings.
2. Click a heading anywhere → it toggles. Its rows collapse; the **state band's count does not
   change**; the same group inside another band is unaffected. The state survives a relaunch.
3. Band holds sessions from exactly **one** group → **no heading at all**; the band renders exactly as
   it does today. This is the load-bearing concession: under a single-project scope, or in a WAITING
   band holding one session, the roster is byte-identical to the current build.
4. `j` / `k` steps card to card. A heading is **never** a cursor stop, and a collapsed group's cards
   are not reachable.
5. A session changes state and moves band → **no motion, no transition**. It simply paints in its new
   band under its group.

## Responsive

- The heading is a single line that truncates its group name before its count — the count is the
  part that stops being guessable when cropped.
- At the sidebar's minimum width the caret, a truncated name and the count all remain visible; the
  heading never wraps to two lines.
- Collapsing the sidebar entirely (`resizable-sidebar`) hides the tier with the rest of the roster —
  no separate rule.

## Data shown

Per heading, and nothing else:

- **Group name** — `ProjectGroup.name`, verbatim, or the literal `elsewhere` for ungrouped sessions.
- **Count** — sessions of that group **in that band**, shown whether the tier is collapsed or not.

Explicitly **not** shown: any per-group status roll-up, any group colour or icon, any project list,
any group action. And the row's own project marker is untouched — `ODO - Frontend` still renders
verbatim under an `ODO` heading. That redundancy is a known, accepted cost: stripping the prefix
would be string surgery on a user-authored name.

## Notes / constraints

- Copy is English, lowercase, matching the existing state headings (`waiting on you`, `idle`); the
  group name itself is rendered as the user typed it.
- Accessibility: the heading is a click target with an accessible name of `<group> <count>`; its
  collapsed/expanded state must be exposed (`aria-expanded`), and it stays out of the roving `j`/`k`
  order (spec FR-22).
- Flat treatment (9a): no 1px stroke, no shadow. If the heading needs more separation, it takes more
  vertical space — never a rule.
- Reference: the state heading in `Francois Redesign.dc.html` turn 12b is the metric to sit beneath;
  the deleted repo heading of turn 7a is the closest prior shape, at one tier lower in weight.
