---
id: fix-agent-view
title: Agent tabs in every pane — per-session dynamic tabs
status: frozen
branch: feat/fix-agent-view
created: 2026-08-12
depends_on: [agent-tab, workflow-details, split-by-4, design-refresh, async-agents, agents-panel, workflow-panel, app-shell]
loop_pass: 0
loop_phase:
reviewed_base:
reviewed_digest:
design_files: ["https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html"]
---

# Agent tabs in every pane — per-session dynamic tabs

## 1. Summary

Clicking a subagent card in the agents panel does nothing while the app is split. That is `split-by-4`
FR-20 working as written — `openAgentTab` returns `{}` whenever `extraPanes.length > 0` — but the
split layout is **persisted** (`francois.split`, FR-23), so a user who split once stays split across
restarts and reads the result as "the agents panel no longer lets me look inside an agent". There is
no other way in: the `⏎` trail is a 180px scroller of truncated one-line steps (`async-agents`
FR-19), never the agent's own text.

This feature removes the restriction at its root rather than special-casing split. A dynamic tab is a
**property of a session**, not of the shell: `agentTabs` stops being one global list and becomes a map
keyed by session id, `PaneTab` widens to carry `agent:<id>` / `workflow:<id>`, and **each pane** — the
single main pane and both panes of a two-pane split — renders its own session's dynamic tabs after
`Shell`. The tab bodies, the transcript IPC, the cap and the eviction order are unchanged; only who
owns the list and who renders it moves.

Once a tab belongs to a session, nothing has to *ask* for it: the first `agent.update` an agent emits
records its chip in that session's strip (FR-21). Clicking a card in the `AGENTS` view stops being the
only way in — it becomes the way to *jump* to a tab that is already there.

Keying by session also fixes a smaller annoyance that predates split: `agent-tab` FR-14 closed every
tab on a session switch, so flipping to another session and back lost the tabs you had open. They were
only ever closed because a global list could not tell which session an agent belonged to. The map can,
so switching away now **keeps** them.

## 2. Goals & non-goals

- **Goals**
  - A subagent's tab appears in its session's strip **on its own**, the moment the agent is first
    seen — reading one no longer costs a trip through the `AGENTS` view to hunt for its card.
  - Clicking an agent or workflow card opens its tab in the pane that owns that card's session, at
    one pane and at two.
  - Each pane's tab strip carries `Session · Diff · Shell` followed by that pane's session's dynamic
    tabs, in the order they were opened.
  - Dynamic tabs survive a session switch and come back with the session.
  - One set of renderers: a split pane's agent tab is the same `AgentView` the single pane shows.
- **Non-goals**
  - **The grid regime (3–4 panes).** `split-by-4` FR-9 makes a dense pane ONE surface with no tab
    strip, so there is nowhere to hang a chip and no way back off the tab. Dynamic tabs stay
    unreachable there; `⤢` promotes a pane to inspect it. This is the one half of FR-20 that survives.
  - Persisting dynamic tabs across an app restart. They stay in-memory, like today.
  - `overview` or the four dissolved panel tabs (`agents`/`mcp`/`skills`/`workflows`) inside a pane.
    They overlay the whole main cell — they are not one session's view — and still clamp to `session`.
  - Any change to the transcript channels, or to the panel's own `⏎` trail.
  - Remembering *which* tab a session was last on. Coming back to a session lands on `Session`; its
    tabs are there, none is pre-activated.
  - A per-pane cap negotiation. The cap stays 6, now counted per session.

## 3. User stories / flows

**Flow 1 — inspect an agent while split (the reported bug).** Two sessions side by side, pane 1
focused. The agents panel is scoped to pane 1's session. Click `explorer` → a chip `● ⇉ explorer ✕`
appears in **pane 1's** strip after `Shell`, activates, and that pane's body becomes the subagent's
transcript. Pane 0 keeps streaming, untouched. `w` closes the chip and pane 1 returns to `Session`.

**Flow 2 — tabs follow their session.** Session A has two agent tabs open. Click session B in the
roster: the pane shows B on `Session`, with B's own dynamic tabs (none, at first). Click back to A:
A's two chips are in the strip again, in the same order.

**Flow 3 — enter split with a tab open.** Single pane, on `agent:abc`. Press `▯▯`: the app splits,
pane 0 keeps `agent:abc` (its session still owns it), pane 1 opens on `Session`. Nothing is closed.
Coming from `Overview` or a panel tab still clamps to `Session`.

**Flow 4 — grow to the grid and back.** At three panes every pane flattens to its transcript, the
`agent:abc` chip included. Shrink back to two and pane 0 is on `agent:abc` again — the tab was never
discarded, only hidden.

**Flow 5 — keyboard.** With a dynamic tab active in the focused pane, `w` closes it and that pane
falls back to `Session`; the other pane is not disturbed.

**Flow 6 — an agent announces itself.** A turn dispatches `explorer`. Without touching anything, a
chip `● ⇉ explorer ✕` appears in that session's strip after `Shell` — dim, not activated, the
transcript still on screen. Click it to read the agent; or `✕` it, and it does not come back when
`explorer` takes its next step.

## 4. Functional requirements

### State

- **FR-1.** `agentTabs` changes type from `AgentTabRef[]` to `Map<SessionId, AgentTabRef[]>`. Each
  entry is that session's open dynamic tabs (agents *and* workflow runs, `ref.kind`) in the order they
  were opened. Not persisted.
- **FR-2.** `AGENT_TAB_CAP` (6) is counted **per session**. Opening a 7th tab for one session evicts
  that session's oldest tab that is not the one being activated; other sessions are unaffected.
- **FR-3.** `PaneTab` widens to `'session' | 'diff' | 'shell' | \`agent:${string}\` |
  \`workflow:${string}\``, and `MainTab` becomes that plus `overview` and the four panel tabs.
  `clampToPaneTab` therefore drops **only** `overview` and `agents`/`mcp`/`skills`/`workflows`, and
  passes a dynamic tab straight through.
- **FR-4.** `openAgentTab(sessionId, ref)` takes the owning session explicitly. It open-or-refreshes
  `ref` in that session's list (FR-2's cap applies), then activates `tabIdFor(ref)` on the pane holding
  `sessionId` — `mainTab` for pane 0, that pane's `PaneSlot.tab` otherwise — and sets
  `focusedPane = 'main'`. When `sessionId` holds no pane the call is a **complete no-op**: nothing
  recorded, nothing activated.
- **FR-5.** `openAgentTab` never changes `focusedPaneIndex`. The dissolved panels are scoped to the
  focused pane's session, so a clicked card always belongs to the focused pane; moving focus between
  panes on a card click would be a surprise.
- **FR-6.** `syncAgentTab(ref)` and `closeAgentTab(id)` keep their single-argument signatures and
  locate the owning session by scanning the map (ids are uuid-v4, globally unique). `syncAgentTab`
  refreshes name/status **in place only** — it never opens a tab, never reorders one, and returns the
  same state object when nothing changed. `closeAgentTab` removes the ref and, for **every** pane
  whose tab equals that id, falls that pane back to `'session'`.
- **FR-7.** `clearAgentTabs()` empties the whole map and falls **every** pane back to `'session'` if
  it was on a dynamic tab. It stays the All-projects-widen path.
- **FR-8.** Switching a pane's session no longer closes any tab. The pane's own tab falls back to
  `'session'` only when it was on a dynamic tab (the existing `mainTabAfterClose` rule); a
  `diff` / `shell` tab is left alone. **This replaces `agent-tab` FR-14.**
- **FR-9.** Removing a session deletes its entry from the map, in the same store action that removes
  the session.
- **FR-10.** Entering split no longer closes dynamic tabs and no longer clamps `agent:` / `workflow:`.
  **This replaces `split-by-4` FR-20's second half** and amends its §7 case 10.

### Regimes

- **FR-11.** In the **single** regime the chips live in `SessionRow` — design 7a's session-scoped
  chrome tier — reading pane 0's session's list. Its existing appearance is unchanged.
- **FR-12.** In the **split** regime (two panes) `SessionRow`'s view segment steps aside as it does
  today, and each `SplitPane` renders its own session's dynamic tabs after `Shell`, behind a divider,
  in that pane's sub-strip register (§8).
- **FR-13.** In the **grid** regime (3–4 panes) no pane shows a dynamic tab. `paneTabAt` flattens one
  to `'session'` via `denseTab` **at read time**, so shrinking back to two panes restores the tab the
  pane was really on; and `openAgentTab` is a no-op, so none can be opened there in the first place.
- **FR-14.** A split pane's tab strip scrolls horizontally past overflow and never wraps, squeezes or
  clips a chip — a half-width pane cannot fit `Session · Diff · Shell` plus six chips.
- **FR-15.** Clicking a chip activates that tab in its own pane (and focuses that pane, via the pane's
  existing click handler). `✕` closes it, applying FR-6's fallback.
- **FR-16.** The agents and workflows panels call `openAgentTab(paneSessionId, ref)` with the panel's
  own session — the same `paneSessionId` those panels are already keyed to.

### Tab bodies

- **FR-17.** A split pane on `agent:<id>` renders `AgentView`, keyed by agent id, with that pane's
  session; on `workflow:<id>` it renders `WorkflowView`, keyed by run id. Same components the single
  pane uses — no second renderer.
- **FR-18.** `AgentView`'s **Back to session** button returns the pane it is rendered in. It stops
  calling `setMainTab('session')` unconditionally and takes the owning pane's tab setter from its
  caller.
- **FR-19.** Opening a dynamic tab in a pane other than pane 0 also clamps `mainTab` off a panel tab.
  `mainTab` doubles as "which dissolved panel overlays the main cell" (design 7a), so leaving it on
  `agents` would hide the very pane the tab just landed in.

### Auto-tracking

- **FR-21.** The **first** `agent.update` seen for an agent records its tab in that agent's session's
  list, without activating it, without moving focus, and without touching any pane. A chip is
  therefore in the strip before you go looking for it; reading the agent is still one click, but the
  click is on the chip rather than on a card two views away.
  - "First" is decided by `useSessionFleetSync`'s existing per-session agent map — the same record
    that backs `runningAgentCount`, dropped with the session in `dropDerived`. So the tab is offered
    **once and once only**: a chip you `✕` does not reappear on the agent's next step, and neither
    does one the cap evicted.
  - Unlike `openAgentTab`, tracking has **no pane lookup and no grid guard**. A dynamic tab is a
    property of a session (FR-1); an agent spawned in a session that is on no pane, or in the grid,
    still gets its chip, ready in the strip the moment that session is on a two-pane-or-fewer pane.
  - Agents only. A `Workflow` run's tab is still opened by clicking its card.
- **FR-22.** The per-session cap (FR-2) never evicts a tab a pane is **currently displaying**. It
  drops the oldest *undisplayed* tab instead, and when every candidate is on screen the cap yields —
  the list runs one over and is trimmed on the next spawn. Eviction used to fire only as a direct
  result of the click that also activated the new tab; FR-21 makes it fire on its own, and pulling
  the chip out from under the transcript you are reading is not something a background event may do.

### Keyboard

- **FR-20.** `w` closes the focused pane's active dynamic tab and falls that pane back to `Session`;
  other panes are untouched. The routing already goes through `focusedTab` — only `closeAgentTab`'s
  lookup changes.

## 5. API contract

**No new IPC channel, no contract file.** This feature is frontend-only: it re-homes frontend state
and rendering. Every channel it touches already exists and is unchanged —
`francois:agents:transcript` + `francois:agents:event` (`agent.block`), `francois:workflows:list` +
`workflow.update`, and `francois:session:event` (`agent.update`).

The frontend types that change are internal, not contract types:

```ts
// src/lib/layoutStore.ts
export type PaneTab = 'session' | 'diff' | 'shell' | `agent:${string}` | `workflow:${string}`;
export type BuiltinPaneTab = 'session' | 'diff' | 'shell';
export function isBuiltinPaneTab(tab: string): tab is BuiltinPaneTab;
/** FR-13: a pane's tab as the GRID regime can render it. */
export function denseTab(tab: PaneTab): PaneTab;

// src/lib/agentTabStore.ts
export type MainTab = 'overview' | 'agents' | 'mcp' | 'skills' | 'workflows' | PaneTab;

export interface AgentTabSlice {
  mainTab: MainTab;
  setMainTab: (t: MainTab) => void;
  agentTabs: AgentTabMap;                                   // FR-1
  openAgentTab: (sessionId: SessionId, ref: AgentTabRef) => void;  // FR-4
  trackAgentTab: (sessionId: SessionId, ref: AgentTabRef) => void; // FR-21 — records, never activates
  syncAgentTab: (ref: AgentTabRef) => void;                 // FR-6 — unchanged signature
  closeAgentTab: (id: string) => void;                      // FR-6 — unchanged signature
  clearAgentTabs: () => void;                               // FR-7 — unchanged signature
}
```

`AgentTabRef`, `tabIdFor`, `agentIdFromTab`, `workflowIdFromTab`, `agentTabLabel`, `syncTab`,
`closeTab` and `mainTabAfterClose` keep their current signatures — and `openTab` keeps its, plus the
same optional `keep` third argument (FR-22) — — they already operate on
one `AgentTabRef[]`, which is now one map value. `mainTabAfterClose` is applied **per pane**.

New pure helpers in `src/features/agents/agent-tab.ts`, so the map logic is unit-testable without the
store:

```ts
export type AgentTabMap = ReadonlyMap<string, AgentTabRef[]>;

export function tabsForSession(tabs: AgentTabMap, sessionId: string | null): AgentTabRef[];
export function sessionOwningTab(tabs: AgentTabMap, id: string): string | null;
/** `keep` (FR-22) = the tab ids a pane is displaying; they are exempt from eviction. */
export function openTabIn(tabs: AgentTabMap, sessionId: string, ref: AgentTabRef, keep?: ReadonlySet<string>): AgentTabMap;
export function syncTabIn(tabs: AgentTabMap, ref: AgentTabRef): AgentTabMap;
export function closeTabIn(tabs: AgentTabMap, id: string): AgentTabMap;
export function dropSessionTabs(tabs: AgentTabMap, sessionId: string): AgentTabMap;
```

Returning the **same map instance** when nothing changed is load-bearing: `syncTabIn` runs on every
`agent.update` — several times a second per running agent — and a fresh `Map` each time would
re-render every strip continuously. `tabsForSession` returns a shared empty array for the same reason.

## 6. Data & state

- **Rust core**: nothing. No core file changes.
- **Frontend, owned here**: `agentTabs: Map<SessionId, AgentTabRef[]>` in `agentTabStore`, and the
  widened `PaneTab` / `MainTab`.
- **Frontend, read**: `activeSessionId`, `mainTab`, `extraPanes`, `focusedPaneIndex`, `focusedPane` —
  all existing.
- **Persistence**: none added. `francois.split` keeps its shape, and `readPaneSlot` already accepts
  only `diff`/`shell`/`session` per slot — so a dynamic tab written into the record degrades to
  `'session'` on reload, which is what FR-1 (not persisted) requires.
- **Derived**: `tabsForSession(agentTabs, paneSessionId)` per pane; `paneTabAt` applies `denseTab`.

## 7. Edge cases & errors

1. **Card clicked for a session on no pane** → complete no-op (FR-4). Unreachable today (the panels
   are keyed to `paneSessionId`), specified so a future caller cannot leak an orphan entry.
2. **Same agent clicked twice** → activate, never duplicate (`agent-tab` FR-10, per session now).
3. **7th tab for one session** → that session's oldest **undisplayed** tab is evicted, never the one
   being activated and never one a pane is showing (FR-2, FR-22); other sessions keep all six.
4. **Two panes swap sessions** (`split-by-4` FR-19) → each pane's tab travels with its session,
   because the tab id is stored in the pane and the list is keyed by session.
5. **Active tab's agent is evicted while the pane shows it** → FR-22 makes this **unreachable**: a
   displayed tab is exempt from eviction, in every pane, whether the 7th tab came from a click or
   from FR-21. Should it ever happen anyway, the body still resolves from the tab id — `AgentView` /
   `WorkflowView` hydrate as usual and render their own empty/error state, and `w` or the `Session`
   tab gets you out. That fallback is the existing single-pane behaviour and `SplitPane` matches it
   deliberately, so the two bodies cannot drift.
6. **A removed session's pane** → `split-by-4` FR-27 drops the pane and compacts the grid; FR-9 drops
   the map entry. A pane left with no session renders its existing empty body.
7. **A dynamic tab id restored from `francois.split`** → degraded to `'session'` by `readPaneSlot`
   (§6). No throw, no dangling chip.
8. **`agent.update` for an agent with no open tab** → `syncTabIn` no-ops and returns the same map
   (FR-6). This is the common case and must not re-render.
9. **All-projects widen with tabs open in several panes** → `clearAgentTabs` empties the map and every
   pane falls back; `unsplit()` then runs and `setMainTab('overview')` wins last, as today.
10. **Growing to the grid while a pane is on a dynamic tab** → every pane flattens to its transcript
    (FR-13) and nothing is written; shrinking back to two restores the tab.
11. **A split pane's strip narrower than one chip** → the strip scrolls; the chip is never squeezed
    below its truncated 14-char label (FR-14). No automatic unsplit.

## 8. Design brief

Source of truth: `Francois Redesign.dc.html` — **turn 5b — Split** for the pane sub-strip, and design
7a for the session row. `SessionRow` already draws the single-regime chips; this adds their sub-strip
sibling.

**Single regime** — no visual change. `SessionRow` keeps its icon view segment and its
`session-row__agent` chips.

**Split pane sub-strip** (`.split-pane__tabs`) — the existing `Session · Diff · Shell` text tabs are
sentence-case, no track, no accent underline, deliberately a level *below* the shell's own chrome. The
dynamic chips follow that register:

- A divider between `Shell` and the first chip, matching the strip's weight (`--border-2`, 1px, inset
  vertically).
- Chip = status dot (`--accent-2` running / `--success` done / `--error` error / `--text-muted` idle,
  pulsing while running), the `⇉` glyph in `--accent-2`, the name truncated at 14 chars with `…`, and
  a `✕` at `--text-disabled` brightening to `--text-dim`. The `✕` is always rendered, never
  hover-gated — gating it made the chip's width jump under the cursor.
- Active chip takes the same treatment `.split-tab--on` gives an active built-in tab, so one pane never
  shows two competing "active" idioms. The **unfocused** pane's chip stays desaturated like its
  `.split-tab--on`; only the status dot keeps its colour, since it reports the agent's liveness rather
  than the pane's focus — the same licence the diff badge already has.
- The strip is `overflow-x: auto` with the `scz` scrollbar treatment and `flex-shrink: 0` children, so
  overflow scrolls rather than squeezing (FR-14).

**Grid regime** — nothing to draw. A dense pane has no strip (`split-by-4` FR-9) and shows no dynamic
tab (FR-13).

**Body** — unchanged. `AgentView`'s purple provenance banner and `WorkflowView` render in a split pane
exactly as full width, just narrower; the banner's `Back to session` returns that pane (FR-18).

## 9. Acceptance criteria

- [ ] Dispatching a subagent puts its chip in that session's strip with no interaction, and does
      **not** activate it — the transcript stays on screen (FR-21).
- [ ] `✕` on an auto-added chip is final: it does not come back on the agent's next step (FR-21).
- [ ] With a pane reading `agent:a1`, six more agents spawning leaves `a1`'s chip in the strip and
      the pane on it (FR-22).
- [ ] At two panes, clicking a subagent card opens a chip in the **focused** pane's strip after
      `Shell` and shows that subagent's transcript in that pane's body (FR-4, FR-12, FR-17).
- [ ] The other pane is untouched by that click — same session, same tab, still streaming (FR-5).
- [ ] Clicking a `Workflow` run card does the same with `WorkflowView` (FR-16, FR-17).
- [ ] Switching a pane to another session keeps the first session's tabs; switching back shows them
      again in the original order (FR-8).
- [ ] Entering a two-pane split with an agent tab active keeps that tab in pane 0; entering it from
      `Overview` or a panel tab still lands on `Session` (FR-3, FR-10).
- [ ] Growing to 3–4 panes flattens every pane to its transcript, and shrinking back to two restores
      the dynamic tab the pane was on (FR-13).
- [ ] Six tabs open for session A, then a 7th → A's oldest is evicted; session B's tabs are untouched
      (FR-2).
- [ ] `w` with a dynamic tab active in the focused pane closes it and returns that pane to `Session`,
      leaving other panes alone (FR-20).
- [ ] Opening an agent tab in pane 1 while the agents panel overlays the cell dismisses the overlay
      (FR-19).
- [ ] `Back to session` inside a split pane's agent tab returns **that** pane (FR-18).
- [ ] Six chips in a half-width pane scroll horizontally; none is clipped or squeezed (FR-14).
- [ ] Quitting and reopening on a dynamic tab reopens that pane on `Session`, with no dangling chip
      and no throw (§6, §7 case 7).
- [x] `npx tsc --noEmit` clean; `npm test` green, including unit tests for `openTabIn` (cap +
      eviction scoped per session, activate-not-duplicate), `syncTabIn` / `closeTabIn` /
      `dropSessionTabs` identity-on-no-change, `sessionOwningTab`, the narrowed `clampToPaneTab`,
      `denseTab` via `paneTabAt` across all three regimes, `openAgentTab` activating the correct
      pane for each of {pane 0, pane 1, no pane, grid}, and `trackAgentTab` recording without
      activating (including for no pane and in the grid) with a displayed tab spared by the cap.

> **DoD status.** Only the last box is ticked — the one the pipeline mechanically verified. Every
> criterion above it describes a runtime interaction and nothing in the pipeline runs the app.

## Remediation

(Empty until a review returns findings.)
