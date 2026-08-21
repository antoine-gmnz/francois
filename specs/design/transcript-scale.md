# DESIGN BRIEF — Transcript scale (`transcript-scale`)

> The "spec return" — §8 of `specs/transcript-scale.md`, standalone.

**Goal:** a long session opens at its tail and reads back on demand, without the transcript ever
becoming a wall the app has to render in full.

**Design system:** the existing kit (`src/ui/`, tokens in `src/styles.css`), flat treatment
(design turn 9a) as applied by `Francois Redesign.dc.html`. Not mobile — this is a desktop app; the
only responsive axis is the window width tiers already declared in `src/app/topbar.ts`.

## Screens / views

- **SESSION tab, reading column** — the transcript. One element is added; nothing else changes.
  - **Earlier-blocks row** — the first child of the reading column, directly above the oldest
    rendered block.
    - Elements: a `▲` caret, then the count sentence — `▲ 2,140 earlier blocks` (singular
      `1 earlier block`), thousands separated. Nothing else: no page-size control, no spinner, no
      count of what is *shown*.
    - Geometry: full-bleed within the reading column, one line tall, the same height and horizontal
      padding as the pending strip's rows from `transcript-perf` (they are siblings in spirit — one
      states what has not run yet, this states what is not shown yet).
    - Surface: the recessed block tone `#101319`. **No stroke, no shadow, no radius** — separation
      from the first transcript block below comes from the tonal step alone, per the flat rules.
    - Type: `--text-muted` for the whole row, including the caret. No accent, no amber: this is
      navigation, not the live thing and not something asking to be come to.
    - States:
      - *default* — as above; the whole row is the hit target.
      - *hover* — the text steps to `--text` and the surface one tone lighter; cursor `pointer`.
      - *focus* — the standard keyboard focus ring (a survivor of the flat pass), on the row.
      - *loading* — a page is in flight: the row stays exactly as it is and further activations are
        ignored. Deliberately no spinner — a page is a local file read, and a flicker on a row the
        user is about to scroll away from is worse than a beat of nothing.
      - *exhausted* — the transcript is fully expanded: the row is **removed**, not disabled.
      - *inert* — an unfocused pane in a split renders the row and does not activate it, matching the
        composer's existing `inert` gate.
    - Absent entirely when the session's transcript fits the window (short sessions never see it).

## Flows

1. The user selects a session with thousands of blocks. The transcript paints at its tail, pinned to
   the bottom as today. The earlier row sits above the first rendered block, off-screen until they
   scroll up to it.
2. They scroll up, reach the row, and click it (or `Tab` to it and press `⏎`/`Space`).
3. A page of earlier blocks prepends above it. **The viewport does not move** — the block they were
   reading stays at the same offset. The row's count drops by the page size and it stays where it
   is, now above the newly prepended blocks.
4. Repeat until the count reaches zero, at which point the row disappears and the top of the
   transcript is the top of the session.
5. At no point does expanding re-pin the view or scroll to the bottom. The "jump to latest" chip
   behaves exactly as it does today and is the only way back.

## Responsive

- The row inherits the reading column's width at every tier and never crops: the count sentence is
  short by construction, and it is the only content.
- Below the 840px tier the reading column is already narrower; no change is needed.

## Data shown

From `TranscriptPage` (spec §5) and frontend window state (spec §6) only:

- the **count of earlier blocks** — held blocks outside the window, plus (when `hasMore`) an
  indefinite tail. When `hasMore` is true and the exact remaining count is unknown, the row reads
  `▲ earlier blocks` with no figure rather than a guessed one.

No timestamps, no block kinds, no per-page bookkeeping surfaces in the UI.

## Notes / constraints

- **Copy is English**, sentence case, no terminal punctuation — matching every other affordance row.
  "blocks", not "messages": a tool call and a permission card are blocks and are counted here.
- **Accessibility**: a real `<button>` (not a div with a click handler) so it is in the tab order and
  announced; `aria-label` carries the full sentence. Activation moves no focus — the user stays on
  the row, which is now the boundary of what they have loaded.
- **No motion.** The content prepends while the scroll offset is corrected in the same layout pass
  (spec FR-14); any transition on insert would fight that correction and read as a jump.
- **No dependency** may be introduced for this (spec FR-16) — the row is the whole mechanism, which
  is why there is no scrollbar-driven auto-loading: that would need height estimation, and estimating
  the height of arbitrary markdown is what this design exists to avoid.
