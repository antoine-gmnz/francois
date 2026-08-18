# Overview dashboard

Francois manages more than one project and more than one session at a time. Two
surfaces give the cross-project view: the **OVERVIEW** main tab, a read-only
dashboard of everything happening across every project, and the **fleet board**
(pane `[1]`, the sessions column), which shows one status card per session at all
times, regardless of which tab is open.

## The OVERVIEW tab

`OVERVIEW` is the first main tab in the strip — `OVERVIEW · SESSION · DIFF · SHELL`
— reachable by clicking it, the global `o` key, or the command palette (`Overview`).
It reads left to right from the whole fleet down to one session's files, which is
why it sits first.

The tab is purely derivative: it owns no IPC command, no event subscription, and no
backend state. Everything it shows already flows through the sessions column's
existing session/diff event subscription, so `OVERVIEW` needs no active session and
no project to render, and mounts and unmounts without seeding or tearing down
anything.

`o` toggles between `OVERVIEW` and `SESSION`, the same way `d` toggles `DIFF` and
`t` toggles `SHELL` — pressing it again returns you to `SESSION`. Like every other
global key, it is swallowed when a modal is open, an input is focused, or the
terminal has focus.

The dashboard has four regions, top to bottom: **fleet totals**, **needs
attention**, **per-project rollup**, and **recent activity**. Clicking any session
row anywhere on the dashboard selects that session, switches the main tab to
`SESSION`, and moves focus to the main pane — exactly as clicking its card in pane
`[1]` would. The dashboard itself has no start/stop/prompt/commit controls; it
reads, the session's own tabs act.

### When it's auto-selected

`OVERVIEW` is the initial tab whenever the sessions column is scoped to **All
projects** — at first launch, and also as the fallback when the project you had
active gets removed. Scoping down to one project never changes the current tab on
its own: mid-conversation in `SESSION` or reviewing a diff in `DIFF`, you stay
there when you narrow the scope. The reverse always holds, though: widening the
scope back to **All projects** returns the main pane to `OVERVIEW`, whatever it was
showing — there is no longer a single project's worth of session in view.

Selecting a session from pane `[1]` while on `OVERVIEW` switches to `SESSION`;
selecting one from `DIFF` or `SHELL` leaves the tab alone, so browsing sessions
while reviewing a diff never ejects you from it. The tab also works scoped to one
project, not just unscoped — it narrows to that project's sessions instead of
disappearing, so `o` is never a dead key regardless of scope.

### Fleet totals

The strip reads `<n> sessions` and, when unscoped, `<n> projects` (counting only
projects holding at least one session), followed by one segment per non-zero
figure — `active`, `ready`, `done`, `error`, `files`, `agents` — in that order.
**Zero-valued segments are omitted**: a strip that always shows `0 error` trains
the eye to skip the word that matters when it isn't zero. If every segment would be
zero but sessions exist, the strip reads `all quiet` instead of trailing off after
the counts.

`files` sums every session's known uncommitted-file count (unknown counts
contribute zero); `agents` sums running-subagent counts. The strip is labelled
`FLEET` when unscoped and `PROJECT` when scoped, and always aggregates over
exactly the sessions/groups rendered.

### Needs attention

Two kinds of session appear here, in order: every **errored** session (most
recently active first), then every **settled** session (idle or done) with a
known, non-zero uncommitted-file count (likewise most recent first). A **running**
session never appears — it's still working, not stuck. An errored session with
uncommitted files appears once, as an error, never twice. The error row's detail
is the session's error message, falling back to "session failed"; the uncommitted
row's detail reads `<n> uncommitted file(s)`, correctly singular. The whole
section is hidden when there's nothing to flag.

### Per-project rollup

One group per project, in registry order, **including projects with no sessions**
— the dashboard has to be able to say a project is idle, not just omit it. An
empty project renders a placeholder dash. Sessions with no project, or whose
project has since been removed, land in a synthetic **unlinked** group appended
last, shown only when non-empty. Scoped to one project, only that project's group
renders and the unlinked bucket is hidden.

Within a group, sessions are ordered by last activity, most recent first. A
group's header shows the project name, a `missing` tag if its root no longer
exists, the abbreviated root path, and a subtitle giving the session count plus
only the statuses worth naming (`active`, `error`, `done`) — `idle` is the resting
state and is never called out, so an all-ready group reads as just "2 sessions."
Each session row shows the status dot (pulsing only while running), the name,
status label, model label, context-token usage, uncommitted-file count and
running-agent count (each only when greater than zero), and relative last
activity, with fixed-width trailing columns so the rollup lines up like a table.

### Recent activity

An in-memory, newest-first log capped at 200 entries, oldest dropped first, and
**never persisted** — it starts empty at every launch. Recorded kinds:

| Kind | Recorded when |
|---|---|
| `session.started` | A session appears the dashboard has never seen before |
| `turn.finished` | A session goes from running to idle |
| `session.done` | A session's status becomes done |
| `session.error` | A session's status becomes error (detail: the error message) |
| `session.removed` | A session is removed |
| `agent.finished` | A subagent finishes (detail: the agent's name) |
| `agent.failed` | A subagent errors (detail: the agent's name) |

A transition into `running` is never recorded — it fires on every prompt and would
drown the feed. A no-op transition (status unchanged) is likewise never recorded.

Each entry captures the session's name and project at record time, not resolved
later, so renaming or removing a session afterward never rewrites its history. The
feed is scoped like the rest of the dashboard: one project shows only that
project's entries (unlinked entries drop out); unscoped shows everything. Up to 40
entries render, each with relative time, session name, event label, and detail,
tinted by tone — red for errors, green for success, accent for active transitions,
faint for neutral. Clicking a row opens that session.

With no sessions and no projects at all, the body is replaced by a centered
"nothing running yet" message with shortcuts to start a new session or open
project management.

## The fleet board (pane [1])

The fleet board is pane `[1]`, the sessions column — the single-glance view of
every workstream, visible regardless of which main tab is open. It renders one
**status card per session**, and every figure on it is aggregated from data that
already flows to the frontend: no new backend command, event, or error code was
introduced to build it.

Each card shows, top to bottom:

1. A header row: a status dot plus the session name on the left, relative
   last-activity time on the right.
2. The abbreviated working directory (single line, ellipsized).
3. A status line: the status label with the model name (e.g. `active · Sonnet
   4.5`).
4. A meta row: context-token usage, then — only when non-zero — an
   uncommitted-diff badge and a running-agent count.

### Status, colour, and pulse

| Backend status | Card label | Colour | Pulses? |
|---|---|---|---|
| `running` | active | the acid accent | yes |
| `idle` | ready | grey | no |
| `done` | done | green | no |
| `error` | error | red | no |

Only `running` pulses. There is deliberately no distinct "needs input" state — a
session that finished its turn is `idle`, ready and waiting, not stuck. An errored
session's stored error message, when present, is the card's hover tooltip.

### Context, diff badge, and agent count

Context usage renders as `used/limit` (e.g. `48.2K/1M`), using the same token
formatter as the conversation view; if the limit is unknown only the used figure
shows, and if both are zero it renders as a dash.

A count pill (`≡ <n>`) appears only when a session has more than zero uncommitted
files — zero and unknown counts both render no badge, since neither is
actionable. The count is seeded once per session on first appearance (a one-shot
summary read) and kept live afterward by diff-changed events, so a session
restored from a previous run shows its correct badge immediately, without a turn
having to run first.

The running-agent count (`⇉ <n>`, accent colour) shows only when greater than
zero, derived purely from the live agent-update event stream — the board never
polls per-session agent lists, so the count is accurate from the moment it mounts.
Restored sessions always start at zero agents, since none survive a restart.

### Last activity, selection, and keyboard

The relative-activity token (`now`, `45s`, `2m`, `3h`, `5d`) refreshes on every
relevant event and on a 30-second timer, so an idle card still visibly ages. A
future timestamp (clock skew) clamps to `now`.

Clicking a card makes that session active immediately; focus stays on the sessions
column. With the column focused, `↑`/`↓` move a keyboard cursor across the visible
cards without changing the active session. `⏎` promotes the cursor's session to
active **and** moves focus into the main pane, landing you in its conversation —
the one point where the fleet board differs from a plain session list, which would
leave focus on the sidebar.

### Inherited behaviour and live updates

The board preserves the sessions column's existing behaviours unchanged: the
inline `/` filter over name and path, the footer's "new session" control and `n`
shortcut, the right-click "remove session" menu with inline confirm, and the
empty/no-matches/hydration-error states. Restored sessions appear immediately with
their persisted status, model, and context usage, and a diff badge seeded from the
current working tree. Every field on every card updates in place as events arrive
— no re-fetch of the session list, no flicker — and the fleet board and the
`OVERVIEW` tab read from the same underlying per-session data, so the dashboard's
summary is always consistent with what the board shows card by card.
