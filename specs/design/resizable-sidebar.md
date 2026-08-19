# DESIGN BRIEF — Resizable sidebar (`resizable-sidebar`)

> §8 of `specs/resizable-sidebar.md`, standalone. Desktop app (Tauri webview) — not mobile-first.

**Goal:** the user drags the roster's right edge to the width their screen and their session names
actually want, and that width sticks.

**Design system:** the existing kit (`src/ui/`) + tokens in `src/styles.css`. **No new chrome is
drawn** — the handle reuses `.app-split-divider`'s visual rules verbatim. `Francois Redesign.dc.html`
(design 7a) stays the reference for everything around it.

## Screens / views

- **App shell — the roster/main gutter** (`.app-grid`, `src/app/App.tsx:309`)
  - Elements: the 12px gap between the roster card `[1]` and the main cell becomes a real grid
    track holding `RosterDivider`. Inside it, a centred 2px full-height rule with `border-radius: 1px`.
  - States:
    - **rest** — rule `transparent`. The gutter looks exactly as it does today; nothing signals the
      handle. Accepted deliberately (see Notes).
    - **hover / `:focus-visible` / dragging** — rule `var(--border-focus)`, cursor `col-resize`.
    - **dragging (global)** — `body.app-resizing-x` forces `col-resize` everywhere and kills text
      selection, so the transcript/terminal/diff under the pointer shows no caret.
    - **folded** — the first track is the existing 46px `SessionRail`; the handle stays present and
      still draggable (single + split regimes only).
    - **absent** — `grid` regime: no handle at all.

## Flows

1. Hover the gutter → cursor becomes `col-resize`, the rule tints.
2. Press and drag right → the roster follows the pointer live, up to `min(560px, 45% of the window)`
   in single / `min(560px, 30%)` in split.
3. Drag left past **180px** → the roster folds to the 46px rail **mid-drag**, under the pointer.
   Keep dragging right and it un-folds at the same threshold, without releasing.
4. Release → the width persists. Reopening the app, or reopening the roster with `[` after a fold,
   restores **that** width — never the 282 default.
5. Double-click the handle, or focus it and press `Home` → 282.
6. Tab to the handle → `←`/`→` nudge 16px per press.

## Responsive

Single desktop breakpoint; the window itself is the variable.

- **Wide window** — the cap (`560px`, or 45%/30% of the width) is what stops the drag.
- **Narrow window** — the stored width renders clamped, and springs back to the stored value when
  the window widens. Nothing is rewritten.
- **Very narrow window** — if the cap computes below 180px, the 180px floor wins; the roster never
  renders narrower than that while shown.
- **Entering / leaving split** — the cap tightens to 30% of the window and the roster may visibly
  narrow; leaving split restores the user's width.

## Data shown

Nothing new. The roster's own content is unchanged — only the width it gets to use. The handle
carries no label and no value readout; its state is exposed to assistive tech only
(`aria-valuenow` = the rendered px, `aria-valuemin` = 180, `aria-valuemax` = the current cap).

## Notes / constraints

- **Motion:** none. The width tracks the pointer 1:1 with no transition — a transition on a dragged
  dimension reads as lag. The fold/un-fold at the threshold is likewise instant.
- **Accessibility:** `role="separator"`, `aria-orientation="vertical"`,
  `aria-label="Resize sidebar"`, `tabIndex={0}`, arrow-key + `Home` operation. The keydown handler
  stops propagation so the app's document-level single-letter and arrow shortcuts never fire while
  the handle has focus.
- **Discoverability is a known, accepted trade.** Invisible-at-rest means a user with a custom width
  has no resting indication the edge is draggable. Chosen over adding chrome the design mirror
  doesn't have; worth revisiting after real use, not before.
- **The mirror no longer governs this dimension.** `282px` came from `Francois Redesign.dc.html`;
  after this it is the *default* only. Do not treat a running app whose roster is not 282px as
  design drift.
- **Copy** (`ui_language: English`): the handle's `title` reads
  `Drag to resize · double-click to reset`.
- **No new dependency and no new token** — `--border-focus` and `--space-12` already exist.
