# Interface tour

A single window, three columns, a status bar. Every pane is focusable with the number keys or a
click; the focused pane gets an accent ring and, where it has one, an accent-colored title.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◈ Francois  ● ~/code/francois ▾          session 42% ▮▮▯ · week 18% ▮▯▯ │
├────────────┬──────────────────────────────────────┬──────────────────┤
│ SESSIONS   │ ( SESSION │ DIFF 7 │ SHELL │ ⇉ agent )│ AGENTS       [3] │
│  [1]       │                                      ├──────────────────┤
│            │                                      │ MCP SERVERS  [4] │
│            │       (active tab content)           ├──────────────────┤
│            │                                      │ SKILLS       [5] │
│            │                                      ├──────────────────┤
│ + new [n]  │  › composer                 [ Send ] │ WORKFLOWS    [6] │
├────────────┴──────────────────────────────────────┴──────────────────┤
│ ⌘K commands   focus main   2 agents running     ⚇ account  ☾ dark  vX │
└──────────────────────────────────────────────────────────────────────┘
```

## Title bar

A fixed 38px strip between the OS window caption and the content grid, and the only piece of
chrome that is never scoped to a session. It carries two clusters:

- **Left — the brand and the project switcher.** A diamond glyph, the Francois wordmark, and a
  button showing the most specific working directory in play right now: the scoped project's
  root, else the active session's cwd, else your home directory. Clicking it opens the project
  scope menu — switch scope, or jump to the Projects modal from its last row. This is the app's
  only project switcher.
- **Right — the plan-limit meters.** Your Claude plan usage for the account the selected session
  runs on: current session, current week, and the per-model weekly figure. Each meter is a
  label, a fill bar and a percent; the fill turns error-red at 80% used. The trailing label
  pairs cache freshness with the reset countdown (`updated 2m ago · resets in 4h 12m`), and the
  whole meter region is the click target for a manual refresh. Full detail in
  [Command palette → The usage bar](/guide/command-palette#the-usage-bar).

The title bar is pure chrome: it never takes focus, never appears in the `1`–`6` pane cycle, and
has no animation at all — its height is identical in every state, so nothing it does reflows the
grid below.

## Left column — Sessions `[1]`

Every session you've created, with a status dot (running, idle, done, error), its model, and
current context usage. Click or navigate to select one; the selection drives everything in the
middle column. Details in [Sessions & projects](/guide/sessions-and-projects).

If you're managing more than one [project](/guide/sessions-and-projects#what-a-project-is), sessions group
under their project, and an **OVERVIEW** main tab becomes available for the cross-project
dashboard — see [Overview dashboard](/guide/overview-dashboard).

## Middle column — the main pane `[2]`

A segmented pill control on a recessed track, with three built-in tabs, always in this order:

- **SESSION** — the structured transcript for the selected session. See
  [Conversation & permissions](/guide/conversation-and-permissions).
- **DIFF** — that session's uncommitted changes, with a badge showing the file count. See
  [Diff & shell](/guide/diff-and-shell).
- **SHELL** — a real terminal in the session's working directory. Also in
  [Diff & shell](/guide/diff-and-shell).

The tab header also shows the session's model, context usage, and elapsed time when relevant.
Clicking an agent card in the right column opens that subagent's own conversation as an
additional dynamic tab after SHELL — see [Agents, MCP & skills](/guide/agents-mcp-skills#opening-an-agent-s-own-conversation-as-a-tab).

## Right column — Agents, MCP, Skills, Workflows `[3]`–`[6]`

Four stacked cards showing everything running underneath the selected session: subagent
progress, MCP server connection health, installed/available skills, and this session's
`Workflow` runs. Full detail in [Agents, MCP & skills](/guide/agents-mcp-skills).

The AGENTS, MCP and SKILLS cards each collapse to their header strip — click the header, or focus
the card and press `c` (there's a palette entry per card too). A collapsed card keeps its live
count and hotkey visible, the cards that stay expanded absorb the freed height, and the collapsed
set survives a restart. Whole columns collapse too: `[` hides or shows the left column, `]` the
right one — handy when you want a full-width diff or transcript.

## Status bar

Always visible, and deliberately condensed: the `⌘K commands` hint (clickable), the current
focus label, a running-agent count when any are running, the account the selected session runs
on, a **theme toggle** (`☾`/`☀` — switches between the dark and light themes, and the choice
persists across restarts), and the app version. The hotkeys it no longer spells out all still
work — the full keymap is in [Keyboard shortcuts](/reference/keyboard-shortcuts).

## Command palette

`⌘K` / `Ctrl+K` opens a fuzzy-matched command list from anywhere in the app — new session, switch
model, attach an MCP server, run a skill, and more. See [Command palette](/guide/command-palette).

## Visual language

Two typefaces, split by role: **IBM Plex Sans** for UI chrome, **JetBrains Mono** for everything
that is code, a file path, a number, a timer, a badge or a hotkey chip. An amber accent
(`#e0a84e`) marks focus rings, prompts, cursors and hotkeys, over warm grey layers; status
colors distinguish running / done / error / connecting / idle at a glance. Subagent dispatches
get their own purple banner in the transcript, and the conversation reads inside a measured
~680px column rather than sprawling to the window width.

Both a dark and a derived light theme ship — the `☾`/`☀` toggle lives in the status bar, the
choice persists, and the native window caption and the SHELL terminal re-theme along with it.
The whole thing is designed to read like a console you'd actually want to look at, but with full
mouse support, so keyboard-first never means keyboard-only.
