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
    details: Per-session working-tree view — a collapsible folder tree with status glyphs, ±counts and a filter box, word-level intraline emphasis, a windowed unified diff that stays snappy on large changes, stage-all and commit without leaving the app.
  - icon: ❯
    title: Real shells
    details: PTY-backed terminals in the session's working directory (xterm.js + portable-pty) — several per session, tabbed. Not a toy console — your actual shell, right next to the AI.
  - icon: ⇉
    title: Agents, MCP, skills & workflows
    details: Live subagent progress with real elapsed time, MCP server health (tool counts, handshakes, timeouts), installed skills, and running Workflow scripts — four views per session, opened straight from the roster or with 3–6.

  - icon: ◈
    title: Projects, groups & profiles
    details: Register your repos once for per-project session defaults and standards, group several checkouts of one product under a name, and save a way of working — system prompt plus vetted claude args — as a reusable profile.

  - icon: ♪
    title: Notifications you'll notice
    details: A desktop banner when a session is blocked on an approval or a question, or a turn lands — plus a short synthesized tone for the same two moments, throttled, and silent under OS Do Not Disturb.
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
│ ◤ francois   Overview │ Sessions │ Agents   +   2 waiting · ▮▮▯ plan · ⚇ · ⌘K · ☾ · vX │
├──────────────────────────────────────────────────────────────────────┤
│ ‹ ODO › acme-api · feat/auth    ● running · opus · 48.2K/200K   ▣ ◫ ❯ │ Stop │
├────────────┬─────────────────────────────────────────────────────────┤
│ ROSTER [1] │                                                          │
│  ▾ ODO     │                                                          │
│   acme-api │        the main pane [2] — one bare surface              │
│    ▪ card  │        SESSION · DIFF · SHELL · OVERVIEW                 │
│    ▪ card  │        AGENTS [3] · MCP [4] · SKILLS [5] · WORKFLOWS [6] │
│   agents 3 │        ⇉ agent · ⚙ workflow · ⊞ ext tabs                 │
│ + new [n]  │  › composer                                 [ Send ]     │
└────────────┴─────────────────────────────────────────────────────────┘
```

Two full-bleed chrome tiers do the talking — the **app row** for what the whole app is doing, the
**session row** for the one session you're reading — and the pane below is a bare surface. `1` and
`2` focus the roster and the main pane; `3`–`6` open the agents, MCP, skills and workflows views as
main tabs (press again to go back to SESSION). Up to four session panes fit side by side. See the
[Interface tour](/guide/interface-tour) for the full walkthrough.

## Install in one line

```sh
npm i -g francois
```

Then open it from the Start Menu, Launchpad, or your applications menu like any other app. See
[Getting started](/guide/getting-started) for requirements, building from source, and what gets
registered where.
