# DESIGN BRIEF — Change permission mode during a session (`session-permission-mode`)

> The "spec return". §8 of `specs/session-permission-mode.md`, standalone.

**Goal:** the user changes a live session's permission mode from the session row, without recreating
the session — and can always read, at a glance, which mode the focused session is in.

**Design system:** the existing UI kit (`src/ui/`) and tokens (`src/styles.css`). Desktop only —
Francois is a native desktop app, so the responsive section below is about window *resize*, not
breakpoints. Visual source of truth: `Francois Redesign.dc.html` (turn 7a) + `Francois Design System
v2.dc.html`.

## Screens / views

Two elements, both inside the **session row** — the second full-bleed chrome tier, right cluster,
between the model chip and the `wsl` badge.

- **Mode badge** (`session-row__mode`) — reports the focused session's permission mode and opens the
  picker. It exists today but is conditional and inert; this feature makes it persistent and
  interactive.
  - Elements: the option's `short` label (`default` · `plan` · `edits-ok` · `bypass`).
  - Geometry, type role and border: unchanged from today's badge — it sits in a row of small chips
    (model chip, `wsl` badge) and must not grow or shift them.
  - States:
    - **default / plan / edits-ok** — neutral chip treatment (today's `session-row__mode`).
    - **bypass** — danger treatment (today's `session-row__mode--danger`), unchanged.
    - **hover** — pointer cursor + the same subtle lift the session name and project crumb use, so it
      reads as a control rather than a label. Tooltip: `permission mode: <label> — click to change`.
    - **open** — held in the hover/active treatment while the popover is up.
    - **no focused session** — not rendered (the whole right cluster is hidden).

- **Mode popover** — a small panel anchored under the badge, right-aligned to it.
  - Elements: four rows in `PERMISSION_MODE_OPTIONS` order —
    `default` · `plan` · `accept edits` · `bypass`. Each row is the full `label` in the primary type
    role with its `hint` beneath in the muted role:
    - default — *inherit your Claude settings (~/.claude)*
    - plan — *read & plan only — never edits or runs commands*
    - accept edits — *auto-approve file edits; other tools follow your settings*
    - bypass — *skip every permission check — full access*
  - **Current-mode marker:** a neutral filled marker (the same `☑`/`◉`-class treatment the question
    cards use), **not acid**. The badge is a repeatable surface — one per pane, and both panes of a
    split can show one — so per the 2026-08-17 `ui` decision it takes the neutral marker treatment,
    leaving the view's single acid for whatever is genuinely singular.
  - **bypass row:** danger tone on the label and hint. No confirm step, no second click — the tone
    and the consequence text carry the warning (2026-08-13 `ui`: annotate, don't block).
  - **Busy line:** when the focused session's status is busy, one muted line under the four rows —
    *turn running — applies to the next turn*. It is informational only; every row stays enabled.
  - States: **idle** (four rows, current marked) · **busy** (adds the line) · **error** (an inline
    error line replaces the busy line, popover stays open, badge unchanged) · there is no loading
    state — the call is local and resolves in a frame.

## Flows

1. User clicks the mode badge → popover opens under it, current mode marked.
2. User clicks a row → `switchPermissionMode` fires → the badge re-renders from the `session.meta`
   event → popover closes.
3. Clicking the already-current row behaves identically (closes, no visible change).
4. Dismissal: outside click or `Escape` (shared `useDismiss` hook), same as every other Francois
   popover. **No bare-letter shortcut opens it** — bare letters are global keys and the PTY forwards
   unmodified keys verbatim (2026-08-04 `ui`).
5. On failure: popover stays open, inline error line, badge keeps the store's value (no optimistic
   update).

## Responsive

- The session row is full-bleed and its right cluster is already crowded (model chip · mode badge ·
  `wsl` badge · context/elapsed figure). The badge takes the `short` label precisely so it stays one
  short token at every width; it must never wrap or push the figure onto a second line.
- On a narrow window the cluster truncates from the left, as it does today — the mode badge is not
  given priority over the model chip.
- The popover is anchored to the badge and right-aligned, so it never overflows the window edge; if
  the badge is close to the right edge it stays flush with it rather than shifting off-screen.
- In a split, each pane's session row renders its own badge and its own popover; only one popover is
  open at a time (opening one closes the other by outside-click dismissal).

## Data shown

Everything comes from the focused session's `SessionMeta` plus the contract's option table:

| On screen | Source |
|---|---|
| badge text | `PERMISSION_MODE_OPTIONS[…].short` for `SessionMeta.permissionMode` |
| badge tone | `PERMISSION_MODE_OPTIONS[…].danger` |
| row label / hint | `PERMISSION_MODE_OPTIONS[…].label` / `.hint` |
| current marker | `SessionMeta.permissionMode` |
| busy line | `SessionMeta.status` (existing busy-status helper) |
| error line | `Result.error.message` from `SessionSwitchPermissionModeResponse` |

No component maps a mode to a label, short label or hint on its own (spec FR-8).

## Notes / constraints

- Copy is **English**, lower-case, matching the existing chips and hints — the four hint strings are
  the ones already shipped in the New Session modal and must not be reworded here; they now live in
  `contract/session-permission-mode.ts` and are shared by both surfaces.
- Styling is per-feature CSS + classNames. The popover lives in `src/features/permissions/` with its
  rules in that feature's stylesheet; the badge keeps its existing `session-row__*` rules in the
  shell's `app.css`, extended with the hover/open affordance. **No inline `style={{}}`.**
- Cap font-weight at 600 (2026-08-04 `ui`).
- Icons, if any, are `lucide-react` inheriting `currentColor` — but the picker needs none beyond the
  existing disclosure/marker glyphs.
- Accessibility: the badge is keyboard-reachable and the popover is `Escape`-dismissible; the current
  mode is conveyed by the marker and the label, never by colour alone (`bypass` is danger-toned *and*
  carries its consequence text).
- The New Session modal's permission chips keep their current appearance — they are re-pointed at the
  shared option table, not redesigned.
