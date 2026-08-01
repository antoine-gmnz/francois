# DESIGN BRIEF — Workflow details (`workflow-details`)

**Goal:** let the user open a running `Workflow` and see what it is actually doing — which agents are
alive, when each ran and for how long, what each cost, what each returned, and what any one of them
said — without leaving Francois for the CLI's `/workflows`.

**Design system:** the existing UI kit (`src/`, tokens in `src/styles.css`). Visual source of truth:
`Claude Terminal.dc.html` + `screenshots/`. This is a **desktop app** (Tauri window), not a responsive
web page — the shell's `grid-template-columns: 276px 1fr 296px` is fixed. Everything here lives in the
**middle column** (`1fr`), in the tab strip and the content area below it.

Two rules govern the whole brief, because this view is assembled from parts that already exist:

1. **The transcript column is the SESSION tab's block rendering, unchanged.** Same glyphs, colours,
   markdown, tool-card layout (`conversation-view` §8 / `agent-tab` §8). A workflow agent's
   conversation must read exactly like a session's. Do not restyle it.
2. **Agent rows reuse pane [3]'s card metrics.** The one genuinely new element in this feature is the
   span bar.
3. **Approval and question cards are the existing components, unmodified.** A workflow ask renders the
   same card the SESSION tab renders, in the same size, with the same buttons. It is *mirrored* here,
   not redesigned and not moved — the SESSION tab keeps its copy.

## Screens / views

### 1. Tab strip — the workflow tab

Extends the strip after `OVERVIEW · SESSION · DIFF · SHELL` and the open agent tabs. Identical
construction to an agent tab (`agent-tab` §8) so the two kinds sit together without a seam:

- Elements, left to right: a 6px **status dot** (`--accent-2` running and pulsing / `--success` done /
  `--error` error), the `⇉` glyph in `--accent-2`, the run name truncated to 14 chars with `…`. On
  hover a trailing `✕` in `--text-faint`, `--error` on its own hover.
- Not upper-cased and not letter-spaced — a workflow name is content, not a chrome label.
- States: active (2px `--accent` bottom border, `--accent` label) · inactive · hover (widens by the
  12px `✕`).

### 2. Tab body

A two-column split filling the content area.

- **Left rail** — fixed **312px**, `background: var(--bg-panel)`, `border-right: 1px solid
  var(--border)`, its own vertical scroller. Holds the run header, then the agent list.
- **Right column** — the remaining width, `--bg-base`, its own vertical scroller. Shows the selected
  agent's transcript, or the script source, or the run summary when nothing is selected.

#### 2a. Run header (top of the left rail)

`padding: 10px 12px`, `border-bottom: 1px solid var(--border)`.

- Line 1: run **name** in `--text-strong` (13px), then a status dot + status word in its status colour.
- Line 2: the run **description**, 11px `--text-muted`, wrapping to at most 2 lines then `…`.
- Line 3 (the meta strip, 10.5px `--text-faint`, `·`-separated): `◷ {elapsed}` · `{N} agents` ·
  `{M} running` · `{tokens} tok` (compact — `1.2k`, `340k`).
- **Waiting banner** (only when `pendingAsks` is non-empty): a full-width strip under line 3,
  `--warning` text on a `--warning` tint at ~8% with a 1px `--warning` border, `--radius-card`, 11px:
  `waiting on you — {N} approval(s)`. It is the one place in this view that raises its voice, because
  a blocked run makes no progress and produces no filesystem activity to notice. It replaces nothing;
  the meta strip stays.
- **Declared phases**: the numbered list `workflow-panel` §8 already defines, under the same
  "declared, not live" note. Dim (`--text-disabled` index, `--text-muted` title). This is the honest
  seam of the feature — the phases are the plan, the agent list below is what happened, and the design
  must not imply the list is grouped under the phases.
- **`script` toggle**: a `Chip` at the right of the meta strip, `--bg-raised`, `--font-size-9`.
  Active (script showing) takes the `--accent` treatment chips already use.
- Empty/error variants: `no agents yet` and an inline error row, both centered 11px `--text-faint` /
  `--error`.

#### 2b. Agent row (the list below the header)

`--bg-hover` fill, `--radius-card`, `inset 0 0 0 1px var(--border-emphasis)`, 6px gap between rows,
`padding: 7px 9px`. Selected adds the `--accent` left border and the `--bg-raised` fill — the mock's
agent card, same as pane [3].

- **Head row**: `StatusDot` (pulsing while running) · `agentType` in `--text-strong` (11px) ·
  `model` in a `--bg-raised` pill (`--font-size-9`, `--text-dim`) when known · right-aligned
  `{elapsed}` and `{tokens} tok` in `--text-faint` (10px).
- **Prompt line**: 10.5px `--text-muted`, single line, ellipsized. This stands in for the CLI's
  `opts.label`, which is not recoverable from disk.
- **Span bar**: the new element. A full-width 3px track in `--bg-raised`, `border-radius: 2px`, with a
  fill positioned by `left: (agent.startedAt - run.startedAt) / window` and
  `width: (agent.end - agent.startedAt) / window`, where `window = (run.endedAt ?? now) -
  run.startedAt`. Fill is `--accent-2` while the agent runs, `--text-disabled` once it is done or
  stopped. Minimum rendered width 2px so an instant agent is still visible. **Bars share one origin
  across all rows** — that shared origin is the entire point: overlapping bars are how the user sees
  what `parallel`/`pipeline` actually did.
- **Result preview** (only when the agent returned something): one line, 10px `--text-disabled`,
  prefixed `→`, ellipsized.
- States: default · hover (`--bg-raised`) · selected · running (pulsing dot, live bar) · done ·
  stopped (`--text-muted` dot, no special copy — a stopped agent is not an error) · **waiting**
  (`--warning` dot, not pulsing — it is stalled, not working; the word `waiting` replaces the elapsed
  value's colour with `--warning`; the span bar keeps its `--accent-2` fill but stops extending).

#### 2c. Right column — agent transcript

- **Header** (fixed above the scroller, `padding: 9px 14px`, `border-bottom: 1px solid var(--border)`):
  `agentType` in `--text-strong`, the model pill, the status word in its colour, right-aligned
  `◷ {elapsed}` in `--text-faint`. Second line: the prompt, 11px `--text-muted`, ellipsized.
- **Blocks**: the SESSION tab renderer, verbatim (rule 1 above).
- **Truncation row** (when `dropped > 0`): a single leading `… {N} earlier block(s)`, 10px
  `--text-disabled`.
- **Result block**: last in the scroller. A `--border` hairline, the label `returned` in 10px
  `--text-faint` letter-spaced, then the value in the mono code treatment the tool cards already use
  (`--bg-raised`, `--radius-card`, 11px), pretty-printed when it is JSON. Absent while the agent runs.
- States: loading (renders nothing — the panel loading convention) · hydrated with blocks · hydrated
  empty (`no activity yet`, centered `--text-faint`) · errored (inline 11px `--error` row).

#### 2c-bis. Right column — a pending ask

When the run has attributed asks, they render **above** everything else in the right column, before
the transcript header, so they cannot be scrolled past.

- The existing approval / question card, unmodified (rule 3 above): same width behaviour, same
  buttons, same copy.
- **Ownership line** above each card, 10px `--text-faint`: `{agentType} · {toolName}` when the ask
  resolved to an agent. When it did not, `this workflow` plus a dim `attributed by elimination` note
  in `--text-disabled` — the design must show that Francois inferred rather than knew, because that
  rung can be wrong.
- Selecting the owning agent scrolls its card into view rather than opening a second copy.
- When no agent is selected and an ask is pending, the right column shows the ask instead of
  `select an agent`.
- States: pending · resolving (the card's existing disabled state) · gone (removed on the next
  detail flush — never left as a dead control).

#### 2d. Right column — script source

Same scroller, no header. The `.js` in the mono code treatment, 11px, `--text-muted`, with the file
path above it in 10px `--text-disabled`. When truncated, a trailing `… truncated at 200 KB` row in
`--text-faint`. No syntax highlighting — the mock has no highlighter and one is not worth introducing
for a read-only escape hatch.

#### 2e. Right column — run summary (nothing selected)

Centered in the column: `select an agent` in `--text-faint`. Nothing else — the left rail already
carries every run-level fact.

## Flows

1. A card in pane [6] is running. **Click it** → the `⇉ {name}` tab appears after SHELL, is activated,
   focus moves to the main pane. The left rail lists the agents that have started; the right column
   shows `select an agent`.
2. New agents append to the list and bars extend as the run proceeds (1 Hz). The header counts update.
3. **Click an agent row** → it selects, and the right column becomes that agent's conversation,
   scrolled to the newest block, ending in its returned value once it has one.
4. **Click `script`** → the right column becomes the source. Clicking any agent row returns to the
   transcript.
5. **An agent blocks on a permission or a question** → the pane [6] card reads `waiting on you`, the
   header shows the waiting banner, the agent's row goes `--warning`, and the card appears at the top
   of the right column. The user decides → the card disappears, the row returns to `running`, the bar
   resumes. The identical card is in the SESSION tab throughout; answering in either place is the same
   answer.
6. The run ends → bars freeze, dots settle, the header elapsed stops. The tab stays open.
7. **Close** with `✕` or `w` → the tab disappears and the main pane falls back to SESSION.
8. `⏎` in pane [6] still expands the card in place. Only a click opens a tab.

## Data shown

Matches spec §5 exactly. Per run: `name`, `description`, `status`, `startedAt`/`endedAt`, `phases`
(declared), `tokens` (total), `agents.length`, running count, `hasScript`, `pendingAsks`. Per agent:
`agentType`, `model?`, `status`, `startedAt`, `lastAt?`, `prompt`, `tokens`, `result?`. Per transcript:
`AgentBlock[]` + `dropped`. Per script: `path`, `source`, `truncated`. Per ask: `blockId`, `kind`,
`agentId?`, `toolName?`, `confidence` — the card's own content comes from the existing
permission/question store, not from this feature.

Nothing displayed is invented: there is **no** per-agent label and **no** phase assignment on disk, so
neither appears. Token counts are counts, never a currency amount.

## Responsive

Not a responsive web page — the window resizes instead. The left rail stays 312px and the right column
absorbs all width change; below roughly 720px of content width the rail may shrink to 260px (rows
ellipsize earlier, bars keep their proportions) but never collapses — a bar with no list beside it says
nothing. The tab strip is a flex row: dynamic tabs ellipsize before the built-in ones and the strip
scrolls horizontally past that rather than wrapping.

## Notes / constraints

- **Copy in English**, lowercase for ambient/system lines (`no agents yet`, `select an agent`,
  `declared phases`, `returned`, `truncated at 200 KB`) — matching the existing panels.
- **Never call a `stopped` agent failed.** The journal records no failure event; an agent with no
  result simply never returned. Copy and colour must both stay neutral (`--text-muted`, no `--error`).
- **Fail soft, visibly but quietly.** If the run directory is unreadable or its layout has changed, the
  rail shows `no agents yet` and the pane [6] card behaves exactly as before. No modal, no banner.
- **A pending ask is the one loud thing.** Everything else in this view is ambient; a blocked run is
  not, because nothing else will move until the user acts. That is the only justified use of
  `--warning` here — do not spend it on `stopped` agents or on truncation.
- **Never imply Francois knows more than it does.** An ask attributed by elimination says so on the
  card. A blocked agent whose ask was not attributed simply reads `running` with a frozen bar.
- **Motion**: none new. The running status dot keeps its existing pulse; bars and clocks update at
  1 Hz and only while the run is running.
- Accessibility: rows are focusable buttons with the selected one carrying `aria-current`; the span bar
  is decorative (`aria-hidden`) since the elapsed text beside it carries the same information.
