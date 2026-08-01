# DESIGN BRIEF — Self-update (`self-update`)

**Goal:** the user notices that a newer Francois exists, reads what changed, and installs it with one
click without leaving the window.

**Design system:** the existing Francois UI kit (`src/`, tokens in `src/styles.css`, mock
`Claude Terminal.dc.html`). Native desktop app — dark surfaces, JetBrains Mono for data, no mobile
breakpoints (see §Responsive). Two touch points only, both inside chrome that already exists; this
feature adds no new region to the shell.

## Screens / views

- **Status-bar version readout** — the far-right element of `app-status-bar`
  (`src/app/StatusBar.tsx:66`), today a static `<span className="app-key">{appVersion}</span>`. It
  gains one new state and is otherwise untouched.
  - **idle** (no update, check failed, or check not yet returned): exactly as today —
    `--text-dim`, mono, `--font-size-10`, the running version, not interactive. A failed launch
    check is indistinguishable from no update; that is deliberate (spec FR-7).
  - **update available**: `↑ 0.16.0` — the up-arrow glyph then the *latest* version, not the
    current one. `--accent` text, `--accent-soft-bg` fill, 1px `--accent` border, `--radius-md`,
    same 10px uppercase mono metrics as the neighbouring `app-key` chips so the bar's rhythm does
    not shift. Cursor pointer, `title="Francois 0.16.0 is available"`.
  - **hover**: `--accent-bright` text. **focus-visible**: 1px `--border-focus` ring, no layout shift.
  - Position is unchanged — last in the right cluster, after the theme toggle. `AccountChip` sits
    two places to its left and establishes the pattern being followed here: a status-bar chip that
    opens a modal.

- **Update modal** — everything the user needs to decide. Opened from the chip and from the palette
  command `Check for updates`.
  - Chrome: reuse `src/ui/Modal.tsx` verbatim — centered panel over `--backdrop`, `--bg-raised`
    surface, 1px `--border-emphasis` frame, `--radius-xl`, `--shadow-modal`. Narrow: `min(560px, 92vw)`.
  - Header: `UPDATE` (mono, uppercase, letterspaced, `--text-dim`, `--font-size-10`), close `✕` right.
  - Headline: the version transition on one line —
    `0.15.8` in `--text-muted`, a `→` in `--text-faint`, `0.16.0` in `--accent-bright`, mono,
    `--font-size-15`. This is the first thing read; nothing sits above it.
  - Notes block: the release body, **preformatted mono text, never rendered as HTML or markdown**
    (spec FR-10). `--bg-deep` surface, 1px `--border` frame, `--radius-md`, `--text` at
    `--font-size-11-5`, `--space-10` padding, capped at `240px` tall and scrolling internally with
    the app's existing thin scrollbar. When notes are absent: a single centered
    `Release notes unavailable` line in `--text-faint`, same frame, no scroll area.
  - Footer row: `View release ↗` on the left — ghost link, `--text-dim` → `--text-bright` on hover,
    opens `notesUrl` in the system browser. Primary action on the right (below).
  - **States:**
    - **update available, npm install** — primary button `Update and restart`, `--accent` fill,
      `--text-bright` label, `--radius-md`, `--shadow-pill`.
    - **applying** — the button becomes `Updating…`, disabled, `--accent` at reduced emphasis, with
      the app's existing dim shimmer on the label. The modal stays open and the window closes under
      it; there is no success state to design, because a successful update ends this process.
    - **blocked by running sessions** — button disabled (`--text-disabled` on `--bg-elevated`,
      `not-allowed` cursor) reading `2 sessions running`, with one `--text-muted`
      `--font-size-11` line beneath: `Francois has to quit to update. Finish or stop the running
      turns first.` Count is live and re-derives while the modal is open.
    - **manual install** — no button at all. In its place, a copyable command row:
      `npm i -g francois@latest` in `--text-bright` mono on `--bg-deep`, 1px `--border`,
      `--radius-md`, with a `COPY` ghost button on the right that flips to `COPIED` in `--success`
      for ~1.2 s. Above it, one `--text-muted` `--font-size-11` line: `This copy wasn't installed
      through npm, so Francois can't update it in place.`
    - **up to date** (manual check only) — no notes block, no footer. A single centered line,
      `You're on the latest version (0.15.8)`, `--text-muted`, with a `--success` `✓` before it.
    - **check failed** (manual check only) — a centered `--error` line carrying the error message,
      and a `Retry` ghost button. No version headline, since neither version is known.

## Flows

1. App launches → shell mounts → check fires → readout flips to `↑ 0.16.0`. Nothing takes focus.
2. Click the readout → modal opens, focus lands on the primary action.
3. `Update and restart` → button → `Updating…` → window closes → app reopens on the new version.
4. Or: `⌘K` → `Check for updates` → check runs → modal opens on whichever state the result implies
   (available / up to date / failed). This is the only path that surfaces a failed check.
5. `Esc` or `✕` closes the modal at any point before the click; after it, the window is going anyway.

## Responsive

Desktop-only Tauri window; there are no breakpoints. What must hold under **window resize**:

- The modal is capped at `min(560px, 92vw)` wide; the notes block scrolls internally while the
  headline and footer stay pinned.
- The status-bar readout never wraps and never pushes the bar taller. Below ~720px of window width
  the status bar already drops its left-hand hints; the update chip is in the right cluster and
  survives — it is the last thing to go, after `AccountChip`.

## Data shown

Everything comes from `UpdateCheck` / `UpdateApplyAck` in `contract/self-update.ts` (spec §5):

- readout: `updateAvailable`, `latest`, `current` (idle state)
- headline: `current`, `latest`
- notes block: `notes` (absent → the unavailable line)
- footer link: `notesUrl`
- manual state: `command`, `method`
- blocked state: the running-session count, derived from the existing `sessions` store slice —
  not from the contract

`checkedAt` and `logPath` are carried by the contract but are **not** rendered; `logPath` exists for
diagnosing a failed update from disk, not for display.

## Notes / constraints

- Copy is English (profile `ui_language`), sentence case in prose lines, uppercase mono for chips
  and section labels — matching the rest of the shell.
- Release notes are third-party text from a GitHub release body: render as plain preformatted text,
  never as HTML.
- The update chip must never animate, pulse, or steal focus. It is ambient information; the release
  cadence means it will be present most of the time and anything louder would become noise.
- Accessibility: the readout is a real `<button>` with an accessible name naming the version, not a
  clickable `<span>`. The modal traps focus and returns it to the chip on close. Disabled states
  carry their reason as text, not only as color — the running-session count is legible without it.
- Both themes: the accent chip must clear contrast on `--bg-panel` in light as well as dark; check
  the light theme, where `--accent-soft-bg` is much closer to the bar's background.
