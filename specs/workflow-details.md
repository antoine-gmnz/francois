---
id: workflow-details
title: Workflow details — a run's agents, timeline and transcripts in the main pane
status: shipped
created: 2026-07-31
depends_on: [workflow-panel, agent-tab, async-agents, conversation-view, app-shell]
design_files: [] # none by decision (2026-07-31): §8 brief + specs/design/workflow-details.md is the design source
reviewed_base: c5281aa25a80633b8c1ab5d5071054bf8e7e54cb
reviewed_digest: 8abbc8fc341664b8
---

# Workflow details — a run's agents, timeline and transcripts in the main pane

## 1. Summary

`workflow-panel` gives a `Workflow` run a card in pane [6], but deliberately stops at
the phases the script *declared*: a workflow's own agents never appear in the parent
session's NDJSON stream, so the card cannot say what is actually happening. They do,
however, appear **on disk**. The dispatch acknowledgement already names the run's
`Transcript dir:`, and that directory holds `journal.jsonl` (a `started` / `result`
line per agent), one `agent-<id>.jsonl` per agent (its full transcript, timestamped,
with per-message token usage), and one `agent-<id>.meta.json` (`agentType`, `model`).
This feature reads and watches that directory and renders it as a **dynamic main tab**:
the run's agents, when each ran and for how long, what each cost in tokens, what each
returned, and — one click away — each agent's own conversation. It is the `/workflows`
progress view, inside Francois.

It also closes the hole that view exposes: a workflow agent that hits a permission gate
or an `AskUserQuestion` blocks the whole run on the user, and on disk that agent is
indistinguishable from one that is merely slow. The ask itself already arrives — a
`control_request` is never diverted to a subagent (`session/stream/mod.rs`), so
`permission-guardrails` parks it — but nothing says it came from the workflow. This
feature attributes those asks to the run and lets the user answer them **from the tab**.

## 2. Goals & non-goals

- **Goals**
  - Read the run directory named by the dispatch ack and keep a live model of the run:
    one record per agent (type, model, status, span, tokens, returned result).
  - A `workflow:{id}` main tab, opened by clicking a pane [6] card — the `agent-tab`
    pattern, in the same tab strip.
  - A **timeline**: each agent's span drawn against the run's own window, so overlap
    (what `parallel`/`pipeline` actually did) is visible.
  - An agent's **own transcript**, rendered by the SESSION tab's block renderer via the
    same `AgentBlock` vocabulary `agent-tab` already defines.
  - The **script source** the harness wrote to disk, read-only.
  - **Asks that block a run** — permission approvals and `AskUserQuestion` cards raised
    from inside it — attributed to the run, visible on its pane [6] card, and answerable
    without leaving the tab.
  - Live updates from a filesystem watcher (`notify`, already a dependency and already
    used by `diff/watch.rs`), never a poll loop.
- **Non-goals**
  - **A phase → agent tree.** `opts.label` and `opts.phase` exist only in the CLI's
    memory; nothing on disk records which phase an agent belonged to. The tab shows the
    declared phases (from `workflow-panel`) and a real agent list, and never pretends
    one is grouped by the other.
  - **Cost in currency.** No pricing table exists in this repo (`/cost` is a CLI
    passthrough — `usage-bar`). Tokens only.
  - **Stopping, resuming or re-running a workflow.** Read-only, like the panel.
  - **A second way to decide an ask.** No new decision channel: the tab renders the
    *same* card component over the *same* `blockId` and answers through the existing
    `permission-guardrails` / `session-questions` commands. The SESSION tab keeps every
    card it renders today — a workflow ask is mirrored, never moved.
  - **Auto-answering anything on a workflow's behalf.** A blocked run stays blocked
    until the user decides, exactly as a blocked turn does.
  - **Persisting any of it.** Derived from disk on demand; nothing enters
    `sessions.json`.
  - Runs from earlier app sessions. A `WorkflowRun` is in-memory (`workflow-panel`
    FR-11), so only runs observed in this app session have a tab.

## 3. User stories / flows

1. **Watch a fan-out.** A `cohorte-cycle` card is running in pane [6]. The user clicks
   it: a `⇉ cohorte-cycle` tab opens after SHELL. The left column lists the agents that
   have started, each with a bar showing its span; new agents append and bars extend as
   the run proceeds. The header counts `7 agents · 3 running` and totals the tokens.
2. **Read one agent.** The user clicks the `frontend` row. The right column becomes that
   agent's conversation — full text and tool cards, the same rendering as the SESSION
   tab — ending with the value it returned to the script.
3. **Read the script.** The user clicks `script` in the header. The right column shows
   the `.js` the harness wrote, so the declared phases have something concrete behind
   them. Clicking an agent returns to the transcript.
4. **The run blocks on the user.** An agent inside it calls `Bash` on something gated.
   The pane [6] card flips to `waiting on you` and the tab's header says so; the agent's
   row goes amber with `waiting`. The approval card renders in the right column, under
   the agent it belongs to. The user clicks `allow` and the bar starts extending again.
   The same card is still in the SESSION tab and answering in either place resolves both.
5. **The run ends.** Bars freeze, statuses settle, the watcher stops. The tab stays open
   and readable.
6. **Switch sessions.** Every workflow tab closes with the agent tabs — run ids are
   session-scoped.

## 4. Functional requirements

### Core — locating the run

- **FR-1.** `workflow-panel` FR-6's ack parse also extracts `Transcript dir: <path>` and
  `Script file: <path>` (each the remainder of its line, trimmed) and stores them on the
  run. `transcriptDir` is exposed on `WorkflowRun`; `scriptPath` is core-only state.
  A dispatch whose ack carries neither leaves both absent.
- **FR-2.** A path is used only if it resolves to an existing directory (resp. file);
  otherwise it is treated as absent. Nothing here ever writes inside the run directory.

### Core — reading the run

- **FR-3.** A **scan** of the run directory produces a `WorkflowDetail`:
  - `journal.jsonl` — a `started` line mints the agent record for its `agentId`; a
    `result` line sets `result` and `status: 'done'`. Unparseable lines are skipped.
  - `agent-<id>.meta.json` — `agentType` and `model` when present.
  - `agent-<id>.jsonl` — `startedAt` = first line's `timestamp`, `lastAt` = last line's;
    `prompt` = the first `user` line's text content, first non-blank line, ≤ 200 chars;
    tokens summed over every `assistant` line's `message.usage`
    (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
    `cache_creation_input_tokens`).
  - Agents are ordered by `startedAt`, then by first appearance in `journal.jsonl`.
- **FR-4.** Agent status is three-valued, because the journal has **no** failure event —
  a dead agent is a `started` with no `result`:
  `done` (a `result` line exists) · `running` (no result, the parent run is still
  `running`) · `stopped` (no result and the run is terminal). `stopped` is never
  called an error. A fourth value, `waiting`, is not read from disk — it is imposed by
  FR-22 when an ask is attributed to that agent, and it overrides `running` only.
- **FR-5.** Rescanning is **incremental**: per file the core keeps the byte offset it
  last consumed and its running aggregate, and parses only the appended tail. A file
  that shrank or whose id is unknown is re-read from zero. A scan never re-reads a
  file's consumed prefix.
- **FR-6.** `francois:workflows:detail` starts a `notify` recursive watch on the run
  directory. Events are debounced at **300 ms**; each flush rescans (FR-5) and emits
  `workflow.detail` with the whole detail. The watch stops when the run is terminal and
  one final scan has been flushed, when its session is removed, or when the app exits.
  At most one watch per run.
- **FR-7.** `francois:workflows:detail` resolves the current detail, starting the watch
  (FR-6) if it is not already running. `WORKFLOW_NOT_FOUND` for an unknown run id;
  `WORKFLOW_NO_TRANSCRIPT` when the run has no usable `transcriptDir` (FR-2).
- **FR-8.** `francois:workflows:agent` returns one agent's transcript as
  `AgentBlock[]` — the `agent-tab` vocabulary, produced by the same classification:
  `text` → assistant block (trimmed, capped at 8000 chars), `tool_use` → tool or
  subagent block, `tool_result` → fills that block's `meta`, `thinking` and everything
  else dropped. At most **400** blocks, oldest dropped, with the `dropped` count
  returned. `WORKFLOW_AGENT_NOT_FOUND` for an unknown `agentId`.
- **FR-9.** `francois:workflows:script` returns the source at the run's `scriptPath`,
  capped at **200 KB** with `truncated: true` past that. `WORKFLOW_NO_SCRIPT` when the
  run has no readable script file.
- **FR-10.** Every filesystem read here is fallible and fails **soft**: an unreadable or
  unexpectedly-shaped file yields fewer agents or thinner records, never an error
  response and never a panic. A run directory that does not match the expected layout
  produces an empty agent list, and the pane [6] card is unaffected.

### Frontend — the tab

- **FR-11.** A **click** on a pane [6] card whose run has a `transcriptDir` opens
  `workflow:{id}` if absent, activates it, and moves focus to the main pane. Clicking a
  card without one only selects it, as today. `⏎` in pane [6] keeps expanding the card
  in place (`workflow-panel` FR-10) and never opens a tab.
- **FR-12.** Workflow tabs live in the same strip and the same cap as agent tabs: at
  most **6** dynamic tabs open at once, the oldest closed first, never the one being
  activated. A workflow tab renders `⇉ {name}` (14 chars, `…`), a status dot in the
  run's status colour, and a `✕` on hover. `w` closes the active one; closing the active
  tab activates `session`.
- **FR-13.** Switching the active session closes every workflow tab, exactly as it
  closes agent tabs.
- **FR-14.** Opening the tab issues `francois:workflows:detail` and subscribes to
  `workflow.detail` for that run id. Events arriving before the response are applied
  after it and are never overwritten by it. `workflow.update` (the panel's own event)
  keeps the header's run status and elapsed clock live.
- **FR-15.** The body is two columns. **Left**: the run header (name, description,
  status, elapsed, `N agents · M running`, token totals, the declared phases, a `script`
  toggle) above the agent list. **Right**: the selected agent's transcript, or the script
  source when `script` is active, or the run summary when nothing is selected.
- **FR-16.** An agent row shows: status dot · `agentType` · `model` when known · elapsed
  (`(lastAt ?? now) - startedAt`) · total tokens · the prompt line, ellipsized. Under it,
  a **span bar** positioned proportionally within `[run.startedAt, run.endedAt ?? now]`,
  so concurrent agents visibly overlap. A row whose agent has `result` shows a one-line
  preview of it.
- **FR-17.** Selecting an agent issues `francois:workflows:agent` and renders the blocks
  with the SESSION tab's renderer. `dropped > 0` renders one leading
  `… {dropped} earlier block(s)` row. The agent's returned `result` renders as a final
  labelled block (pretty-printed when it is JSON). A `running` agent's transcript is
  re-fetched on each `workflow.detail` flush that reports new activity for it.
- **FR-18.** The transcript column auto-scrolls to the newest block unless the user has
  scrolled up (within 8px of the bottom counts as at the bottom — `agent-tab` FR-18).
- **FR-19.** The 1 Hz clock driving the header elapsed, row elapsed and bar extents runs
  only while the run is `running`.

### Asks raised inside a run

A workflow agent's permission gate or `AskUserQuestion` arrives on the parent session's
stdio channel as an ordinary `control_request` — `session/stream/mod.rs` deliberately
never diverts that line — so `permission-guardrails` FR-1(d) / `session-questions` FR-6
already park it and already emit its card. **None of that changes.** This feature adds
attribution and a second place to answer.

- **FR-20.** Every parked ask is offered to a **workflow attribution ladder**, most
  specific rung first, and the first rung that matches wins:
  1. the request's `parent_tool_use_id` equals the `tool_use_id` of a `Workflow`
     dispatch this session minted (`workflow-panel` §6's `workflow_by_tool`) → that run;
  2. an `agent_id` / `agentId` field on the request matches an `agentId` the run scan
     (FR-3) has seen → that run *and* that agent, `confidence: 'exact'`;
  3. exactly one workflow run is `running`, **and** no ordinary background subagent is
     running → that run, agent unknown, `confidence: 'inferred'`;
  4. nothing matches → the ask is **not** a workflow ask and this feature ignores it.
  Rung 3 is deliberately the same shape as `workflow-panel` FR-8's sole-candidate rung
  and carries the same risk, which is why it is marked `inferred` rather than hidden.
- **FR-21.** Attribution is **additive and non-destructive**. The ask stays in the
  session's `pending_questions` / `pending_permissions` maps untouched, its SESSION-tab
  card is still emitted, and it is still resolved by the existing commands under the
  existing exactly-once claim. A mis-attribution can therefore mislabel a card but can
  never lose one, double-answer one, or leave the CLI parked.
- **FR-22.** While an ask is attributed to a run, that run's detail carries it in
  `pendingAsks`, and the agent named by rung 2 (if any) reports `status: 'waiting'`.
  Resolving, cancelling (`control_cancel_request`) or orphaning the ask removes it and
  restores the agent's disk-derived status.
- **FR-23.** Attributing or removing an ask emits `workflow.detail` immediately — this
  path does not wait for FR-6's 300 ms filesystem debounce, because a blocked run
  produces no filesystem activity to debounce.
- **FR-24.** A run with at least one attributed ask reports `pendingAsks: N` on its
  `WorkflowRun`, so the pane [6] card can say `waiting on you` without the panel
  subscribing to this feature's detail stream. `WorkflowStatus` is unchanged — waiting
  is an overlay on `running`, not a lifecycle state.
- **FR-25.** The workflow tab renders each attributed ask with the **existing** approval
  / question card component, keyed by its `blockId`, positioned under the agent it is
  attributed to (or at the top of the right column when the agent is unknown). An
  `inferred` attribution renders a dim `attributed by elimination` note on the card.
- **FR-26.** Answering from the workflow tab calls the same commands the SESSION tab
  calls. A card whose `blockId` is no longer pending — answered elsewhere, cancelled, or
  orphaned by a turn that ended — disappears from the tab on the next
  `workflow.detail`; it is never left as a dead control.

## 5. API contract

Domain `workflows`. Types live in `contract/workflow-details.ts`, which imports
`AgentBlock` from `contract/agent-tab.ts` and `WorkflowRunId` / `SessionId` / `BlockId` from
`contract/common.ts`. `contract/common.ts` changes in exactly three ways: `WorkflowRun`
gains `transcriptDir?: string` and `pendingAsks?: number` (FR-24), and `ErrorCode` gains
`WORKFLOW_NOT_FOUND`, `WORKFLOW_NO_TRANSCRIPT`, `WORKFLOW_AGENT_NOT_FOUND`,
`WORKFLOW_NO_SCRIPT`. `WorkflowStatus` is **not** touched (FR-24), and no
permission/question type is redefined — this feature carries a `blockId` and the
existing card owns the payload.

**Channels owned by this feature**

| Channel | Payload | Result data | Error codes |
|---|---|---|---|
| `francois:workflows:detail` | `WorkflowDetailRequest` | `WorkflowDetail` | `WORKFLOW_NOT_FOUND`, `WORKFLOW_NO_TRANSCRIPT` |
| `francois:workflows:agent` | `WorkflowAgentRequest` | `WorkflowAgentTranscript` | `WORKFLOW_NOT_FOUND`, `WORKFLOW_AGENT_NOT_FOUND` |
| `francois:workflows:script` | `WorkflowScriptRequest` | `WorkflowScript` | `WORKFLOW_NOT_FOUND`, `WORKFLOW_NO_SCRIPT` |

Physical binding: `invoke('workflows_detail' | 'workflows_agent' | 'workflows_script', …)`
→ `Promise<Result<T>>`.

**Event owned by this feature** — `francois:workflows:event` → Tauri event
`francois://workflows/event`, payload `WorkflowDetailEvent`.

```ts
export type WorkflowAgentId = string;            // the harness's `a…` id
export type WorkflowAgentStatus = 'running' | 'done' | 'stopped' | 'waiting';

export interface WorkflowTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface WorkflowAgentInfo {
  agentId: WorkflowAgentId;
  agentType: string;                             // 'workflow-subagent' when unspecialised
  model?: string;
  status: WorkflowAgentStatus;
  startedAt: number;                             // epoch ms, first transcript line
  lastAt?: number;                               // absent while running
  prompt: string;                                // ≤ 200 chars, may be ''
  tokens: WorkflowTokens;
  result?: string;                               // stringified return value, ≤ 2000 chars
}

/** FR-20..FR-25. Correlation only — the card's payload stays where it already lives. */
export interface WorkflowPendingAsk {
  blockId: BlockId;                              // the key the existing card is stored under
  kind: 'permission' | 'question';
  agentId?: WorkflowAgentId;                     // absent unless ladder rung 2 matched
  toolName?: string;                             // permission asks only, for the row label
  confidence: 'exact' | 'inferred';              // 'inferred' ⇒ ladder rung 3
}

export interface WorkflowDetail {
  id: WorkflowRunId;
  sessionId: SessionId;
  transcriptDir: string;
  hasScript: boolean;
  agents: WorkflowAgentInfo[];
  tokens: WorkflowTokens;                        // run total
  pendingAsks: WorkflowPendingAsk[];             // [] when nothing is blocking
}

export interface WorkflowDetailRequest { runId: WorkflowRunId }
export interface WorkflowAgentRequest { runId: WorkflowRunId; agentId: WorkflowAgentId }
export interface WorkflowAgentTranscript { blocks: AgentBlock[]; dropped: number }
export interface WorkflowScriptRequest { runId: WorkflowRunId }
export interface WorkflowScript { path: string; source: string; truncated: boolean }

export type WorkflowDetailEvent =
  { type: 'workflow.detail'; sessionId: SessionId; detail: WorkflowDetail };
```

## 6. Data & state

- **Core** — `src-tauri/src/session/workflow_details.rs` (scan + parse, pure over paths)
  and `workflow_watch.rs` (the `notify` watcher, mirroring `diff/watch.rs`). `Session`
  gains `workflow_scripts: HashMap<runId, PathBuf>`; `WorkflowRun` gains
  `transcript_dir: Option<String>`. The `Engine` gains
  `workflow_scans: Mutex<HashMap<runId, ScanState>>` — per-file byte offsets and running
  aggregates (FR-5) plus the watcher handle. None of it is serialized. The scan itself is
  a pure function over `(&Path, &mut ScanState)` so it is unit-testable against a temp
  directory, which is how the core tests must exercise it. Attribution (FR-20) lives in
  `workflow_details.rs` as a pure function over `(&Session, &Value)` returning
  `Option<(runId, Option<agentId>, Confidence)>`, called from `handle_control_request`
  **after** it has parked the ask, never instead of it. The attributed set is
  `Engine.workflow_asks: Mutex<HashMap<runId, Vec<WorkflowPendingAsk>>>`, keyed off the
  same `blockId` the turn's pending maps use, and drained by the same claim.
- **Frontend** — `src/features/workflows/`: `workflow-detail.ts` (the reducer and the
  span/token derivations, pure and tested), `WorkflowView.tsx` (the tab body),
  `WorkflowAgentRow.tsx`. `src/lib/store.ts`: `MainTab` gains `` `workflow:${string}` ``
  and the existing `agentTabs` list becomes the shared dynamic-tab list so FR-12's cap
  covers both kinds.

Derived, not stored: elapsed strings, bar offsets and widths, the `N agents · M running`
count, the token totals rendered per row.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| Ack carried no `Transcript dir:` (older harness, or a changed ack format) | The card is not clickable (FR-11); nothing else changes. |
| The run directory exists but is empty (the run has not spawned yet) | Empty agent list, `no agents yet` in the left column; the watcher keeps running. |
| The harness changes the directory layout | FR-10: fewer/no agents, no error UI. The panel card and the session are untouched. |
| An agent's transcript file exists but the journal has no `started` for it | The file is authoritative for existence — the agent is listed, `status` from FR-4. |
| A `result` line for an unknown `agentId` | Mints the record from the journal alone; span and tokens stay absent until its file appears. |
| A `result` whose value is a large object | Stringified and capped at 2000 chars for the row; the agent view renders the same capped value, pretty-printed. |
| An agent never finishes (the 6-of-70 case seen in a real run) | `stopped` once the run is terminal. Never an error. |
| Two tabs open on the same run | Impossible — FR-11 activates rather than duplicates. |
| The run finishes while the tab is open | One final flush, the watch stops, everything freezes at real values. |
| `workflows_agent` for an agent whose file is mid-write | Trailing partial line is skipped; the next flush picks it up. |
| Script file deleted between ack and click | `WORKFLOW_NO_SCRIPT`; an inline error row in the right column, the tab stays open. |
| The harness tags a workflow ask with no id Francois recognises | Ladder rungs 1–2 miss. With one running workflow and no background agent, rung 3 attributes it `inferred`; otherwise it is left alone and behaves exactly as it does today (a SESSION card). |
| An ask is attributed to the wrong run | It is mislabelled, never lost: FR-21 keeps the SESSION card and the single claim, so it is still answerable and still resolves once. |
| A workflow ask arrives while the workflow tab is closed | Nothing is lost — the card is in the SESSION tab as always, and the pane [6] card reads `waiting on you` (FR-24). |
| Two agents of one run block at the same time | Both asks sit in `pendingAsks`; each renders under its own agent when rung 2 resolved it, otherwise both sit at the top of the column. |
| The user answers in the SESSION tab | The claim resolves there; the next `workflow.detail` drops the card from the tab (FR-26). |
| The turn ends while an ask is parked | `permission-guardrails` FR-10 orphans it; FR-22 removes it from `pendingAsks` and `workflow-panel` FR-9 closes the run. No card is left answerable. |
| A blocked agent whose ask was never attributed | It reads `running` with a frozen bar — the same honest "we have not seen it finish" the `stopped` case gets. |

## 8. Design brief

The tab body is a two-column split inside the main pane: a **312px** left rail
(`--bg-panel`, `--border` right edge) holding the run header and the agent list, and the
remaining width for the transcript / script column. Agent rows reuse pane [3]'s card
metrics; the transcript column reuses the SESSION tab's block rendering unchanged. The
span bar is a 3px `--bg-raised` track with an `--accent-2` fill while running and
`--text-disabled` once done, positioned proportionally — the one genuinely new element.
Status colours are the established triple (`--accent-2` running, `--success` done,
`--text-muted` stopped). No motion beyond the running dot's existing pulse and the 1 Hz
clock.

> full brief: `specs/design/workflow-details.md`

## 9. Acceptance criteria

> Ticked 2026-08-01 by `/review` round 2 (SHIP): spec conformance + `ui_language` copy verified by
> the review, tests · typecheck green in the same cycle's preflight. Items left `- [ ]` are the ones
> whose verifying stage has **not** run this cycle — they assert what the UI *renders* on click, and
> no `/smoke` was run (per PIPELINE.md §Testing the frontend has no DOM component framework wired, so
> unit tests cannot close them).

- [x] The ack's `Transcript dir:` and `Script file:` are parsed onto the run, and a path
      that does not exist is treated as absent (FR-1, FR-2).
- [x] Scanning a fixture run directory yields one record per agent with type, model,
      span, prompt line and summed tokens, ordered by start (FR-3).
- [x] An agent with a `started` and no `result` is `running` while the run is, and
      `stopped` once it is terminal (FR-4).
- [x] A second scan after appending to a transcript file re-reads only the appended tail
      and produces the same totals as a full re-read (FR-5).
- [x] Writing into the run directory emits exactly one `workflow.detail` per 300 ms
      window, and no watch survives a terminal run's final flush (FR-6).
- [x] `workflows_detail` on an unknown run resolves `WORKFLOW_NOT_FOUND`; on a run with
      no transcript dir, `WORKFLOW_NO_TRANSCRIPT` (FR-7).
- [x] `workflows_agent` returns `AgentBlock`s whose tool blocks carry the `meta` from
      their `tool_result`, capped at 400 with a `dropped` count (FR-8).
- [x] A malformed / truncated / missing file anywhere in the directory yields a thinner
      detail and never an error or a panic (FR-10).
- [ ] Clicking a pane [6] card with a transcript dir opens and activates
      `workflow:{id}`; clicking one without does not (FR-11). _— store half proven
      (`agentTabStore.test.ts`); the click guard needs `/smoke`._
- [x] Agent tabs and workflow tabs share one 6-tab cap and one eviction order (FR-12).
- [x] Switching sessions closes every workflow tab (FR-13).
- [x] Detail events buffered before the `workflows_detail` response survive it (FR-14).
- [ ] Overlapping agents render overlapping span bars against the run's window (FR-16).
      _— `spanBar` math proven; the render needs `/smoke`._
- [ ] Selecting an agent renders its transcript and its returned result; the script
      toggle renders the source (FR-17, FR-9). _— state machine proven; the render needs
      `/smoke`._
- [x] Each ladder rung attributes in isolation, and rung 3 does **not** fire when a
      background subagent is also running or when two workflows are running (FR-20).
- [x] A `control_request` that this feature attributes is still parked, still emitted as
      a SESSION card, and still resolved exactly once by the existing command — proven
      by the existing `permission-guardrails` tests passing unchanged (FR-21).
- [x] An attributed ask sets the agent to `waiting` and restores its disk-derived status
      when the ask resolves (FR-22).
- [x] Attributing an ask emits `workflow.detail` without waiting for the 300 ms
      filesystem debounce (FR-23).
- [ ] A run with a parked ask reports `pendingAsks` on its `WorkflowRun` and the pane [6]
      card reads `waiting on you` (FR-24). _— `pendingAsks` proven core-side; the card
      copy needs `/smoke`._
- [ ] Answering from the workflow tab resolves the same ask as answering from the SESSION
      tab, and the card then disappears from both (FR-25, FR-26). _— needs `/smoke`._

## Remediation

- 2026-08-01 — review round 1 (core REVISE, frontend SHIP) — 5 findings (1 CRITICAL, 2 MEDIUM, 2 LOW), all fixed.
      - fixed: `workflows.rs` `emit_workflow_updates` now flushes/stops the watch for every run leaving
        `running` with a `transcript_dir`, via the pure `terminal_watch_run_ids` choke point (FR-6).
      - fixed: `workflow-detail.ts` `spanBar` takes `frozenAt` and freezes a `waiting` agent's bar width;
        `WorkflowAgentRow.tsx` captures the freeze point in a ref.
      - fixed: `asks.rs` gained a `top_level_ask_request` fixture + two ladder tests covering the real
        top-level `parent_tool_use_id`/`agent_id` wire shape.
      - fixed: `commands.rs` `read_script` truncates on a UTF-8 char boundary via `last_char_boundary`.
      - fixed: `WorkflowView.tsx` `onSelect` scrolls the selected agent's owned ask card into view.
