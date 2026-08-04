# DESIGN BRIEF — Multiple shells per session (`multiple-shells`)

> The "spec return" for `specs/multiple-shells.md` §8. Francois is a **native desktop app** — there is
> no mobile breakpoint; the only responsive axis is the desktop window's own resize.

**Goal:** run several terminals side by side in one session — a dev server in one, git in another —
switching between them instantly, without losing either one's scrollback.

**Design system:** the v2 identity (`Francois Design System v2.dc.html`) and the shipped UI kit
(`src/ui/`, tokens in `src/styles.css`). Acid `--accent` means *the live thing* — one per view; the
"ready/alive" green is `--success`, never the accent.

## Screens / views

- **SHELL tab body** — the only surface this feature touches (`src/app/ShellTabView.tsx`). Vertical
  stack, top to bottom: **shell strip** (new) · terminal area (existing) · footer (existing).
  - **Shell strip** — a single horizontal row, `padding: var(--space-6) var(--space-14)`, bottom
    border `1px solid var(--border)`, background `--bg-app`, `gap: var(--space-6)`, horizontally
    scrollable with the app's `.scz` thin scrollbar and never wrapping. Contains one **shell chip**
    per shell in creation order, then the **`+` chip**.
    - **Shell chip** — the existing `.app-tab-chip` vocabulary at a smaller scale: height `24px`
      (vs 28px in the main strip — this is a *sub*-level and must read as subordinate to it),
      `--radius-card`, `1px solid var(--border)`, `--bg-app`, label `var(--font-size-11)` weight 500
      in `--text-hint`. Left to right: **process dot** (`StatusDot`, 6px) · **name** (truncated at
      ~18 chars with an ellipsis, full name in `title`) · **unread dot** (5px, `--accent-2`, only
      when unread) · **`✕`** (`--text-muted`, brightening to `--text-strong` on hover, always
      rendered so the chip's width never jumps under the cursor — same rule as agent tabs).
    - **`+` chip** — same geometry, no dots, a single `Plus` glyph (`lucide-react`) in `--text-muted`;
      `title: "New shell  ⌘T"`.
  - **Terminal area** — unchanged. Exactly one shell's terminal is visible at a time; the others are
    present in the DOM but `display: none`.
  - **Footer** — unchanged, and always describes the *displayed* shell: process dot, `<shellName>`,
    `·`, `~`-abbreviated cwd, then the right-aligned `⌃C interrupt` / `⌃L clear` hints.

### States

- **Strip — hidden.** With 0 or 1 shells the strip does not render at all: a single-shell session must
  be pixel-identical to today's SHELL tab. It appears the moment a second shell exists.
- **Chip — active.** `--bg-hover-2`, `1px solid var(--border-focus)`, label `--text-bright` weight 600,
  `var(--shadow-pill)`. Exactly one chip is active.
- **Chip — inactive.** Base treatment above; on hover `--bg-hover` + `--border-emphasis`.
- **Chip — alive / exited.** Process dot `--success` / `--error`. The dot never pulses — pulse means
  "in progress" in this app's vocabulary, not "connected".
- **Chip — unread.** The 5px `--accent-2` dot between the name and the `✕`, on inactive chips only;
  it disappears the instant the chip is selected. Never animated.
- **Chip — renaming.** The label swaps for an inline text input, same font and size, transparent
  background, `1px solid var(--border-focus)`, seeded with the current name and fully selected. No
  layout shift: the input is sized to the chip's current label width, min ~72px.
- **`+` — at the cap.** Dimmed to ~40% opacity, non-interactive, `title: "6 shells maximum"`.
- **Tab body — no shells.** `EmptyPane`: "No shells" with the hint "⌘T to open one". The strip shows
  the `+` alone.

## Flows

1. One shell → the strip is invisible; the tab looks exactly as it does today.
2. `+` (or `⌘T`) → a second chip appears at the right of the strip, becomes active, its terminal
   mounts and takes focus; the strip becomes visible.
3. Click a chip → its terminal appears instantly (CSS swap, no spinner, no replay flicker), the
   footer's shell name and cwd update, its unread dot clears.
4. Output arrives in a shell you are not looking at → its chip gets the accent unread dot.
5. Double-click a chip's label → inline rename. `⏎` commits, `Esc`/blur cancels, empty restores the
   auto name `<shellName> <n>`.
6. `✕` (or `⌘W`) → the chip disappears and the neighbour to its right becomes active (else the left,
   else the empty state).
7. A shell's process exits → its dot turns red; when displayed, the terminal shows the existing dim
   `process exited (code N) — press ⏎ to restart` line. `⏎` restarts it in place: the chip keeps its
   name and its position, the dot returns to green.

## Data shown

Straight from `ShellInfo` (spec §5): `name` (the chip label), `shellName` + `cwd` (the footer),
`alive` / `exitCode` (the process dot). Unread is frontend-derived (spec FR-14) and never persisted.

## Notes / constraints

- **Copy is English**, sentence case: "New shell", "No shells", "6 shells maximum". The chip label is
  *content* (a name the user may have typed), so it is never upper-cased or letter-spaced the way the
  chrome tabs above it are.
- **Hierarchy is the whole job.** The main tab strip (Overview/Session/Diff/Shell + agent tabs) is
  chrome and already claims the eye; this strip sits *inside* one of those tabs and must read as one
  level down — smaller, quieter, lighter border. If a mock makes the two rows compete, the sub-strip
  is wrong.
- **One accent per view.** Within the SHELL tab, `--accent-2` appears only on unread dots. If the
  active chip also used the accent, "which shell am I in" and "which shell has news" would fight;
  the active chip is distinguished by fill, weight, and border instead.
- **No motion.** No slide-in for a new chip, no fade for the unread dot, no transition on the terminal
  swap — everything in this tab is an instant state change, matching the rest of the app.
- **Icons** are `lucide-react` (`Plus`, `X` where a glyph is not already conventional); they inherit
  `currentColor` and are toned by the feature's CSS.
- **Both themes.** Every value above is a token, so light mode follows for free — check that the
  inactive chip's `--bg-app` on the strip's own `--bg-app` still reads as a chip in light mode; if it
  does not, the strip (not the chip) takes the recessed background, mirroring `.tab-segment`.
