# DESIGN BRIEF — Audio cues for attention and turn-done (`audio-cues`)

> §8 of `specs/audio-cues.md`, standalone. Desktop app (Tauri webview), not a website — the
> "mobile-first / responsive" sections of the template do not apply and are answered as such.

**Goal:** the user hears that a session needs them, or that a turn finished, without looking at
Francois — and can always see *why* the app is silent when they have turned that off.

**Design system:** the existing UI kit (`src/ui/`) and the tokens in `src/styles.css`. Visual source of
truth: `Francois Redesign.dc.html` + `Francois Design System v2.dc.html`.

## Screens / views

There is **no new screen and no new component**. Two existing surfaces change.

- **Status bar — `◇ muted` chip** (`src/features/notifications/NotifyMutedChip.tsx`, right cluster of
  `.app-status-bar`, immediately before `AccountChip`) · roles: n/a (`rbac.enabled: false`)
  - Elements: glyph `◇` (U+25C7) + a one-word label. Dim `--text-faint`, no border, no background —
    unchanged chrome. Native `title` on hover. Click opens the command palette.
  - States:
    - *all-on (default)* — **renders nothing.** Zero chrome in the state the app is in almost always.
      This is the state design-refresh FR-10 condensed the bar for; do not spend a slot on it.
    - *one or two of three channels off* — `◇ muted`
    - *all three off* — `◇ muted (all)`
    - loading / error / empty: n/a — the value is local state, always resolved.
  - The only change from today: the condition and the `title` widen from two channels to three.
    Do **not** add a count, a second chip, or a colour.

- **Command palette — one new row** (`⌘K`, `src/features/palette/`)
  - Elements: glyph `◈`, name **"Sound: audio cues"**, right-aligned hint reading `on` / `off`.
  - Placement: directly after *"Notifications: approvals & questions"* and *"Notifications: turn
    finished"*, so the three mute controls read as one contiguous group.
  - States: `on` (default) · `off`. No disabled state, no confirmation.

## Flows

1. A session needs attention or a turn settles → a **tone plays**. Nothing on screen changes; the
   existing banner and fleet-card behaviour are untouched.
2. The user finds it chatty → `⌘K` → types "sound" → the row is matched → `⏎` flips it to `off`.
3. The palette closes. The `◇ muted` chip appears in the status bar (or, if it was already showing for
   a notification class, its `title` gains `audio cues`).
4. Hovering the chip reads exactly what is silenced, e.g. `turn finished notifications, audio cues are
   off`. Clicking it re-opens the palette to fix it.

No role-specific variation.

## Responsive

Desktop-only app; the window resizes but there are no breakpoints here.

- The chip is one of the bar's fixed right-cluster items and never wraps or truncates — both labels
  (`muted`, `muted (all)`) are short by design, which is the reason the detail lives in the `title`
  rather than in the chip.
- The palette row inherits the palette's existing row layout and truncation.

## Data shown

Everything on screen derives from three booleans, and nothing else — no counts, no session names, no
timestamps (matching the shipped chip's rule).

| Surface | Value | Source (spec §5) |
|---|---|---|
| chip label | `null` \| `'muted'` \| `'muted (all)'` | `mutedChipLabel(off: MutedChannel[])` |
| chip `title` | enumerated off-channels + `' are off'`, or `MUTED_ALL_TITLE` | `mutedChipTitle`, `MUTED_CHANNEL_LABEL` |
| palette hint | `'on'` \| `'off'` | `soundEnabled` (notificationsStore) |

Channel phrases are fixed strings from the contract — `approvals & questions notifications`,
`turn finished notifications`, `audio cues` — do not re-word them in the component.

## Notes / constraints

- **The tones are specified, not designed.** Exact frequencies, gains and envelopes are pinned in
  `contract/audio-cues.ts` (`TONES`) and are not a design deliverable: `attention` = 660→880 Hz rising,
  peak gain 0.05, 180ms; `turnDone` = 440 Hz, peak gain 0.035, 140ms. Both sine, 8ms attack,
  exponential decay. There is deliberately **no volume control** — OS volume is the user's dial.
- **No acid.** Nothing in this feature is the one live/focused thing in a view, so nothing takes
  `--accent`. The chip stays `--text-faint`; the palette row takes standard row treatment. (2026-08-17
  `ui` decision: acid marks the one singular surface.)
- **Never a silent app with no visible reason.** The chip is the entire justification for widening it
  to three channels — if sound can be off, the bar must say so. Do not make the chip conditional on
  anything else.
- **No in-app audio affordance.** No test-tone button, no volume slider, no per-session control, no
  toast when a tone is swallowed by the browser autoplay policy. Failures are silent by design
  (spec FR-10).
- **Copy is English** (`ui_language: English`), lowercase in the chip, sentence case in the palette
  name, matching the two shipped notification rows.
- Accessibility: the tone is an *additional* channel, never the only one — every trigger it fires on
  already has a banner, a fleet-card state, and a transcript entry. A user who cannot hear it loses
  nothing that was not already on screen.
