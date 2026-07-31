---
id: workflow-panel
title: Workflow panel (pane [6])
status: shipped
created: 2026-07-31
depends_on: [session-engine, agents-panel, async-agents, app-shell]
---

# Workflow panel (pane [6])

## 1. Summary

Claude Code's harness ships a `Workflow` tool: the assistant hands it a script that
orchestrates many subagents deterministically (phases, fan-out, pipelines), and the
tool returns immediately while the run proceeds in the background. Today a Francois
user watching a session sees that dispatch as one anonymous tool block in the
transcript and nothing afterwards — the run is invisible until it finishes. This
feature gives workflow runs the same standing subagents already have in pane [3]:
a card per run in the right column, live from the session's own event stream, with
the run's name, what it is for, how long it has been going, and the phases its
script declared.

## 2. Goals & non-goals

- **Goals**
  - A fourth right-column pane, `WORKFLOWS · [6]`, listing this session's `Workflow`
    runs in first-seen order with running ones on top.
  - Per run: name, description, status (running / done / error), a live elapsed
    clock anchored to the dispatch, the last thing observed about it, and the
    harness run id once known.
  - Expanding a card lists the phases the script declared.
  - Everything derived from the NDJSON stream the core already reads — no new
    process, no filesystem watching, no polling.
- **Non-goals**
  - **Per-phase progress.** A workflow's own agents do not surface in the parent
    session's stream, so the panel reports which phases were *declared* and says
    so; it never implies a phase is current or finished. (`/workflows` in the CLI
    remains the place to watch a run tick.)
  - **Dispatching or stopping a run from Francois.** The panel is read-only: a run
    starts because the assistant called the tool during a turn.
  - **A catalog of saved workflows** (`.claude/workflows/*.md`). That is the
    skills-panel shape, not this one; it can be a later feature.
  - Reading the run's transcript directory (`journal.jsonl`, `agent-*.jsonl`). Its
    layout is not a stable interface.

## 3. User stories / flows

1. The assistant dispatches a workflow mid-turn. A card appears in pane [6] the
   moment the tool block opens, `running`, with a ticking clock. Its name fills in
   a beat later, when the tool's input JSON has finished streaming.
2. The user presses `6`. The right column reveals itself if hidden and pane [6]
   takes focus; `↑`/`↓` move the selection, `⏎` expands the selected card to its
   phase list, `⏎` again collapses it. A click does the same thing.
3. The workflow finishes. The card goes `done` (or `error`), the clock freezes at
   the real elapsed time, and the last line shows the completion notice's text.
4. The user switches sessions. The panel empties and rehydrates for the new
   session; runs are per-session and never leak across.

## 4. Functional requirements

- **FR-1** Pane [6] is the fourth pane of the right column, titled
  `WORKFLOWS · [6]`, showing the count of this session's runs. Key `6` focuses it
  and reveals the column if hidden; hiding the column with `]` while it has focus
  hands focus to `main` — the same contract panes [3]/[4]/[5] already have.
- **FR-2** A `content_block_start` for a tool named `Workflow` mints a run:
  `status: 'running'`, `startedAt` = now, no `endedAt`. `startedAt` never changes
  afterwards.
- **FR-3** Every mint, change, and terminal transition emits exactly one
  `workflow.update` carrying the whole run.
- **FR-4** At `content_block_stop` the dispatch's input JSON is complete, so the
  run's `name`, `description`, and `phases` are read from it: an inline `script`'s
  own `export const meta` block first, else the saved-workflow `name`, else the
  `scriptPath` file stem. A dispatch carrying none of them still yields a named
  card (`workflow`). No `workflow.update` is emitted when nothing changed.
- **FR-5** The elapsed clock runs from `startedAt` to `endedAt`, and to *now* while
  `endedAt` is absent — so a running card ticks and a finished one is frozen.
- **FR-6** The dispatch's `tool_result` is an **acknowledgement**, not a
  completion: on success it records the `wf_…` run id parsed out of the result text
  and leaves the run `running`. Only an `is_error` result ends the run (`error`,
  `endedAt` set).
- **FR-7** `workflows_list` returns this session's runs in first-seen order. A card
  updated in place keeps its position.
- **FR-8** A harness task-notification closes its run (`done`, or `error` when the
  text matches the async-agents FR-15 word test). It is matched by: the run id
  verbatim → the run's name → the single running run. The first two rungs are
  tried **before** async-agents' own notice ladder and the third **after** it, so
  neither feature's sole-candidate fallback can swallow the other's notification.
- **FR-9** At turn end — and when the session fails — no run is left `running`:
  each is closed (`done`, or `error` when the turn errored) with `endedAt` and an
  `ended with the turn` activity line. This is the backstop that keeps the clock
  honest when FR-8's notification never arrives.
- **FR-10** Selecting a card collapses any expanded one; `⏎` (or a click) toggles
  the selected card between collapsed and expanded. An expanded card lists the
  declared phases, numbered, with each phase's `detail` when the script gave one,
  under a line stating that these are declared phases rather than live progress.
- **FR-11** Runs are per-session: switching sessions clears the list, the
  selection, and the expansion, then rehydrates from `workflows_list`. Runs are
  in-memory only and are never persisted across an app restart.

## 5. API contract

Lives in `contract/workflow-panel.ts`; `WorkflowRun` / `WorkflowPhaseInfo` /
`WorkflowStatus` / `WorkflowRunId` are shared vocabulary in `contract/common.ts`
because they ride on `SessionEvent`.

- **`francois:workflows:list`** (request/response) → Tauri command `workflows_list`
  - Request: `{ sessionId: SessionId }`
  - Resolves `Result<WorkflowRun[]>` — first-seen order.
  - Errors: `SESSION_NOT_FOUND`.
- **`francois:session:event`** (consumed) → `francois://session/event`
  - New member: `{ type: 'workflow.update'; run: WorkflowRun }`. The panel reacts
    only to this member, filtered to the active session.

```ts
export type WorkflowRunId = string; // uuid v4 — minted by the core, not the harness
export type WorkflowStatus = 'running' | 'done' | 'error';

export interface WorkflowPhaseInfo {
  title: string;
  detail?: string;
}

export interface WorkflowRun {
  id: WorkflowRunId;
  sessionId: SessionId;
  name: string;
  description: string;
  status: WorkflowStatus;
  startedAt: number;
  endedAt?: number;
  phases: WorkflowPhaseInfo[];
  runId?: string;
  lastActivity?: string;
}
```

## 6. Data & state

- **Core** (`src-tauri/src/session/workflows.rs`, model in `session/mod.rs`):
  `Session.workflows: HashMap<runId, WorkflowRun>`, `workflow_order: Vec<String>`
  (FR-7), `workflow_by_tool: HashMap<toolUseId, runId>` (the FR-2 correlation key,
  session-scoped so the ack and the notice both reach it after the tool call
  closed). None of it is serialized — a reloaded session starts with no runs
  (FR-11). The dispatch's run id also rides in the tool record's input as
  `__workflowId`, and survives the `content_block_stop` reparse the same way
  `__agentId` does.
- **Frontend** (`src/features/workflows/`): `useWorkflowsFeed` holds
  `Map<id, WorkflowRun>` on the shared hydrated-subscription engine; the panel
  holds `selectedId`, `expandedId`, and the 1 Hz clock (only while something runs).

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| `workflows_list` fails / session gone | The panel body shows the error message; no cards. |
| A `workflow.update` arrives before hydration resolves | It is buffered and drained in arrival order; the later snapshot never overwrites it. |
| The script has no `export const meta` block, or a nameless one | Fall through the FR-4 ladder (`name` → `scriptPath` stem → `workflow`). Phases stay empty and the expanded card reads `no phases declared`. |
| A meta block whose strings contain `{`, `}`, or `[` | Brace/bracket matching ignores anything inside a quoted string, so the block is still found. |
| A phase entry with no `title` | Dropped — an unlabelled row says nothing. |
| The dispatch ack carries no `wf_…` token | `runId` stays absent; the expanded card simply omits that line. |
| A notification that matches no run | Left for the agent ladder; if nothing claims it, it reaches the transcript unchanged. |
| Two runs in flight and an unattributable notification | Neither is closed (FR-8's sole-candidate rung needs exactly one); FR-9 closes them at turn end. |

## 8. Design brief

The pane reuses pane [3]'s card metrics exactly — the two sit in the same 296px
column, and a second card scale there would read as a different kind of object.

- **Panel shell**: `--bg-panel` on a `--border-2` outline, `--radius-xl`, header via
  the shared `PanelHeader` (`WORKFLOWS`, count, `· [6]`); `--border-focus` outline
  when focused. Column share `flex: 0.8` — the smallest of the four, since a
  session usually has zero or one runs while the panes above are list-shaped.
- **Card**: `--bg-hover` fill, `--radius-card`, `inset 0 0 0 1px --border-emphasis`;
  selected adds the `--accent` left border and the `--bg-raised` fill (the mock's
  agent card). Head row = `StatusDot` (pulsing while running) · name · phase-count
  pill (`--bg-raised`, `--font-size-9`) · status text, colored `--accent-2`
  running / `--success` done / `--error` error. Then the description
  (`--text-muted`, truncated until expanded), then the meta line: `◷` + elapsed +
  `elapsed` + `·` + last activity (`--text-muted`, truncated).
- **Expanded**: a `--border` hairline, then the run id (`--text-disabled`), the
  "declared phases" note, and numbered phase rows (`index` `--text-disabled`,
  title `--text-muted`, detail `--text-disabled`).
- **Empty**: `no workflows yet` in `--text-faint`, centered padding — no call to
  action, because the user cannot start one from here.
- **Motion**: none beyond the dot's existing pulse and the 1 Hz clock.

## 9. Acceptance criteria

- [ ] Pressing `6` focuses pane [6] and reveals the right column when hidden (FR-1).
- [ ] Dispatching a workflow makes a card appear immediately, with a ticking clock,
      and its name/description/phases fill in when the input finishes streaming
      (FR-2, FR-4, FR-5).
- [ ] A successful dispatch result does **not** stop the clock; the run id appears
      on the expanded card (FR-6).
- [ ] The completion notification flips the card to `done` and freezes the clock;
      a failure notification flips it to `error` (FR-8).
- [ ] A turn that ends without any notification still leaves no card running (FR-9).
- [ ] `↑`/`↓`/`⏎` and clicking select and expand/collapse as described; expanding
      lists the declared phases with their details (FR-10).
- [ ] Switching sessions empties and rehydrates the panel (FR-11).

## Remediation

(Empty until a review returns findings.)
