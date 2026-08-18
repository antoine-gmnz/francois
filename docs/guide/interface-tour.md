# Interface tour

A single window: the native caption, **two full-bleed chrome tiers** under it, and a two-track grid
below that — the roster on the left, the main pane on the right. Both tracks are focusable with the
number keys or a click; the focused one gets an accent ring.

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

::: info If you've used an older build
Francois used to have a third column on the right holding four stacked cards (agents, MCP, skills,
workflows), a tab strip inside the main pane's card, and a status bar along the bottom. All three
are gone. The four panels **dissolved into the roster's own rows** and open as main-pane tabs, the
tabs moved up into the session row, and every status-bar readout moved next to the thing it
describes. With the right column went its two bindings, `]` and `c`.
:::

## The app row

The outer chrome tier, and the only one never scoped to a session. It states what the *whole app*
is doing:

- **Left** — the three-slab mark and the wordmark, three view pills (**Overview** → the whole
  fleet, **Sessions** → the selected session, **Agents** → its subagents), and an accent `+` for a
  new session.
- **Right** — how many sessions are parked waiting on you, the plan-limit meters for the account
  the selected session runs on, the account chip, the `⌘K` hint, the theme toggle (`☾`/`☀`), the
  update chip when a new version is available, and the app version.

Nothing in this row takes focus, appears in the pane cycle, or animates — its height is identical
in every state, so nothing it does reflows the grid below. The meters are covered in
[Command palette → The usage bar](/guide/command-palette#the-usage-bar).

## The session row

The inner tier, scoped to the one session the main pane is showing: the project breadcrumb and
**project switcher**, the session's status dot, its model, its live context usage and elapsed time,
icons for its three views (SESSION / DIFF / SHELL), any `ext:` tabs its project matched, and
**Stop** to interrupt a running turn. Chips appear here for a worktree branch, a cloud-adopted
session, and an active remote control.

## The roster `[1]`

The left track, and the app's map of everything you're running. It nests three tiers:

- **Group** — an optional named parent over projects, for when one product spans several
  checkouts (`ODO` → `ODO - Frontend`, `ODO - Databases`). Organising only.
- **Project** — a registered repo, with its own defaults and standards.
- **Session cards** — one per session: status dot (pulsing while a turn runs), name, model, live
  context usage, an uncommitted-diff badge, a running-agent count, and a last-activity clock.

Headings collapse, and each carries its own `+`. Below the sessions sit the **quiet rows** that
replaced the old right column — `agents`, `mcp`, `skills`, `workflows` — each showing a live count
and opening its view as a main tab. `/` filters sessions by name and path; `n` (or **+ new
session**) opens the new-session modal. Details in
[Sessions & projects](/guide/sessions-and-projects).

`[` folds the roster to a 46px rail. Folded is never *gone* — the rail keeps `[1]` and the panel
rows one click away.

## The main pane `[2]`

A bare surface, since the tabs moved into the session row. It renders whichever tab is active:

- **SESSION** — the structured transcript. See
  [Conversation & permissions](/guide/conversation-and-permissions).
- **DIFF** — the session's uncommitted changes, as a folder tree plus a unified diff. See
  [Diff & shell](/guide/diff-and-shell).
- **SHELL** — real terminals in the session's working directory, several per session. Also in
  [Diff & shell](/guide/diff-and-shell).
- **OVERVIEW** — the cross-project dashboard, auto-selected on "All projects". See
  [Overview dashboard](/guide/overview-dashboard).
- **AGENTS `[3]` · MCP `[4]` · SKILLS `[5]` · WORKFLOWS `[6]`** — the four dissolved panels. Each
  key opens its tab and, pressed again, returns you to SESSION. See
  [Agents, MCP & skills](/guide/agents-mcp-skills).
- **Dynamic tabs** — an `⇉ agent:` tab for a subagent's own conversation, a `workflow:` tab for one
  `Workflow` run, and `ext:` tabs from [extensions](/guide/extensions). `w` closes the active one.

Up to **four panes** fit side by side in a resizable grid, each on its own session, and each
rendering its own tabs — a split pane's agent tab belongs to that pane's session, not to the app.

## Command palette

`⌘K` / `Ctrl+K` opens a fuzzy-matched command list from anywhere in the app — new session, switch
model, run a skill, attach an MCP server, manage projects, profiles, permissions, accounts or
extensions, toggle sound, check for updates. See [Command palette](/guide/command-palette).

## Visual language

Two typefaces, split by role: **IBM Plex Sans** carries the interface, **JetBrains Mono** carries
facts — paths, counts, keys, code, elapsed time. No mono headings, no sans file paths.

The accent is **acid** (`#c3f53f`) on cool greys, and it means *the live thing*: **one acid per
view**, so two acid buttons would mean neither is the answer. Status hues each mean exactly one
thing and are never decorative — working is the acid itself, ready is green (`#4fae86`, moved off
the accent deliberately so status never reads as accent), error is red, measurement and context are
blue. Subagents get their own purple, tool glyphs a teal. Panes are a hairline plus one luminance
step, never shadowed; shadow is reserved for the composer, popovers and the window.

The mark is three slanted slabs, each stepping right of the one below, with the bottom slab always
dim — that's the idle session, not a shadow, so it never takes the accent.

Both a dark and a derived light theme ship — the `☾`/`☀` toggle lives in the app row, the choice
persists, and the native window caption and the SHELL terminal re-theme along with it. The
conversation reads inside a measured ~680px column rather than sprawling to the window width.
