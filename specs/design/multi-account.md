# DESIGN BRIEF — Multi-account (several Anthropic accounts) (`multi-account`)

**Goal:** the user registers several Anthropic accounts, sees at a glance which one a session runs
on, and picks one when opening a session.

**Design system:** the existing Francois UI kit (`src/`, tokens in `src/styles.css`, mock
`Claude Terminal.dc.html`). Native desktop app — dark surfaces, JetBrains Mono for data,
IBM Plex Sans for prose, no mobile breakpoints (see §Responsive).

## Screens / views

- **Accounts modal** — manage the registered accounts. Opened from the status-bar account chip, the
  command palette (`Accounts`), and the Accounts row of the new-session modal.
  - Chrome: centered panel over `--backdrop`, `--bg-raised` surface, 1px `--border-emphasis` frame,
    `--radius-panel`, `--shadow-modal` — identical to the **Projects modal**; reuse it verbatim.
  - Header: `ACCOUNTS` (mono, uppercase, letterspaced, `--text-dim`) + `[+ ADD ACCOUNT]` ghost
    button on the right (`--accent` text, `--border` frame, `--accent-soft-bg` on hover).
  - Row (one per account, `--space-10` vertical rhythm, `--bg-hover` on hover/cursor):
    - left: **label** (`--text-bright`, mono) and, under it, **email** (`--text-muted`, 11px mono).
      When label === email, show the email alone.
    - a `DEFAULT` pill on the default row: `--accent` text on `--accent-soft-bg`, 1px `--accent`
      border, `--radius-pill`, 10px uppercase mono.
    - middle: that account's **usage meters** — reuse the usage-bar meter chip exactly (fill bar,
      `%` number, `--success` → `--warn` → `--error` at ≥80%). `—` when the snapshot is `empty`, a
      dim shimmering `…` when `loading`, `--error` text when `error`.
    - right: actions, revealed on row hover/focus, icon-or-text ghost buttons in `--text-dim`,
      `--text-bright` on hover: `SET DEFAULT` · `RENAME` · `RE-LOGIN` · `REMOVE` (`--error` on
      hover). The built-in `Default` row shows no `REMOVE`.
    - An account flagged `authFailedAt` / missing its config dir: a `NEEDS LOGIN` pill in `--error`
      on `--bg-elevated`, and `RE-LOGIN` shown permanently rather than on hover.
  - Footer: one line of `--text-faint` 11px prose — "Each added account keeps its own Claude Code
    configuration: settings, skills, agents and MCP servers are not shared."
  - States: **list** (default) · **login** (see below) · **rename** (the label becomes an inline
    text input on the row, `Enter` commits / `Esc` cancels) · **remove-confirm** (see below).

- **Login view** (replaces the modal body while an account is being added)
  - A title line: `LOGGING IN — complete the Claude Code sign-in below` (`--text-dim`), then an
    xterm.js terminal filling the panel: `--bg-deep`, 1px `--border` frame, `--radius-panel`,
    JetBrains Mono 12px, the same theme object the SHELL tab uses. Raw passthrough — the real
    `claude` TUI renders here, colors and all.
  - Below: `Esc to cancel` hint in `--text-faint`.
  - States: **connecting** (frame with a centered `--text-muted` `starting claude…`) · **live**
    (terminal) · **success** (terminal fades out over ~120ms, row appears in the list, brief
    `--success` flash on the new row) · **error** (terminal replaced by an `--error` message —
    "Login timed out", "This Anthropic account is already registered", "Could not start claude" —
    with a `TRY AGAIN` / `CLOSE` pair).

- **Remove confirmation** — a compact dialog inside the modal: `--bg-elevated`, `--error`-tinted
  1px border. Copy: `Remove <label>?` then, in `--text-dim`, "Its credentials on this machine will be
  deleted." and, when sessions are bound, "N sessions will fall back to Default:" followed by up to
  5 session names (`--text-muted`, `+N more`). Buttons: `CANCEL` (ghost) · `REMOVE` (`--error` text,
  `--error-dim` border).

- **New-session modal — `ACCOUNT` field** — a new row directly after `MODEL`, using the exact
  `ModelField`/select chrome already in that modal: label `ACCOUNT` in `--text-dim` mono uppercase,
  value in `--text-bright`. Options show `label` with the email as dim secondary text. The row is
  pre-selected from the project default or the app default; when a project pre-fills it, show the
  same "from project" affordance the other pre-filled fields use.

- **Status bar — account chip** — right cluster, before the usage bar: a small mono chip showing the
  selected session's account label (truncate at ~18 chars with `…`), `--text-dim`, `--text-bright` on
  hover, `--bg-hover` background on hover, `--radius-chip`. The default account's chip is rendered in
  `--text-muted` (quieter); a `NEEDS LOGIN` account renders it in `--error`. Click → Accounts modal.

- **Sidebar row — account badge** — pane [1]: for sessions **not** on the default account, a 10px
  uppercase mono badge after the session name, `--hue-blue` text on `--bg-elevated`,
  `--radius-pill` — the first 2 letters of the label, or the email's local part truncated to 6 chars,
  with the full label in the `title` tooltip. Nothing at all for default-account sessions, so the
  badge reads as "unusual account".

## Flows

1. Status bar chip (or `⌘K` → `Accounts`) → Accounts modal, list state.
2. `[+ ADD ACCOUNT]` (or `a`) → login view → the real `claude` TUI: theme choice, OAuth URL, paste
   code → on success the view returns to the list with the new row selected.
3. `Esc` during login → cancel, straight back to the list, nothing added.
4. Row actions: `Enter`/`SET DEFAULT` moves the `DEFAULT` pill · `r`/`RENAME` inline-edits the label
   · `Del`/`REMOVE` → remove-confirm → the row disappears and affected sidebar badges clear.
5. New session (`n`) → the `ACCOUNT` row is pre-filled → optionally change it → create → the sidebar
   row shows its badge and the status bar chip follows selection.

## Responsive

Desktop-only Tauri window; there are no breakpoints. What must hold under **window resize**:

- The Accounts modal is capped at `min(720px, 92vw)` wide and `min(560px, 80vh)` tall; the row list
  scrolls internally, header and footer stay pinned.
- The login terminal fits its container and re-fits on resize (same `FitAddon` discipline as the
  SHELL tab), forwarding the new geometry to the core.
- Row actions collapse to icon-only below ~560px of panel width; meters are the first thing dropped
  when the row runs out of room (label + email never truncate below ~10 chars).
- The status-bar chip truncates before the usage bar does; below ~900px window width it shows only
  the first 8 characters.

## Data shown

Per account: `label`, `email`, `isDefault`, `builtIn`, `authFailedAt` (as `NEEDS LOGIN`), and its
`UsageSnapshot` (`status`, `meters[].label/percentUsed/resetsAt`, `fetchedAt` as the meter tooltip's
freshness text). Remove-confirm additionally shows the names of the sessions in
`AccountRemoveData.reassignedSessions`. New-session field binds `NewSessionRequest.accountId`;
the sidebar badge and status chip read `SessionMeta.accountId`. (Types: spec §5.)

## Notes / constraints

- Copy in **English**, terminal register: uppercase mono for labels/actions, sentence case for prose.
- Never render a credential, token or file path from a config directory in the UI — the email is the
  only identity shown.
- The login terminal is a real TTY: keyboard focus must land in it on mount, and `Esc` must be
  intercepted by the modal (cancel) rather than forwarded to the TUI — state that hint visibly.
- Motion: modal 120ms ease-out fade+lift (existing modal transition); row hover 80ms; no spinners
  other than the existing dim-`…` idiom.
- Accessibility: every action reachable by keyboard (see §Flows), focus ring uses `--border-focus`,
  and the `NEEDS LOGIN` / `DEFAULT` states are conveyed by text, not color alone.
