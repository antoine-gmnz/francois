---
id: design-refresh
title: Design refresh (Francois Redesign, variant 3a)
status: frozen
created: 2026-07-30
depends_on: [app-shell, sessions-sidebar, conversation-view, diff-view, shell-terminal, agents-panel, mcp-panel, skills-panel, usage-bar, agent-tab, command-palette, projects]
design_files: ["https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html"]
---

# Design refresh (Francois Redesign, variant 3a)

## 1. Summary

Apply the updated design system from `Francois Redesign.dc.html` (Claude Design project
`a4b15728-147c-4932-b83c-f60a5fc60db7`) across the app. The mock is an iterative deck; the
**target state is variant 3a** — Console chrome + Focus reading treatment + agent tabs. The new
system splits typography (IBM Plex Sans for UI chrome, JetBrains Mono demoted to
code/paths/numbers), brightens the accent (`#e0a84e`), warms the grey layers, replaces
bracket-underline tabs with a segmented pill control, restructures the titlebar, and upgrades
session rows to metadata cards. Thanks to the prior tokenization refactor this is mostly a
rewrite of the `:root` token blocks plus a short, enumerated list of baked-in values.

## 2. Goals & non-goals

- **Goals**
  - Every existing surface renders in the new design language (dark + derived light theme).
  - Token **names** are preserved; only values change — feature CSS stays untouched except where
    an FR names it.
  - All baked-in color/font literals outside the token layer are updated in lockstep (contract
    files, Rust caption tint, shell hardcodes, backdrop rgba, font links).
- **Non-goals**
  - **Multi-account (deck variant 4a)** — account tiles, titlebar account chip, reroute banner,
    account step in new-session. Future feature (`accounts`), needs `/brainstorm` + own spec.
  - Dropped explorations **1b** (light "Daylight" layout: fleet strip, icon rail) and **1c**
    (floating overlay panels, icon-avatar session rail) — token hints only, no structure adopted.
  - Right-rail IA changes from the mock (MCP/Skills collapsed rows, "Dispatch an agent" CTA,
    "Activity" feed) — deferred; panels are restyled in place.
  - Removing the light theme or any keyboard capability. Layout changes to Command Palette,
    Projects modal, New Session modal. App icon / brand raster assets.

## 3. User stories / flows

No functional flows change. The user sees the same app restyled: same panes, tabs, hotkeys
(1–5 pane focus, ⌘K, d/t, ⌥1-9/⌘W agent tabs), same mouse paths. The theme toggle in the status
bar now switches between the new dark and new derived-light palettes; xterm re-themes live as
today. The status bar shows condensed content (⌘K · counts · theme toggle · version) instead of
the verbose hint text, but every hotkey keeps working.

## 4. Functional requirements

- **FR-1 Dark tokens.** Rewrite `src/styles.css` `:root` color tokens to the new palette per the
  design brief's token table. Token names unchanged. `--space-*` and `--font-size-*` scales
  unchanged; `--radius-*` and `--shadow-*` roles updated per brief.
- **FR-2 Typography split.** New tokens `--font-ui` (`'IBM Plex Sans', system-ui, sans-serif`)
  and `--font-mono` (`'JetBrains Mono', ui-monospace, monospace`). `body` uses `--font-ui`;
  code, file paths, numbers/percentages, timers, badges, and hotkey chips use `--font-mono`
  (per brief). `index.html` font link loads IBM Plex Sans 400/500/600 + JetBrains Mono 400/500.
- **FR-3 Light theme.** Rewrite `:root[data-theme='light']` with the derived light values per
  brief (accent `#b07d24`, near-black primary buttons, 1b diff colors). Full token coverage — no
  old light value survives.
- **FR-4 Titlebar.** Left-aligned: diamond logo glyph (accent), "Francois" wordmark, project-path
  button. Session % + week % usage meters with reset countdown live in the titlebar (existing
  usage-bar data, component relocated/restyled). No account UI.
- **FR-5 Tab strip.** Segmented pill control on a recessed track: sentence-case `Overview`,
  `Session`, `Diff` (badge in-pill), `Shell`; divider; dynamic agent tabs (status dot, elapsed
  time, close ×, `+N` overflow chip) restyled per 3a. Tab behavior, order, and hotkeys unchanged.
- **FR-6 Session cards.** Sidebar rows become cards: name, status dot, model badge chip, mini
  token-usage bar, age. Data only from what the frontend store already holds — no new IPC.
- **FR-7 Conversation.** Reading column max-width ~680px centered; body 15px/1.65 in `--font-ui`;
  user prompts render as cards; consecutive tool calls group into one bordered block; subagent
  dispatch renders as a purple-tinted banner; streaming caret blinks `step-end`.
- **FR-8 Composer.** Card-style composer with visible **Send** button and hint row
  (`esc` interrupt · `⌘K` commands · `⇧⏎` newline).
- **FR-9 Right rail.** Agents / MCP / Skills panels keep current structure, content, and
  behavior; restyled with new tokens, card surfaces, and typography only.
- **FR-10 Status bar + keyboard.** Status bar content: `⌘K` commands · agent/mcp/skill counts ·
  theme toggle · version. All existing hotkeys and the pane focus ring stay; ring uses the new
  emphasis border token value.
- **FR-11 Contract literals.** Update the hex literal unions/maps in `contract/conversation-view.ts`
  and `contract/fleet-board.ts` exactly as pinned in §5, plus their Rust mirrors and the test
  fixtures asserting the old literals.
- **FR-12 Native caption tint.** `src-tauri/src/window.rs` `tint_window_chrome()` COLORREFs update
  to the new `--bg-app` and `--text-hint` values (dark + light) per §5.
- **FR-13 Shell literals.** `src/features/shell/ShellTerminal.tsx`: exited-banner ANSI truecolor
  escape and the `accentSelection()` fallback rgba update to the new `--text-muted` / `--accent`
  values. xterm `fontFamily` stays `'JetBrains Mono'`; theme keeps flowing from tokens via
  `cssVar()` (no other change).
- **FR-14 Diff & Shell colors.** No dark mock exists: current diff/shell colors are remapped
  role-for-role onto the new palette through the token layer (mapping stated in the brief).
- **FR-15 Backdrop token.** New `--backdrop` token replaces the duplicated
  `rgba(6, 7, 9, 0.62)` literals in `src/styles.css` (`.modal-backdrop`) and
  `src/features/mcp/mcp.css` (`.mcp-overlay-backdrop`).
- **FR-16 Motion.** `pulse` becomes `1.6s steps(6, end) infinite` (ticking); caret `blink` is
  `1s step-end infinite`; scrollbar thumb `#2d333f` (dark) / brief value (light).
- **FR-17 Inherit-only surfaces.** Command Palette, Projects modal, New Session modal render with
  the new tokens but keep their current layouts exactly.

## 5. API contract

**No new contract file, no new IPC channels, no new events.** This feature changes literal
*values* inside two existing contract files (type shapes preserved); the Rust core mirrors them.

`contract/conversation-view.ts` — every old→new pair, applied to the union types **and** the
function bodies (`assistantColors`, `classifyToolStart`):

| where | old | new |
|---|---|---|
| assistant/tool glyph + tool body, settled dim | `#868a93` | `#8b93a3` |
| assistant glyph streaming (accent) | `#c8a15a` | `#e0a84e` |
| assistant body settled | `#c4c7ce` | `#c3c9d4` |
| assistant body streaming | `#dfe2e8` | `#e6e9ef` |
| tool glyph Edit/Write | `#7fa07a` | `#8fbab8` (teal — mock's tool accent) |
| subagent glyph | `#c8a15a` | `#b39ede` (purple — mock's dispatch hue) |
| subagent body | `#b9bcc4` | `#c3c9d4` |

`contract/fleet-board.ts` — `STATUS_COLOR: Record<SessionStatus, string>`:

| status | old | new |
|---|---|---|
| `running` | `#d0a45c` | `#e0a84e` |
| `idle` | `#6b7079` | `#6fae7d` (mock: "ready" is green) |
| `done` | `#7fa07a` | `#8b93a3` (settled → dim; hue swap with idle is intentional per mock) |
| `error` | `#c46b62` | `#d1685e` |

`STATUS_LABEL`, `statusPulses`, and all other exports unchanged.

**Rust mirrors** (core surface): sweep `src-tauri/` for every old hex above (the transcript
builder mirrors the glyph map for `conversation_get_transcript`) and apply the same mapping.
`src-tauri/src/window.rs` COLORREFs (FR-12): dark caption bg `0x0d_0f_13` (new `--bg-app`),
light caption bg per brief's light `--bg-app`; caption text = new dark/light `--text-hint`.

**Tests**: fixtures asserting old literals — `src/features/agents/agent-tab.test.ts`,
`src/features/conversation/conversation-blocks.test.ts` — updated to the new values, plus the
Rust-side equivalents found by the sweep.

## 6. Data & state

No new state, persistence, or derived state on either surface. Theme store (`src/lib/theme.ts`)
and `data-theme` mechanism unchanged. Session/agent/usage/diff data shown by the new visuals
already exists in the frontend store.

## 7. Edge cases & errors

- **Fonts unreachable** (offline desktop): stacks fall back to `system-ui` / `ui-monospace`;
  layout must not break at fallback metrics (no fixed-width assumptions on UI text).
- **Light theme contrast**: light accent is `#b07d24` (not `#e0a84e`, which fails on white);
  primary buttons near-black per 1b. Any token whose derived light value would drop below
  WCAG AA for its role gets darkened in the brief, not ad hoc in code.
- **Caption tint lockstep**: `window.rs` duplicates two CSS tokens as Win32 COLORREFs — this spec
  updates both; a code comment in `window.rs` must name the two token names it mirrors.
- **xterm re-theme on toggle**: existing effect rebuilds the theme from `cssVar()` — new values
  flow automatically; verify selection fallback (FR-13) only triggers when vars are unresolved.
- **Old-hex stragglers**: after the sweep, `grep -rE '#(c8a15a|d0a45c|868a93|7fa07a|c46b62|c4c7ce|dfe2e8|b9bcc4|6b7079)'`
  across `src/`, `contract/`, `src-tauri/src/` must return only historical comments (or nothing).

## 8. Design brief

New two-font design system (IBM Plex Sans UI + JetBrains Mono code), brighter amber accent,
warmer grey layering, segmented pill tabs, restructured titlebar with usage meters, session
metadata cards, measured conversation reading column, card composer with Send button, restyled
right rail and status bar, agent tabs per 3a; dark palette from the mock + fully derived light
palette. Exact token table (old name → new dark/light values), per-screen element specs, glyphs,
hover states, and the diff/shell role mapping:

> full brief: specs/design/design-refresh.md

## 9. Acceptance criteria

- [ ] AC-1 (FR-1..3) `src/styles.css` `:root` + `[data-theme='light']` match the brief's token
  table; no token renamed; `npx tsc --noEmit` and `npm test` pass.
- [ ] AC-2 (FR-2) UI chrome renders in IBM Plex Sans; code/paths/numbers/badges in JetBrains
  Mono; both weights load from `index.html`.
- [ ] AC-3 (FR-4, FR-5) Titlebar shows glyph + wordmark + project path + session/week meters;
  tabs are the segmented control with agent tabs per 3a; all tab hotkeys work unchanged.
- [ ] AC-4 (FR-6..9) Session cards, conversation treatment, composer, and right rail match the
  brief; no new IPC calls appear in the network of `invoke()` wrappers.
- [ ] AC-5 (FR-10) Every pre-existing hotkey works; focus ring visible in new emphasis color;
  status bar shows the condensed content.
- [ ] AC-6 (FR-11) Contract literals match §5 exactly; TS and Rust agree; updated tests pass.
- [ ] AC-7 (FR-12) Windows caption bar matches the new `--bg-app`/`--text-hint` in both themes.
- [ ] AC-8 (FR-13..16) Shell/diff render in new palette in both themes; single `--backdrop`
  token; pulse ticks in steps; the §7 old-hex grep returns no live code hits.
- [ ] AC-9 (FR-17) Palette / Projects / New Session modals restyled, layouts pixel-identical in
  structure to today.

## Remediation

(Empty until a review returns findings.)
