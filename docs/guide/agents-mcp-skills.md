# Agents, MCP & skills

The right column of Francois's main window carries four panes that describe what the active
session's Claude Code process is doing and what it can reach: **AGENTS** (pane `[3]`), **MCP
SERVERS** (pane `[4]`), **SKILLS** (pane `[5]`), and **WORKFLOWS** (pane `[6]`). All four are
scoped to whichever session is currently active — switching sessions in the sidebar clears and
re-hydrates all of them.

The AGENTS, MCP and SKILLS cards can each be **collapsed to their header strip**, so a long agent
trail doesn't have to share the column with panels you aren't reading: click the header, or focus
the card and press `c`. There's a palette entry per card too ("Toggle agents panel", and so on),
which also reveals the column if it's hidden. A collapsed card keeps its live count and its `[n]`
hotkey visible, the still-expanded cards take the freed height in their usual ratios, and the
collapsed set is remembered across restarts. (WORKFLOWS is not collapsible.) `]` still hides the
whole column at once.

## AGENTS (pane [3])

The AGENTS panel lists the active session's subagents as a scrollable stack of cards. Each card
shows a status dot, the agent's name, a right-aligned status label, a one-line task description,
and a progress-style meta row. The header reads `AGENTS · N · [3]`, where `N` counts every agent
the session has ever spawned — cards are never dropped once an agent finishes.

Cards are grouped, not just listed: all `running` agents first, then `idle` (queued), then
`done`/`error` interleaved by the order they were first seen. Updates re-bucket a card in place
without disturbing where it sits within its new bucket.

From this pane you can:

- **Dispatch a new agent** — press `a` (or run "New agent" from `⌘K`) to open a small prompt modal,
  type a task description, and submit. The card appears once the engine's own `agent.update` event
  arrives; the panel never synthesizes a placeholder.
- **Kill a running agent** — hover a running card's status label to reveal a `✕`, press `x` with it
  selected, or use `⌘K`'s "Kill agent" entry, which lists only the session's currently running
  agents. Killing is bookkeeping, not a hard interrupt (see below); the card is left alone until the
  next `agent.update` reports the outcome.
- **Expand a card** — select it with `↑`/`↓` and press `⏎` to see the full task text and an explicit
  progress percentage, plus (for agents with recorded activity) a scrollable trail — see below.

A session with no subagents yet shows `no agents yet · press a` instead of a card list.

### Async subagents: real elapsed time, not instant completion

Claude Code's subagent tool (`Agent`) runs **in the background by default** — its immediate
`tool_result` is only a spawn acknowledgement, not the agent's actual result. Francois classifies
every dispatch as synchronous or background and treats them differently:

- A **synchronous** dispatch (the stock `Task` tool, or an explicit `run_in_background: false`)
  completes exactly on its `tool_result`: the card flips to `done` (or `error`), and `endedAt` is
  stamped then.
- A **background** dispatch (`Agent`, or an explicit `run_in_background: true`) is *not* completed
  by that `tool_result`. The card stays `running` and its elapsed timer keeps counting real
  wall-clock time until one of: a background-completion notice arrives in the stream, the turn
  itself ends (whatever the agent's state, it is finalized as `done`/`error` when the turn
  finishes — a card can never be stuck on `running` forever), or the agent is killed. This is what
  lets a four-minute subagent report roughly four minutes of elapsed time instead of `0s`.

Background agents show an `async` marker on their card. If Francois observes further activity from
an agent it had already marked finished, it restores the card to `running` — observed activity
always outranks an inferred completion.

**Activity trail.** Every line the stream attributes to a subagent (via `parent_tool_use_id`) is
turned into a step — text the agent said, a tool it called, or a lifecycle notice (dispatched,
completed, killed, ended with the turn) — and kept as a bounded, ordered trail per agent (windowed
at 200 steps; a truncation counter says how many earlier steps were dropped). The collapsed card
shows the newest step as a one-line "what it's doing right now" suffix on the meta row
(`◷ 31s · ⧉ Grep is_subagent_tool`); the expanded card shows the whole trail, auto-scrolling to the
newest entry unless you've scrolled up inside it. These inner lines never appear in the SESSION
tab's own transcript — they belong to the agent, not the parent turn.

### Opening an agent's own conversation as a tab

Clicking a card (as opposed to selecting it with the keyboard) does more than select it: it opens —
or, if already open, focuses — a dedicated tab for that agent in the main pane's tab strip, after
SHELL. The tab shows `⇉ {name}`, a status dot, and a `✕` on hover to close it.

That tab renders the subagent's **own transcript**: the same assistant text and tool cards the
SESSION tab uses for the parent turn, but built from the very lines the activity trail summarizes —
full text and full tool bodies, not the trail's 120-character labels. The tab header repeats the
agent's name, its `async` marker if applicable, status, live elapsed time, and task line. New blocks
append and auto-scroll the same way the trail does; a truncation row appears if the transcript
window (400 blocks) has dropped older content.

A few rules govern the tab strip:

- Up to **6** agent tabs can be open at once; opening a 7th closes the oldest tab that isn't the one
  being activated.
- Closing the active agent tab falls back to SESSION; closing an inactive one leaves the current tab
  alone. The `w` key closes the active agent tab the same way.
- Switching the active session closes every agent tab (agent ids are session-scoped).
- `↑`/`↓` and `⏎` in pane `[3]` still drive the in-place trail expansion — only a *click* opens a tab.
  A subagent that itself dispatches a subagent gets no tab of its own; that nested call shows up as
  one tool card inside its parent's tab.

## MCP SERVERS (pane [4])

The MCP panel reflects the active session's configured MCP servers as status rows: a colored dot,
the server name, and a right-aligned detail — a tool count when `connected`, `handshake…` while
`connecting` (the only state that pulses), or the error message when `error`. The header reads
`<N> · [4]` plus a `+` affordance for attaching a new server.

Rows come from every scope the Claude Code CLI itself sees for the session's working directory,
merged with precedence **local > project > user**, and each row carries a scope badge. Writes,
though, stay project-scoped: attach and detach only ever touch the session's project `.mcp.json`.
Detaching a server that lives in a non-project scope is refused (the panel hides the Detach action
for those rows) with guidance to remove it via `claude mcp remove` instead.

Selecting a row (`↑`/`↓` or click) and pressing `⏎` (or just clicking) opens a detail popover:
transport, the resolved command or URL, and either the tool count or the **full**, untruncated error
text. From there:

- **Reconnect** restarts the connection; on success the row optimistically flips to `connecting`
  pending the next update.
- **Detach** requires an inline confirm before it removes the server from `.mcp.json` and asks the
  session to disconnect it.

**Attaching a new server** is a two-step flow, opened from `⌘K`'s "Attach MCP server" or the panel's
`+`:

1. **Registry** — a list of curated entries (e.g. `linear`, `sentry`, `notion`) sourced from a
   static, app-bundled catalog, plus a trailing `custom…` row that stays available even if the
   registry fetch itself fails.
2. **Parameters** — picking a registry entry generates one form field per parameter (masked when
   marked secret); picking `custom…` asks for a name, a transport (`stdio` or `http`), and the
   matching command or URL. Submit is disabled until required fields are filled, and a client-side
   check rejects a name already in the row list before it ever reaches the core.

On submit, non-secret parameter values are substituted into the entry's command/URL template;
secret values are collected separately and applied as env vars or headers, never written into the
command/URL text itself. A successful attach closes the flow — the new server typically appears
moments later via a `connecting` row as the connection comes up.

## SKILLS (pane [5])

The SKILLS panel lists everything the active session's Claude Code process can actually invoke —
not a static catalog. **Installed** rows (`✦`) are the union of SKILL.md skills and slash-command
files discovered from the project (`<cwd>/.claude/{skills,commands}`), the user
(`~/.claude/{skills,commands}`), and every enabled plugin, deduped by name with precedence
**project > user > plugin** (and skill over command within a scope). **Available** rows (`◇`) are
SKILL.md skills from marketplace plugins that are *not* currently enabled, listed alphabetically
after the installed rows. Each row carries a scope badge; command rows additionally show a `/`
prefix and a `cmd` badge. The header reads `N · [5]`, unaffected by the in-panel filter.

Selecting a row and pressing `⏎` (or clicking it) does one of two things depending on its state:

- **Installed** — opens a run modal: the skill name in the header, an optional single-line
  arguments field, `⏎ run` / `esc cancel`. Submitting composes `/<name>` (or `/<name> <args>` when
  arguments were given) and sends it as a user message into the session, exactly as if it had been
  typed into the SESSION composer.
- **Available** — opens an install-confirm modal (name, description, "Install"/"Cancel", "Install"
  selected by default). Confirming **enables the owning plugin** — it writes
  `enabledPlugins[<plugin>] = true` into `~/.claude/settings.json` (global, effective on the next
  turn), not a per-project file copy — and the confirm dialog discloses that this also turns on the
  plugin's hooks and MCP servers. The list refreshes automatically afterward.

The list also refreshes on its own whenever the core's filesystem watcher sees a change under
either skills directory. Pressing `/` opens a one-line filter that matches name and description
case-insensitively without re-ordering the installed/available split or re-fetching from the core;
`esc` clears it. `⌘K`'s "Run skill" entry reuses the same in-memory data, filtered to installed
entries only, and runs one with no arguments.

If the discovery scan itself cannot complete — an unreadable or unparseable settings file, for
example — the panel shows a single dim, error-colored row with the failure message instead of the
normal list; pressing `⏎` on it retries. A clean scan that simply finds nothing shows
`no skills or commands found`, not an error.

## WORKFLOWS (pane [6])

Claude Code's harness ships a `Workflow` tool: the assistant hands it a script that orchestrates
many subagents deterministically — phases, fan-out, pipelines — and the tool returns immediately
while the run proceeds in the background. Without this pane that dispatch is one anonymous tool
block in the transcript and then silence. Pane `[6]` gives workflow runs the standing subagents
already have in pane `[3]`.

Cards list the session's runs in first-seen order with running ones on top, and each shows a
status dot (pulsing while running), the run's **name** from the script's `meta`, a phase-count
badge, the status, a **live elapsed clock** anchored to the dispatch, and the last thing observed
about the run. Selecting with `↑`/`↓` and pressing `⏎` — or clicking the card — expands it to the
harness run id and the **phases the script declared**.

Two things the panel deliberately does not do:

- **It never implies per-phase progress.** A workflow's own agents don't surface in the parent
  session's stream, so the panel reports which phases were declared and says so on the expanded
  card. Watching a run tick phase by phase is still `/workflows` in the CLI.
- **It never dispatches or stops a run.** A run starts because the assistant called the tool
  during a turn, so unlike pane `[3]` there is no `+` affordance and no kill action. A session
  with no runs shows an empty label rather than a card list.

## How the four panes relate

All four panes are read-only reflections of state the core (session-engine) owns — none of them
run an agent, an MCP client, a skill loader, or a workflow themselves. They share a common shape:
hydrate once via an IPC snapshot when a session becomes active, then stay live off the same
session event stream, discard everything on session switch, and persist nothing to disk (the
collapsed/expanded state is the one exception, and it's a frontend preference, not session
state). The AGENTS panel is the only one with a second, deeper surface — the agent tab — because
a subagent's own conversation is worth reading in full, not just summarized as a card.
