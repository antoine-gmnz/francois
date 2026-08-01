# What is Francois?

**Francois** is a native desktop app that turns [Claude Code](https://claude.com/claude-code)
from one terminal tab you babysit into an actual control room. It spawns and supervises
**multiple Claude Code sessions** across different project directories, streams each one's
activity into a structured UI, and puts a **real terminal** next to the AI — so you never leave
the window to run something yourself.

It's built as a **native desktop app** (Tauri 2: Rust core, the system webview — no Electron),
styled like a console you'd actually want to look at: an amber accent on warm greys, IBM Plex
Sans for chrome and JetBrains Mono for code, paths and numbers, in a dark or light theme —
keyboard-first, full mouse support.

## The problem it solves

Claude Code stopped being one terminal tab a long time ago for anyone running it seriously.
You've got a refactor running in one repo, tests being written in another, an infra change
waiting for review in a third — and you're alt-tabbing between terminal windows like it's
air-traffic control with sticky notes. Francois gives every one of those sessions a home in one
window: its own transcript, its own diff, its own subagents, its own MCP servers, its own shell.

## What's in the window

- **Sessions sidebar** (pane `[1]`) — every session, with live status, model, and context usage.
  See [Sessions & projects](/guide/sessions-and-projects).
- **SESSION tab** — the structured, streaming transcript: user messages, assistant text, tool
  calls, subagent dispatches, permission prompts, and slash commands. See
  [Conversation & permissions](/guide/conversation-and-permissions).
- **DIFF tab** — the session's working-tree changes, staged and committed without leaving the
  app. See [Diff & shell](/guide/diff-and-shell).
- **SHELL tab** — a real PTY-backed terminal in the session's directory. Also covered in
  [Diff & shell](/guide/diff-and-shell).
- **AGENTS / MCP SERVERS / SKILLS / WORKFLOWS** (panes `[3]`–`[6]`) — everything running
  underneath a session, one glance, each card collapsible. See
  [Agents, MCP & skills](/guide/agents-mcp-skills).
- **Command palette** (`⌘K`) — every action, fuzzy-matched. See
  [Command palette](/guide/command-palette).
- **OVERVIEW tab** — a cross-project dashboard when you're managing more than one codebase. See
  [Overview dashboard](/guide/overview-dashboard).
- **Title bar** — the project switcher and the plan-limit meters for the account the selected
  session runs on. See [Accounts & usage](/guide/accounts).

## What Francois is not

- Not a replacement for Claude Code itself — every session runs the real `claude` CLI
  underneath, driven through its structured `stream-json` interface. Francois is the cockpit,
  not a reimplementation.
- Not a web app. It's a native Tauri 2 app — a Rust core process managing sessions and PTYs, a
  React + TypeScript frontend rendering the UI in the system webview.
- Not tied to one project. Sessions can span any number of working directories at once, grouped
  by [project](/guide/sessions-and-projects#what-a-project-is).

## What's next

Three features have frozen specs but aren't built yet: **desktop notifications** when a
background session finishes or needs you, a **session brake** to stop a running turn mid-flight,
and a live **`francois` CLI companion** that talks to the already-running app from any terminal
(distinct from the install/launcher CLI documented in [The francois CLI](/reference/cli), which
is built today). Everything else in this guide is shipped and working.

## The name

Named after **Claude François** — the French singer with the immaculate choreography. He kept a
stage full of Claudettes perfectly in sync; Francois does the same for a fleet of Claudes.
*Comme d'habitude.*
