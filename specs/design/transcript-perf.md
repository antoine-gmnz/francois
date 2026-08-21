# DESIGN BRIEF — Transcript performance + queued-prompt ordering (`transcript-perf`)

> The "spec return". §8 of `specs/transcript-perf.md`, standalone.

**Goal:** a prompt typed while a turn is running is visibly *waiting*, retractable, and never
wedged into the middle of the reply it was typed over. (The rest of the feature is a render
restructuring with no visual output — this brief covers the one new element.)

**Design system:** the existing UI kit (`src/ui/`) and tokens (`src/styles.css`). Desktop only —
Francois is a native desktop app, so the responsive section below is about window *resize*, not
breakpoints. Visual source of truth: `Francois Redesign.dc.html` (turn 9a, flat treatment) +
`Francois Design System v2.dc.html`.

## Screens / views

One new element inside the SESSION tab: the **pending strip**.

- **Pending strip** (`composer-pending`) — a stack of rows in `.composer-col`, between
  `.composer-banners` and `.composer-bar`. That slot is where send-error banners already live, so
  a row **pushes the composer down** rather than overlapping it, and the transcript above reflows
  once — the same behaviour a banner already has.
  - Elements: one row per queued prompt, FIFO top-to-bottom, full-bleed within the composer's
    reading column.
  - States:
    - **empty** — not rendered at all. No placeholder, no zero-height wrapper.
    - **1–20 rows** — the queue cap is 20 (`QUEUE_CAP`); at that many the strip is tall but is
      never scrolled or truncated — it is the user's own backlog and hiding part of it would be
      worse than the height.
    - **inert pane** — rows render identically but read-only: the `✕` is not shown, matching the
      composer's own `inert` gate (an unfocused pane does not own the keyboard or its actions).

- **Pending row** (`composer-pending__row`) — one line, three parts left to right:
  - `⟳` glyph, tone `--warn`. This is the tone the `.block-user__queued` badge used and which this
    strip replaces — it is the established "waiting, not live" colour, and deliberately **not** the
    accent (the accent means *the live thing*, and a queued prompt is the opposite of live).
  - The prompt's **first line** in `--text-muted`, `--font-mono`, `--font-size-12-5`, truncated
    with an ellipsis at the row's width. Never wrapped — a queued prompt is being identified, not
    read. Full text in the row's `title` tooltip.
  - `✕` — a plain, instant dismiss button (not `RemoveControl`, which is a two-step confirm-in-place
    control that renders the word "Remove" — this row needs a one-click `✕` glyph, same precedent
    as `AttachmentChip.tsx`), right-aligned, 26px like every other control in the shell.
  - Geometry: flat (turn 9a) — **no stroke, no shadow, no radius**. Separation from the composer
    bar below comes from a tonal step: the strip sits on the recessed block `#101319` against the
    canvas. Removing a rule means adding a surface.
  - States: **rest** · **hover** (the `✕` gets a standard hover tone shift; the row itself does not
    lift — it is not clickable, only its `✕` is) · **inert** (no `✕`).

## Flows

1. A turn is running. The user types a follow-up and presses `⏎`.
2. The composer clears. A pending row appears above it. **The transcript does not change** — the
   streaming reply keeps its single turn header and keeps streaming.
3. A second follow-up adds a second row below the first.
4. The turn finishes. The core drains the first prompt: its row disappears and the prompt appears
   in the transcript at the head of its own turn, immediately followed by its reply. Row two stays.
5. Alternatively, before the drain, the user clicks a row's `✕`. The row goes and its text is
   **appended** to the composer draft — separated by a newline if the draft is non-empty — with the
   caret at the end and the textarea re-grown to fit.
6. If the `✕` loses the race to the drain, the composer is left untouched and the row clears on its
   own as the prompt enters the transcript. From the user's side this reads as "too late, it's
   running" — which is the truth.

## Responsive

The strip inherits `.composer-col`'s capped, centred reading column, so it tracks the composer at
every window width and needs no rule of its own. Only the prompt text flexes; the `⟳` and the `✕`
are `flex-shrink: 0`, so a narrow window truncates the text further and never crops the control —
the same rule the ranked topbar (turn 10a) applies to everything except the session title.

## Data shown

Per row, from the frontend's pending queue (`spec §6`): the prompt `text` (first line + full text
in the tooltip). Nothing else — no queue position number (the visual order *is* the position), no
timestamp (it has not run yet, so there is nothing to time), no session name (the strip is inside
one session's composer).

## Notes / constraints

- **Motion:** none on insert or removal. The strip changes height, which moves the composer and
  reflows the transcript above it; animating that would make the reflow more visible, not less.
- **Copy** in English (`ui_language`), lowercase, no trailing punctuation.
- **Theming:** `--warn`, `--text-muted` and the recessed block tone are all existing tokens and
  resolve in both themes. No inline `color`; the row's tone lives in `conversation.css`.
- **What this replaces:** the `queued` badge inside a user transcript block (`.block-user__queued`,
  `Block.tsx:84-88`) is deleted along with the contract field behind it. There is exactly one place
  a waiting prompt appears, and it is not the transcript.
- **Accessibility:** the `✕` carries an accessible label naming what it removes
  (`remove queued message`); the row's truncated text is title-attributed so the full prompt is
  reachable without opening anything.
