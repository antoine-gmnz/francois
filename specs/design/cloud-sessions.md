# DESIGN BRIEF — Cloud Sessions (`cloud-sessions`)

> The "spec return". Paste into the design tool (see `PIPELINE.md` §design). This is §8 of the frozen
> spec, standalone.

**Goal:** the user brings a Claude Code session they started on their phone or claude.ai into
Francois, choosing where it lands on disk, and it becomes an ordinary local session.

**Design system:** the existing UI kit (`src/ui/`) and the v2 identity —
`Francois Design System v2.dc.html` + `Francois Redesign.dc.html` (turn 4 is the current shell).
Desktop app, fixed console chrome; **not** mobile-first (see §Responsive). Compose from
`Modal`, `ListRow`, `Chip`, `ChipGroup`, `Button`, `StatusDot`, `EmptyPane`, `HintBar`.
**No new colors, tokens or glyphs.** Acid `#c3f53f` means *the live thing* — one per view, so it
belongs to the in-flight phase row and nothing else in this feature.

## Screens / views

- **"Adopt cloud session" modal** — the whole feature's front door. Opened from a pane [1]
  action beside "new session" and from a ⌘K command.
  - Elements, top to bottom:
    1. **Paste field** — "Paste a claude.ai/code link or session id". This is the
       authoritative path and must read as such: full width, focused on open.
    2. **Session list** — rows from the cloud sessions API. Each row: title (or the short id
       when the API returns none), repo, branch, relative updated-at. Selecting a row fills
       the paste field; the two inputs are one value, never two competing selections.
    3. **Landing toggle** — `ChipGroup`: *New worktree* (default, pre-selected) · *This
       project's checkout*. The destructive option is the one you reach for.
    4. **Project selector** — pre-selected and quiet when the repo matched a registered
       project; promoted to a required, visibly-empty field when it did not.
    5. **Adopt** primary button + Cancel.
  - States:
    - **empty** — no ref entered: Adopt disabled.
    - **loading (list)** — skeleton rows, paste field already usable. The list never gates the field.
    - **degraded** — one quiet line where the list would be: "Couldn't load your cloud
      sessions — paste a link instead." `--text-disabled`, no error tone, no icon. This is the
      normal state when offline or when the endpoint moved; it must not read as a failure.
    - **confirm (checkout)** — picking *This project's checkout* reveals an inline warning
      naming the branch: "Teleport will stash uncommitted changes in `<project>` and check out
      `<branch>`." Adopt stays disabled until an explicit checkbox is ticked.
    - **in-flight** — see Flows; the form is replaced by the phase list, Cancel becomes
      **Run in background**. There is deliberately no Abort: §5 exposes no cancel channel, so
      leaving stops *watching* the adoption, never the adoption itself. The label must say so —
      a button reading "Abort" that only closes the dialog is the one wording we cannot ship.
      A run that finishes after the dialog closes still lands in pane [1] via `session.meta`.
    - **error** — the mapped message in `--error` tone, the form restored with the ref intact,
      Adopt re-enabled. Retry costs one click.
- **Pane [1] session row + SESSION tab header** — a `cloud` provenance chip.
  - Shaped exactly like the existing `rc` chip: same height, same corner radius, same
    `StatusDot` family. Tone is neutral/`--text-secondary`, **not** accent — provenance is a
    fact, not a live state.
  - Tooltip carries the one-way rule verbatim: "Adopted from a cloud session. Work you do here
    does not go back to claude.ai." This is load-bearing copy, not a footnote — if the UI
    implies the phone still sees the session, users lose work believing it does.

## Flows

1. User opens the modal (pane [1] action or ⌘K). Paste field is focused; the list loads behind it.
2. They either paste a link/id **or** click a list row — both land the same value in the field.
3. The repo is resolved: if it matches a registered project, the project selector fills in
   quietly. If not, the selector is empty and required.
4. Landing stays on *New worktree* unless they switch to *checkout*, which reveals the
   branch-naming confirmation and its checkbox.
5. **Adopt** replaces the form with a five-step phase list — Resolving · Preparing · Teleporting ·
   Loading history · Ready. Steps are a vertical list with a `StatusDot` each: done, current
   (acid, the one live thing), pending (`--text-disabled`). **Never a bare spinner** — this
   takes up to three minutes and a silent spinner is how this feature earns a bug report.
6. On Ready the modal closes, the new session is selected in pane [1] wearing its `cloud` chip,
   and the transcript shows the cloud conversation already scrolled to the end.
7. On failure the phase list stops at the step that failed, marked in `--error`, with the mapped
   message beneath it and the form restored above.

## Responsive

Fixed desktop console chrome — this feature adds no breakpoints.

- The modal is a fixed-width centred dialog matching the existing `Modal` width; the session
  list scrolls internally past ~6 rows rather than growing the dialog.
- At short viewport heights the list is the only region that shrinks; the paste field, the
  landing toggle and the actions stay visible. The authoritative path never scrolls out of view.

## Data shown

Matches spec §5 exactly. Every one of these can be **null** from the API — render an honest
fallback, never a synthesized value:

- Per list row: `title` (fallback: the short id), `repo` (fallback: hidden), `branch`
  (fallback: hidden), `updatedAt` as relative time (fallback: hidden).
- Landing: `destination` (`worktree` | `checkout`), the resolved branch name in the checkout
  confirmation, the target project name.
- In-flight: the phase (`resolving` · `preparing` · `teleporting` · `hydrating` · `ready` ·
  `failed`) and, on `failed`, the mapped error message.
- Chip: presence only — no id or timestamp on the chip face; both live in the tooltip.

## Notes / constraints

- **Copy is English** (`ui_language`), plain and actionable. Never use the words "Remote
  Control" anywhere in this feature: the CLI's auth errors say it, but that is a different
  object and echoing it misleads (spec §7 #4).
- **Accessibility**: the phase list is an `aria-live="polite"` region so progress is announced;
  each phase row has a text label, never colour alone. The checkout confirmation is a real
  checkbox with a label, reachable by keyboard, and Adopt is genuinely `disabled` until ticked.
- **Keyboard**: `Esc` closes the dialog (in flight, that means "run in background" — it stops
  watching, not the adoption; see the in-flight state above), `⏎` submits when Adopt is
  enabled, `↑`/`↓` move through list rows. The list is optional to the flow — everything is
  reachable without touching it.
- **Icons** are `lucide-react`, inheriting `currentColor`; tone set in `cloud-sessions.css`,
  never with a `color` prop. Styling is per-feature CSS + BEM-lite classNames, no inline `style`.
- **Edge case worth drawing**: the degraded-list state is the *common* state for anyone offline,
  not a rare one. Design it as a calm empty state, not an alarm.
