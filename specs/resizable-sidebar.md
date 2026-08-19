---
id: resizable-sidebar
title: Resizable sidebar
status: shipped
branch: feat/resizable-sidebar
created: 2026-08-19
depends_on: [app-shell, sessions-sidebar, split-by-4, collapse-right-column]
loop_pass: 0
loop_phase:
reviewed_base: bf2052b758093c1d89e4e97eddf70cd3a5d09e6a
reviewed_digest: 0e5c9f626142f99b
design_files: []
---

# Resizable sidebar

## 1. Summary

The pane [1] roster is a fixed `282px` (single) / `238px` (split), baked into `shellColumns()` in
`src/app/appShell.ts`. Session, project and worktree names truncate at a width that came from the
design mock rather than from anyone's screen, and the only escape is folding the roster entirely
(`[`). This makes that edge draggable: one persisted pixel width, a snap-collapse into the existing
46px rail at the narrow end, and a viewport-relative cap at the wide end. Frontend-only — no
contract file, no IPC, no Rust, no dependency.

## 2. Goals & non-goals

- **Goals**
  - Drag the roster's right edge; the width persists across restarts.
  - **User width wins over the regime.** `282`/`238` become seed defaults, never runtime rules.
  - Snap-collapse to the 46px rail below a threshold, **without destroying the stored width**.
  - Clamp on read AND on render; never rewrite storage.
  - Keyboard + a11y parity with `SplitDivider` (focusable `role="separator"`, arrows, `Home`).
  - Retire the duplicate-drag risk: extract the shared pointer-drag mechanics into one hook.
- **Non-goals**
  - Any core/Rust work — no contract file, no Tauri command, no persisted core state.
  - Per-project or per-session width (a project switch that resizes chrome is hostile).
  - A palette command for the width — it is a drag, not a command.
  - Resizing anything else; `SplitDivider` already owns the main-pane split.
  - New Claude Design mockups — `design_files: []` stays empty.
  - Any new dependency (`2026-08-18 · deps`).

## 3. User stories / flows

1. **Widen.** Hover the 12px gap between roster and main cell → `col-resize`, a subtle tint on the
   2px rule. Press and drag right; the roster follows the pointer live. Release — the width persists.
2. **Snap-collapse.** Drag left past ~180px: the roster folds to the 46px rail **mid-drag**, under
   the pointer. Keep dragging right without releasing and it un-folds at the same threshold.
3. **Restore.** After collapsing (by drag or by `[`), pressing `[` reopens the roster at **the user's
   stored width**, not 282.
4. **Reset.** Double-click the handle, or focus it and press `Home` → back to 282.
5. **Keyboard.** Tab to the handle; `←`/`→` nudge 16px per press; `Home` resets.
6. **Small window.** Shrink the window until the stored 520px no longer fits: the roster renders
   clamped. Widen the window again and it springs back to 520 — storage never changed.

## 4. Functional requirements

- **FR-1** `.app-grid` becomes **three tracks** — `<left> 12px 1fr` — with `column-gap: 0`. Today it
  is two tracks separated by `gap: var(--space-12)`; the 12px middle track reproduces that spacing
  exactly and **is** the handle's hit area (the same trick `SplitDivider` uses — no overlay stealing
  clicks from the card edge). `row-gap` and the grid's padding are unchanged.
- **FR-2** A new `RosterDivider` component renders into that middle track. Invisible at rest
  (transparent 2px `::before`), `cursor: col-resize`, tinted `var(--border-focus)` on hover, focus
  and drag — reusing the `.app-split-divider` visual rules rather than restating them.
- **FR-3** The roster width is one number persisted at `francois.rosterWidth` in the `layoutStore`
  localStorage slice, alongside `francois.showLeftPane`.
- **FR-4** **User width always wins over the regime.** `ROSTER` (282) is the seed default only. Once
  a width is stored it is the sole intent input to the first track. `ROSTER_SPLIT` (238) is deleted —
  no regime picks a width any more.
- **FR-5** **The regime constrains fit, it does not own intent.** The wide-end cap is
  `min(MAX_ROSTER_WIDTH, viewportWidth × frac)` where `frac` is `0.45` in `single` and `0.30` in
  `split`. This is the same class of constraint as the viewport itself: the **stored** value is
  untouched, so leaving split restores the user's width. `MIN_SPLIT_PANE_PX` (260) keeps guarding
  the panes independently.
- **FR-6** **Snap-collapse below `MIN_ROSTER_WIDTH` (180), live during the drag.** Crossing the
  threshold sets `showLeftPane = false` (roster → 46px rail) mid-`pointermove`; crossing back right
  sets it `true`. Neither writes `rosterWidth`. Pointer capture is on the **handle**, so the roster
  unmounting under the pointer does not end the drag.
  - Sanctioned degrade: if live snap proves unreliable in practice, applying the fold on `pointerup`
    (clamping at the 180 floor during the drag) is an accepted fallback and **not** a spec violation.
- **FR-7** `MIN_ROSTER_WIDTH` is both the snap threshold and the floor: while the roster is shown it
  never renders narrower than 180. If the cap computes below 180 (a very narrow window), the floor
  wins — clamp to `[MIN, max(MIN, cap)]`.
- **FR-8** **Clamp on read and on render, never rewrite storage.** A hand-edited `99999`, `"abc"`,
  `NaN`, a negative or a missing key all resolve without throwing (garbage → 282, out-of-range →
  clamped); a window too small for the stored width renders clamped and springs back. Follows
  `parseCollapsedPanes`' precedent: normalize, never throw, degrade silently.
- **FR-9** Double-click the handle → 282. This mirrors `SplitDivider`'s double-click-to-even-split.
- **FR-10** Keyboard: `tabIndex={0}`, `role="separator"`, `aria-orientation="vertical"`,
  `aria-label="Resize sidebar"`, `aria-valuenow` = rendered px, `aria-valuemin` = `MIN_ROSTER_WIDTH`,
  `aria-valuemax` = the current cap. `←`/`→` nudge by `KEY_STEP_PX` (16); `Home` resets to 282. The
  handler calls `preventDefault` + `stopPropagation` so the app's single-letter/arrow globals on
  `document` never see it — as `SplitDivider` already does.
- **FR-11** In the `grid` regime the handle is **not rendered**: split-by-4 forces the roster to the
  rail there (`showLeftPane: regime === 'grid' ? false : …`), and a handle that fights that setter
  would be two owners of the same flag.
- **FR-12** Grabbing the handle is a layout gesture: `onClick` stops propagation so it never moves
  focus between sessions (matching `SplitDivider` FR-12).
- **FR-13** **Extract `usePaneDrag`** into `src/lib/hooks/usePaneDrag.ts` — pointer capture, the
  once-per-drag measured box, the `app-resizing-x`/`-y` body class, and the `dragging` flag.
  **`SplitDivider` is refactored onto it in the same change**; it keeps its own ratio math and clamp.
  Two near-identical pointer-drag implementations where only one gets a fix is the outcome this
  forbids. No behaviour change to `SplitDivider` — its existing tests must stay green untouched.
- **FR-14** **Extract `useWindowWidth`** into `src/lib/hooks/useWindowWidth.ts` (a `window.innerWidth`
  state + `resize` listener) and move `AccountChip.tsx:25-28`'s inline copy onto it. The second
  consumer is what promotes it, per the shared-hook convention.

## 5. API contract

**No contract file and no IPC.** `contract/resizable-sidebar.ts` is deliberately not created — this
feature crosses no frontend↔core boundary and adds no Tauri command, event or persisted core state
(same shape as `diff-navigator`). The internal surface below is the whole interface.

`src/lib/layoutStore.ts` — constants, pure helpers and store slice:

```ts
export const DEFAULT_ROSTER_WIDTH = 282;
/** Both the snap threshold and the shown-roster floor (FR-6/FR-7). */
export const MIN_ROSTER_WIDTH = 180;
export const MAX_ROSTER_WIDTH = 560;
/** Fraction of the viewport the roster may take, by regime (FR-5). */
export const ROSTER_CAP_FRACTION: Record<'single' | 'split', number> = { single: 0.45, split: 0.3 };
export const ROSTER_WIDTH_STORAGE_KEY = 'francois.rosterWidth';
/** One arrow press (FR-10). */
export const ROSTER_KEY_STEP_PX = 16;

/** The wide-end cap for a regime + viewport. `grid` uses `single`'s fraction (FR-11: no handle). */
export function rosterCap(viewportWidth: number, regime: LayoutRegime): number;

/** Render-time clamp: intent ∩ what fits. Never persisted (FR-7/FR-8). */
export function clampRosterWidth(width: number, viewportWidth: number, regime: LayoutRegime): number;

/** Storage normalizer: garbage/absent → DEFAULT, else the raw stored intent (FR-8). */
export function parseRosterWidth(raw: string | null): number;

/**
 * Drag position → the next width and whether the roster should be folded (FR-6).
 * `gridContentLeft` is `.app-grid`'s content-box left (border box + padding-left).
 * `width` is always ≥ MIN_ROSTER_WIDTH and ≤ the cap; `collapse` is true when the
 * raw pointer distance fell below MIN_ROSTER_WIDTH.
 */
export function rosterWidthFromDrag(
  pointerX: number,
  gridContentLeft: number,
  viewportWidth: number,
  regime: LayoutRegime,
): { width: number; collapse: boolean };
```

Store slice additions:

```ts
rosterWidth: number;                    // the stored INTENT, unclamped by viewport
setRosterWidth: (px: number) => void;   // persists; does not touch showLeftPane
resetRosterWidth: () => void;           // → DEFAULT_ROSTER_WIDTH, persists
```

`src/app/appShell.ts` — `shellColumns` widens and gains a third track:

```ts
export interface ShellColumns {
  /** `grid-template-columns` for `.app-grid` — now THREE tracks: left, 12px gutter, 1fr. */
  template: string;
  leftRail: boolean;
  /** FR-11: false in the `grid` regime, where the roster is forced to the rail. */
  showHandle: boolean;
}

export function shellColumns(
  regime: LayoutRegime,
  showLeftPane: boolean,
  rosterWidth: number,     // the stored intent
  viewportWidth: number,   // for the cap
): ShellColumns;
```

`regime` **stays** a parameter (contrary to the brainstorm's conditional note): it no longer picks a
width, but it still selects the cap fraction and `showHandle`.

`src/lib/hooks/usePaneDrag.ts`:

```ts
export interface PaneDragBox { start: number; size: number }
export function usePaneDrag(opts: {
  axis: 'x' | 'y';
  /** Measured once per drag from the handle element (its grid parent's box). */
  measure: (handle: HTMLElement) => PaneDragBox | null;
  onDrag: (pos: number, box: PaneDragBox) => void;
}): {
  dragging: boolean;
  handlers: Pick<React.DOMAttributes<HTMLDivElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>;
};
```

`src/lib/hooks/useWindowWidth.ts`: `export function useWindowWidth(): number;`

## 6. Data & state

- **Frontend, persisted** — `francois.rosterWidth` (localStorage, plain integer string). Written on
  drag-release, arrow nudge and reset; **never** written by the snap-collapse or by a clamp.
- **Frontend, derived** — the rendered width `clampRosterWidth(rosterWidth, useWindowWidth(), regime)`,
  recomputed on every render of the shell. Not stored anywhere.
- **Frontend, existing** — `showLeftPane` (`francois.showLeftPane`) keeps its exact current meaning.
  Visibility and width are **two independent pieces of state**; that separation is what makes the
  snap gesture non-destructive and is the single thing this spec must not paper over.
- **Core** — none. Nothing is persisted outside the webview.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| No stored value (first run) | 282 — indistinguishable from today. |
| Garbage in storage (`"abc"`, `null`, `NaN`, `""`) | `parseRosterWidth` → 282. Never throws. |
| Stored `99999` / negative | Stored intact; renders clamped to the cap / to 180. |
| `localStorage` unavailable (restricted env, node tests) | Reads → 282, writes swallowed — the `try/catch` shape `loadPane`/`persistPane` already use. |
| Window shrinks below the stored width | Renders clamped; springs back on widen. Storage untouched. |
| Cap computes below 180 (very narrow window) | Floor wins: renders at 180 (FR-7). |
| Drag crosses the snap threshold | Rail at 46px, `showLeftPane=false`, `rosterWidth` untouched; recrossing right restores. |
| Drag while roster is already the rail | Handle is still present (single/split) — dragging right past 180 un-folds it. |
| `grid` regime | No handle (FR-11); the rail is forced as today. |
| Pointer released outside the window / pointercancel | Pointer capture releases, `dragging` clears, the last committed width stands. |
| Entering split with a 520px roster | Clamped to `min(560, 0.30 × viewport)`; leaving split restores 520. |

## 8. Design brief

No new chrome is drawn: the handle is invisible at rest and reuses `.app-split-divider`'s existing
2px rule, `var(--border-focus)` tint and `col-resize` cursor. The only visual change is that the
roster's width becomes user-set — so **`Francois Redesign.dc.html` now owns the 282px *default* and
no longer the runtime value**. A later `/cohorte-review` or `/cohorte-align-ds` must not flag that
divergence as design drift.

> full brief: specs/design/resizable-sidebar.md

## 9. Acceptance criteria

- [ ] Dragging the gap between roster and main cell resizes the roster live; the width survives a restart. (FR-1, FR-2, FR-3)
- [x] The roster is 282px on first run and 238px never appears in any regime. (FR-4)
- [x] A 520px roster clamps entering split and returns to 520 on leaving it. (FR-5)
- [ ] Dragging left past 180px folds to the 46px rail mid-drag; dragging back right un-folds without releasing. (FR-6)
- [ ] After a drag-collapse, `[` reopens the roster at the user's width, not 282. (FR-6)
- [x] A hand-edited `francois.rosterWidth` of `99999`, `-5` or `"abc"` never throws and renders clamped/default; storage is unchanged after render. (FR-8)
- [x] Shrinking the window clamps the roster; widening restores the stored width. (FR-7, FR-8)
- [ ] Double-click and `Home` both reset to 282; `←`/`→` nudge 16px and do not trigger the app's global shortcuts. (FR-9, FR-10)
- [x] The handle is absent in the `grid` regime. (FR-11)
- [x] Clicking the handle does not change the focused session. (FR-12)
- [x] `SplitDivider` runs on `usePaneDrag`, and its existing tests pass unmodified. (FR-13)
- [x] `AccountChip` runs on `useWindowWidth`; no inline `resize` listener remains there. (FR-14)
- [x] Unit tests cover `parseRosterWidth`, `clampRosterWidth`, `rosterCap` and `rosterWidthFromDrag` (floor, cap per regime, snap boundary, garbage input). (FR-5..FR-8)
- [x] `npx tsc --noEmit` and `npm test` are green; `cargo test` is untouched (no core change).

## Remediation

- 2026-08-19 — 2 findings, all fixed
