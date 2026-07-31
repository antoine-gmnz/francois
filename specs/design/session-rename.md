# DESIGN BRIEF — Session rename (`session-rename`)

> The "spec return". Paste into the design tool (Claude Design). Standalone version of
> `specs/session-rename.md` §8. Visual source of truth: `Claude Terminal.dc.html` + `screenshots/`.

**Goal:** correct a session's name after creation, from the sidebar row or ⌘K, without leaving the
current view.

**Design system:** the existing UI kit (`src/ui/` — `Modal`, `Button`) and the existing
`NameField` from the new-session modal. Tokens from `src/styles.css`. JetBrains Mono throughout.
**This is a fixed-size desktop app, not a responsive web page** — there is no mobile breakpoint.

## Screens / views

### 1 — Sidebar row context menu (modified)

The existing `.context-menu` popup on a pane [1] session row. Today it holds a single item,
"Remove session".

- Elements: **"Rename session"** added as the **first** item, "Remove session" below it. Same
  `.context-menu__item` treatment as the existing item — 13px, same row padding, same hover
  background. No glyph, no icon, no divider between the two: two peers, and a rule would make a
  two-item menu look heavier than it is.
- Ordering rationale: the non-destructive action reads first; the destructive one stays last, where
  the eye lands least by accident.
- States: **default** (both items) · **hover** on either item · **confirming** and **error** are the
  existing remove-flow states and are **unchanged** — "Rename session" is not rendered in either, so
  the confirm step never offers a second escape route.

### 2 — Rename modal (new)

The smallest modal in the app — one field, one decision.

- Purpose: edit the name and commit or cancel.
- Elements, top to bottom:
  - **Title**: `RENAME SESSION` — uppercase, letter-spaced, the same header treatment every other
    modal title uses.
  - **`NameField`** — reused verbatim from the new-session modal: `NAME` label above a full-width
    input, placeholder `session name`. Prefilled with the current name, **fully selected on open**,
    so the first keystroke replaces it.
  - **Inline error line** — appears only after a failed commit, directly under the input: 12–13px,
    the app's error red, the core's `error.message` rendered as-is. It pushes the action row down
    rather than overlaying anything; the modal grows by one line.
  - **Action row**, right-aligned: `Cancel` (secondary) · `Rename` (primary).
- Width: narrower than the new-session modal — it carries one field, not seven. Vertically centered,
  same scrim/backdrop as every other modal.
- States:
  - **default** — prefilled, selected, `Rename` enabled.
  - **invalid** — trimmed input empty or over 80 characters: `Rename` disabled (dimmed, not hidden).
    No inline message in this state; the disabled button is the signal, and a message that appears
    the instant you clear a field to retype reads as nagging.
  - **in-flight** — `Rename` disabled while the call is out. The call is near-instant (an in-memory
    mutation plus a file write), so **no spinner** — a spinner that flashes for 8ms is noise.
  - **error** — inline line under the input, `Rename` re-enabled so the user can correct and retry.
  - There is no loading or empty state: the modal never opens without a session and a name.

### 3 — ⌘K palette (one row added)

- Element: a command row `✎  Rename session`, using the palette's existing 16px glyph column, 13px
  name, no right-aligned hint.
- States: **listed** when a session is selected · **absent entirely** when none is (the palette hides
  disabled commands rather than graying them — matches every other session-scoped command there).
- No other change to the palette's layout, ranking, or empty state.

## Flows

**A — mouse:** right-click a session row → context menu → "Rename session" → the menu closes and the
modal opens, prefilled and preselected → type → Enter or click `Rename` → the modal closes and the
name updates simultaneously in the sidebar row, the main tab strip, the status bar and the overview
rollup.

**B — keyboard:** ⌘K → type `ren` → Enter → the palette closes and the same modal opens for the
active session → continue as A. The whole path is keyboard-only; the input is already focused and
selected when the modal appears.

**C — cancel:** Escape, `Cancel`, or a click on the backdrop closes the modal with nothing changed.

**D — failure:** a rejected name keeps the modal open with the error line under the input; the input
keeps what the user typed, so they can fix it rather than retype it.

## Data shown

- The session's **current name** (prefilled input value) — from the cached `SessionMeta.name`.
- The core's **`error.message`** on failure — rendered verbatim, never rewritten in the UI.
- Nothing else. No id, no path, no status, no branch — this modal edits one field.

## Notes / constraints

- **Copy is English, lowercase-leaning** to match the app's existing voice: menu item
  `Rename session`, buttons `Cancel` / `Rename`, title `RENAME SESSION`.
- **The worktree branch is deliberately not shown or explained here.** A renamed session keeps its
  original `feat/<slug>` branch, and the worktree card keeps showing that real branch with **no added
  hint or warning** — the branch name is the truth about git, and annotating it would imply something
  is broken when nothing is.
- **Accessibility / focus**: focus moves into the input on open and returns to the sidebar row (or the
  element that had it) on close. Escape must work from anywhere inside the modal. The disabled
  `Rename` button stays focusable-skipped but visible, so its state is readable rather than
  disappearing.
- **Motion**: reuse whatever open/close transition the existing modals use. Nothing bespoke — this
  modal should feel like the app's other modals, only smaller.
- **Duplicate names are legal** — no warning, no badge, no disambiguation glyph. Two rows may read
  identically.
