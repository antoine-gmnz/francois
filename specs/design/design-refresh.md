# DESIGN BRIEF — Design Refresh (`design-refresh`)

> The "spec return". Source of truth: `Francois Redesign.dc.html` variant **3a** (Console chrome +
> Focus reading + agent tabs). 4a (multi-account) and 1b/1c as standalone layouts are OUT OF SCOPE —
> see PIPELINE.md decisions. Old mock: `Claude Terminal.dc.html`. Current tokens: `src/styles.css`
> lines 22–183.

**Goal:** Re-skin the existing app shell (unchanged layout/IPC) with 3a's visual language — IBM Plex
Sans UI type, gold accent, restyled cards/tabs/rail — in both dark and light theme, with zero new
data or channels.

**Design system:** use the existing UI kit (`src/`), token-driven. Desktop-first: this is a native
window, not a responsive page — see §Window behavior instead of a mobile/tablet/desktop ladder.

## Token table

Color tokens — current name → new dark value → new light value. Bold = **directly evidenced** in
the mock; plain = **extrapolated** (kept role-consistent, flagged in the summary below).

| token | new dark | new light | evidence |
|---|---|---|---|
| `--bg-app` | **#0d0f13** | **#eef0f4** | 3a window bg / 1b window bg |
| `--bg-deep` | **#11141a** | **#f8f9fb** | 3a titlebar/footer/composer bg / 1b fleet-strip bg |
| `--bg-panel` | **#14171d** | **#ffffff** | 3a sessions/main/aside panel bg / 1b panel bg |
| `--bg-elevated` | **#161a21** | #fbfcfd | 3a idle session-card bg |
| `--bg-raised` | **#1c212a** | #f2f4f7 | 3a selected session/agent-list-item bg |
| `--bg-hover` | **#1a1e26** | **#e9ebef** | 3a button/row/composer-input hover-and-rest bg / 1b `style-hover` |
| `--bg-hover-2` | **#232833** | #dce0e6 | 3a active-tab pill bg / segmented-control active bg |
| `--border` | **#1f242d** | **#e2e5ea** | 3a inner dividers (header bottom, list separators) / 1b internal dividers |
| `--border-2` | **#232833** | **#d7dbe2** | 3a outer panel/card border / 1b window border |
| `--border-emphasis` *(new token)* | **#2d333f** | #c9cdd4 | 3a button/input/composer/dashed-chip border |
| `--border-focus` *(new token)* | **#3c4453** | **#14171c** | 3a hover/selected-ring border (session-card `inset 0 0 0 1px #333a48`≈, tab hover) / 1b selected-card border |
| `--text-bright` | **#f2f4f8** | **#14161b** | 3a active session name, headings |
| `--text-strong` | **#e6e9ef** | #1c1f26 | 3a wordmark, "You" card body |
| `--text` | **#d6dae2** | #292c33 | 3a tool-call target text, secondary emphasis |
| `--text-2` | **#c3c9d4** | #33373f | 3a assistant body copy |
| `--text-hint` | **#9aa2b1** | #42464e | 3a session meta / inactive-tab label |
| `--text-dim` | **#8b93a3** | #565a63 | 3a tool-kind label, badge counts |
| `--text-muted` | **#6b7385** | #6d717a | 3a path text, hint row |
| `--text-faint` | **#565e6e** | #878c95 | 3a version string, close glyph |
| `--text-disabled` | #3a4049 | #b6bac2 | extrapolated (between faint and border-emphasis) |
| `--accent` | **#e0a84e** | **#b07d24** | 3a gold — dot/meter/badge/link; scope-decision light value |
| `--accent-2` | #e0a84e (= accent) | #a67b28 | mock doesn't visually distinguish accent-2 from accent |
| `--accent-bright` | **#f0c47c** | #8c661d | 3a Send-button / link hover |
| `--accent-soft-bg` | #332a18 | **#f4ead0** | extrapolated dark; light per scope decision (unchanged) |
| `--warn` | #d4c46f | #8f7f2e | extrapolated, same offset from accent as before |
| `--success` | **#6fae7d** | #4d7a48 | 3a cwd-valid dot, "done" agent-dot |
| `--success-bright` | #8bc292 | **#285024** | extrapolated dark; light = scope-decision diff-add text |
| `--success-dim` | #517a55 | #7e9b79 | extrapolated |
| `--error` | **#d1685e** | #b0463d | 3a "limited" dot |
| `--error-bright` | **#e0918a** | **#7d2b24** | 3a diff-stat / limited-label text; light = scope-decision diff-del text |
| `--error-dim` | #8f3f37 | #c98d87 | extrapolated |
| `--hue-purple` | **#b39ede** | #6a55a0 | 3a subagent badge text/glyph |
| `--hue-purple-soft` | **#cbb9ec** | #92678b | 2a dispatch-banner agent-name emphasis |
| `--hue-teal` | **#8fbab8** | **#3f8582** | 3a tool-call glyph / diff-stat "+"; unchanged from current — mock reuses it verbatim |
| `--hue-blue` | **#6f9fd8** | #416b8f | 3a token-usage mini-bar fill |
| `--hue-slate` | #7c8aa0 (unchanged) | #566480 | not distinctly shown in the mock — kept as-is |
| `--backdrop` *(new token, spec FR-15)* | rgba(6,7,9,.62) | rgba(6,7,9,.62) | value unchanged — tokenizes the duplicated modal/overlay backdrop literal; dimming layer works on both themes |

Diff-view row backgrounds: dark keeps the current `color-mix(var(--success/--error) 9%, transparent)`
formula (role-correct already, just inherits the new base hex above). Light theme sets explicit
tinted backgrounds instead of the formula, per the scope decision: add row `#eaf5e9` bg /
`var(--success-bright)` text, del row `#fdeceb` bg / `var(--error-bright)` text.

**Typography.** New `--font-ui: 'IBM Plex Sans', system-ui, sans-serif` at weights 400/500/600
becomes the UI font (labels, buttons, body copy, panel headers). `--font-mono` (JetBrains Mono
400/500) stays but is **demoted**: code, file paths, numbers/counters, badges/chips, hotkey glyphs
only — xterm.js keeps JetBrains Mono unconditionally (shell content isn't UI chrome). `body`'s
`font-family` in `styles.css` (currently JetBrains Mono for the whole app) switches to
`var(--font-ui)`; components that render code/paths/numbers opt into `var(--font-mono)` explicitly
(most already isolate these in their own `<span>`s per the current markup).

**Radius.** Ladder gains one step for the new card motif: session/tool-call/prompt cards move off
`--radius-base`(4)/`--radius-lg`(6) onto a new `--radius-card: 7px` (3a session card, tool-call
block, agent card). Panels (`--radius-xl`, 8px) are unchanged. Modals/composer/popovers move from
`--radius-xl`(8)/`--radius-2xl`(12) up slightly to **9–11px** (composer 11px, account/new-session
style modals 11px, dropdowns 12px) — reuse `--radius-2xl` at 12px for the largest, introduce
`--radius-2xl` stays 12px and note modal/composer callers now pass an explicit 10–11px inline value
where the ladder doesn't have a step (same convention as today's raw literals). Small
chips/badges/pills stay on `--radius-base`(4)/`--radius-md`(5); the fully-round subagent pill uses
`20px` (unchanged idiom, just a bigger literal).

**Shadows.** `--shadow-modal` deepens: `0 30px 80px -20px rgba(0,0,0,.85)` → `0 30px 70px -18px
rgba(0,0,0,.9)` (account/new-session-style dialogs, dropdowns). `--shadow-card` /
`--shadow-card-sm` / `--shadow-bar` are unchanged in value — the mock's composer/card shadows match
current numbers closely enough not to warrant a new constant. The mock's window-level shadow (`0
40px 90px -30px rgba(0,0,0,.9)`) is a canvas-presentation artifact simulating an OS window shadow —
not applicable inside the real Tauri window; skip it.

**Animation.** `pulse` stays `steps(6,end)` at **1.6s** (already the app's throttled value —
`styles.css` lines 7–10 — the mock uses the identical timing, so no change needed there). `blink`
(streaming caret) changes from the current ease-implicit 50/50 duty cycle to explicit **`1s
step-end infinite`** (already what `styles.css` line 208 defines — confirm no drift, mock matches).
Scrollbar thumb: `--border-2`-backed today; mock hardcodes `#2d333f` for `.scz` thumbs — fold that
into the new `--border-emphasis` dark value so `.scz::-webkit-scrollbar-thumb` keeps referencing a
token (`var(--border-emphasis)`) rather than a literal.

## Screens / views

- **Titlebar** — 38px (was 44px). Left: diamond logo glyph (9×9 square, `rotate(45deg)`, accent
  fill) + "Francois" wordmark (`--font-ui` 600, 12.5px) + project-path button (status dot in
  `--success`, path in `--font-mono` 11px, `▾` caret) — all left-aligned, replacing the current
  centered "clyde · session orchestrator — {project}" text convention. Right: session% and week%
  usage meters (existing `UsageBar`/usage store data), each a label + 4px track + fill + `--font-mono`
  percentage, plus a "resets in Xh Ym" countdown — no account chip, no reroute banner (4a only).
  - States: path button hover (`--bg-hover-2`); meters read-only, no interaction beyond hover.
- **Sessions sidebar** — unchanged data (name, status, path, model badge, mini token bar, age),
  restyled as `--radius-card` cards: name (`--font-ui` 600 13.5px) + status dot/label, path in
  `--font-mono` 11px, model badge chip (`--bg-hover-2`, `--radius-base`), a 3px token-usage mini-bar
  (`--hue-blue` fill), token count and age in `--font-mono`. Selected card: `--bg-raised` +
  `--border-focus` inset ring + 2px left accent rail. Idle cards: `--bg-elevated`, hover →
  `--bg-hover`. "+ New session" button keeps its `n` hotkey badge.
- **Main tab strip** — segmented pill control replaces the current uppercase/underline tabs:
  Overview · Session · Diff · Shell, sentence-case, `--font-ui` 500/12.5px, active tab gets
  `--bg-hover-2` fill + `--shadow-card-sm`-scale inset shadow, inactive tabs `--text-faint`. Diff
  keeps its count badge (accent-on-dark pill). A 1px `--border-2` divider, then the dynamic agent
  tabs: each a small pill (dot, name, close `✕` on hover), active one gets `--bg-hover-2` +
  `--border-focus`; overflow beyond the visible run collapses to a dashed `+N` chip (`--border-emphasis`,
  hover → `--border-focus`) rather than shrinking the fixed four tabs.
- **Conversation view** — reading column capped ~680px, centered. Body copy 15px/1.65 in
  `--font-ui`. User prompt renders as a card (`--bg-elevated`, `--radius-card`, "You" label in
  `--font-ui` 600 11px uppercase `--text-dim`). Tool calls group into one hairline-divided block
  (`--border-2` 1px separators inside a `--radius-card` container, each row: glyph in `--text-dim`,
  with Edit/Write rows in `--hue-teal` — the two-tier mapping pinned in spec §5's contract table —
  kind label, `--font-mono` target, `--font-mono` faint meta). Subagent dispatch renders as a
  banner tinted with `--hue-purple`'s soft background/border (mirrors the mock's purple-tinted
  dispatch block), bold agent name in `--hue-purple-soft`. Streaming caret: 8×16px block,
  `--accent` fill, `blink 1s step-end infinite`.
- **Composer** — card style (`--bg-hover`, `--border-emphasis`, `--radius-card`+ a touch, e.g. 11px,
  `--shadow-card`), `›` prompt glyph in accent, placeholder text, visible **Send** button
  (`--accent` bg / `--bg-app`-on-accent text, hover `--accent-bright`) — replacing today's
  send-on-Enter-only affordance. Hint row beneath: `esc` interrupt · `⌘K` commands · `⇧⏎` newline,
  each hotkey glyph in `--font-mono` `--text-dim`.
- **Right rail — Agents / MCP / Skills** — restyle in place only: keep the current docked,
  always-expanded `AgentsPanel`/`McpPanel`/`SkillsPanel` structure (`agent-card`, MCP rows, skill
  rows) and all current features (kill, dispatch modal, activity trail, connect/attach). Apply the
  new token values, `--radius-card` on cards, `--font-ui` for names/labels, `--font-mono` for
  counts/meta, and the new focus-ring token on `*-panel--focused`. Do **not** add the mock's
  collapsed-row MCP/Skills treatment, the "Dispatch an agent" ghost-row CTA copy change, or an
  "Activity" feed section — those stay out of scope.
- **Agent tab content** (`AgentView`) — header: agent-identity tile (name `--font-ui` 600 14.5px +
  "subagent" pill in `--hue-purple`), meta row ("from `<parent session name>`" · model ·
  `--font-mono` context · `--font-mono` tool count) — parent name is already known client-side (the
  tab was opened from the active session). Task block: purple-tinted card, "Task" label uppercase
  `--hue-purple`-adjacent, task text `--font-ui` 14.5px/1.6. Trace: same hairline tool-call block
  style as the conversation view. Footer: status dot + "working · `elapsed`" (existing elapsed
  data), then a live diff stat `+N`/`−N` in `--hue-teal`/`--error-bright` **derived client-side by
  summing the edit-tool deltas already present in the agent's own block trace** (no new IPC), then
  "results merge into `<parent>`" using the same already-known parent name.
- **Status bar** — 30px (was part of the grid row). Adopts the mock's cleaner content: `⌘K`
  commands hint (accent glyph), then context-dependent counts — on Session: "N agents · N MCP · N
  skills" (existing counts); inside an agent tab: "focus `<agent name>`" · `⌥1-9` jump to tab ·
  `⌘W` close tab (existing agent-tab keyboard model, just surfaced as hint text) — spacer — theme
  toggle (`☾`/`☀` + label, click to flip, same handler as today) — `--font-mono` version string.
  Drops the current verbose `1-5 switch pane / ↑↓ nav / ⏎ send / o overview / d diff / t shell / [
  sessions / ] panels / n new session / focus: <pane>` string; the 1–5 pane hotkeys, `[`/`]` pane
  toggles, and focus ring **keep working** exactly as today — only their status-bar text shrinks.
  Pane focus ring: replace the current `border-color: var(--accent)` on `*-panel--focused` /
  `.qcard-pending`-style indicators with `var(--border-focus)` (#3c4453 dark / #14171c light),
  reserving accent for the true "make it gold" moments (badges, active states, links).
- **Inherit-only (token language only, layout/behavior unchanged)** — Command Palette, Projects
  modal, New Session modal, dark-theme Diff view, dark-theme Shell view. Dark Diff/Shell: role-for-
  role token mapping (old value → new dark value per the table above); their existing
  `var(--success)`/`var(--error)`/`var(--border)`/etc. references pick up the new hex automatically,
  no code change beyond the token file. Light-theme Diff borrows explicit values from 1b (see diff
  row note above); light Shell has no mock reference — inherits the light token ladder only
  (`--bg-app`/`--bg-deep` shell background, `--text` output, `--success`/`--error` for git-status
  coloring) with no further redesign. JetBrains Mono stays the xterm/PTY font unconditionally in
  Shell regardless of theme.

## Flows

No flow changes. Every interaction (session select, tab switch, agent dispatch/kill, MCP
attach/detach, skill run, diff stage/commit, shell input, palette open/run, project switch,
new-session create) keeps its current trigger, hotkey, and IPC call — this is a visual pass only.

## Window behavior

Native desktop window, not a responsive page. No mobile/tablet breakpoints. Existing min-window
constraints from `tauri.conf.json` are unchanged; the grid (`276px | 1fr | 296px` columns per the
mock, close to the current sidebar/rail widths) reflows the same way it does today when the window
narrows below comfortable — sidebar/rail collapse via the existing `[`/`]` toggles, not a new
responsive layout. Two themes (dark default, light opt-in via the existing toggle) — both are
first-class, not a "mobile" variant of each other.

## Data shown

No new fields, no new IPC. Everything above reads from data already in the frontend store:
session name/status/path/model/token-usage/age, agent name/status/elapsed/task/tool-count,
per-agent edit deltas (aggregated client-side from the existing block trace), diff file
add/del counts, MCP/skill lists, usage-bar session%/week% + reset countdown.

## Notes / constraints

- Copy in English throughout (project `ui_language`).
- Glyphs are taken verbatim from the mock where it defines them: `▾` (path caret), `›` (composer
  prompt), `✕` (close), `⇉` (subagent dispatch), `+`/`✕` overflow chip, `☾`/`☀` (theme), status
  dots as plain filled circles. Where the mock is silent on a hover/pressed state, use the nearest
  equivalent already established elsewhere in the mock (e.g. `--bg-hover` for row hover, `--accent-
  bright` for accent-button hover) rather than inventing a new interaction language.
- `style-hover` attributes in the mock are authoritative for hover states wherever present; treat
  their absence as "match nearest equivalent," not "no hover."
- Accessibility: text-ladder contrast ratios preserved by construction (each token keeps its
  relative position in the ladder — see token table); focus is now indicated by `--border-focus`
  everywhere a panel/card can be keyboard-focused, not just visually implied by content changing.
- No account tiles, no account chip in the titlebar, no reroute banner, no account step in
  new-session (4a explicitly out of scope). No fleet strip, no icon-rail sidebar, no floating
  overlay panels (1b/1c structures explicitly dropped — only 1b's *light color values* are reused).
