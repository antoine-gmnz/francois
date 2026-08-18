# Francois — Claude Code Session Orchestrator

A terminal application for running and supervising [Claude Code](https://claude.com/claude-code) sessions. One window shows every session, its conversation, its diff, its subagents, its MCP servers, and its skills — plus a **regular terminal** (real shell) alongside the AI, so you never have to leave the app to run commands yourself.

The name **Francois** is a nod to Claude François, the French singer. (The design mock still uses the earlier working name "clyde", v0.4.2 — treat every "clyde" in the mock as "francois".) The reference design lives in this repo:

| File | Purpose |
|---|---|
| `Francois Redesign.dc.html` | The shell as it ships — variant 3a, with the v2 identity applied (source of truth) |
| `Francois Design System v2.dc.html` | Surfaces, type roles, colour families, geometry, components, rules |
| `Francois Logo.dc.html` | The three-slab mark — size ramp, tone variants, lockups, clearspace, misuse |
| `Claude Terminal.dc.html` | The pre-v2 mock; still governs surfaces the redesign never re-drew |
| `support.js` | Runtime for the design mocks (do not edit — generated) |
| `screenshots/` | Captures of the session, diff, and shell views |

---

## Concept

Claude Code is a CLI you normally babysit one terminal tab at a time. Francois turns that into an orchestrator: it spawns and manages multiple Claude Code sessions across different project directories, renders their activity in a structured UI, and gives each session a plain shell for manual work. The aesthetic is a console — keyboard-first, one accent for the live thing — but with full mouse support.

## Layout

A single window with the native caption, **two full-bleed chrome tiers** under it, and a two-track
grid below that (design turn 7a — the earlier three-column grid with a right rail is gone):

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● ● ●   ◤ francois   Overview │ Sessions │ Agents   + │ 2 waiting · ▮▮▮ plan · account · ⌘K · ☾ · v0.23.0 │
├──────────────────────────────────────────────────────────────────────┤
│ ‹ ODO › acme-api · feat/auth   ● running · opus · 48.2K/200K   ▣ ◫ ❯ │ ⊞ ⧉ │ Stop │
├────────────┬─────────────────────────────────────────────────────────┤
│ ROSTER [1] │                                                          │
│  ODO       │   the main pane — one bare surface, no card              │
│   acme-api │   (SESSION · DIFF · SHELL · OVERVIEW · AGENTS · MCP ·    │
│    ⋯ cards │    SKILLS · WORKFLOWS · agent: · workflow: · ext: tabs)  │
│   agents 3 │                                                          │
│   mcp   2  │                                                          │
│ + new [n]  │   › composer                                             │
└────────────┴─────────────────────────────────────────────────────────┘
```

- **App row** — app-scoped and never animated: the mark, three view pills (Overview / Sessions /
  Agents), `+`, how many sessions are parked on you, the plan meters, the account chip, `⌘K`, the
  theme toggle, the update chip, the version.
- **Session row** — scoped to the one session the main pane shows: project breadcrumb + switcher,
  status dot, model, context usage, elapsed, its view icons, any `ext:` tabs, and `Stop`.
- **Roster `[1]`** — groups → projects → session cards, plus the quiet rows that open the dissolved
  panels (agents, mcp, skills, workflows) as main tabs. It folds to a 46px rail with `[`; folded is
  never *gone*.
- **Main pane `[2]`** — a bare surface, since the tabs moved into the session row. Up to **four**
  panes side by side in a resizable grid, each on its own session.

> **The design mocks are the reference for layout, colors, glyphs and micro-interactions — this
> section describes what ships.** The authoritative **feature** list is the feature map in
> [`PIPELINE.md`](PIPELINE.md); each feature's behavior is its frozen spec in `specs/`.

## Features

### 1. Roster `[1]`

- Three tiers: **group** (a named parent over projects — organising only) → **project** → **session
  cards**. Headings are collapsible; each carries a `+`.
- Each session card is a fleet-board readout: status dot (pulsing while a turn runs), name, model,
  live context usage, an uncommitted-diff badge, running-agent count, last-activity clock, and chips
  for a worktree, a cloud-adopted session or an active remote control.
- `/` filters by name and path; the project switcher in the session row scopes the roster.
- Footer: **+ new session** (`n`) — directory, model, account, profile, and optionally its own
  `git worktree` (new or existing). A **profile** bundles a system prompt and vetted extra `claude`
  args under a name, paired to a project.
- Context menu / palette: rename, open in VS Code, remote control, kill.

### 2. Main pane `[2]` — the tabs

Fixed tabs: **SESSION · DIFF · SHELL · OVERVIEW**, plus the dissolved panels **AGENTS · MCP ·
SKILLS · WORKFLOWS**, plus dynamic **`agent:` / `workflow:` / `ext:`** tabs. Every tab is keyed to
its own session, so each pane of a split renders its own.

#### SESSION tab — the conversation

Structured rendering of the Claude Code `stream-json` transcript, in a measured reading column:

- **User messages**: distinct "YOU" block (accent left border).
- **Assistant status/thinking lines**: `●` glyph, plain text.
- **Tool calls**, compact one-liners with a glyph and metadata (`⧉ Read … · 128 lines`,
  `⌕ Grep … · 14 matches`, `✎ Edit … · +34 −19`).
- **Subagent dispatch**: `⇉ Dispatched subagent test-writer · writing tests`.
- **Cards that ask for something**: `AskUserQuestion` options and permission approvals for gated
  tool calls (with a rules editor over Claude Code's own `settings.json`).
- **Welcome header** on an empty transcript: identity column + repo column (CLAUDE.md, branch/ahead,
  sessions that finished here).
- **Composer**: `/` slash-command autocomplete, `↑`/`↓` message recall, file and clipboard
  attachments (drop, paste a screenshot, or pick), interrupt via `Stop`.

#### DIFF tab — review the session's changes

- **Navigator**: a collapsible **folder tree** with status glyphs and ±counts, a `/` filter box, and
  `↑↓←→` traversal (`←`/`→` fold and unfold).
- **Diff body**: windowed unified diff with line numbers, `+`/`−` gutter signs, hunk headers, tinted
  add/delete backgrounds, and **word-level intraline emphasis** on paired lines.
- **Footer**: aggregate stats and actions — `[s]` stage all, `[c]` commit.

#### SHELL tab — the regular terminal

Real PTY-backed shells in the session's working directory — **several per session**, tabbed inside
the tab (new / next / close / rename from `⌘K`). ANSI colour, interrupt, scrollback. On Windows the
shell and `claude` follow the WSL runtime while git follows the filesystem.

#### OVERVIEW tab — the fleet

Cross-project dashboard, auto-selected on "All projects": fleet totals, what needs attention,
per-project rollup, activity feed.

### 3. Agents

- Cards for the selected session's subagents: status dot, name, status label, task line, real
  elapsed time, and a per-agent activity trail derived from `parent_tool_use_id`.
- Click a card to open **that agent's own transcript** as its own main tab; a spawned subagent adds
  its chip on its first update. `w` closes the active dynamic tab, `x` kills the selected agent.

### 4. MCP servers

Per server: status dot, name, and a detail column — tool count when connected (`github · 21 tools`),
the error when failed (`puppeteer · timeout`), or progress when connecting (`linear · handshake…`).
Attach a server from the palette.

### 5. Skills

Per skill: glyph (`✦` installed, `◇` available), name, one-line purpose, status label. `/` filters;
run from the palette.

### 6. Workflows

`Workflow` tool runs read off the session stream — name, description and phases from the script's
`meta`, live elapsed, ack and completion. Open a run to get its own tab: its agents, the phase
timeline, and per-agent transcripts.

### 7. Command palette (⌘K / Ctrl+K)

Modal overlay with a text input and a fuzzy-filtered command list — around three dozen commands:
new session (plain, with a profile, in a worktree, or adopting a cloud session), rename session,
switch model, compact context, attach MCP server, run skill, kill agent, new agent, open any of the
four panel tabs, view diff / overview, manage projects · profiles · permissions · accounts ·
extensions, refresh usage, check for updates, toggle theme, notifications and sound, and the shell
verbs. `↑↓` moves, `⏎` runs, `esc` dismisses.

### 8. Extensions

Main-pane `ext:` tabs fed by out-of-process providers under hard caps, rendered with four
declarative primitives (`key-value`, `table`, `stat-row`, `log-tail`). Plugins load from
`~/.francois/extensions/*/extension.json` (`francois ext install|list|remove`) — a manifest declares
commands, nothing runs until you consent, and consent is bound to the manifest's sha256.

### 9. Notifications

A desktop banner when a session is blocked on an approval or a question, or its turn finishes or
errors — plus a short synthesized tone for the same two classes (Web Audio, no asset), with no focus
gate, one master toggle, a 1.5s throttle, and silence under OS Do Not Disturb.

## Keyboard model

Keyboard-first throughout. Single-key bindings stand down while a text input or the SHELL terminal
has focus; `⌘K` always works.

| Key | Action |
|---|---|
| `1` / `2` | Focus roster / main pane |
| `3`–`6` | Open (and toggle back from) AGENTS / MCP / SKILLS / WORKFLOWS |
| `d` / `t` / `o` | Toggle DIFF / SHELL / OVERVIEW |
| `w` | Close the active agent or workflow tab |
| `n` / `a` | New session / new agent |
| `x` | Kill the selected agent (in AGENTS) |
| `/` | Filter — sessions, skills, or DIFF files |
| `↑` `↓` `⏎` | Navigate the focused pane · commit the selection |
| `←` `→` | Fold / unfold a folder in the DIFF tree |
| `s` / `c` | Stage all / commit (in DIFF) |
| `[` | Fold the roster to its rail |
| `⌘K` / `Ctrl+K` | Toggle the command palette |
| `esc` | Dismiss the palette |
| `⌃C` / `⌃L` | Interrupt / clear (inside SHELL) |

## Visual design system

Extracted in `Francois Design System v2.dc.html`. The rule that generates the rest: **sans carries the
interface, mono carries facts** — paths, counts, keys, code, elapsed time. Dark is the base; light is a
token override of the same system (geometry, type and spacing do not change).

- **Typefaces**: IBM Plex Sans (400/500/600) for the interface; JetBrains Mono (400/500) for facts.
  No mono headings, no sans file paths.
- **Mark**: three slanted slabs, each stepping right of the one below. Slab height 27.5% of the mark
  height, gap 8.75%, step 10%, total width 110%. The bottom slab is always dim — it is the idle
  session, not a shadow, so it never takes the accent. Two-tone down to 16px; single-tone below.
- **Surfaces** (three stacked steps + hover): app `#0d0f13` · deep `#11141a` (titlebar, status bar,
  composer well) · panel `#14171d` · raised `#1c212a` · hover `#232833`.
- **Lines**: inner hairline `#1f242d` · border `#232833` · strong `#2d333f` · active `#3c4453` ·
  overlay edge `#303845`.
- **Accent**: acid `#c3f53f`, hover `#d6fa7e`, soft bg `#1b240f`, soft edge `#35401f`. Acid marks the
  live thing and the recovering action — **one acid per view**; two acid buttons means neither is the answer.
- **Status hues** (each means exactly one thing, never decorative): working = the acid · ready `#4fae86` ·
  error `#d1685e` (text `#e0918a`) · measurement/context `#6f9fd8`.
- **Semantic**: tool glyph teal `#8fbab8` · subagent purple `#b39ede` (name `#cbb9ec`) · diff add
  `#9dbb98` · diff remove `#d68f86`.
- **Account tints** (fixed per account): blue `#1b2836`/`#2e4a63`/`#9cc2e4` · teal `#18262a`/`#2c4a4a`/`#9fd0cd` ·
  red `#2a1a19`/`#4a2b27`/`#e0918a`.
- **Text ladder**: bright `#f2f4f8` → default `#e6e9ef` → strong `#d6dae2` → body `#c3c9d4` →
  label `#9aa2b1` → meta `#8b93a3` → dim `#6b7385` → faint `#565e6e`.
- **Radii**: 5 inner tab pill · 6 button/chip/row · 7 card/tab · 8 pane · 11 window/overlay/composer.
- **Spacing**: 6 tab gap · 8 row · 10 panel · 12 pane gutter · 16 block · 22 transcript · 26 reading pad.
- **Elevation**: panes are hairline + one luminance step, never shadowed. Shadow is reserved for the
  composer (`0 8px 24px rgba(0,0,0,.4)`), popovers and the window itself.
- **Motion**: 1.6s stepped pulse for running dots; 1s step blink for cursors.
- **Light theme**: surfaces invert to near-white, the acid darkens to `#4e6a14`, status hues darken for contrast.

## Under the hood (implementation notes)

1. **Session management** — spawn/stop Claude Code per project directory (optionally in its own
   `git worktree`), track status, model, context usage and elapsed time, and **persist** all of it so
   a session survives quit/reopen and resumes over `claude --resume`. Driven through
   `claude -p --output-format stream-json --include-partial-messages`, so the transcript arrives as
   structured events rather than scraped terminal output; interactive slash commands and approvals go
   over the stdio control channel.
2. **Event rendering** — map streamed events (assistant text, tool calls, tool results, subagent and
   workflow lifecycle, questions, permission asks) to block types; support streaming partials.
3. **PTY terminals** — several real pseudo-terminals per session for the SHELL tab, with ANSI colour,
   interrupt and scrollback; WSL-aware on Windows.
4. **Git integration** — per-session working-tree diff (tree with counts, unified hunks), stage-all
   and commit, worktree create/attach.
5. **Agent/MCP/skill/workflow state** — subagent progress and per-agent transcripts, MCP connection
   status and tool counts, installed/available skills, and `Workflow` runs with their phases.
6. **Accounts & usage** — several Anthropic accounts side by side, each with its own
   `CLAUDE_CONFIG_DIR`, logged in through a real `claude` TUI inside the app; plan meters and reset
   clock in the app row.
7. **Beyond the app window** — remote control (hand a session to Claude Code's native Remote Control),
   cloud-session adoption, out-of-process extension providers, desktop notifications + audio cues, an
   in-app self-update, and the `francois` CLI companion.

Every frontend↔core payload shape lives in [`contract/`](contract/); the Rust core mirrors it with
serde. Spawned children resolve their binaries against the **login-shell** PATH, not launchd's.

## Open decisions

- ~~**Delivery target**~~: resolved — a **native desktop app, not a web app**: Tauri 2 with a Rust core and a React + TypeScript frontend; xterm.js + `portable-pty` for the terminal panes; Claude Code driven through its headless `stream-json` interface. Details in PIPELINE.md.
- ~~**Name**~~: resolved — **Francois** (after Claude François, the French singer).
- ~~**Scope of v1**~~: resolved — multi-pane split views (up to four), session persistence/restore and
  remote sessions all shipped. What is still open is tracked as specs in `specs/`, not here:
  `session-brake` (stop a turn mid-flight) and `cli-companion` are frozen but not built.
