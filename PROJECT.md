# Francois — Claude Code Session Orchestrator

A terminal application for running and supervising [Claude Code](https://claude.com/claude-code) sessions. One window shows every session, its conversation, its diff, its subagents, its MCP servers, and its skills — plus a **regular terminal** (real shell) alongside the AI, so you never have to leave the app to run commands yourself.

The name **Francois** is a nod to Claude François, the French singer. (The design mock still uses the earlier working name "clyde", v0.4.2 — treat every "clyde" in the mock as "francois".) The reference design lives in this repo:

| File | Purpose |
|---|---|
| `Claude Terminal.dc.html` | Interactive design mock (source of truth for layout, colors, behavior) |
| `support.js` | Runtime for the design mock (do not edit — generated) |
| `screenshots/` | Captures of the session, diff, and shell views |

---

## Concept

Claude Code is a CLI you normally babysit one terminal tab at a time. Francois turns that into an orchestrator: it spawns and manages multiple Claude Code sessions across different project directories, renders their activity in a structured UI, and gives each project a plain shell for manual work. The aesthetic is a TUI — monospace, dark, keyboard-first — but with full mouse support.

## Layout

A single window (design reference: 1360×864) with a title bar, a three-column grid, and a status bar:

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

Every pane is focusable (keys `1`–`5` or click). The focused pane gets an accent ring and accent title. The title bar shows the app name, the active project, and a live pulsing indicator with the number of running agents.

## Features

### 1. Sessions sidebar `[1]`

- Lists all Claude Code sessions. Each entry shows:
  - **Name** and **working directory** (e.g. `acme-api` / `~/projects/acme-api`)
  - **Model** the session runs on (e.g. Sonnet, Opus, Haiku)
  - **Status** with a colored dot: `running` (pulsing amber), `idle` (gray), `done` (green), `error` (red)
- Click or navigate to select; the selected session drives the main pane.
- Footer action: **+ new session** (`n`) — spawns a new Claude Code session in a chosen directory.
- Header shows the session count and the pane hotkey.

### 2. Main pane `[2]` — three tabs

Tab header also shows session metadata when relevant: current model, **context usage** (e.g. `48.2K/200K`), and elapsed time.

#### SESSION tab — the conversation

Structured rendering of the Claude Code transcript:

- **User messages**: distinct "YOU" block (accent left border).
- **Assistant status/thinking lines**: `●` glyph, plain text.
- **Tool calls**, compact one-liners with a glyph and metadata:
  - `⧉ Read src/auth/middleware.ts · 128 lines`
  - `⌕ Grep verifyToken( · 14 matches · 6 files`
  - `✎ Edit src/auth/middleware.ts · +34 −19`
- **Subagent dispatch**: `⇉ Dispatched subagent test-writer · writing tests`.
- **Streaming**: the in-progress assistant line ends with a blinking block cursor.
- **Input bar** at the bottom: send a follow-up or run a command; hints at the ⌘K palette.

#### DIFF tab — review the session's changes

The tab label carries a badge with the number of changed files.

- **File strip**: horizontally scrollable chips, one per changed file, each with `+added` / `−deleted` counts; selectable.
- **Diff view**: unified diff with line numbers, `+`/`−` gutter signs, hunk headers, and tinted add/delete backgrounds.
- **Footer**: aggregate stats (`+185 −21 across 4 files`) and actions — `[s]` stage all, `[c]` commit….

#### SHELL tab — the regular terminal

A real, PTY-backed shell in the session's working directory. This is the "normal terminal" option: everything a standalone terminal does, inside the app.

- Prompt shows project + `❯`; full command history above.
- Color-coded output (success green, errors red, git-modified amber, untracked green — the design shows `git status`, test runs, `francois agents --status`, and a failing `docker compose` as examples).
- Blinking cursor at the active prompt.
- Footer: shell indicator (`● bash · ~/projects/acme-api`) and hints — `⌃C` interrupt, `⌃L` clear.

### 3. Agents panel `[3]`

Live view of the selected session's subagents:

- Each agent card: status dot (pulsing when running), **name**, status label, one-line **task description** (e.g. `auth.middleware.test.ts · 12 cases`), and a **progress bar**.
- Statuses: `running`, `idle` (queued), `done` (e.g. `0 vulnerabilities found`).
- New agent via the `a` shortcut; kill agent via the command palette.

### 4. MCP servers panel `[4]`

Connection status of the session's MCP servers:

- Per server: status dot, name, and a detail column — tool count when connected (`github · 21 tools`), the error when failed (`puppeteer · timeout`, red), or progress when connecting (`linear · handshake…`, pulsing).
- Attach a new server from a registry via the command palette.

### 5. Skills panel `[5]`

Skills available to the session:

- Per skill: glyph (`✦` installed, `◇` available), name, one-line purpose (e.g. `pdf-extract · read & parse PDFs`), and status label (`installed` / `available`).
- Run a skill via the command palette.

### 6. Command palette (⌘K / Ctrl+K)

Modal overlay with a text input and a filterable command list. Commands shown in the design:

| Command | Hint |
|---|---|
| New session | spin up in cwd |
| Switch model | sonnet · opus · haiku |
| Attach MCP server | from registry |
| Run skill | browse installed |
| View diff | 7 files changed |
| Compact context | 48.2K → summary |
| Kill agent | select running |

Navigation: `↑↓` to move, `⏎` to run, `esc` to dismiss. Clicking the backdrop also dismisses.

### 7. Status bar

Always-visible keymap and app state: `1-5` switch pane · `⏎` open · `/` search · `⌘K` commands · `a` new agent · `d` diff · `t` shell — plus the current **focus** label and the app version.

## Keyboard model

Keyboard-first throughout. Bindings from the design:

| Key | Action |
|---|---|
| `1`–`5` | Focus sidebar / main / agents / mcp / skills |
| `⏎` | Open the selected item |
| `/` | Search |
| `n` | New session |
| `a` | New agent |
| `d` | Toggle DIFF tab (focuses main pane) |
| `t` | Toggle SHELL tab (focuses main pane) |
| `⌘K` / `Ctrl+K` | Toggle command palette |
| `esc` | Dismiss palette |
| `⌃C` / `⌃L` | Interrupt / clear (inside SHELL) |

## Visual design system

From the mock — dark only, monospace everywhere:

- **Typeface**: JetBrains Mono (400/500/700).
- **Surfaces**: window `#121318` on `#08090b` radial backdrop; panels `#16171c`; main `#131419`; shell `#0f1015`; raised rows `#1a1c22`/`#1b1d23`; borders `#24262d` / `#2a2c33`.
- **Accent**: amber `#c8a15a` (focus rings, prompts, cursors, hotkeys, selection markers).
- **Status colors**: running `#d0a45c` · done/ok `#7fa07a` · error `#c46b62` · connecting `#c2b06a` · idle `#6b7079`.
- **Text**: primary `#c4c7ce`, bright `#dfe2e8`, dim `#868a93`, faint `#565a63`.
- **Diff tints**: adds `rgba(127,160,122,0.09)`, deletes `rgba(196,107,98,0.09)`.
- **Motion**: 1.4s ease pulse for running/connecting dots; 1s step blink for cursors.
- Rounded panels (5px), 10px gutters, 8px thin scrollbars.

## Under the hood (implementation notes)

What the UI implies the backend must do:

1. **Session management** — spawn/stop Claude Code per project directory, track status, model, context usage, and elapsed time. Integration via Claude Code's programmatic interface (headless `claude -p --output-format stream-json` or the Claude Agent SDK) so the transcript arrives as structured events, not scraped terminal output.
2. **Event rendering** — map streamed events (assistant text, tool calls, tool results, subagent lifecycle) to the SESSION tab's block types; support streaming partials.
3. **PTY terminals** — one real pseudo-terminal per session for the SHELL tab (bash/zsh/PowerShell per platform), with ANSI color rendering, interrupt, and scrollback.
4. **Git integration** — per-session working-tree diff (file list with counts, unified hunks), stage-all and commit actions.
5. **Agent/MCP/skill state** — surface subagent progress, MCP server connection status and tool counts, and installed/available skills from the session's configuration.
6. **CLI companion** — the mock shows a `francois agents --status` command, implying a small CLI that talks to the running app.

## Open decisions

- ~~**Delivery target**~~: resolved — a **native desktop app, not a web app**: Tauri 2 with a Rust core and a React + TypeScript frontend; xterm.js + `portable-pty` for the terminal panes; Claude Code driven through its headless `stream-json` interface. Details in PIPELINE.md.
- ~~**Name**~~: resolved — **Francois** (after Claude François, the French singer).
- **Scope of v1**: the mock shows one active session's detail at a time; multi-session split views, session persistence/restore, and remote sessions are not in the design and are out of scope until decided.
