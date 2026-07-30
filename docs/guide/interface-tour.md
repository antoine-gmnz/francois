# Interface tour

A single window, three columns, a status bar. Every pane is focusable with the number keys or a
click; the focused pane gets an accent ring and an accent-colored title.

```
┌────────────────────────────────────────────────────────────────┐
│  ● ● ●     francois · session orchestrator — <project>   ◉ N agents running │
├────────────┬──────────────────────────────────┬────────────────┤
│ SESSIONS   │  SESSION │ DIFF (7) │ SHELL      │ AGENTS         │
│  [1]       │                                  │  [3]           │
│            │   (active tab content)           ├────────────────┤
│            │                                  │ MCP SERVERS    │
│            │                                  │  [4]           │
│            │                                  ├────────────────┤
│ + new [n]  │  › input / prompt                │ SKILLS  [5]    │
├────────────┴──────────────────────────────────┴────────────────┤
│ 1-5 switch pane  ⏎ open  / search  ⌘K commands  a  d  t   focus: … │
└────────────────────────────────────────────────────────────────┘
```

## Title bar

Shows the app name, the currently active project, and a live pulsing indicator with the count of
running agents across the fleet.

## Left column — Sessions `[1]`

Every session you've created, with a status dot (running, idle, done, error), its model, and
current context usage. Click or navigate to select one; the selection drives everything in the
middle column. Details in [Sessions & projects](/guide/sessions-and-projects).

If you're managing more than one [project](/guide/sessions-and-projects#what-a-project-is), sessions group
under their project, and an **OVERVIEW** main tab becomes available for the cross-project
dashboard — see [Overview dashboard](/guide/overview-dashboard).

## Middle column — the main pane `[2]`

Three tabs, always in this order:

- **SESSION** — the structured transcript for the selected session. See
  [Conversation & permissions](/guide/conversation-and-permissions).
- **DIFF** — that session's uncommitted changes, with a badge showing the file count. See
  [Diff & shell](/guide/diff-and-shell).
- **SHELL** — a real terminal in the session's working directory. Also in
  [Diff & shell](/guide/diff-and-shell).

The tab header also shows the session's model, context usage, and elapsed time when relevant.
Clicking an agent card in the right column opens that subagent's own conversation as an
additional dynamic tab after SHELL — see [Agents, MCP & skills](/guide/agents-mcp-skills#opening-an-agent-s-own-conversation-as-a-tab).

## Right column — Agents, MCP, Skills `[3]` `[4]` `[5]`

Three stacked panels showing everything running underneath the selected session: subagent
progress, MCP server connection health, and installed/available skills. Full detail in
[Agents, MCP & skills](/guide/agents-mcp-skills).

## Status bar

Always visible: the active keymap (`1-5` switch pane, `⏎` open, `/` search, `⌘K` commands, plus
context-specific keys like `a` new agent, `d` diff, `t` shell), the current focus label, and the
app version. The full keymap is in [Keyboard shortcuts](/reference/keyboard-shortcuts).

## Command palette

`⌘K` / `Ctrl+K` opens a fuzzy-matched command list from anywhere in the app — new session, switch
model, attach an MCP server, run a skill, and more. See [Command palette](/guide/command-palette).

## Visual language

Dark only, monospace everywhere (JetBrains Mono). An amber accent marks focus rings, prompts,
cursors, and hotkeys; status colors distinguish running / done / error / connecting / idle at a
glance. The whole thing is designed to read like a TUI you'd actually want to look at — but with
full mouse support, so keyboard-first never means keyboard-only.
