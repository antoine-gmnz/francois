---
layout: home

hero:
  name: Francois
  text: Mission control for your Claude Code fleet
  tagline: A native desktop app that spawns and supervises multiple Claude Code sessions in one window — structured transcripts, a diff tab that commits, a real shell, and full subagent/MCP/skill visibility, per session.
  image:
    src: /francois-mark.png
    alt: Francois
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is Francois?
      link: /guide/what-is-francois
    - theme: alt
      text: GitHub
      link: https://github.com/antoine-gmnz/francois

features:
  - icon: ⌗
    title: The fleet board
    details: One status card per session — colour-coded state, model, live context usage, an uncommitted-diff badge, running-agent count, and a last-activity clock. Every workstream, one glance.
  - icon: §
    title: Structured transcripts
    details: Not scraped terminal output. Francois drives Claude Code's stream-json interface, so user blocks, assistant text, tool calls, and subagent dispatches render as first-class blocks, streaming live.
  - icon: ≡
    title: A diff tab that commits
    details: Per-session working-tree view — file selector with status glyphs and ±counts, a windowed unified diff that stays snappy on large changes, stage-all and commit without leaving the app.
  - icon: ❯
    title: A real shell
    details: A PTY-backed terminal per session (xterm.js + portable-pty), in the session's working directory. Not a toy console — your actual shell, right next to the AI.
  - icon: ⇉
    title: Agents, MCP, skills & workflows
    details: Live subagent progress with real elapsed time, MCP server health (tool counts, handshakes, timeouts), installed skills, and running Workflow scripts — four collapsible cards, all per session.
  - icon: ⌘K
    title: Command palette + durable sessions
    details: Fuzzy-matched commands for everything, and sessions that survive quitting the app — transcripts, status, model, and context usage all come back.
  - icon: ⚇
    title: Several accounts at once
    details: Register more than one Anthropic account, each with its own Claude Code config directory, logged in from inside the app. Bind one per session or per project, with plan-limit meters per account.
---

## The window, in one picture

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

Every pane is focusable — keys `1`–`6` or click. Keyboard-first throughout, full mouse support
everywhere. See the [Interface tour](/guide/interface-tour) for the full walkthrough.

## Install in one line

```sh
npm i -g francois
```

Then open it from the Start Menu, Launchpad, or your applications menu like any other app. See
[Getting started](/guide/getting-started) for requirements, building from source, and what gets
registered where.
