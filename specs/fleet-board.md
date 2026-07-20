---
id: fleet-board
title: Fleet board (Mission Control)
status: shipped
created: 2026-07-19
depends_on: [sessions-sidebar, session-engine, agents-panel, diff-view, durable-sessions, app-shell]
---

# Fleet board (Mission Control)

## 1. Summary

Pane `[1]` today is a plain session list: a status dot, a name, an abbreviated
path, and a `"<status> · <model>"` line per row (`sessions-sidebar`). Fleet-board
evolves that list into a rich **Mission Control status board** — one card per
session showing, at a glance: name, abbreviated cwd, **status** (relabelled and
colour-coded), model label, **context usage** (`used/limit`, e.g. `48.2K/1M`), an
uncommitted-**diff file-count** badge, a **running-agent count**, and a relative
**last-activity** stamp. The board is keyboard-navigable (`↑`/`↓` move a cursor,
`⏎` promotes the cursor's session to the active session **and** jumps focus to the
main pane) and click-to-select. It **is** the 264px left column of the grid — a
larger free-floating or grid "expanded board" is an explicit non-goal (§2).

Fleet-board is **frontend-only**: it defines **no new IPC command, no new
`SessionEvent` member, and no new `ErrorCode`**. Every figure it shows is
aggregated from channels that already exist — the cached `SessionMeta` per session
(status / model / context / last-activity), plus live `agent.update` and
`diff.changed` events — combined into a small per-session derived map. It replaces
and upgrades `sessions-sidebar`'s row component while preserving all of that
feature's behaviours (hydration, the `/` filter, new-session `n`, the remove
context menu, selection ownership) and it renders reloaded sessions from
`durable-sessions` on startup with their persisted status/model/context intact.

## 2. Goals & non-goals

- **Goals**:
  - Render one **status card** per session in pane `[1]`, glanceable: name,
    abbreviated cwd, status (dot + relabelled word), model label, context usage,
    diff file-count badge, running-agent count, relative last activity.
  - Aggregate all of the above from **existing** channels only — no new command,
    event, or error code (§5). Maintain a per-session **derived map** for the two
    figures that are not on `SessionMeta` (diff file count, running-agent count).
  - Keep the board live: `session.meta`/`session.status`/`context.usage`/
    `agent.update`/`diff.changed`/`session.removed` all update cards in place with
    no re-hydration.
  - Preserve every `sessions-sidebar` behaviour unchanged: hydration + initial
    auto-select, the `/` name/path filter, the footer + `n` new-session flow, the
    right-click remove-with-confirm menu, and sole ownership of `activeSessionId`.
  - Keyboard: `↑`/`↓` move a cursor; `⏎` sets the active session **and** moves
    pane focus to `main`. Click sets the active session (focus stays on the board).
  - Coexist with `durable-sessions`: reloaded sessions appear on the board at
    startup with persisted status (`idle`), model, and context usage; their diff
    badge is seeded from the current working tree.
- **Non-goals** (out of scope / elsewhere):
  - A larger "expanded board" (grid / full-window / resizable) — **future**; the
    board is fixed as the 264px left column here.
  - **OS / desktop notifications** on status change — separate spec `notifications`.
  - A **"stop this turn" control** and **per-session worktree isolation** —
    separate spec `session-brake`.
  - Session lifecycle itself (spawn/stop, status transitions, the token counting
    that produces `context.usage`, the agent lifecycle that produces `agent.update`,
    the git scanning that produces `diff.changed`) — `session-engine`, `agents-panel`,
    `diff-view`. Fleet-board only **consumes** their outputs.
  - Renaming, reordering/pinning, multi-select, per-session settings, cost/token-$
    tracking, a "needs input" status (there is none — see §1/FR-9).
  - The new-session modal and `francois:session:pickDirectory` internals — those
    remain exactly as `sessions-sidebar` defines them; fleet-board keeps them as-is.

## 3. User stories / flows

**A — Glance across the fleet.** Several sessions are running concurrently. The
user looks at pane `[1]`: `acme-api` shows a pulsing amber dot, `active`,
`Sonnet 4.5`, `128.4K/1M`, a `≡ 3` diff badge, `⇉ 2` agents, and `now`.
`billing-svc` shows a grey dot, `ready`, `Opus 4`, `42.1K/1M`, no diff badge, no
agents, `4m`. `infra-tf` shows a red dot, `error`, and a `12m` stamp. The user
reads the state of every workstream without opening any of them.

**B — Keyboard select + jump to the conversation.** Pane `[1]` is focused (via `1`
or a click). The user presses `↓` twice; a thin cursor outline walks down the
cards, `activeSessionId` unchanged. The user presses `⏎`: the cursor's session
becomes the active session (card gets the selected treatment) **and** pane focus
moves to `main`, so the SESSION transcript is immediately focused for typing. (This
is the one behavioural change from `sessions-sidebar`, whose `⏎` left focus on the
sidebar — FR-17.)

**C — Click select.** The user clicks a card. `activeSessionId` is set to that
session immediately and pane focus stays on `[1]` (identical to
`sessions-sidebar` FR-8). The main/agents/mcp/skills panes re-render for the new
session (their concern).

**D — A turn starts and finishes.** The user sends a message to the active
session elsewhere. `session.status` flips it to `running`: its dot starts pulsing,
its status word becomes `active`, its last-activity ticks toward `now`. As the
turn works, `context.usage` bumps the `used/limit` figure, a subagent dispatch
raises the `⇉` count, and file edits raise the `≡` diff badge. When the turn ends,
`session.status` flips to `idle`: dot stops pulsing, word becomes `ready`, the
`⇉` count falls back to `0` (badge hidden) as agents finish; the diff badge
persists (files are still uncommitted).

**E — Restart (durable-sessions).** The user quits and reopens Francois. On mount
the board hydrates `francois:session:list`; every persisted session reappears as a
card with status `idle`/`ready`, its persisted model and `contextUsedTokens`
already shown, and its diff badge seeded from the current working tree (a session
with 3 uncommitted files shows `≡ 3` without any turn running). Running-agent
counts are `0` (no agent survives a restart).

**F — Filter, new session, remove (unchanged).** `/` opens the inline name/path
filter; the visible cards narrow as the user types; `↑`/`↓`/`⏎` operate on the
filtered set; `Esc` clears it. The footer `+ new session [n]` control and the
global `n` key open the new-session modal. Right-clicking a card opens the
`Remove session` menu → inline confirm → `francois:session:remove`. All exactly as
`sessions-sidebar` specifies.

## 4. Functional requirements

**Aggregation — frontend-only, existing channels**

- **FR-1 (no new wire surface).** Fleet-board adds **no** IPC command, **no**
  `SessionEvent`/other tagged-union member, and **no** `ErrorCode`. It reads only
  the channels enumerated in §5's consumed table. `contract/fleet-board.ts` exports
  only frontend vocabulary (a status→label/colour map, a relative-time formatter,
  and the derived-aggregate type).
- **FR-2 (hydration).** On mount the board invokes the existing
  `francois:session:list` and populates the shared session cache in returned order
  (identical to `sessions-sidebar` FR-1). Initial auto-select is unchanged
  (`sessions-sidebar` FR-7): if `activeSessionId` is `null` and the cache is
  non-empty, select the first session.
- **FR-3 (live SessionMeta).** The board subscribes to `francois:session:event` for
  its lifetime and handles exactly these members (`FleetHandledSessionEvent`, §5),
  ignoring all others:
  - `session.meta` → upsert into the cache by `id`, preserving position (append on
    create).
  - `session.status` → patch `status` on the matching cached entry.
  - `session.removed` → delete the matching cached entry.
  - `context.usage` → patch `contextUsedTokens`/`contextLimitTokens` on the matching
    entry and refresh its last-activity (the store's existing `patchUsage`). *(This
    is the one `SessionEvent` member fleet-board consumes that `sessions-sidebar`
    did not — it keeps the on-card context figure live.)*
- **FR-4 (derived map).** The board maintains a per-session, in-memory
  `SessionDerived { fileCount: number | null; runningAgentCount: number }` (§5),
  keyed by `SessionId`, holding only the two figures **not** present on
  `SessionMeta`. `status`, `model`, `contextUsedTokens`, `contextLimitTokens`, and
  `lastActivityAt` are read straight from the cached `SessionMeta` and are never
  duplicated into the derived map.
- **FR-5 (running-agent count).** `runningAgentCount` for a session is derived from
  `agent.update` events on `francois:session:event`: the board keeps, per session, a
  `Map<AgentId, AgentStatus>` fed by each `agent.update` (keyed by `agent.id`,
  scoped by `agent.sessionId`), and `runningAgentCount = count of that map's entries
  with status === 'running'`. The board does **not** call `agents_list` per session:
  the live stream is complete because (a) the board subscribes at app mount, before
  any turn can dispatch an agent, and observes every subsequent `agent.update`, and
  (b) reloaded sessions start with zero running agents (`durable-sessions` reloads
  `idle`, resuming no in-flight turn). This is a coarse, count-only view; the
  detailed per-agent list remains `agents-panel`'s (active-session) concern.
- **FR-6 (diff file count).** `fileCount` for a session is derived from
  `francois:diff:event` `diff.changed { sessionId, fileCount }`, matched by
  `sessionId` (the board tracks **all** sessions, not just the active one — it keys
  off the event's `sessionId`, independent of `App.tsx`'s separate active-session
  DIFF-badge subscription). To show an accurate badge for freshly-hydrated / reloaded
  sessions that have uncommitted changes but no live turn, the board **seeds**
  `fileCount` once per session on first appearance (each session from FR-2's
  hydration and each newly-upserted session from a `session.meta` create) via the
  existing read `francois:diff:getSummary` → `data.files.length`; thereafter
  `diff.changed` keeps it live. A seed that resolves `ok:false` (e.g.
  `NOT_A_GIT_REPO` for a non-repo cwd, `GIT_ERROR`) leaves `fileCount` `null`
  (no badge) and surfaces no error — seeding is best-effort. *(Perf note: this
  issues one read per session at startup; see §7 and the open question about a
  batched alternative.)*
- **FR-7 (derived cleanup).** On `session.removed` (and on a successful
  `francois:session:remove`), the board drops that session's `SessionDerived` entry
  and its per-session agent-status map, alongside removing it from the cache.

**Card content**

- **FR-8 (card fields).** Each card renders, top to bottom:
  1. a header row: an 8px status dot + the session `name` (12.5px, weight 500) on
     the left, and the relative last-activity token on the right (`formatRelativeTime
     (lastActivityAt, now)`, §5), faint;
  2. the abbreviated cwd (10.5px, faint, single line, ellipsis on overflow);
  3. a status line: `"<statusLabel> · <model.label>"` (10px, coloured by status);
  4. a meta row: context usage, then (when present) the diff badge and the
     running-agent count.
- **FR-9 (status presentation).** The four backend `SessionStatus` values are
  presented via `STATUS_LABEL`/`STATUS_COLOR`/`statusPulses` (§5):
  - `running` → label **`active`**, colour `#d0a45c`, dot **pulses** (`pulse 1.4s
    ease-in-out infinite`).
  - `idle` → label **`ready`**, colour `#6b7079`, no pulse. `idle` means the session
    finished its turn and is **ready / waiting for the user** — there is deliberately
    no distinct "needs input" status (§1/§2).
  - `done` → label **`done`**, colour `#7fa07a`, no pulse (terminal).
  - `error` → label **`error`**, colour `#c46b62`, no pulse (terminal); the cached
    `SessionMeta.errorMessage` (when set) is exposed as the card's hover `title`.
  The dot fill and the status-line text share the status colour.
- **FR-10 (context usage).** The meta row shows
  `${formatContextTokens(used)}/${formatContextTokens(limit)}` using the existing
  formatter from `contract/conversation-view.ts` (imported, never redefined) — e.g.
  `48.2K/1M`. Prefixed with a faint `ctx ` label. If `contextLimitTokens <= 0`
  (unknown), render only `formatContextTokens(used)`; if both are `0`, render `—`.
- **FR-11 (diff badge).** When `fileCount > 0`, render a count pill (`≡ <n>`,
  DIFF-badge styling, §8). When `fileCount` is `0` or `null` (unknown), render no
  badge.
- **FR-12 (running-agent count).** When `runningAgentCount > 0`, render `⇉ <n>` in
  accent. When `0`, render nothing.
- **FR-13 (relative last activity).** The header-right token is
  `formatRelativeTime(lastActivityAt, now)` (§5): `now`, `45s`, `2m`, `3h`, `5d`;
  a future timestamp (clock skew) clamps to `now`. It refreshes per FR-25.
- **FR-14 (abbreviated cwd).** The cwd line abbreviates the home directory to `~`
  when resolvable (same client-side rule and `homeDir` source as `sessions-sidebar`
  §6), else shows the raw absolute path; always single-line, ellipsis on overflow.

**Selection / keyboard / focus**

- **FR-15 (click select).** Clicking a card sets `activeSessionId` to that session
  and requests focus for pane `[1]` — immediate, no confirm (identical to
  `sessions-sidebar` FR-8).
- **FR-16 (keyboard cursor).** While pane `[1]` is focused, `↑`/`↓` move a local
  keyboard cursor among the currently visible (post-filter) cards, clamped at both
  ends (no wrap), without changing `activeSessionId` (identical to `sessions-sidebar`
  FR-9). The cursor renders as a thin inset outline, independent of and combinable
  with the selected treatment.
- **FR-17 (keyboard commit — behavioural change).** `⏎`, while pane `[1]` (or the
  filter input) is focused and the visible list is non-empty, sets `activeSessionId`
  to the cursor's session **and** sets `focusedPane` to `'main'`. This differs from
  `sessions-sidebar` FR-10 (which left focus on the sidebar): fleet-board's `⏎`
  promotes **and** jumps to the main pane so the user lands in the conversation.
  No-op if the visible list is empty.
- **FR-18 (cursor sync).** Whenever `activeSessionId` changes or the visible list
  changes (filter applied/cleared, sessions added/removed), the cursor is clamped
  into range; if its session is no longer visible it resets to the card matching
  `activeSessionId` if visible, else index `0` (identical to `sessions-sidebar`
  FR-11).
- **FR-19 (selection visuals).** The card whose `id === activeSessionId` gets
  background `#20222a`, a 2px `#c8a15a` left marker, and its name brightened to
  `#dfe2e8`; all others transparent background, transparent marker, name `#c4c7ce`
  (identical tokens to `sessions-sidebar` FR-6).

**Preserved `sessions-sidebar` behaviours**

- **FR-20 (filter).** The `/` inline filter over `name`/`cwd` (case-insensitive
  substring), its no-match state (`"no matches · esc to clear"`), and `Esc`-to-clear
  are unchanged (`sessions-sidebar` FR-13–FR-17). The header count `N · [1]` is the
  total cached session count, unaffected by the filter.
- **FR-21 (new session).** The footer `+ new session [n]` control and the global
  `n` key open the new-session modal; the modal, its fields, `francois:session:
  pickDirectory`, `francois:session:models`, `francois:session:create`, and the
  post-create upsert + auto-select are all unchanged (`sessions-sidebar`
  FR-18–FR-24). A successful create adds a card and (via FR-6) seeds its diff badge.
- **FR-22 (remove).** The right-click `Remove session` context menu, its inline
  confirm, `francois:session:remove`, and the post-remove selection reassignment are
  unchanged (`sessions-sidebar` FR-25–FR-27); on success the card is removed and its
  derived entry dropped (FR-7).
- **FR-23 (empty / error states).** The zero-sessions empty state
  (`"no sessions yet · press n"`), the hydration-failure state
  (`"failed to load sessions"` + retry), and the header count are unchanged
  (`sessions-sidebar` FR-1/FR-3/FR-12, §7).
- **FR-24 (durable-sessions coexistence).** Sessions reloaded by `durable-sessions`
  at startup render as cards from FR-2's hydration with status `idle`→`ready`, their
  persisted `model` and `contextUsedTokens`, a diff badge seeded per FR-6, and
  `runningAgentCount` `0`. No fleet-board-specific persistence exists; the board is a
  pure projection of the cache + derived map.

**Refresh**

- **FR-25 (relative-time refresh).** Relative last-activity labels are recomputed
  on every consumed event that touches a session and additionally on a periodic tick
  (every 30 000 ms) so idle cards age visibly without any event. The tick only
  recomputes rendered labels; it issues no IPC.

## 5. API contract

Fleet-board is **frontend-only**. It introduces:

- **No new IPC command.** It calls only existing channels.
- **No new event.** It consumes existing event members only.
- **No new `ErrorCode`.** (Seed failures reuse existing diff-view codes and are
  swallowed as "unknown file count" — FR-6.)

### Channels this feature consumes (all pre-existing; shapes pinned so it builds standalone)

| Channel | Binding | Direction | Payload | Result data | Error codes | Use |
|---|---|---|---|---|---|---|
| `francois:session:list` | `session_list` | invoke | none | `SessionMeta[]` | `INTERNAL` | hydration (FR-2) |
| `francois:session:event` | `francois://session/event` | event | `SessionEvent` | — | n/a | live cache + agent count; handles `FleetHandledSessionEvent` members only (FR-3/FR-5) |
| `francois:diff:event` | `francois://diff/event` | event | `DiffEvent` (`diff.changed`) | — | n/a | live per-session `fileCount` (FR-6) |
| `francois:diff:getSummary` | `diff_get_summary` | invoke | `{ sessionId }` | `DiffSummary` | `NOT_A_GIT_REPO`, `GIT_ERROR`, `SESSION_NOT_FOUND`, `INTERNAL` | one-shot `fileCount` seed (FR-6) |

Inherited from `sessions-sidebar` and **unchanged** (fleet-board keeps its
new-session and remove flows): `francois:session:pickDirectory`,
`francois:session:models`, `francois:session:create`, `francois:session:remove`.
See `contract/sessions-sidebar.ts` — fleet-board redefines none of them.

### `contract/fleet-board.ts`

Everything below is the full content of `contract/fleet-board.ts`. It imports only
from `contract/common.ts` (and, at call sites, reuses `formatContextTokens` from
`contract/conversation-view.ts` — not re-exported here). There are no IPC channels
or tagged-union members declared by this file.

```ts
// contract/fleet-board.ts — fleet-board (pane [1], the Mission Control status board).
// Evolves sessions-sidebar's row list into a per-session status card. Frontend-only:
// NO IPC command, NO francois://…/event member, NO ErrorCode is defined here — the
// board aggregates the already-existing channels listed in specs/fleet-board.md §5.
// Imports shared vocabulary from common.ts; never redefines it. This file is the
// single source of the status→label/colour map and the relative-time formatter
// (both pure, frontend-only). Context tokens are formatted with formatContextTokens
// from contract/conversation-view.ts (imported at the call site, not duplicated).

import type { SessionId, SessionStatus, SessionEvent } from './common';

// ---------- consumed session-event members ----------
// fleet-board subscribes to francois:session:event and handles exactly these
// members; every other SessionEvent member is ignored by this feature (FR-3/FR-5).
export type FleetHandledSessionEvent = Extract<
  SessionEvent,
  | { type: 'session.meta' }
  | { type: 'session.status' }
  | { type: 'session.removed' }
  | { type: 'context.usage' }
  | { type: 'agent.update' }
>;

// ---------- per-session derived aggregate (in-memory, frontend-only) ----------
/**
 * The two figures the board derives per session ON TOP of its cached SessionMeta.
 * status / model / contextUsedTokens / contextLimitTokens / lastActivityAt come
 * straight from SessionMeta (common.ts) and are deliberately NOT duplicated here.
 */
export interface SessionDerived {
  /**
   * Uncommitted-file count for the session's cwd (FR-6):
   *   null  = unknown — no diff.changed seen yet and the diff_get_summary seed has
   *           not resolved (or the cwd is not a git repo)  → render NO diff badge.
   *   0     = known-clean                                   → render NO diff badge.
   *   > 0   = render the count pill.
   * Seeded once via the existing francois:diff:getSummary read on first appearance,
   * then kept live by francois:diff:event `diff.changed`.
   */
  fileCount: number | null;
  /** This session's subagents currently in status 'running' (FR-5). 0 when none. */
  runningAgentCount: number;
}

// ---------- status presentation (single source; frontend-only) ----------
/**
 * The board relabels the four backend SessionStatus values. There is deliberately
 * NO "needs input" state: a session that finished its turn is `idle` — i.e.
 * ready/waiting for the user (§1/§2, FR-9).
 */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: 'active',
  idle: 'ready',
  done: 'done',
  error: 'error',
};

/** Dot fill + status-line colour per status (tokens from PROJECT.md's palette). */
export const STATUS_COLOR: Record<SessionStatus, string> = {
  running: '#d0a45c',
  idle: '#6b7079',
  done: '#7fa07a',
  error: '#c46b62',
};

/** True only for `running` — the sole status whose dot pulses (FR-9). */
export function statusPulses(status: SessionStatus): boolean {
  return status === 'running';
}

// ---------- relative time (pure; FR-13) ----------
/**
 * Compact relative-time token for a card's last-activity label — 'now', '45s',
 * '2m', '3h', '5d'. No 'ago' suffix (the card is space-constrained). A future
 * `then` (clock skew) clamps to 'now'. `now` defaults to Date.now().
 */
export function formatRelativeTime(then: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - then);
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// ---------- derived-map helper (pure) ----------
/** runningAgentCount from a session's tracked agent-status map (FR-5). */
export function countRunning(agents: ReadonlyMap<string, SessionStatus>): number {
  let n = 0;
  for (const st of agents.values()) if (st === 'running') n++;
  return n;
}

export type { SessionId };
```

*(`countRunning` is typed against `SessionStatus` because `AgentStatus` in
`common.ts` is the identical `'running' | 'idle' | 'done' | 'error'` union; the
board stores `AgentInfo.status` values, which satisfy it.)*

## 6. Data & state

**Shared frontend store (zustand), owned by `sessions-sidebar`, reused here** — the
`SessionMeta[]` cache and `activeSessionId`/`sidebarFilter` slice. Fleet-board reads
and writes them through the same store setters (`setSessions`, `upsertSession`,
`patchStatus`, `patchUsage`, `removeSession`, `setActiveSessionId`,
`setSidebarFilter`) and reads/writes `focusedPane` via `setFocusedPane` (owned by
`app-shell`) — including the new `⏎`→`focusedPane:'main'` write (FR-17). It does not
introduce a new global store slice.

**Feature-local state** (not shared cross-feature):
- `derived: Map<SessionId, SessionDerived>` — the per-session `{ fileCount,
  runningAgentCount }` map (FR-4). Rebuilt live from events; not persisted.
- `agentStatus: Map<SessionId, Map<AgentId, AgentStatus>>` — backing store for
  `runningAgentCount` (FR-5); `runningAgentCount = countRunning(agentStatus.get(id))`.
- `rowCursor: number` — keyboard-cursor index into the visible (post-filter) card
  list (FR-16/FR-18).
- `now: number` — a clock value bumped by the FR-25 tick (and on events) so relative
  labels re-render; ticks every 30 000 ms.
- All the modal / context-menu / hydration-error local state inherited unchanged
  from `sessions-sidebar` §6 (new-session modal fields, context-menu target/confirm,
  `hydrationError`).

**Derived (recomputed, not stored):** the visible card list (`sessions` filtered by
`sidebarFilter`), the header count `N = sessions.length`, each card's abbreviated
cwd, status label/colour (`STATUS_LABEL`/`STATUS_COLOR`), context string
(`formatContextTokens`), diff-badge visibility (`fileCount > 0`), agent-count
visibility (`runningAgentCount > 0`), and relative-time token (`formatRelativeTime`).

**Persistence:** none of fleet-board's own. The cache and `activeSessionId` are
in-memory (per `sessions-sidebar`); the *durability* of sessions/transcripts is
`durable-sessions`' concern. The board is a pure projection over the cache + derived
map and holds nothing to persist.

**Seeding & subscription lifecycle:** on mount the board (1) subscribes to
`francois:session:event` and `francois:diff:event`, (2) invokes `francois:session:
list` and, for each returned session, fires a best-effort `francois:diff:getSummary`
seed (FR-6), (3) starts the 30 s relative-time tick. Each later `session.meta`
*create* triggers a one-shot seed for the new id. All subscriptions and the timer
are torn down on unmount.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| Reloaded session (durable-sessions) at startup | Card renders `idle`→`ready`, persisted model + `contextUsedTokens`, diff badge seeded via `diff_get_summary` (FR-6/FR-24), `runningAgentCount` 0. |
| `diff_get_summary` seed fails (`NOT_A_GIT_REPO` for a non-repo cwd, `GIT_ERROR`, etc.) | `fileCount` stays `null` → no diff badge; no error surfaced (best-effort seed, FR-6). |
| `diff.changed` for a session not in the cache (removed/unknown) | Ignored — the board keys the derived map by `sessionId` but only renders cards for cached sessions; a stale entry is harmless and dropped on `session.removed` (FR-7). |
| `agent.update` before its session appears in the cache | Its status is still recorded in `agentStatus`; the count applies as soon as the session's card renders (no ordering dependency). |
| A session's agents all finish | Their statuses flip to `done`/`error` via `agent.update`; `runningAgentCount` recomputes to `0` → agent badge hidden (FR-12). |
| `contextLimitTokens <= 0` (unknown) | Render only `formatContextTokens(used)`; if both 0, render `—` (FR-10). |
| `fileCount === 0` vs `null` | Both hide the badge; the distinction only matters internally (seeded-clean vs not-yet-known) (FR-11). |
| `lastActivityAt` in the future (clock skew) | `formatRelativeTime` clamps to `now` (FR-13). |
| `status === 'error'` | Red dot + `error` label; `SessionMeta.errorMessage` (if present) shown as the card's hover `title` (FR-9). |
| Rapid `session.status` flapping (`running → error → running`) | Latest event wins; dot colour/pulse reflect the newest value, no debounce (as `sessions-sidebar` §7). |
| Removing the active session | Selection reassigned per `sessions-sidebar` §7; the removed session's derived + agent maps are dropped (FR-7). |
| `⏎` with an empty visible list | No-op (FR-17). |
| Home directory unresolvable | Raw absolute cwd shown, ellipsis-truncated (FR-14, as `sessions-sidebar` §7). |
| Very large fleet | Card list scrolls (`.scz`, `overflow:auto`); cards are fixed height; header/footer never scroll. **Startup seeding issues one `diff_get_summary` per session** — acceptable for a normal fleet; a batched read is the flagged follow-up (open question, §9 handoff). |
| Duplicate/late `session.meta` for an existing id | Update in place, position preserved; no re-seed of `fileCount` (seed fires only on first appearance) (FR-3/FR-6). |
| Two `diff/event` subscribers (this board + `App.tsx`'s active-session badge) | Independent listeners on the same event stream; no coordination needed (FR-6). |

## 8. Design brief

### Screens / regions

Pane `[1]`, the sidebar column of the three-column grid — reference
`Claude Terminal.dc.html` lines 49–68 (`<!-- SIDEBAR / sessions -->`: header row,
scrollable `.scz` card list, footer). Fleet-board keeps that outer chrome exactly
and replaces the **row body** (mock lines 57–64) with the richer status card below.
The two overlays it inherits from `sessions-sidebar` — the new-session modal and the
remove context menu — are unchanged (that spec's §8). Column width is `264px`, owned
by `app-shell`'s grid, not this spec.

### Components

- **Panel chrome** (unchanged): bg `#16171c`, border `1px solid #24262d`
  (`#c8a15a` when pane focused), radius `5px`; header `SESSIONS` (11px, letter-spacing
  `0.14em`, weight 700, accent `#c8a15a` when focused else dim `#868a93`) + count
  `N · [1]` (10px `#565a63`); footer `+ new session [n]` (`padding:8px 12px`, top
  border `1px solid #24262d`, 10.5px `#565a63`, hotkey glyph `#3a3d45`).
- **SessionCard** — the new per-session card (replaces the mock's row). Variants:
  default / hover / selected / keyboard-cursor (see States).
- **StatusDot** — 8px circle, `border-radius:50%`, filled with `STATUS_COLOR`;
  `animation: pulse 1.4s ease-in-out infinite` only when `running` (reuse the mock's
  `@keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.35 } }`).
- **MetaRow** — context figure + optional diff badge + optional agent count.
- **DiffBadge** — count pill (reuses the DIFF-tab badge token from `App.tsx`
  lines 243–246 / mock line 76).
- **AgentCount** — `⇉ <n>` in accent.
- **RelativeTime** — right-aligned faint token.
- Inherited unchanged: **FilterInput**, **EmptyState** / **NoMatchesState**,
  **NewSessionModal**, **ContextMenu** (`sessions-sidebar` §8).

### SessionCard layout & exact tokens

Container: `display:flex; flex-direction:column; gap:4px; padding:9px 10px;
border-radius:4px; margin-bottom:3px; cursor:pointer;`
- Default: `background:transparent; border-left:2px solid transparent;`
- Hover: `background:#1b1d23;`
- Selected (`id === activeSessionId`): `background:#20222a; border-left:2px solid
  #c8a15a;`
- Keyboard-cursor (not yet committed): `outline:1px solid #3a3d45; outline-offset:-1px;`
  — independent of and combinable with selected.

**Row 1 — header:** `display:flex; align-items:center; gap:9px;`
- StatusDot: `width:8px; height:8px; flex-shrink:0;` fill `STATUS_COLOR[status]`,
  pulse per `statusPulses`.
- Name: `flex:1; min-width:0; font-size:12.5px; font-weight:500;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;` colour `#dfe2e8` when
  selected else `#c4c7ce`.
- RelativeTime: `flex-shrink:0; font-size:10px; color:#565a63;` text
  `formatRelativeTime(lastActivityAt, now)`.

**Row 2 — cwd:** `font-size:10.5px; color:#565a63; white-space:nowrap;
overflow:hidden; text-overflow:ellipsis; margin-left:17px;` (aligns under the name,
past the 8px dot + 9px gap). Text = abbreviated cwd (FR-14).

**Row 3 — status line:** `font-size:10px; letter-spacing:0.02em; margin-left:17px;`
colour `STATUS_COLOR[status]`; text `` `${STATUS_LABEL[status]} · ${model.label}` ``
(e.g. `active · Sonnet 4.5`, `ready · Opus 4`).

**Row 4 — meta:** `display:flex; align-items:center; gap:10px; margin-left:17px;
font-size:10px;`
- Context: `` `ctx ` `` label in `#565a63`, then
  `formatContextTokens(used)` in `#a9adb6`, then `/${formatContextTokens(limit)}` in
  `#565a63` (e.g. `ctx 48.2K/1M`). Per FR-10 fallbacks for unknown limit.
- DiffBadge (only when `fileCount > 0`): a `≡` glyph in `#565a63` immediately
  followed by a pill — `background:#26282f; color:#a9adb6; font-size:9px;
  padding:1px 5px; border-radius:8px; letter-spacing:0;` containing `fileCount`
  (matches the DIFF-tab badge exactly).
- AgentCount (only when `runningAgentCount > 0`): `⇉ <n>` in accent `#c8a15a`
  (`⇉` is the app's subagent glyph, `contract/conversation-view.ts`).

If both DiffBadge and AgentCount are absent the meta row shows only the context
figure; the row never wraps (the three items comfortably fit 264px − padding at
these sizes; if a very long model label pushes Row 3, only that line ellipsis-
truncates, never the meta row).

### States

- **Card**: default / hover / selected / keyboard-cursor (tokens above; selected +
  cursor combine).
- **StatusDot**: running (amber, pulsing) / ready (grey, static) / done (green,
  static) / error (red, static).
- **DiffBadge**: hidden (`fileCount` 0 or null) / shown (`> 0`).
- **AgentCount**: hidden (`0`) / shown (`> 0`).
- **List**: populated / empty (`"no sessions yet · press n"`) / no-match
  (`"no matches · esc to clear"`) / hydration-error (`"failed to load sessions"` +
  `retry`) — all inherited (FR-23).

### Interactions

- **Mouse:** click card → select + focus pane `[1]` (FR-15); hover → hover
  treatment; right-click → remove context menu at cursor (FR-22); footer / filter as
  inherited.
- **Keyboard** (pane `[1]` focused): `↑`/`↓` move the cursor (FR-16); `⏎` commits
  the active session **and** moves focus to `main` (FR-17); `/` opens the filter,
  `Esc` clears it (FR-20); global `n` opens the new-session modal (FR-21). Inside the
  filter, `↑`/`↓`/`⏎` still drive the visible cards (inherited).

### Motion

- Dot pulse `1.4s ease-in-out infinite` for `running` only (reused token).
- No enter/exit transition on cards, selection, modal, or context menu — instant
  swaps, matching the app's un-animated row/selection convention.
- Relative-time labels update on the 30 s tick and on events (FR-25) — a text swap,
  no animation.
- Optional (implementer's discretion, not required): a ≤120 ms colour transition on
  the status dot/line when `status` changes; must not pulse or draw attention beyond
  the existing running-pulse.

### Resize / responsive

Card content degrades gracefully at any width the grid gives the column: name, cwd,
and status line each `white-space:nowrap` + ellipsis (never wrap); the meta row does
not wrap (context abbreviates via `formatContextTokens`; badges are fixed-width). The
card list scrolls vertically (`.scz`, 8px thumb `#2a2c33`, transparent track, 4px
radius) when it overflows; header and footer are fixed-height and never scroll. The
inherited modal and context menu are fixed-width overlays, unaffected by column
width.

## 9. Acceptance criteria

- [ ] Pane `[1]` renders one **card** per session showing name, abbreviated cwd,
  status dot + relabelled word, model label, context usage (`used/limit`), a diff
  file-count badge, a running-agent count, and a relative last-activity token
  (FR-8, §8).
- [ ] Status is presented as `running→active` (pulsing amber `#d0a45c`),
  `idle→ready` (grey `#6b7079`), `done→done` (green `#7fa07a`), `error→error` (red
  `#c46b62`); only `running` pulses; there is no "needs input" state (FR-9).
- [ ] Context usage renders `${formatContextTokens(used)}/${formatContextTokens
  (limit)}` (e.g. `48.2K/1M`) using the existing formatter, with the documented
  unknown-limit fallbacks (FR-10).
- [ ] The diff badge shows `fileCount` only when `> 0`, seeded from
  `francois:diff:getSummary` on first appearance and kept live by
  `francois:diff:event` `diff.changed` matched on `sessionId` (FR-6, FR-11).
- [ ] The running-agent count shows only when `> 0`, derived purely from
  `agent.update` events (per-session running tally), with no `agents_list` call
  (FR-5, FR-12).
- [ ] Relative last-activity renders via `formatRelativeTime` (`now`/`45s`/`2m`/`3h`/
  `5d`), clamps future timestamps to `now`, and refreshes on events and a 30 s tick
  (FR-13, FR-25).
- [ ] `↑`/`↓` move a keyboard cursor without changing `activeSessionId`; **`⏎` sets
  the active session AND moves focus to the main pane** (FR-16, FR-17); clicking a
  card selects it and keeps focus on `[1]` (FR-15).
- [ ] After an app restart, every `durable-sessions`-reloaded session appears on the
  board with status `ready`, persisted model + context, a diff badge seeded from the
  working tree, and `0` agents (FR-24, §7).
- [ ] The `/` filter, footer/`n` new-session flow, right-click remove-with-confirm,
  header count `N · [1]`, empty/no-match/hydration-error states, and
  `activeSessionId` ownership all behave exactly as `sessions-sidebar` specifies
  (FR-20–FR-23).
- [ ] Fleet-board adds **no** IPC command, **no** `SessionEvent` member, and **no**
  `ErrorCode`; `contract/fleet-board.ts` exports only `FleetHandledSessionEvent`,
  `SessionDerived`, `STATUS_LABEL`, `STATUS_COLOR`, `statusPulses`,
  `formatRelativeTime`, `countRunning` (and re-exports `SessionId`), importing only
  from `common.ts` (FR-1, §5).
- [ ] `session.meta`/`session.status`/`context.usage`/`agent.update`/`diff.changed`/
  `session.removed` all update cards in place with no re-hydration (FR-3, FR-5,
  FR-6, FR-7).

## Remediation

(Empty until a review returns findings.)
