# DESIGN BRIEF — Desktop notifications (`notifications`)

> The "spec return". Paste into the design tool (Claude Design). Standalone version of
> `specs/notifications.md` §8. Visual source of truth: `Claude Terminal.dc.html` + `screenshots/`.

**Goal:** know that a background session is blocked on you (approval / question) or has finished its
turn, without watching the window — and be able to silence the chatty half without going blind to the
blocking half.

**Design system:** the existing UI kit (`src/ui/`) and the existing status bar / command palette.
Tokens from `src/styles.css`. JetBrains Mono throughout. **This is a fixed-size desktop app, not a
responsive web page** — there is no mobile breakpoint.

**The defining constraint:** the notification itself is **OS-rendered and not styleable**. Only its
title, body and icon are ours. So this brief is about the *near-nothing* in-app surface — and the
guiding decision is that the default (everything on) state must add **zero** chrome to the status bar,
which design-refresh FR-10 deliberately condensed down to `⌘K · focus · account · theme · version`.

## Screens / views

### 1 — Status bar "muted" chip (new, conditional)

The only new persistent element, and it is **absent** in the default state.

- Purpose: a single honest cue that you have silenced something — you should never be partially deaf
  without knowing it, and you should never pay chrome for the state you are in 95% of the time.
- Placement: `.app-status-bar` right cluster, **before** `AccountChip` (so the leftmost thing in the
  right cluster is the exception, not the routine).
- Elements: glyph `◇` (U+25C7, hollow diamond) + label. One `<span>`, inline, matching the existing
  status-bar item rhythm (glyph + label, `16px` gap from neighbours), 10.5px.
- Copy:
  - one class muted → `◇ muted`
  - both classes muted → `◇ muted (all)`
- Native `title` tooltip names exactly what is silenced, e.g. *"turn-finished notifications are off"* /
  *"all notifications are off"*.
- Colour: `--text-faint` for both glyph and label — this is a *quiet* warning, not an alarm. It must
  not compete with the accent-coloured `⌘K` at the other end of the bar. **No** red, no pulse, no
  badge, no animation.
- States:
  - **hidden** — both classes on. Renders nothing at all (not an empty span, not a spacer).
  - **default** — faint glyph + label.
  - **hover** — label brightens to `--text-hint`; glyph unchanged; no background change; cursor
    pointer.
  - No focused / disabled / loading states — it is either absent or interactive.

### 2 — Command palette rows (two new commands)

Where the toggles actually live. Two rows in the existing `⌘K` list, using the standard palette row
treatment (glyph, name, right-aligned hint) with no new component.

- **`Notifications: approvals & questions`** — glyph `◈` (U+25C8, filled diamond). Hint reads the
  live value: `on` / `off`.
- **`Notifications: turn finished`** — glyph `◈`. Hint reads `on` / `off`.
- Ordering: the blocking class first, the noisy class second — the same "non-destructive reads first"
  logic the sidebar context menu uses.
- States: **default** · **highlighted** (existing palette row highlight) · the hint text is the only
  thing that changes after a run — the row does not disappear or re-order.
- Running a row flips the value immediately, closes the palette (existing palette behaviour), and the
  muted chip appears or disappears in the same frame.

## Flows

1. **Silencing the noise.** `⌘K` → type `noti` → both rows filter in → `↵` on *Notifications: turn
   finished* → palette closes → `◇ muted` fades into the status bar right cluster. Approval and
   question pings keep arriving.
2. **Checking what's muted.** Hover the chip → tooltip names the silenced class. Click the chip →
   the palette opens (pre-filtered is *not* required) so the fix is one row away.
3. **Restoring.** `⌘K` → the same row, hint now reads `off` → `↵` → hint reads `on`, chip disappears.
4. **Default install.** Nothing new is visible anywhere. The first notification the user ever sees is
   the OS permission prompt, then the OS notification itself.

## Data shown

Everything below is exactly what spec §5 `contract/notifications.ts` produces — no other field
reaches the screen.

- **Chip:** derived from `enabled: Record<NotifyClass, boolean>` only. No counts, no session names.
- **Palette hints:** `enabled.attention` / `enabled.turnDone` rendered as `on` / `off`.
- **OS notification** (not styleable — reference only, `notificationBody()`):
  - Title: `francois` — a stable identity so pings group under the app name.
  - Body, separator U+00B7:
    - `api-refactor · needs approval: Bash`
    - `api-refactor · needs an answer`
    - `api-refactor · turn finished`
    - `api-refactor · error`
    - `nightly-build · done`
  - Icon: the bundled app icon from `tauri.conf.json`; `Options.icon` is omitted.

## Notes / constraints

- **Copy is lowercase English**, matching every other status-bar item (`commands`, `focus`, `theme`).
  The palette command *names* keep their sentence case, matching the existing palette rows.
- **Deliberately excluded from the notification body:** the `PermissionAsk.summary`, the tool input,
  the cwd and the question text. They would put command text and file paths into the OS notification
  centre, which persists outside the app and outside the user's control. The tool *name* (`Bash`,
  `Write`) is the most triage value per character that is safe to leak.
- **No in-app toast, banner, or nag** — ever, including when OS permission is denied. The
  command-palette owns in-app toasts; this feature is strictly OS-level. A denied permission is
  silent by design.
- **No notification retraction** when an ask is resolved elsewhere — desktop platforms do not support
  it reliably, so a stale tray entry is expected and clicking it simply selects the session.
- **Resize:** the status bar is a single flex row; the chip keeps its natural width and never wraps.
  The `flex: 1` spacer absorbs any shortfall before any status item, and `◇ muted` is short enough to
  survive every supported width.
- **Accessibility:** the chip is a real interactive element with a `title`; its meaning is carried by
  the label text, not by the glyph or colour alone (the `◇`/`◈` distinction is decorative — the words
  `muted` and `on`/`off` carry the state).
