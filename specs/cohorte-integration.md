---
id: cohorte-integration
feature_id: cohorte-integration
title: Cohorte integration — runs, gates and health inside Francois
status: frozen
branch: feat/integration-cohorte
created: 2026-09-23
depends_on: [projects, session-engine, sessions-sidebar, conversation-view, app-shell, notifications, command-palette, wsl-filesystem, github-page]
contract: contract/cohorte-integration.ts + contract/cohorte-events.ts
reviewed_base:
reviewed_digest:
design_files:
  - "Figma YEY4c6AiWq1bKYuaju9qdV — 25 `154:14871` (L25 `162:24872`), 26 `156:15293` (L26 `162:25368`), 27 `158:15589` (L27 `162:25860`), 28 `159:15655` (L28 `162:26045`); Icon/cohorte `168:17296`; Session panel Tab=Cohorte `153:14818`"
---

# Cohorte integration — runs, gates and health inside Francois

## 1. Summary

[Cohorte](D:\cohorte) v3 is a durable pipeline runner (`cohorte run <spec> --detach`): one detached
host per run, one SQLite store per repo, and one-shot CLI "controllers" for everything else
(`status`, `tail`, `approve`, `deny`, `pause` …, each ≤10 s, ≤4 MiB — designed around Francois'
10 s kill). This feature makes a Cohorte run a first-class citizen of Francois: the core detects
`.cohorte/`, watches the project's runs by polling the CLI's `--json` documents and event dump,
normalises **every** Cohorte Protocol 1.0 event into a typed Francois event, and exposes run
controls that **always shell out to the CLI** (Francois never signs a command, never reads the
SQLite store, never writes into `.cohorte/`). The frontend shows a pending gate in the session it
belongs to (header chip, inline transcript card, session-panel Cohorte tab — frame 25), a full run
view (frame 26), a per-project Settings page with health and four preferences (frames 27/28), and
optional Needs-you / run-grouping behaviour in the roster.

Runtime facts: `.cohorte/design/cohorte-runtime-brief.md`, verified against `D:\cohorte @
3.0.0-dev.8` (commit `7c1c16e`). Where the brief and the code disagree, **the code wins** and this
spec says so (§2.3).

## 2. Goals & non-goals

### 2.1 Goals
- Detect Cohorte per project and per session cwd, including from a linked git worktree.
- Bind **all 68** catalogue event types (packages/protocol/src/catalogue.ts `EVENTS`) to typed
  `CohorteEvent` members, plus a forward-compatible `unknown` member, and give each a defined UI effect.
- Answer a gate (approve · send to fix · deny) from the transcript, the panel, the run view, the
  roster and the palette — each mapped to exact CLI argv, with the command shown as a hint.
- Pause / resume / cancel a run; run `doctor`; run `init` (the one write, through the CLI).
- Map runs to sessions deterministically (§FR-30).
- Demo mode shows frames 25–28.

### 2.2 Non-goals
- Starting a run from Francois (`cohorte run …`) — users start runs from a session (a Claude
  turn or the shell); Francois only observes and answers. No "new run" UI.
- Reading `.cohorte/state/cohorte.db` or any Cohorte-internal file other than the existence checks
  in FR-2; parsing `.cohorte/*.yaml` (policy comes from `cohorte config get`).
- `cohorte gc`, `providers test`, `config set|trust`, `skip`, `send`, `run-tool`, `shutdown`,
  `inspect` — not driven (gc/config-set write; providers-test hits the network).
- Opening artifacts in an editor (artifact rows are informational, except the log row, FR-54).
- A streaming `tail --follow` subscription: dev.8 ignores `--follow` (§2.3).

### 2.3 Cohorte 3.0.0-dev.8 realities this spec builds on (verified in source)
| Topic | Documented (DESIGN / brief) | Actual dev.8 (`apps/cli/src/commands/*`) | Francois does |
|---|---|---|---|
| `status --json` (project) | `ProjectStatusDocument` | `store.listRuns()` → **`RunRecord[]`** (status/index.ts) | accept both (FR-14) |
| `status <run> --json` | `RunSnapshotDocument` | `store.getRun()` → **`RunRecord`** | accept both |
| `status` precondition | walks up | requires `<cwd>/.cohorte/project.yaml` | always spawn with `cwd = root` |
| `tail <run> --json` | follow, since-seq | dumps **durable** events `afterSequence:0, limit:1000`, once; `--json` not registered (`VERBS` has no `json` on `tail`), lines still one JSON envelope each | poll + dedupe + HWM; pass `--since-seq` anyway (FR-20) |
| `approve` | `--approval-id --scope --answer --note` | **positional** `approve <runId> <approvalId> [<answer>]`, scope fixed `once`, no note | positional argv (FR-45) |
| `deny` | `--approval-id --note` | positional `deny <runId> <approvalId>`, no note | positional |
| `cancel` | `--reason` | `cancel <runId>`, `keepWorktrees:false`, no reason | as-is |
| `pause` | `--reason` | `pause <runId> [reason words…]` | reason positional |
| `fix` | `retry --phase FIX` | `fix <runId>` → `controller.send('retry',{target:{kind:'phase',state:'FIX'}})` | `fix <runId>` |
| exit codes | 0 · 2 usage · 3 rejected · 4 pending | same (`result.status`) | FR-47 |
| `ApprovalRequest.cli` | `cohorte approve <id>` | same literal — **missing the runId the real CLI needs** | Francois builds its own hint |
| doctor `cohorteVersion` | real version | hard-coded `'3.0.0'` | take the version from `--version` |

## 3. User stories / flows

1. **Gate in a session (frame 25).** A session `orbit-api` ran `cohorte run auth-retry --detach`.
   Its transcript shows `Cohorte · run auth-retry --detach · run_7fa3c1` tool rows. The run reaches a
   pending approval. Within one poll the header gains an attention chip "Gate · needs your verdict" and
   a run chip `◂ run_7fa3c1`; an inline gate card appears under the last turn with the latest review's
   findings and **Approve · ship `1`**, **Send to fix `2`**, **Deny · stop run `3`**; the panel's
   Cohorte tab shows the compact gate and the phases. The user presses `1` (focus not in an editable
   field) → `cohorte approve <runId> <approvalId>` runs; the buttons show a busy state; on exit 0/4 the
   card closes as soon as `approval.resolved` is observed (or immediately on exit 0).
2. **Send to fix.** User types context in the composer, then clicks **Send to fix**: the core runs the
   FR-43 sequence; the card reports each step (`denied · fix requested`, or Cohorte's refusal).
3. **Deny · stop run.** `3` arms an inline confirm ("Deny and cancel run_7fa3c1? `3`/Enter confirm ·
   Esc back"); confirming runs `deny` then `cancel`.
4. **Run view (frame 26).** Clicking the run chip, **Open run**, a roster run row, or palette
   "Cohorte: Open run" opens the main-pane tab `cohorte:<runId>`: header with Back, phase timeline,
   steps table, findings / artifacts / snapshot cards, command bar. Back (or `Esc` with no editable
   focus) returns to the session tab that was showing.
5. **Settings · Cohorte (frames 27/28).** Settings → PROJECT → **Cohorte** (dot green when detected).
   Detected: detection card with doctor rows + **Run doctor**; four switches; gate policy. Not detected:
   empty state with **Run cohorte init** (primary), **Check again**, **Cohorte docs**.
6. **Background.** With the window unfocused the watcher slows down (FR-17); with **Notify when a run
   reaches a gate** on, a desktop notification fires once per gate.

## 4. Functional requirements

Every FR is tagged **[core]** or **[front]**. The two agents build in parallel against
`contract/cohorte-integration.ts`; nothing in a [front] FR requires a core change beyond the contract,
and vice versa.

### 4.1 Core — module & wiring

- **FR-1 [core]** New module directory `src-tauri/src/cohorte/`: `mod.rs` (serde mirrors of every
  contract type; `CohorteState` held in Tauri managed state; `EVENT_CHANNEL =
  "francois://cohorte/event"`), `detect.rs`, `cli.rs` (argv builders + runner + exit mapping),
  `wire.rs` (envelope parse + normalisation + sanitiser), `documents.rs` (status/doctor/config
  parsers), `projection.rs` (run reducer, gate + actions, finding labels), `watcher.rs` (poll loops,
  dedupe, HWM, log ring, emission), `commands.rs` (the 14 Tauri commands of `CohorteCommandMap`),
  `#[cfg(test)] mod testutil` (fixtures). Each file ≤1000 lines with its own `mod tests`. Register the
  commands in `lib.rs`. Add the ten `COHORTE_*` variants to `ipc/error_code.rs` (`ErrorCode`, `ALL`,
  `as_str`) — the parity test `rust_enum_matches_the_contract_union` is red until this lands.
- **FR-1a [core]** Every Cohorte spawn goes through one function `cli::run(host, root, argv, timeout,
  cap)` built on `github::gh::run_routed("cohorte", …)` (login-shell PATH via `process_util::spawn`,
  `CREATE_NO_WINDOW`, bounded, WSL-routed). No other code path spawns `cohorte`. `cwd` is always the
  Cohorte `root` (dev.8 `status` requires `<cwd>/.cohorte/project.yaml`).
- **FR-1b [core]** Francois never opens a file under `<root>/.cohorte/` for writing and never reads a
  file there except the existence checks of FR-2 (`stat` only). A unit test greps the module for
  `.cohorte` path joins and asserts each is under an allow-list (`project.yaml`, `state/cohorte.db`
  stat-only).

### 4.2 Core — detection (`cohorte_detect`)

- **FR-2 [core]** `detect(startDir)`:
  1. Normalise `startDir`; missing or not a directory → `state:'no-project'`.
  2. Walk up from `startDir` (inclusive) to the filesystem root; the first ancestor `A` with a
     directory `A/.cohorte` wins (`foundVia:'walk-up'`) — **except** the user's home directory, which
     only counts when `~/.cohorte/project.yaml` exists (`~/.cohorte/` is Cohorte's user config layer,
     not a project).
  3. Else run `git rev-parse --path-format=absolute --git-common-dir` in `startDir` (routed, 5 s);
     when it prints a path ending in `/.git`, its parent `M` (the main checkout) is tested for
     `M/.cohorte` (`foundVia:'git-common-dir'`). This is how a session in a linked worktree (e.g.
     `../orbit-auth-retry`) finds the main checkout's `.cohorte/` — the same resolution Cohorte uses
     for its store (DESIGN §2.4, brief "State").
  4. Not found → `state:'not-initialised'`; the CLI is still probed (frame 28 needs it for init).
  5. Found → `root`, `dir = root/.cohorte`, `hasProjectFile` (`stat root/.cohorte/project.yaml`),
     `stateBackend` (`'sqlite'` iff `root/.cohorte/state/cohorte.db` exists, else `null`),
     `rootBranch` (`git rev-parse --abbrev-ref HEAD` in root; `HEAD`/failure → `null`).
- **FR-3 [core]** State precedence when `.cohorte/` is found: CLI unresolvable → `cli-missing`;
  version outside range → `cli-incompatible`; else `detected`. `detected` additionally reads
  `runtime` from `cohorte config get` (FR-15) — a failure there leaves `runtime` absent, never
  changes the state.
- **FR-4 [core]** CLI probe: `cohorte --version` (5 s), stdout trimmed, first token matching semver.
  Cached per host dialect (native / each WSL distro) for 5 minutes; `force` bypasses it.
  Spawn failure → `installed:false`.
- **FR-5 [core]** Supported range `>=3.0.0-dev.1 <4.0.0` (semver with prerelease ordering; 2.x is the
  retired V2 runtime → incompatible). `supportedRange` is reported verbatim.
- **FR-6 [core]** Host routing: a `startDir` that `wsl::` classifies as a WSL path runs `git` and
  `cohorte` through `wsl.exe -d <distro> --cd <dir> -- …` exactly as github-page does; all paths in
  results are reported in the host dialect Francois uses for that project.
- **FR-7 [core]** Detection results are cached 30 s per normalised `startDir`; `force:true` bypasses.
  When a result differs from the last one emitted for that `startDir` (state, root, cli.version,
  hasProjectFile), emit `francois.detection.changed`.

### 4.3 Core — doctor, policy, init

- **FR-10 [core]** `cohorte_doctor(root)`: `cohorte doctor --json` (30 s, 4 MiB) → parse
  `DoctorReport` (`checks[{id,status,summary,detail?,remediation?}]`, `ok`); exit 1 with a parseable
  report is **not** an error (doctor exits 1 when a check errors). Then `cohorte config validate`
  (10 s): exit 0 → row status `ok`, summary `.cohorte/config.yaml valid`; exit 1 → `error`, summary =
  sanitised stdout/stderr first line. `rows` = `[cohorte doctor (aggregate: "<n> checks passed · <w>
  warnings[ · <e> errors]"), cohorte config validate, then one row "cohorte doctor · <id>" per check
  whose status is not ok/skipped]`. `cohorteVersion` comes from the cached `--version`, not the report.
- **FR-11 [core]** `cohorte_policy(root)`: `cohorte config get` (10 s) → JSON of `config.yaml`.
  `gatedSteps` = `['ship']` unless `policy.approvals.ship === 'auto'`, then one label per rule in
  `policy.dangerousCommands` and `policy.commands.ask` (label = rule's program + first positional /
  subcommand when present, e.g. `git push`, `npm publish`; duplicates removed, order kept), then
  `network access` when `network.provisioning === true`. `unattended` = `policy.approvals.unattended`.
  `file = '.cohorte/config.yaml'`. Unparseable → `COHORTE_OUTPUT_INVALID`.
- **FR-12 [core]** `cohorte_init(projectRoot)`: refuses (`INVALID_INPUT`) when `projectRoot` already
  resolves a Cohorte root; requires the CLI (`COHORTE_CLI_MISSING` / `_INCOMPATIBLE`). Runs `cohorte
  init` with cwd `projectRoot` (60 s). Non-zero exit → `COHORTE_COMMAND_FAILED` (detail: code, stderr
  tail ≤2 KiB). Success → forced re-detect, returned and emitted.

### 4.4 Core — the watcher

- **FR-14 [core]** Status parsing accepts, in order: (a) an object with `documentVersion: 1` →
  `ProjectStatusDocument` / `RunSnapshotDocument` (schemas/project-status, run-state); (b) a JSON
  array → dev.8 `RunRecord[]`; (c) an object with `runId` + `state` and no `documentVersion` → dev.8
  `RunRecord`. Anything else → `COHORTE_OUTPUT_INVALID`. All RFC3339 strings → epoch ms; an
  unparseable timestamp → field absent (never 0). Unknown fields ignored; unknown enum values kept as
  strings (`Open<>`).
- **FR-15 [core]** `cohorte_watch({roots, foreground})` is declarative: the core starts a watcher for
  each new root, keeps the rest, and schedules removed roots for stop after a **30 s linger** (a quick
  project switch back does not restart cold). `roots: []` → all linger out. Idempotent.
- **FR-16 [core]** One watcher task per root, one `status --json` spawn at a time per root, and at most
  **one tail spawn in flight per root** (runs are tailed round-robin). Global cap: 4 concurrent
  Cohorte spawns across all roots; mutating commands (FR-41..) bypass the read queue but are
  serialised **per run**.
- **FR-17 [core]** Intervals (from the end of the previous poll):

  | Poll | Foreground | Background (`foreground:false`) |
  |---|---|---|
  | project `status --json`, ≥1 non-terminal run | 3 s | 30 s |
  | project `status --json`, no non-terminal run | 15 s | 60 s |
  | `tail <run>`, run view ∈ running | 2 s | 15 s |
  | `tail <run>`, view ∈ gate/waiting/paused/auth/quota | 5 s | 30 s |
  | `tail <run>`, run terminal | once after the terminal state is first seen, then never | same |

  Terminal = COMPLETED/CANCELLED; FAILED/BLOCKED are polled like suspended (they are resumable).
  After any command Francois issues (FR-41..), the affected run gets an immediate status + tail.
- **FR-18 [core]** Backoff: a failed poll (spawn failure, timeout, exit ≠ 0, invalid output) doubles
  that poll's interval up to 60 s; the next success resets it. Detection is re-run (forced) after 3
  consecutive `COHORTE_CLI_MISSING` failures; a root whose detection is no longer `detected` stops
  polling until the next `cohorte_watch`/`cohorte_detect(force)`.
- **FR-19 [core]** Emit `francois.watch.status` when a root's health flips (healthy ↔ failing) with the
  `AppError` code/message and `nextPollInMs`; not on every poll.
- **FR-20 [core]** Tail: argv `tail <runId> --json --since-seq <hwm>` (the flags are ignored by dev.8
  and honoured by a later version; both are safe). Each stdout line is parsed independently; a line
  that is not a JSON object is skipped (counted, logged at debug). Order lines by `(sequence, sub)`,
  **never** by timestamp. Dedupe key `(runId, sequence, sub)` with a per-run high-water mark `hwm` =
  highest durable `sequence` folded; durable lines with `sequence ≤ hwm` are dropped; ephemeral lines
  (`sub > 0`) are dropped when `sequence < hwm` (stale) and deduped by `(sequence, sub)` within one
  dump. A durable gap (`sequence > hwm + 1`) is logged and tolerated (the next dump fills it). When a
  dump returns ≥1000 durable lines and none is above `hwm`, set `tailTruncated:true` (dev.8 caps the
  dump at 1000); status polling still drives run state.
- **FR-21 [core]** Backfill: the **first** dump of a run (hwm = 0) is folded into the projection
  silently — one `francois.run.updated` is emitted, and the entries go to the log ring, but **no**
  per-event wire emission (avoids a 1000-event IPC burst). Every later event is folded **and** emitted
  as its `CohorteEvent` member.
- **FR-22 [core]** Coalescing (ephemeral only, within one dump): `agent.message.delta` merged per
  `(runId, messageId, channel)` into one member whose `delta` is the concatenation capped at 8 KiB
  (tail kept) and `coalesced` = number merged; `tool.progress` → only the last per `toolCallId`;
  `heartbeat` → never emitted as wire, only folded (host liveness) — and forwarded once when
  `hostAlive` flips; `snapshot` → document folded, emitted with `lastSequence` only.
- **FR-23 [core]** Derived events, emitted after the wire events of the same poll:
  `francois.run.updated` (whenever the projection's serialised form changed — whole `CohorteRun`),
  `francois.run.removed` (a runId present before is absent from a successful project status),
  `francois.gate.opened` (edge: an approvalId becomes the run's gate — once per approvalId, also on
  backfill), `francois.gate.resolved` (the gate's approvalId got `approval.resolved`, or vanished from
  a status that lists pending approvals → `decision:'unknown'`), `francois.detection.changed` (FR-7),
  `francois.watch.status` (FR-19).
- **FR-24 [core]** `CohorteRun.view`: a known pending approval → `gate`; else by state: active
  states → `running`; `WAITING_APPROVAL` → `waiting`; `PAUSED` → `paused`; `AUTH_REQUIRED` → `auth`;
  `QUOTA_EXCEEDED` → `quota`; `FAILED` → `failed`; `BLOCKED` → `blocked`; `COMPLETED` → `completed`;
  `CANCELLED` → `cancelled`; `IDLE` → `idle`; unknown → `running`. `currentPhase` = active state, or
  `resumeTo` while suspended/halted. `host.alive` = snapshot `run.host.alive` when present, else
  heartbeat/attached/detached events, else (`RunRecord`) `hostHeartbeatAt` within 45 s (3 × Cohorte's
  15 s heartbeat) — a non-terminal run with `alive:false` is "host not running" (FR-83).
- **FR-25 [core]** Phases: from `RunSnapshotDocument.phases` when present (table order, pending
  included); otherwise the profile's table order — `feature`: BRAINSTORM SPEC PREFLIGHT BUILD TEST
  REVIEW FIX SHIP, dropping BRAINSTORM/SPEC when the first `phase.started` is PREFLIGHT; `bugfix`:
  PREFLIGHT..SHIP; `review`: REVIEW, plus FIX/TEST once either is started; unknown profile: the
  phases seen, in first-seen order. Label = PhaseNode.label or title-cased state. FIX may run several
  iterations: the phase shows the latest phase run; steps accumulate across iterations with
  `attempt`/`incarnation` kept.
- **FR-26 [core]** Log ring: every accepted wire event (backfill included) appends a
  `CohorteLogEntry` to a per-run ring of 500; `cohorte_run_log` returns the newest `limit` oldest-first.
  In memory only; dropped 10 min after the run leaves every watched root.
- **FR-27 [core]** Sanitiser (DESIGN §2.3.6), applied to **every** agent-controlled or free-text
  string that crosses IPC (summary, finding texts, preview, reason, messages, delta, error messages,
  check names, labels): remove C0 (U+0000–U+001F) except `\n` in `preview`/`delta`, DEL, C1
  (U+007F–U+009F), bidi overrides (U+202A–U+202E, U+2066–U+2069); collapse to NFC; cap each field
  (summary 200, title 160, preview 4 KiB, message 2 KiB, delta 8 KiB) with `truncated` where the
  contract has one. Ids are validated against `^[a-z]+_[A-Za-z0-9_]+$` before being put in an argv
  (anything else → `INVALID_INPUT`).

### 4.5 Core — the event binding (every catalogue type)

- **FR-28 [core]** `wire.rs` maps an envelope to exactly one `CohorteWireEvent` member: header
  (`projectRoot`, `runId`, `eventId`, `sequence`, `sub`, `durability`, `at` = ms of `timestamp`,
  `source`, `severity`, `summary`, `phase?`, `agent?`, `causationId?`) + the member's normalised
  payload as typed in the contract (dropped fields: sealed `args`, `normalizedArgs`, digests except
  `pinDigest`/`snapshotDigest`, context manifest entries, `commandAuth`, `redactions`, raw `result`).
  A type outside `COHORTE_WIRE_EVENT_TYPES`, or a known type whose required fields do not parse, or an
  envelope whose `protocolVersion` major ≠ 1, becomes `{type:'unknown', cohorteType, malformed}` —
  never an error, never dropped from the log. Event types are matched as exact strings.
- **FR-29 [core]** Projection effects — the core folds each member into `CohorteRun` as follows
  (anything not listed here only produces a log entry):

  | Event | Projection effect |
  |---|---|
  | `pipeline.started` | title/specId/specKind/profile/runtime/snapshotDigest/cohorteVersion/unattended; `git.baseBranch/baseSha/integrationBranch`; `startedAt` |
  | `pipeline.completed` | `endedAt`, `stop`, `git.integrationHead`, `usage` totals |
  | `pipeline.failed` | `state` (FAILED/BLOCKED), `lastError`, `stop` |
  | `run.state.changed` | `state`, `since`, `resumeTo`, `stop`; recompute `view`/`currentPhase` |
  | `run.paused` | steps of `parkedAgents` → `paused` |
  | `run.resumed`, `run.host.attached` | `host.alive = true` (+pid) |
  | `run.host.detached` | `host.alive = false` |
  | `run.cancelled` | `endedAt`; running/pending steps → `cancelled` |
  | `phase.started` | phase `running`, `startedAt`, `iteration`; seed `planned` agents as `pending` steps |
  | `phase.completed` | status ← outcome (passed→completed, failed→failed, needs-human→waiting-approval, skipped→skipped), `endedAt`, `durationMs`, `checks`; `outputs` → artifacts |
  | `check.completed` | append to the current phase's `checks` |
  | `error` | `lastError` |
  | `agent.declared` | create step (phase from header, `pending`) |
  | `agent.spawned` | step + `worktrees[]` get `worktree{path,branch}` |
  | `agent.started` | step `running`, `startedAt` |
  | `agent.state.changed` | step `lifecycle`; status: running/spawning/retrying/escalated→running, waiting→waiting-approval if the agent has a pending approval else running, paused→paused, completed→completed, failed→failed, cancelled→cancelled |
  | `agent.completed` | step status (completed→completed, failed→failed, blocked→blocked, needs-input→waiting-approval), `endedAt`, `durationMs`, `summary`, `findings`; report artifacts |
  | `agent.failed` | step `lastError`; status failed unless `willRetry` |
  | `model.responded` | add `tokens`/`cost` to `usage` |
  | `file.written` / `tool.completed.filesTouched` | diff artifact: distinct paths + summed `diffStat` |
  | `review.started` | open a new `review` round (findings `[]`, `startedAt`) |
  | `review.finding` | push the finding (disposition recorded; `refuted`/`duplicate` kept out of `findings`) |
  | `review.completed` | round `verdict`, `blocking`, `counts`, `clean`; relabel findings (FR-40) |
  | `review.approved` | round `verdict = 'approved'` |
  | `approval.requested` | add to pending approvals; step `pendingApprovalId`; recompute `gate` |
  | `approval.resolved` | remove from pending; recompute `gate`; emit `gate.resolved` |
  | `git.worktree.created` / `.removed` | `worktrees[]` add / mark `removed` |
  | `git.merge.completed` | `integrationHead = mergeSha` when `into == integrationBranch` |
  | `snapshot` | overlay the embedded document (phases, host, approvals, usage) |
  | `heartbeat` | `host.alive`, `host.heartbeatAt = at` |

  Pending approvals are the union of (a) status' `pendingApprovals`/`approvals.pending`
  (`ApprovalView`) and (b) `approval.requested` without a matching `approval.resolved`. An
  `ApprovalView` without its request event yields `view:'gate'` only once its request event is seen;
  until then `view:'waiting'` (the card needs `allowedDecisions`/`options`).

### 4.6 Core — gates and actions

- **FR-39 [core]** The run's **gate** = the oldest pending approval (by `requestedAt`); `morePending` =
  the others. `findings` = the latest review round's findings **iff** `kind ∈ {ship, review-leftovers,
  contract-change, loop-stalled}` and that round started after the previous `approval.resolved` of the
  run (else `[]`). `phaseIndex` = 1-based index of `request.phase.state` in `phases`; `phaseCount =
  phases.length`.
- **FR-40 [core]** Finding labels: `blocking = true` iff the finding's `id` is in the round's
  `review.completed.blockingItems`; **before** `review.completed` arrives, or when `blockingItems` is
  empty while `blocking > 0` (ids not matched), fall back to `severity ∈ {critical, major}`. `label` =
  `blocking` when `blocking`, else `minor` for `minor|major|critical`, `nit` for `info`. `title` =
  sanitised `actual` (≤160) — the one-line statement of the defect —, falling back to `rule`.
  Ordering: blocking first, then critical > major > minor > info, then event order.
- **FR-41 [core]** Actions are computed by the core so the hint is the exact argv (display form
  `cohorte <args joined by space>`, full ids):
  - `approve` — offered iff `allowedDecisions` contains `allow-once`. Steps: `approve <runId> <approvalId>`.
  - `fix` — offered iff the gate has ≥1 finding (FR-39) **and** the run's phases include FIX.
  - `deny` — offered iff `allowedDecisions` contains `deny`. `stopsRun = true` iff `kind ∈ {ship,
    review-leftovers, contract-change, loop-stalled, budget, spec-not-ready, blocked-ack}` (run-level
    gates); `false` for `tool`, `shared-path`, `unowned-path`, `api-billing`, `provision-network` and
    **any unknown kind** (non-destructive default). Steps: `deny <runId> <approvalId>` (+ `cancel
    <runId>` when `stopsRun`).
- **FR-42 [core]** `cohorte_approve`: validates the approval is the run's pending one (else
  `COHORTE_GATE_NOT_PENDING` without spawning); `answer`, when given, must be one of
  `request.options` (else `INVALID_INPUT`) and is appended positionally. 15 s timeout.
- **FR-43 [core] "Send to fix" mapping.** Cohorte 3.0 has no single "send this gate to FIX" command:
  a FIX iteration is entered by the engine itself (feature.v1 `T11 REVIEW → FIX, review-findings`),
  and the explicit `cohorte fix <run>` (= `retry {target:{kind:'phase',state:'FIX'}}`, DESIGN §9 line
  2870; apps/cli/src/commands/fix/index.ts) is legal only from FAILED (DESIGN §2.5.1 command matrix:
  `retry` × *suspended → reject "use resume", × *active → reject `conflict/run-active`; T31).
  Therefore, in order:
  1. If `request.options` contains an entry matching `/\bfix\b/i` → `approve <runId> <approvalId>
     <that option>` (the Cohorte-native way to pick a branch of an `approval_request`, refs.ts
     `options` + commands.ts `approve.answer`). Done.
  2. Else `deny <runId> <approvalId>`; if that step is rejected, stop and return
     `COHORTE_REJECTED`. Then re-read status; **if the run is FAILED** run `fix <runId>`, otherwise
     record the fix step as `outcome:'skipped'` with message "Cohorte routes the findings after the
     denial" (after a denial the engine resumes via T30-approval and routes kept findings to FIX
     through T11 itself). A `fix` rejected with a `conflict/*` code is `outcome:'rejected'` in the
     steps but the response stays `ok`.
  `note` is not passed at 3.0.x (FR-45).
- **FR-44 [core] "Deny · stop run" mapping.** `deny` resolves the approval only — the command matrix
  says approve/deny "applies; may trigger T30", i.e. a denial can *resume* the run. Stopping requires
  `cancel` (T27, legal from every non-terminal state). So `cohorte_deny({stopRun:true})` = `deny
  <runId> <approvalId>` then, iff the deny step was completed or pending (exit 0/4), `cancel <runId>`.
  `stopRun:false` runs the deny only.
- **FR-45 [core]** Argv dialect `positional-3.0` (the only verified one) lives in one pure module
  (`cli.rs::argv`), unit-tested per verb: `approve <run> <apr> [answer]`, `deny <run> <apr>`, `fix
  <run>`, `pause <run> [reason…]`, `resume <run>`, `cancel <run>`, `tail <run> --json --since-seq
  <n>`, `status [<run>] --json`, `doctor --json`, `config validate`, `config get`, `init`,
  `--version`. Notes/reasons are only passed where this table says so.
- **FR-46 [core]** `cohorte_pause | cohorte_resume | cohorte_cancel` run the single verb (15 s).
  Pre-checks without spawning: run unknown → `COHORTE_RUN_NOT_FOUND`; terminal run →
  `COHORTE_REJECTED` (message "run is <state>").
- **FR-47 [core]** Exit mapping per step: 0 → `completed`; 4 → `pending` (**not an error**: the inbox
  is durable, the watcher picks the outcome up); 3 → `rejected` with `message`/`errorCode` from the
  `CommandResultDocument` on stdout (`error.message`, `error.code`) — when it is the **first** step the
  whole call returns `COHORTE_REJECTED`, when a later step it is reported in `steps` and the call is
  `ok`; 2 → `COHORTE_COMMAND_FAILED` ("usage", a Francois bug); timeout → `COHORTE_TIMEOUT` (the
  command may still land — the next poll reflects it); other codes → `COHORTE_COMMAND_FAILED`. A
  rejection whose message says the approval is not pending (`conflict/unexpected` + "not pending") →
  `COHORTE_GATE_NOT_PENDING`. After every call the run is re-read (status + tail) and returned in
  `run`.
- **FR-48 [core]** `cohorte_list_runs(root)` returns the projections (sorted: non-terminal first,
  then `startedAt` desc); root not watched → performs one status + tail round first. `cohorte_get_run`
  forces a refresh of that run; unknown → `COHORTE_RUN_NOT_FOUND`.

### 4.7 Frontend — store, API, linkage

- **FR-50 [front]** `src/lib/api.ts`: one typed wrapper per `CohorteCommandMap` entry
  (`cohorteDetect`, …, `cohorteCancel`) and `listenCohorte(cb)` over `COHORTE_EVENT_CHANNEL`.
- **FR-51 [front]** `src/lib/cohorteStore.ts` (standalone zustand store, like
  `notificationsStore`): `detections: Record<startDir, CohorteDetection>`, `runs: Record<runId,
  CohorteRun>`, `logs: Record<runId, CohorteLogEntry[]>` (fetched lazily), `busy: Record<runId,
  CohorteGateActionId | 'pause' | 'resume' | 'cancel' | null>`, `lastOutcome: Record<runId,
  CohorteCommandOutcome>`, `explicitLinks: Record<SessionId, runId[]>`, `prefs: CohortePrefs`, and an
  `apply(event: CohorteEvent)` reducer with an **exhaustive switch over `CohorteEvent['type']`**
  (default branch `const _: never`). Wire members append a `CohorteLogEntry` to `logs[runId]` when
  that run's log is loaded; derived members replace (`run.updated` replaces the whole run — never
  merge), delete (`run.removed`), or update detections. Unit-tested: every member type handled.
- **FR-52 [front]** `useCohorteWatch()` (mounted once in App): computes the watched root set = the
  roots of `detected` detections for (a) the active project's root, (b) every open session's cwd in
  the current project scope; calls `cohorte_watch({roots, foreground})` on change (debounced 500 ms),
  with `foreground = document.visibilityState === 'visible' && document.hasFocus()`. Detection is
  requested (`cohorte_detect`) for the active project root with `force:true` on every project switch
  (frame 28: "re-checks on every project switch") and for each new session cwd (unforced, cached).
  After a root is first watched, `cohorte_list_runs(root)` hydrates the store.
- **FR-30 [front] Run ↔ session mapping** — pure `src/features/cohorte/linkage.ts`, unit-tested.
  Cohorte has no session id; for each session `S` and each run `R` in the same Cohorte root (the root
  detected for `S.cwd`), the first rule that matches decides, in this precedence:
  1. **launched** (`origin`): `S`'s transcript contains a Bash tool call whose command's first
     program is `cohorte` (also `npx cohorte`) with verb `run|loop|build|fix|review` and whose result
     text contains `R.runId` (or its first 10 chars). Recorded into `explicitLinks` by the transcript
     tool-row renderer (FR-66) — in memory, rebuilt on hydration.
  2. **worktree** (`step`): normalised `S.cwd` equals a `R.worktrees[].path` (removed or not) or a
     step's `worktree.path` (case-insensitive on Windows/macOS, `/` vs `\` normalised).
  3. **branch** (`step`): `S.worktree?.branch` equals `R.git.integrationBranch` or a `R.worktrees[].branch`.
  4. **base-branch** (`origin`): `S.cwd` equals the Cohorte root, `S.worktree` is absent, the root's
     `detection.rootBranch` equals `R.git.baseBranch`, and `R` is not terminal.
  A session links to **at most one** run: among matching runs, prefer the strongest rule, then a
  non-terminal run, then the latest `startedAt`. A run may link many sessions. The run's **origin
  session** (header chip, inline card, Needs-you) is its best `origin` link, falling back to its first
  `step` link; a run with neither has no session and surfaces only in the run view / roster run row.
- **FR-53 [front]** Prefs (`CohortePrefs`) persist to `localStorage` under `COHORTE_PREF_KEYS`
  (guarded read/write like notificationsStore; absent/malformed → `COHORTE_PREF_DEFAULTS`). They are
  app-wide Francois preferences, shown on each project's Cohorte page; **never** written to `.cohorte/`.

### 4.8 Frontend — frame 25 (gate in a session)

- **FR-60 [front] Header chips** (`SessionHeader`, beside the name): when the active session has a
  linked run, render `CohorteRunChip` (20px, `--bg-raised`, radius 4, padding-x 7, gap 6; Cohorte mark
  7.5px + short id `run_` + first 6 hex in Mono Small `--text-secondary`; title = full id + title;
  click → run view). When the run's `view` is `gate`, a **state chip** "Gate · needs your verdict"
  (attention variant) **replaces** the session's status pill; `paused` → "Run paused" (neutral),
  `auth` → "Cohorte needs login" (attention), `quota` → "Cohorte quota reached" (attention),
  `failed`/`blocked` → "Run failed"/"Run blocked" (danger) — these four sit beside the status pill
  instead of replacing it. `running`/`completed`/`cancelled`/`idle`/`waiting` → run chip only.
- **FR-61 [front] Inline gate card** `GateCard variant="full"` rendered by `ConversationView` in the
  trailing slot after the last turn (same slot as a pending permission card, never persisted into the
  transcript), for the run's **origin session** only, while `run.gate` is non-null. Content per §8:
  head (approval glyph · `COHORTE GATE · <KIND LABEL>` · Tag `phase i of n` when `phaseIndex` ·
  spacer · `waiting <relative>` live), question, findings list (dot · title · `file:line` · label;
  none → the list is omitted and `request.reason` shows as a Small muted line; `preview` of kind
  `command`/`diff` shows in a Mono block capped at 8 lines with "show more"), `+N more pending` when
  `morePending`, actions, CLI hint = the `cli` lines of the **focused/hovered** action (default:
  `approve`'s), each line copyable on click.
- **FR-62 [front] Kind copy** (`gate-view.ts`, unit-tested):

  | kind | label | question | approve label |
  |---|---|---|---|
  | `ship` | SHIP APPROVAL | Ship `<spec>`? | Approve · ship |
  | `review-leftovers` | REVIEW VERDICT | Ship `<spec>`, or send it back to fix? | Approve · ship |
  | `contract-change` | CONTRACT CHANGE | A fix touches the contract. Allow it? | Approve |
  | `loop-stalled` | LOOP STALLED | The fix loop stopped making progress. Continue? | Approve · continue |
  | `budget` | BUDGET | The run hit a budget limit. Raise it and continue? | Approve · continue |
  | `spec-not-ready` | SPEC NOT READY | The spec is not ready to build. Proceed anyway? | Approve |
  | `tool` / `shared-path` / `unowned-path` / `provision-network` / `api-billing` | TOOL APPROVAL / SHARED PATH / UNOWNED PATH / NETWORK / API BILLING | `request.reason` | Allow once |
  | `blocked-ack` | BLOCKED | `request.reason` | Acknowledge |
  | other | the kind upper-cased, `-` → space | `request.reason` | Approve |

  Fix label "Send to fix"; deny label "Deny · stop run" when `stopsRun`, else "Deny". Buttons: approve
  = Attention md `1`, fix = Secondary md `2`, deny = Ghost md `3`; an action absent from
  `gate.actions` is not rendered and its digit does nothing.
- **FR-63 [front] Keyboard 1/2/3**: active while a gate card (inline or the run view header) is
  visible in the focused main pane **and** no editable element (input, textarea, contenteditable,
  xterm) has focus; also when focus is inside the card. `3` on a `stopsRun` deny arms an inline
  confirm (card footer: "Deny and cancel `<short id>`? · `3`/Enter confirm · Esc back") — a second `3`
  or Enter confirms. While `busy[runId]` is set the buttons are disabled with a spinner on the pressed
  one; digits are ignored.
- **FR-64 [front] Composer**: while the origin session's run has a gate, the composer placeholder is
  "Answer the gate above, or add context for the fix step…". Sending stays a normal Claude turn. When
  **Send to fix** is pressed with a non-empty draft, the draft is passed as `note` and **kept** in the
  composer (3.0.x drops notes, FR-45) with a toast "Cohorte 3.0 does not take a note — your text stays
  in the composer".
- **FR-65 [front] Outcome feedback**: after a command, the card shows one line per
  `CohorteCommandStep` (`✓ completed` / `… pending — Cohorte will apply it` / `✕ rejected: <message>` /
  `– skipped: <message>`) for 8 s or until the gate resolves. `COHORTE_GATE_NOT_PENDING` → toast
  "Already answered elsewhere" and a `cohorte_get_run` refresh. `COHORTE_TIMEOUT` → "Cohorte did not
  answer in time — it may still apply the command" (warning), no retry.
- **FR-66 [front] Transcript tool rows**: a Bash tool call whose command's first program is `cohorte`
  (or `npx cohorte`) renders verb **Cohorte** (Mono Medium `--text-primary`), target = the rest of
  the command, meta = `<runId short>` when the result contains `run_[0-9a-f]{6,32}` (records the
  `launched` link, FR-30) or the existing meta otherwise. Every other tool row is unchanged.
- **FR-67 [front] Session panel Cohorte tab**: `SESSION_PANEL_TABS` gains `'cohorte'` (last).
  `SessionPanelSection` gains optional `visible?(session): boolean` and `Icon?: ComponentType` +
  `showLabel?: boolean`; `resolveSection` skips invisible sections. The Cohorte entry is visible iff
  `prefs.showPanelTab` and the session's cwd has a `detected` detection. The tab shows the mark 12.25px
  + "Cohorte" (the only labelled tab). Body `CohortePanelSection`:
  - linked run → run header (spec name UI Strong + Tag `<specKind> spec` when known · row 2 glyph +
    summary + short id), compact `GateCard variant="compact"` when a gate, phases list, footer
    (runtime line `<runtime.id> runtime · snapshot pinned` when `pinDigest`, digest = first 6 of
    `snapshotDigest`; buttons **Open run** (Secondary, flex 1) · **Tail logs** (Ghost) · **Pause** /
    **Resume** (Ghost, by `view`)).
  - no linked run → `EmptyPane` "No Cohorte run for this session" + the three most recent runs of
    the root as rows (click → run view).
  - Summary line (row 2) from real state (resolves the mock inconsistency): `gate` → "Waiting at the
    `<kind label lower>` gate"; `running` → `<verb> · phase i of n` with verbs Brainstorming · Writing
    spec · Preflight · Building · Testing · Reviewing · Fixing · Shipping; `paused` → "Paused";
    `auth` → "Needs login"; `quota` → "Quota reached"; `failed`/`blocked` → "Failed"/"Blocked" +
    `stop.reason`; `completed` → "Shipped" (or "Completed" when `stop.reason ≠ review-clean`);
    `cancelled` → "Cancelled"; `waiting` → "Waiting for approval".
- **FR-68 [front] Phases list** (panel): label row `PHASES` + `<done count> / <n>`; one block per
  phase, the current one `--bg-raised`; glyph by status (completed → done, running → running,
  waiting-approval → approval, failed/blocked → danger x, pending/skipped/cancelled → hollow); meta:
  running phase → live elapsed `mm:ss` in `--state-running`; gate phase → "waiting"; completed →
  duration `m:ss`; pending → "—". Steps (indent 21): glyph · label · right meta = linked session name
  (a session linked to that step's worktree, FR-30 rule 2) else nothing.
- **FR-69 [front] Tail logs**: toggles the panel body to the run's activity log (fetch
  `cohorte_run_log(limit 200)`, then live-append from wire events): rows `hh:mm:ss · type · summary`,
  severity-tinted (warning/error), auto-scroll unless scrolled up; header "Back to run" + copyable
  `cohorte tail <runId> --json`; `tailTruncated` → notice "Cohorte 3.0 shows the first 1000 events".

### 4.9 Frontend — frame 26 (run view)

- **FR-70 [front] Placement**: a dynamic main tab `cohorte:<runId>` — added to `MainTab` as
  `` `cohorte:${string}` `` like `ext:` (not session-scoped: it survives a session switch; not in
  `agentTabs`). `mainPaneBranch` returns a new `'cohorte'` branch; `hostedTab('cohorte') = null`;
  `MainPaneBody` renders `<CohorteRunView key={runId} runId={runId} />`. `App.tsx` hides the
  `SessionHeader` on this branch (the run header replaces it, like the agent drill-in) and **keeps the
  session panel** (frame 26). No new tab chip in the session header; the roster is left as the user
  had it (the mock's rail is not forced). Back returns to the tab active before opening (stored in
  cohorteStore `returnTab`, default `'session'`). An unknown runId shows `EmptyPane` "Run not found"
  with Back.
- **FR-71 [front] Run header** per §8 (Back · breadcrumb `<project name> › Cohorte run` · spec name ·
  Tag · state chip (FR-60 wording; `running` → "Running · <verb>") · `<short id> · <elapsed> ·
  <runtime.id>` · buttons: Approve / Send to fix (only with a gate, FR-41 availability) · Pause or
  Resume (by view; hidden when terminal) · Cancel (hidden when terminal; confirm modal "Cancel `<short
  id>`? Cohorte stops every agent and removes the run's worktrees." — dev.8 cancels with
  `keepWorktrees:false`)). Keyboard 1/2/3 as FR-63.
- **FR-72 [front] Phase timeline**: one equal column per phase (gap 4): 4px bar (completed
  `--state-success`, running `--state-running`, waiting-approval/gate `--state-attention`,
  failed/blocked `--state-danger`, else `--bg-strong`), glyph + name + meta (as FR-68, without live
  seconds: `done` / `waiting` / elapsed / `—`).
- **FR-73 [front] Steps table**: every step of every phase in phase order then `startedAt`; columns
  Step (label) · Agent (role; surface in title) · Session (linked session name in `--state-info`,
  click → `setActiveSessionId` + tab session; else `—`) · Duration (`m:ss`, live for running) · State
  (glyph + Done/Running/Pending/Failed/Waiting/Paused/Cancelled/Blocked/Skipped). Empty → "No steps
  yet".
- **FR-74 [front] Side cards**: **REVIEW · N FINDINGS** (latest round, compact rows, no file:line;
  footer: gate present → "Verdict pending — approve to ship, or send back to fix."; `clean` → "Review
  clean."; otherwise the verdict) — hidden when no round; **ARTIFACTS** (rows from `run.artifacts`,
  icon `File`; the log row "`cohorte tail <short id>`" opens Tail logs in the panel; other rows are
  not clickable); **SNAPSHOT** (Runtime `<id> · pinned|unpinned`, Bundle first 6 of snapshotDigest,
  Policy = first two `gatedSteps` joined " + " prefixed "gates on " (from `cohorte_policy`, fetched
  once per root), footnote "Nothing changes provider mid-run.").
- **FR-75 [front] Command bar**: `SquareTerminal` icon · `cohorte status <runId> --json` (click
  copies, toast "Copied") · "Everything here maps to a CLI command".
- **FR-76 [front] Host not running**: a non-terminal run with `host.alive:false` shows a warning strip
  under the run header (and a line in the panel header): "Run host is not running — Cohorte restarts
  it on the next command." (Cohorte spawns a host on approve/resume when `policy.approvals.autoResume`,
  DESIGN §4.5.)

### 4.10 Frontend — frames 27/28 (Settings · Cohorte)

- **FR-80 [front]** `SettingsPage` gains `'cohorte'`; `isProjectPage('cohorte') = true`; the nav item
  is the last of the PROJECT group: 13px mark · "Cohorte" · 6px dot (`--state-success` when the
  project root's detection is `detected`, else `--text-faint`). Opening the page calls
  `cohorte_detect({startDir: project.root})` (cached) and, when detected, `cohorte_doctor` once per
  page open + `cohorte_policy`.
- **FR-81 [front] Detected (frame 27)**: header (`<project> / Cohorte`, 20px mark + "Cohorte", `dir`
  in Mono faint); detection card head: success badge, "Cohorte detected in this project", sub-line
  `.cohorte/ · cohorte <cli.version> · runtime <runtime> · state SQLite` (runtime/state segments
  omitted when unknown), state chip `doctor passed` (success) / `doctor: N warnings` (attention) /
  `doctor failed` (danger) / none while running, sm Secondary **Run doctor** (spinner while running).
  Check rows = `doctor.rows` (glyph by status: ok check success, warning triangle attention, error x
  danger, skipped hollow). `hasProjectFile:false` adds a warning row "`.cohorte/project.yaml` missing
  — run `cohorte init`". Then the four switches (FR-53, copy per §8), the gate-policy block (Tags =
  `gatedSteps`; head hint `cohorte config get`; note "Everything else runs unattended. Policy lives in
  .cohorte/config.yaml — François reads it, never edits it."), footer note.
- **FR-82 [front] Not detected (frame 28)**: sub-line "No .cohorte/ in `<root>`"; empty card per §8
  with **Run cohorte init** (Primary; disabled with title "Install Cohorte first: npm i -g cohorte"
  when `cli.installed:false`; busy while running; success → page flips to frame 27), **Check again**
  (`cohorte_detect force`), **Cohorte docs** (Ghost; opens `https://github.com/TheBidouilleAgency/cohorte#readme` (apps/cli/package.json `homepage`)
  through the existing external-link opener) and the meta line "Last checked `<relative checkedAt>` ·
  François re-checks on every project switch"; the "What turns on" card. `cli-missing` shows the same
  page as detected but the detection card head reads "Cohorte CLI not found" (danger badge) with
  `npm i -g cohorte`; `cli-incompatible` → "Cohorte `<version>` is not supported — Francois needs
  `<supportedRange>`" (attention).

### 4.11 Frontend — roster, notifications, palette, demo

- **FR-85 [front] Needs you** (`prefs.gatesInNeedsYou`): a run whose `view` is `gate` puts its origin
  session in the NEEDS YOU group (regardless of the session's own status) with an attention card:
  line 1 "Cohorte gate · `<kind label lower>`", line 2 the question (1 line, ellipsis), inline sm
  buttons for the offered actions (approve Attention, fix Secondary, deny Ghost — deny with
  `stopsRun` asks for a second click "Confirm"), and **Open** (→ run view). A gated run with **no**
  origin session in the current scope appears as a run row at the top of NEEDS YOU (mark + spec name
  + short id + the same card). Off → no roster change.
- **FR-86 [front] Group under run** (`prefs.groupSessionsUnderRun`): within one state group, a
  run's `step` sessions render directly after its origin session row, indented 16px, with a thin
  `--line-subtle` guide; step sessions in a different group than their origin stay in their own group
  and carry a Tag `<short id>`. Off → rows unchanged. (Not drawn in the mocks — this is the minimal
  reading of the toggle's copy.)
- **FR-87 [front] Notification** (`prefs.notifyOnGate`, default off): on `francois.gate.opened` (not
  during backfill of a run first seen >60 s after its gate opened), fire one OS notification per
  approvalId through the notifications feature's existing OS-notify path, title `Francois`, body
  "`<spec>` · Cohorte gate: `<kind label lower>`" — no agent text. Fires when the window is unfocused
  or the gate's origin session is not the visible one. Independent of the attention-class toggle.
- **FR-88 [front] Palette** (registered in `src/features/cohorte/cohortePaletteCommands.ts`, shown
  only when applicable to the active session's linked run, or the active project's detection):
  "Cohorte: Open run", "Cohorte: Approve gate", "Cohorte: Send gate to fix", "Cohorte: Deny gate"
  (asks the FR-63 confirm when `stopsRun`), "Cohorte: Pause run" / "Resume run", "Cohorte: Cancel
  run…" (confirm), "Cohorte: Show logs", "Cohorte: Run doctor", "Cohorte: Settings", "Cohorte: Check
  again".
- **FR-89 [front] Demo** (`VITE_FRANCOIS_DEMO=1`): `src/demo/cohorte-fixtures.ts` + cases in
  `demo.ts` for every `cohorte_*` command and the event channel: project **orbit** detected (cli
  `3.4.1`, runtime Pi, state SQLite, doctor 4 rows passed, gatedSteps `ship push db migrations
  network access secrets`), every other demo project not initialised; run `run_7fa3c1<26 hex>`
  (spec `auth-retry`, kind feature, phases as frame 26, gate kind `review-leftovers` with the four
  frame-25 findings, `phaseIndex 3` of 5); orbit-api's transcript carries the three Cohorte tool rows
  so the link is `launched`; the Settings page for orbit shows frame 27 and for any other project
  frame 28. Demo approve/fix/deny resolve the gate after 600 ms and loop the fixture back after 20 s.

## 5. API contract

Exact types: **`contract/cohorte-integration.ts`** (channels, projection, derived events) + **`contract/cohorte-events.ts`** (vocabulary, records, the event catalogue — split for the 1000-line cap) (authoritative; summarised here). Error codes are
members of `ErrorCode` in `contract/common.ts`.

| Channel | Tauri command | Request | `Result<T>` data | Errors |
|---|---|---|---|---|
| `francois:cohorte:detect` | `cohorte_detect` | `CohorteDetectRequest` | `CohorteDetection` | `INVALID_INPUT` |
| `francois:cohorte:doctor` | `cohorte_doctor` | `CohorteRootRequest` | `CohorteDoctorReport` | `COHORTE_NOT_DETECTED`, `COHORTE_CLI_MISSING`, `COHORTE_CLI_INCOMPATIBLE`, `COHORTE_TIMEOUT`, `COHORTE_OUTPUT_INVALID`, `COHORTE_OUTPUT_CAPPED` |
| `francois:cohorte:policy` | `cohorte_policy` | `CohorteRootRequest` | `CohortePolicySummary` | same as doctor |
| `francois:cohorte:init` | `cohorte_init` | `CohorteInitRequest` | `CohorteDetection` | `INVALID_INPUT`, `COHORTE_CLI_MISSING`, `COHORTE_CLI_INCOMPATIBLE`, `COHORTE_TIMEOUT`, `COHORTE_COMMAND_FAILED` |
| `francois:cohorte:watch` | `cohorte_watch` | `CohorteWatchRequest` | `null` | `INVALID_INPUT` |
| `francois:cohorte:listRuns` | `cohorte_list_runs` | `CohorteRootRequest` | `CohorteRun[]` | detection codes, `COHORTE_TIMEOUT`, `COHORTE_OUTPUT_INVALID`, `COHORTE_OUTPUT_CAPPED`, `COHORTE_COMMAND_FAILED` |
| `francois:cohorte:getRun` | `cohorte_get_run` | `CohorteRunRequest` | `CohorteRun` | + `COHORTE_RUN_NOT_FOUND` |
| `francois:cohorte:runLog` | `cohorte_run_log` | `CohorteRunLogRequest` | `CohorteLogEntry[]` | `COHORTE_RUN_NOT_FOUND` |
| `francois:cohorte:approve` | `cohorte_approve` | `CohorteApproveRequest` | `CohorteCommandOutcome` | `INVALID_INPUT`, `COHORTE_RUN_NOT_FOUND`, `COHORTE_GATE_NOT_PENDING`, `COHORTE_REJECTED`, `COHORTE_TIMEOUT`, `COHORTE_COMMAND_FAILED`, detection codes |
| `francois:cohorte:sendToFix` | `cohorte_send_to_fix` | `CohorteSendToFixRequest` | `CohorteCommandOutcome` | same as approve |
| `francois:cohorte:deny` | `cohorte_deny` | `CohorteDenyRequest` | `CohorteCommandOutcome` | same as approve |
| `francois:cohorte:pause` / `resume` / `cancel` | `cohorte_pause` / `cohorte_resume` / `cohorte_cancel` | `CohorteRunControlRequest` | `CohorteCommandOutcome` | `COHORTE_RUN_NOT_FOUND`, `COHORTE_REJECTED`, `COHORTE_TIMEOUT`, `COHORTE_COMMAND_FAILED`, detection codes |

Event stream `francois:cohorte:event` → Tauri `francois://cohorte/event`, payload `CohorteEvent` =
`CohorteWireEvent` (68 typed members, `type` = the Cohorte type string verbatim, plus `unknown`) |
`CohorteDerivedEvent` (`francois.detection.changed`, `francois.run.updated`, `francois.run.removed`,
`francois.gate.opened`, `francois.gate.resolved`, `francois.watch.status`).
`COHORTE_WIRE_EVENT_TYPES` lists the catalogue; two compile-time assertions prove it equals the union.

Detail shapes: `COHORTE_REJECTED` `{cli, cohorteCode, message}`; `COHORTE_TIMEOUT` `{cli, timeoutMs}`;
`COHORTE_OUTPUT_CAPPED` `{cli, capBytes}`; `COHORTE_COMMAND_FAILED` `{cli, code, stderr}` (stderr
sanitised, ≤2 KiB); `COHORTE_CLI_INCOMPATIBLE` `{version, supportedRange}`; `COHORTE_RUN_NOT_FOUND`
`{runId}`; `COHORTE_NOT_DETECTED` `{startDir}`.

### 5.1 UI binding of every event type (the "all events bound" contract)

"Log" = a `CohorteLogEntry` in the run's activity log (FR-69) — **every** member produces one.
"Run" = reflected through the next `francois.run.updated` (FR-29).

| Family | Types | UI effect beyond the log |
|---|---|---|
| run | `pipeline.started` | Run: title, spec, runtime/snapshot card, base/integration branch (linkage FR-30 rule 3/4) |
| | `pipeline.completed` | Run: state chip "Shipped"/"Completed", timeline all done, header buttons collapse to none |
| | `pipeline.failed` | Run: danger chip, `lastError.message` + `remediation` under the run header and in the panel |
| | `run.state.changed` | Run: state chip, panel summary, phase highlight, roster Needs-you membership, poll cadence |
| | `run.paused` / `run.resumed` | Run: Pause⇄Resume button, parked steps paused |
| | `run.cancelled` | Run: "Cancelled", steps cancelled, gate card removed |
| | `run.host.attached` / `run.host.detached` / `heartbeat` | Run: FR-76 host strip on/off |
| | `phase.started` / `phase.completed` | Run: timeline bar + phases list progression, live elapsed, planned steps appear |
| | `check.started` / `check.completed` | Run: check results under the phase (run view step table tooltip); failed check → log severity error |
| | `error` | Run: `lastError` line; `fatal` → danger styling |
| | `checkpoint.created` | log only |
| agent | `agent.declared` / `agent.spawned` / `agent.started` / `agent.state.changed` / `agent.completed` / `agent.failed` | Run: step rows (state glyph, duration, session link via worktree), `agent.failed` with `willRetry:false` → step danger + message |
| | `agent.turn.started` / `agent.turn.completed` / `agent.message.started` / `agent.message.completed` / `agent.message.accepted` | log only (message.completed shows its `preview` in the log row) |
| | `agent.message.delta` | coalesced (FR-22); log shows one row per coalesced burst (`+N chars`) |
| | `runtime.warning` | log (warning tint) |
| | `model.requested` / `model.responded` | Run: `usage` tokens/cost (snapshot card "Usage" line when cost known); `status:'error'` → log error |
| | `context.built` / `escalation.applied` | log only (escalation → warning tint) |
| tool | `tool.requested` / `tool.started` / `tool.progress` / `tool.completed` / `tool.rejected` | log only (`tool.progress` coalesced; `isError`/`timedOut` → error tint) |
| | `tool.denied` | log (warning); when `approvalId` is set the gate arrives via `approval.requested` |
| | `file.read` | log only |
| | `file.written` / `file.changed` | Run: diff artifact "diff · N files" `+a −d` |
| | `review.started` | Run: new review round (REVIEW card resets) |
| | `review.finding` | Run: finding accumulates in REVIEW card and the open gate card (FR-39/40) |
| | `review.completed` / `review.approved` | Run: blocking relabel, verdict footer |
| governance | `approval.requested` | Run: gate opens → header chip, inline card, panel compact card, Needs-you (pref), notification (pref) |
| | `approval.resolved` | Run: gate closes everywhere; actor shown in the outcome line when it was not this window |
| | `budget.updated` | log only |
| | `budget.exceeded` | log (warning); the resulting `budget` gate arrives as `approval.requested` |
| | `quota.updated` | log only |
| | `auth.required` | Run: `view:'auth'` via state; chip "Cohorte needs login"; panel line shows the event's `cli` hint (`cohorte auth login`) |
| | `retry.scheduled` | log (warning) |
| | `command.accepted` / `command.completed` | log only |
| | `command.rejected` | log (error); if its `commandId` equals one Francois issued in the last 60 s (from the `CommandResultDocument`), a toast "Cohorte rejected <type>: <message>" |
| git | `git.worktree.created` / `git.worktree.removed` | Run: `worktrees[]` → session linkage (FR-30 rule 2/3) |
| | `git.worktree.provisioned` / `git.commit.created` / `git.merge.completed` | log only (merge updates integrationHead) |
| | `git.worktree.quarantined` / `git.merge.conflicted` / `repo.change.detected` | log (error tint) |
| | `lock.acquired` / `lock.released` | log only |
| | `lock.stolen` | log (warning) |
| stream | `snapshot` | Run: whole projection refresh |
| — | `unknown` | log only (`type` = `cohorteType`, italic "unrecognised") |

## 6. Data & state

- **Core** (`CohorteState`, in memory, nothing persisted): detection cache (per startDir, 30 s),
  CLI probe cache (per host, 5 min), `watchers: HashMap<root, Watcher>` each holding `runs:
  HashMap<runId, RunProjection>` (projection + pending approvals + `hwm` + review rounds + log ring),
  the watch set + foreground flag, recent command ids (60 s, for `command.rejected` correlation).
  A projection is dropped 10 min after its root stops being watched.
- **Frontend**: `cohorteStore` (FR-51) in memory; prefs in `localStorage` (FR-53); the panel tab id
  persists via the existing `francois.sessionPanelTab` key (a persisted `'cohorte'` falls back to
  `changes` when the section is invisible).
- **Cohorte root** = the directory containing `.cohorte/` (the main checkout). Runs are keyed by
  `runId` (globally unique `run_<32hex>`); `projectRoot` travels with every run and event.
- **Derived**: short id = `run_` + first 6 hex; elapsed clocks live from `startedAt`/phase `startedAt`
  with the existing `useElapsedClock`.

## 7. Edge cases & errors

- **FR-90 cohorte absent**: no `.cohorte/` → no chips, no tab, no roster change, Settings frame 28;
  `.cohorte/` but CLI missing → Settings "CLI not found", watcher not started, tab hidden (no data).
- **FR-91 older/newer version**: < 3.0.0-dev.1 or ≥ 4 → `cli-incompatible`, nothing polled. A newer
  3.x whose documents or events carry unknown fields/types → parsed per FR-14/FR-28 (unknown kept).
- **FR-92 exit 3 rejected**: FR-47; the gate stays; message shown verbatim (sanitised).
- **FR-93 exit 4 pending**: step `pending`; UI shows "Cohorte will apply it"; buttons re-enable when
  the next poll shows the approval resolved or after 20 s (whichever first).
- **FR-94 timeout**: FR-47; a read timeout counts as a failed poll (FR-18).
- **FR-95 output cap**: reads 4 MiB, tail 8 MiB → `COHORTE_OUTPUT_CAPPED`. A capped tail dump is
  not folded at all (a cut dump cannot be trusted to be complete) → failed poll, backoff; status
  polling keeps the run state current meanwhile.
- **FR-96 host dead**: FR-76; commands still allowed (Cohorte may spawn a host).
- **FR-97 unknown event types / kinds / enum values**: `unknown` member / `Open<>` strings; unknown
  approval kind → generic copy (FR-62), non-destructive deny (FR-41).
- **FR-98 multiple runs per project**: all tracked; each session links to ≤1 (FR-30); the panel's
  "no linked run" list and the run view reach the others; Needs-you lists every gated run.
- **FR-99 several windows / several Francois instances** (Francois is single-window; a dev build can
  run beside the release one): reads are lock-free and SIGKILL-safe (Cohorte `direct-read` route), so
  concurrent pollers are harmless. Two instances answering the same gate: the second gets exit 3 "not
  pending" → `COHORTE_GATE_NOT_PENDING` → "Already answered elsewhere". A gate resolved by a terminal
  `cohorte approve` shows as `gate.resolved` with the human actor.
- **FR-100 project moved/removed**: detection `no-project`; watcher stops; runs dropped after linger.
- **FR-101 malformed tail line / broken status JSON**: skipped line / `COHORTE_OUTPUT_INVALID` failed
  poll (FR-18) with `francois.watch.status`; the UI keeps the last good projection and shows a faint
  "Cohorte not responding — retrying in Ns" line in the panel header.
- **FR-102 run removed** (gc): `run.removed` → run view "Run not found", links drop.
- **FR-103 a gate expires** (`expiresAt`): card shows "expires in …"; after expiry the actions stay
  enabled (Cohorte decides; `approval.resolved{expired}` closes it).
- **FR-104 ids / injection**: runIds/approvalIds validated (FR-27) before any argv; argv is never
  passed through a shell.

## 8. Design brief

Source: Figma `YEY4c6AiWq1bKYuaju9qdV` page `124:2` — frames and node ids in the table below; full
measurements, verbatim copy and per-element tokens are in **`.cohorte/design/cohorte-frames-brief.md`**
(§0 vocabulary, §1 frame 25, §2 frame 26, §3 frame 27, §4 frame 28), screenshots
`.cohorte/design/frame-25.png` … `frame-28.png`, mark `.cohorte/design/icon-cohorte.svg`. Light
twins are structurally identical (tokens only).

| Frame | Dark | Light | Key nodes |
|---|---|---|---|
| 25 Gate in a session | `154:14871` | `162:24872` | header `154:14876`, run chip `154:15444`, tool rows `154:15452`, gate card `154:15465`, panel tab `153:14818` / instance `154:14925` |
| 26 Run view | `156:15293` | `162:25368` | run header `156:15774`, timeline `156:15809`, columns `156:15850`, command bar `156:16001` |
| 27 Settings detected | `158:15589` | `162:25860` | nav item `158:15715` |
| 28 Settings not detected | `159:15655` | `162:26045` | — |

**Token mapping** (all exist in `src/styles.css` except where noted): surfaces `--bg-rail` (panel,
tool-group, side cards, toggle rows, command bar), `--bg-card` (detection card), `--bg-canvas`
(findings list), `--bg-raised` (Tag, run chip, current phase, selected tab), `--bg-selected` (nav
item), `--bg-strong` (pending bar), `--bg-terminal` (init code block); lines `--line-subtle` (all
1px rules), `--line-default` (Secondary button, Back); gate `--tint-attention` bg + `--tint-attention-line`
border, label `--state-attention-text`, chip `--tint-attention-strong`; success chip `--tint-success`
+ `--state-success-text`; severity dots/labels blocking `--state-danger`, minor `--state-info`, nit
`--text-faint`; running clock/steps `--state-running`; session links `--state-info`; text ramp
`--text-primary/secondary/muted/faint/disabled` (the raw hexes of the mock map per brief §0). Type
roles `--type-label` (+ `--tracking-label`), Mono Small/Mono/Mono Medium/Mono Code, Small/Small
Medium, UI/UI Medium/UI Strong, Title, Heading, Body per brief §0. **Two additions**: `--brand-cohorte:
#F5851F` is **not** added — the mark keeps its hex inside the SVG and is never recoloured (brief
§0); `--space-36` is not added — the Settings content reuses the existing Settings view padding
(literal 36px only if that view has none).

**New components** (all in `src/features/cohorte/`, styled by `cohorte.css`, BEM-lite `cohorte-*`):
`CohorteMark` (inline SVG, sizes 7.5/12.25/13/20px), `CohorteStateChip` (20px, glyph 11px +
Small Medium; variants attention/success/danger/neutral — reuse `Chip` if its geometry matches,
else a feature-local component), `CohorteRunChip`, `GateCard` (`full` 680 wide · `compact`),
`FindingRow` (`full` with file:line · `compact`), `CohortePanelSection` (+ phases list, footer,
log sub-view), `CohorteRunView` (+ `PhaseTimeline`, `StepsTable`, `ReviewCard`, `ArtifactsCard`,
`SnapshotCard`, `CommandBar`), `CohorteSettingsPage` (detected · not-detected). Reused primitives:
`Button` (attention/secondary/ghost/primary, md/sm, shortcut suffix), `Tag`, `StateIcon`, `Switch`,
`EmptyPane`, `SidePanel*`, lucide `ChevronLeft`, `ChevronRight`, `File`, `SquareTerminal`, `Lock`,
`Check`, `X`, `TriangleAlert`.

**States not drawn** (decided here): doctor warning/error rows (FR-81), failed/blocked/cancelled
phase bars and step states (FR-72/73), paused/auth/quota/failed chips (FR-60), host-dead strip
(FR-76), Deny confirm (FR-63), roster gate card and run nesting (FR-85/86), the "no linked run"
panel (FR-67), CLI-missing/incompatible Settings heads (FR-82). All compose existing tokens; no
new colour. Motion: running glyph spinner (existing), no other animation. Resize: gate card max-width
680, shrinks with the transcript column; the run view's side column 360 fixed, steps table
horizontally scrolls below 720px main width.

## 9. Acceptance criteria

Core (`cargo test` in `src-tauri`):
- [ ] AC-1 (FR-28, §5.1) A fixture with **one NDJSON envelope per catalogue type (68)** normalises each
  into the member whose `type` equals it — none becomes `unknown` — and each yields one log entry.
- [ ] AC-2 (FR-28) An envelope of type `foo.bar`, one with a known type but a missing required payload
  field, and one with `protocolVersion: "2.0"` become `unknown` (`malformed` true/true/false) without error.
- [ ] AC-3 (FR-20/21) Two consecutive dumps of the same 1000 lines emit zero wire events on the second;
  a third dump with 3 new durable lines emits exactly those 3, in `(sequence, sub)` order even when the
  lines arrive shuffled; the first dump emits no wire event and exactly one `francois.run.updated`.
- [ ] AC-4 (FR-22) 50 `agent.message.delta` lines for one message coalesce into one member with
  `coalesced: 50`; 10 `tool.progress` for one call → the last one only.
- [ ] AC-5 (FR-14) `status --json` fixtures in all three shapes (ProjectStatusDocument, `RunRecord[]`,
  `RunRecord`) parse; ISO timestamps become epoch ms; an unparseable timestamp leaves the field absent.
- [ ] AC-6 (FR-2/3) Temp-dir tests: walk-up finds `.cohorte/` two levels up; a linked worktree resolves
  the main checkout's `.cohorte/` via git-common-dir; `~/.cohorte` without project.yaml is ignored;
  CLI stub missing → `cli-missing`; stub printing `2.4.0` → `cli-incompatible`; `3.0.0-dev.8` → `detected`.
- [ ] AC-7 (FR-41/43/44/45) Argv builders: approve/deny/fix/pause/resume/cancel/tail/status produce the
  exact positional argv of §2.3; a runId with a space or `;` is `INVALID_INPUT`.
- [ ] AC-8 (FR-43) With a stub CLI: options `["ship","send to fix"]` → one `approve … "send to fix"` step;
  no options + run WAITING_APPROVAL after deny → steps `deny completed`, `fix skipped`; run FAILED
  after deny → `fix` runs; deny exit 3 → `COHORTE_REJECTED` and no second spawn.
- [ ] AC-9 (FR-44) `stopRun:true` runs deny then cancel; deny exit 3 → no cancel; `stopRun:false` → deny only.
- [ ] AC-10 (FR-47) Exit 4 → `pending` and `ok`; exit 3 on a later step → `ok` with that step
  `rejected`; exit 2 → `COHORTE_COMMAND_FAILED`; stub sleeping past the deadline → `COHORTE_TIMEOUT`;
  "not pending" rejection → `COHORTE_GATE_NOT_PENDING`.
- [ ] AC-11 (FR-40) Findings with `blockingItems` matching ids label from them; without `review.completed`
  critical/major → blocking; info → nit.
- [ ] AC-12 (FR-27) The sanitiser strips C0/C1/bidi controls and caps lengths; a finding with an ANSI
  escape renders without it.
- [ ] AC-13 (FR-17/18) Scheduler unit tests (fake clock): intervals per table; failure doubles to 60 s
  and resets on success; background multiplies as specified; linger stops a root after 30 s.
- [ ] AC-14 (FR-1b) No write under `.cohorte/` anywhere in `src-tauri/src/cohorte/` (allow-list test).
- [ ] AC-15 (FR-1) `rust_enum_matches_the_contract_union` passes with the ten `COHORTE_*` codes.

Frontend (`npm test`):
- [ ] AC-20 (FR-51) The store reducer handles every `CohorteEvent['type']` (exhaustive switch; a test
  iterates `COHORTE_WIRE_EVENT_TYPES` + the six derived types).
- [ ] AC-21 (FR-30) Linkage table tests for all four rules, the precedence, ≤1 run per session, the
  terminal/non-terminal tie-break and Windows path normalisation.
- [ ] AC-22 (FR-62) Kind → label/question/approve-label, including an unknown kind.
- [ ] AC-23 (FR-67/68) Panel summary line and phase meta for every `CohorteRunView`.
- [ ] AC-24 (FR-53) Prefs load defaults when storage is empty/malformed/unavailable and round-trip.
- [ ] AC-25 (FR-66) Tool-row classification: `cohorte run auth-retry --detach` → verb Cohorte, meta
  short id; `npx cohorte status` → Cohorte; `git status` → unchanged.
- [ ] AC-26 (FR-70) `mainPaneBranch('cohorte:run_x') === 'cohorte'`, `hostedTab('cohorte') === null`,
  the session header is hidden and the session panel shown on that branch.

Manual / demo (`VITE_FRANCOIS_DEMO=1`, dark and light):
- [ ] AC-30 Frame 25 matches: header chips, three Cohorte tool rows, inline gate card with 4 findings and
  1/2/3, composer placeholder, panel Cohorte tab with compact gate, phases and footer.
- [ ] AC-31 Frame 26 matches via the run chip and via Open run; Back returns to the session.
- [ ] AC-32 Frame 27 for orbit (green nav dot, doctor rows, switches, policy); frame 28 for another project.
- [ ] AC-33 Pressing `1` with the composer focused types "1"; with focus on the transcript it approves;
  `3` asks for the confirm first.
- [ ] AC-34 Turning each switch off removes, respectively: the panel tab; the Needs-you gate row; the
  nesting; the notification.
- [ ] AC-35 Against a real Cohorte ≥3.0.0-dev.1 project: detection, a run appearing within one poll,
  approve from the card resolving the gate, and no file under `.cohorte/` modified by Francois
  (`git status --ignored .cohorte` before/after, excluding Cohorte's own state writes).

## Remediation

### Round 1 — 2026-09-23 (reviewer: core FIX, frontend FIX)

Amendments the lead made to the frozen spec/contract for this round:
- **Native Windows is in scope** — the non-goal is withdrawn: the user runs Cohorte natively on Windows,
  where `cohorte` is an npm `.cmd` shim (e.g. `C:\nvm4w\nodejs\cohorte.cmd`). **FR-6b [core]**: a native
  (non-WSL) root spawns cohorte through `process_util::resolve_cli_program` (the resolver claude/grok use:
  handles `.cmd` shims, `CREATE_NO_WINDOW`). WSL roots keep FR-6. Argument passing must be safe on the
  `.cmd` path too (cmd.exe metacharacters in agent/user text — apply the R-2 allowlist).
- Contract: `command.rejected` gains `issuedByFrancois: boolean` (R-4).

Core:
- **R-1 [BLOCKING]** Terminal runs (COMPLETED/CANCELLED/FAILED) never carry a gate: `to_run` builds no gate when
  terminal; on `run.cancelled` / `pipeline.completed` / `pipeline.failed`, and on a status showing a terminal
  state, clear pending approvals and emit `francois.gate.resolved` for each; backfill never re-emits
  `gate.opened` for a terminal run. Test: `approval.requested` then `run.cancelled` → `gate == null`.
- **R-2 [MAJOR]** WSL argv must not pass through a shell: `wsl.exe -d <distro> --cd <dir> --exec bash -lc 'exec cohorte "$@"' _ <args…>`
  (login shell so nvm-installed node/cohorte resolve; args as separate values — also fixes R-3). Defence in
  depth: reject approve answers / pause-cancel reasons outside `^[A-Za-z0-9 ._,:/'-]+$` with `INVALID_INPUT`.
- **R-3 [MAJOR]** Covered by R-2 (login-shell PATH inside the distro).
- **R-4 [MAJOR]** Keep a 60 s cache of commandIds Francois issued (from the CLI's command result where available,
  else match commandType + runId inside the window) and set `issuedByFrancois` on `command.rejected`.
- **R-5 [MAJOR]** `watcher.rs` `refresh_run`: no indexing panic (`get` → `COHORTE_RUN_NOT_FOUND`); a slot created by
  refresh survives one status cycle; no path leaves a poisoned mutex / `thread_running` stuck.
- **R-6 [MAJOR]** Tail scheduling: non-terminal runs first (sort key `(terminal, next_tail_at)`); terminal runs
  backfilled lazily; `op_list_runs` returns after status alone and the thread backfills.
- **R-7 [MAJOR, from frontend M1]** Claude Code Bash blocks never expose the output, so FR-30 rule 1 never fires.
  In `session/tools.rs` (Bash meta), when the command invokes `cohorte` and the result contains
  `run_[0-9a-f]{6,32}`, the block meta carries `started run_<id>` so the existing frontend parser works for
  Claude Code sessions. Test against real `meta_bash` output.
- **R-8 [MINOR]** dev.8 tail prints through `sanitizeHuman`: rewrite `\xHH` → `\u00HH` before JSON parse; an
  unparseable line is logged to the run log as a parse warning, never silently skipped.
- **R-9 [MINOR]** Compare status `lastSequence` with hwm to set `tailTruncated`; events never overwrite the state
  of a newer status.
- **R-10 [MINOR]** Put `--` before free text (or drop words starting with `-`); shell-quote display hints that
  contain whitespace; don't cache a timed-out `--version` probe; exit decision + `thread_running` write under
  the watch_set lock; `next_status_at` from end-of-poll time; RAII guard for the read slot.
- **R-11 [MINOR]** Parse test with the real dev.1 `cohorte doctor --json` output at
  `.cohorte/design/real-doctor-dev1.json` (copy it into a test fixture).

Frontend:
- **R-12 [MAJOR, M2]** Gate keys: ignore `e.repeat`; while the deny confirm is armed, Enter on a focused
  button / link / `[role=button]` passes through to that control.
- **R-13 [MAJOR, M3]** Runs whose `projectRoot` leaves the watch set are pruned (runs, logs, busy, outcomes)
  after the same 30 s linger; roster / Needs-you / palette only consider watched roots.
- **R-14 [MAJOR, M4]** Toast `Cohorte rejected <commandType>: <message>` on `command.rejected` when
  `issuedByFrancois`.
- **R-15 [MAJOR, M5]** `approval.resolved` by another actor (not this window's last command) → an
  `Answered by <actor> · <decision>` line for ~6 s in the panel header and the run view.
- **R-16 [MINOR]** auth.required renders the event's own `cli`; `panelLogRunId` keyed by session; buffer events
  that arrive while a log fetch is in flight; Settings doctor race guard (root it started for); "Cohorte:
  Settings" works when Settings is already open; clear `lastOutcome` on gate resolved; `COHORTE_TIMEOUT` toast
  is a warning; no fallback to `gate.request.cli` (build `cohorte approve <runId> <approvalId>` or show nothing);
  split `cohorte.css` under 1000 lines.
