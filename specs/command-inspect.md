---
id: command-inspect
title: Command inspect — open a transcript step to see what actually ran
status: shipped
branch: feat/command-inspect
created: 2026-08-25
depends_on: [conversation-view, session-engine, transcript-scale, durable-sessions, multi-provider-seam, shell-terminal, multiple-shells, wsl-filesystem]
reviewed_base: 55386f631ffc20c034e5c757c23a3087d930631c
reviewed_digest: 2e27e05317476729
design_files: ["https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html"]
---

# Command inspect — open a transcript step to see what actually ran

## 1. Summary

A tool row in the SESSION transcript is a summary: `Bash npm test · 14 failed` says a command failed
and nothing about why. The exact invocation, the working directory, the runtime it ran under, the
timings and the output all pass through the core's stream reader — which derives `summary` and `meta`
from them (`session/tools.rs`) and **discards the rest**. This feature keeps that record and gives it
a surface: clicking a tool row unfolds it **in place**, inside the step rail, directly beneath the row
that owns it (design turn **16a**). The transcript stays one document read top to bottom; closing
returns it to the exact height it had. The record is written to a per-session sidecar at capture time
and fetched lazily by `blockId` on open, so the transcript's hot path — paging the folded block
sequence (transcript-scale) — is untouched.

## 2. Goals & non-goals

**Goals**

- Capture, per settled tool step: tool, cwd, runtime (+ distro), start/end, error state, the exact
  input, and a tail-biased slice of the output with its **true** pre-cap totals.
- `Bash` unfolds the full 16a shell block: header · `$` command line · folded output.
- Every other tool unfolds the same chrome with a **generic** body (pretty-printed input JSON).
- `copy` the exact invocation; `shell ↗` hands it to the SHELL tab **prefilled, not executed**.
- All four runtimes populate a record; fields a runtime cannot state are absent and do not render.

**Non-goals**

- **A per-tool rich renderer** — no diff hunk for `Edit`/`Write`, no file preview for `Read`. The
  mock's "an Edit step unfolds with a diff hunk" is deferred; `Edit` gets the generic body. The
  intraline-emphasis machinery lives in `diff-navigator` and stays there.
- **`re-run`** — the mock's third `$`-line action. A record is read-only; `shell ↗` carries the
  intent and leaves the user as the one who presses Enter.
- **A docked inspector, a step cursor, `j`/`k`** — that is design **16b**, the variant not chosen.
- **Any keyboard path at all** — open and close are mouse-only (FR-19). No `⏎`, no `esc`.
- **Detail in agent tabs / workflow-details** — their transcripts are in-memory and never persisted,
  so they have no record and their rows stay inert (FR-8).
- **Backfilling existing sessions** — a step captured before this feature has no record and no
  chevron (FR-12).

## 3. User stories / flows

1. **Why did it fail.** A `Bash npm test · 14 failed` row carries a chevron. The user clicks it. The
   row keeps its summary, its chevron rotates, and a block opens beneath it: a header reading
   `bash · D:\acme-api · wsl · Ubuntu-22.04 · 12:06:41 · 4.2s · failed`, then the command alone on a
   `$` line, then `output · 214 lines · 8.1 KB`, folded to its tail — the part that explains the exit.
   The user reads the fourteen identical module errors and clicks the row shut.
2. **Read the whole log.** `187 earlier lines folded · show all` expands the slice in full. If lines
   were dropped at capture the strip says so instead of pretending.
3. **Take it to a shell.** `shell ↗` switches the main pane to SHELL, ensures a shell for the session,
   and writes the command into it **without a newline**. The user edits it and presses Enter himself.
4. **Copy it.** `copy` puts the invocation, byte for byte, on the clipboard.
5. **A non-Bash step.** Clicking an `Edit src/routes/index.ts` row opens the same chrome with the
   tool's whole input as pretty JSON, and the result slice below it.
6. **Compare two failures.** Opening a second step leaves the first open. Both stay open until
   clicked shut, the session is switched, or the app restarts.
7. **An old session.** Its tool rows have no chevron and do not respond to a click — exactly as today.

## 4. Functional requirements

### Capture (core)

- **FR-1**: when a tool block settles (its `tool_result` arrives — `session/stream/tool_results.rs`),
  the core appends one JSON object to the sidecar `transcripts/<sessionId>.details.jsonl`, shaped as
  `StepDetail` (§5). Append-only; on read, the **last** line for a `blockId` wins.
- **FR-2**: `cwd`, `runtime` and `distro` are read from the session at capture time — `distro` only
  when `runtime === 'wsl'` and the cwd parses as a WSL UNC path (`wslUncToLinux`, wsl-filesystem);
  absent otherwise. `startedAt` is when the `tool_use` was seen, `endedAt` when the `tool_result` was.
- **FR-3**: `body.kind` is `'command'` for a tool whose input IS a command line — `Bash` and
  `PowerShell`, which share the `command` + `description` input shape — and `'generic'` for every
  other tool, known or not.
  `'command'` takes `command` (and `description` when the input carried one) **verbatim** — never
  re-quoted, re-escaped or normalized. The `description` renders in the record's header (design
  brief §2), not on the `$` line. `'generic'` takes the whole tool input, pretty-printed and
  truncated to 4000 chars — the same rule `PermissionAsk.inputJson` already uses.
- **FR-4**: `isError` is the `tool_result`'s `is_error` (absent ⇒ `false`). `exitCode` is set **only**
  when the runtime states one in a structured wire field; the claude-code adapter never sets it, so
  its steps read `failed` rather than `exit 1` (stated departure, §8).
- **FR-5**: `output.text` is the **tail** of the result, cut on a line boundary at 64 KB.
  `totalLines` and `totalBytes` count the **full** result as produced, and `droppedLines` is
  `totalLines − lines(text)`. A result at or under the cap yields `droppedLines: 0`.
- **FR-6**: `output.stderrLines` is set only by a runtime that separates the streams. Claude Code
  merges them into one `tool_result` text, so it is absent for claude-code sessions.
- **FR-7**: the sidecar is swept with the transcript it shadows — when a session's transcript file is
  removed, its `.details.jsonl` goes with it, and a sidecar with no transcript is removed on load.
  Nothing else reads or writes the file.
- **FR-8**: per-agent (`agent-tab`) and workflow (`workflow-details`) transcripts capture nothing:
  they are in-memory by construction, so their tool rows carry no `hasDetail` and never expand.
- **FR-9**: all four adapters (`claude-code`, `codex`, `grok`, `francois`/openai) capture. An adapter
  fills what its wire format carries; every optional field it cannot state is **absent**, and the
  panel omits the corresponding element rather than rendering a placeholder.
- **FR-10**: `ToolConversationBlock` gains `hasDetail?: boolean`, set `true` iff FR-1 wrote a record
  for that block; the `tool.done` event carries the same flag. This is the **only** thing the record
  adds to the transcript's hot path — the record itself never rides an event or a `TranscriptPage`.
- **FR-11**: new IPC `francois:conversation:stepDetail` (§5) resolves one `StepDetail` by
  `(sessionId, blockId)`. It reads the sidecar and returns; it never blocks on a turn. Unknown
  session ⇒ `SESSION_NOT_FOUND`; no record for that `blockId` ⇒ `STEP_DETAIL_NOT_FOUND`.

### Panel (frontend)

- **FR-12**: a tool row renders a chevron and becomes clickable **iff** `hasDetail === true`. A row
  without it is byte-identical to today — no chevron, no cursor change, no click handler. This is
  what makes a pre-feature session's rows inert, with no "unavailable" state to render.
- **FR-13**: clicking an eligible row toggles it. On first open the frontend calls `stepDetail`; the
  row shows a one-line loading state until it resolves, and the record is memoized per `blockId` for
  the session's lifetime (a settled step is immutable — never re-fetched).
- **FR-14**: the record renders **inside the step rail**, immediately after its own row, as a sibling
  in the same column — the rail's vertical line runs unbroken past it. It is never a modal, an
  overlay, or a portal.
- **FR-15**: the header carries, in order and each omitted when absent: the tool name **lowercased**,
  `cwd`, `runtime`+`distro` (`wsl · Ubuntu-22.04`; nothing when `native`), the wall-clock time of
  `startedAt`, the duration `endedAt − startedAt`, and the outcome — `exit N` when `exitCode` is
  known, `failed` when `isError` without one, and nothing when the step succeeded.
- **FR-16**: `'command'` body — the invocation alone on a `$` line, wrapping, followed by `copy` and
  `shell ↗`. `copy` writes `command` verbatim to the clipboard. `shell ↗` switches the main pane to
  SHELL, calls `shell:ensure` for the session, and `shell:write`s `command` **with no trailing
  newline**; it never executes. `'generic'` body — `inputJson` in place of the `$` line, no actions.
- **FR-17**: the output strip states `output · {totalLines} lines · {totalBytes}` and, when
  `stderrLines` is present and non-zero, `{n} on stderr`. The body shows the **last 15 lines** of
  `text`. When more remain, a footer reads `{n} earlier lines folded · show all`; `show all` reveals
  the whole of `text` and does not toggle back. When `droppedLines > 0` the footer instead reads
  `{droppedLines} lines dropped at capture · show all` — the panel never presents a capped slice as
  complete. An empty `output.text` renders no strip and no body.
- **FR-18**: any number of steps may be open at once. Open state is frontend-only, keyed by
  `blockId`, per session — cleared on session switch and never persisted, so a reopened session shows
  no expanded steps.
- **FR-19**: open and close are **click-only**. The row is not focusable, takes no `Enter`, and `Esc`
  does not close a record. The rotated chevron is the sole close affordance.
- **FR-20**: a `stepDetail` that resolves an error replaces the loading line with one dim sentence in
  the row's place; the row stays open so the user can close it. No toast, no notification.

## 5. API contract

Contract file: `contract/command-inspect.ts`. Two existing files are **amended** rather than
duplicated (decision 2026-08-04 · api): `contract/conversation-view.ts` for FR-10's block flag, and
`contract/common.ts` for the `tool.done` flag and the new error code.

```ts
// contract/command-inspect.ts
import type { BlockId, ClaudeRuntime, Result, SessionId } from './common';

// ---------- francois:conversation:stepDetail (request/response) ----------
// Tauri command `conversation_step_detail`.
export interface StepDetailPayload {
  sessionId: SessionId;
  blockId: BlockId;
}

/** The command line of a Bash step (FR-3) — verbatim, never re-quoted. */
export interface StepCommand {
  command: string;
  /** The tool input's own `description`, when it carried one. */
  description?: string;
}

/** The captured slice of a step's result (FR-5/FR-6). */
export interface StepOutput {
  /** Tail-biased slice actually kept, cut on a line boundary at 64 KB. '' when the step was silent. */
  text: string;
  /** TRUE totals of the result as produced — NOT the slice's (FR-5). */
  totalLines: number;
  totalBytes: number;
  /** totalLines − lines(text). 0 ⇒ `text` is the complete result. */
  droppedLines: number;
  /** Only from a runtime that separates the streams; absent for claude-code (FR-6). */
  stderrLines?: number;
}

export type StepBody =
  | { kind: 'command'; command: StepCommand; output: StepOutput }
  /** `inputJson`: the whole tool input, pretty JSON, truncated to 4000 chars (FR-3). */
  | { kind: 'generic'; inputJson: string; output: StepOutput };

export interface StepDetail {
  blockId: BlockId;
  /** Verbatim tool name, e.g. 'Bash'. The header chip renders it lowercased (FR-15). */
  tool: string;
  cwd: string;
  runtime: ClaudeRuntime;
  /** WSL only, derived from the cwd (FR-2). */
  distro?: string;
  startedAt: number; // epoch ms
  endedAt?: number; // absent only if the record was written without one
  isError: boolean;
  /** Only when the runtime states one structurally; never for claude-code (FR-4). */
  exitCode?: number;
  body: StepBody;
}

// errors: SESSION_NOT_FOUND | STEP_DETAIL_NOT_FOUND
export type StepDetailResponse = Result<StepDetail>;
```

**Amendments**

```ts
// contract/conversation-view.ts — ToolConversationBlock gains (FR-10):
  /** true ⇒ a StepDetail record exists; the row is expandable. Absent on every
   *  block captured before command-inspect, and on agent/workflow blocks (FR-8). */
  hasDetail?: boolean;

// contract/common.ts — SessionEvent 'tool.done' gains the same optional flag:
  | { type: 'tool.done'; sessionId: SessionId; blockId: BlockId; meta: string; hasDetail?: boolean }

// contract/common.ts — ErrorCode gains:
  | 'STEP_DETAIL_NOT_FOUND' // command-inspect FR-11: no record for that blockId (never captured, or swept)
```

No new event stream: the record is pulled, never pushed (FR-10).

## 6. Data & state

**Core** — one append-only sidecar per session, `transcripts/<sessionId>.details.jsonl`, one
`StepDetail` per line, written at FR-1 and read at FR-11 (last line per `blockId` wins). It is
derived, disposable data: deleting it costs the chevrons on that session's old rows and nothing else.
Path validation reuses `valid_session_id` (persistence.rs), so a session id can never escape the
transcripts dir. No new in-memory core state — capture writes straight through.

**Frontend** — per-session, in-memory only, never persisted (FR-18): the set of open `blockId`s, the
set of `blockId`s whose output is fully expanded (`show all`), and a `blockId → StepDetail` memo.
All three are dropped on session switch.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| Step captured before this feature | No `hasDetail`, no chevron, row inert (FR-12) |
| Sidecar deleted between render and click | `STEP_DETAIL_NOT_FOUND` → FR-20's dim sentence, row stays open |
| Sidecar unreadable / a corrupt line | That line is skipped; a `blockId` with no surviving line is `STEP_DETAIL_NOT_FOUND` |
| Step produced no output | `output.text === ''`, `totalLines: 0` — no strip, no body (FR-17) |
| Result larger than 64 KB | Tail kept, `droppedLines > 0`, footer says lines were dropped at capture (FR-17) |
| Tool input is not an object / unparseable | `'generic'` body with the value pretty-printed as-is; never a capture failure |
| Session running while the row is open | Nothing re-fetches — a settled step is immutable (FR-13) |
| Row evicted from the block buffer while open | The row unmounts with the transcript; its open state is dropped with it |
| `shell ↗` when the shell cap is reached | `shell:ensure` returns its own error; surfaced as FR-20's dim sentence |
| `runtime: 'native'` | No runtime segment in the header at all (FR-15) |

## 8. Design brief

Design turn **16a** ("Unfolds in place") in `Francois Redesign.dc.html` — the chosen variant; **16b**
(docked inspector) is explicitly not built. The open row keeps its summary and gains a rotated
chevron; the record hangs directly beneath it inside the step rail, so the fold never breaks the
reading order, and closing restores the transcript's exact height. One header carries everything that
is *not* the command; the command sits alone on a `$` line with its actions; the output is folded to
the tail with the totals called out.

Three stated departures from the mock, each forced by what the runtimes actually report or by FR-19:
the outcome chip reads `failed` rather than `exit 1` for claude-code sessions (FR-4); the
`12 on stderr` chip is absent unless the runtime separates the streams (FR-6); and the footer's
`esc to close` hint is dropped, since there is no keyboard path — the rotated chevron carries it.

> full brief: `specs/design/command-inspect.md`

## 9. Acceptance criteria

- [ ] A `Bash` row in a live session gains a chevron; clicking it unfolds the record in place, inside
      the rail, and clicking again restores the transcript's previous height. (FR-12, FR-13, FR-14)
- [ ] The header shows tool, cwd, runtime+distro on WSL, wall clock, duration and outcome, omitting
      each segment whose field is absent. (FR-15, FR-2)
- [ ] The `$` line shows the invocation byte-for-byte as sent; `copy` puts exactly that on the
      clipboard. (FR-3, FR-16)
- [ ] `shell ↗` opens the SHELL tab with the command prefilled and **not executed** — the prompt still
      awaits Enter. (FR-16)
- [ ] A >64 KB result renders the true `totalLines`/`totalBytes`, folds to the last 15 lines, and its
      footer says lines were dropped at capture; `show all` reveals everything kept. (FR-5, FR-17)
- [ ] An `Edit` row unfolds the same chrome with its input as pretty JSON. (FR-3, FR-16)
- [ ] A tool row in a session created before this feature has no chevron and ignores clicks. (FR-12)
- [ ] Two steps can be open at once; both close on session switch and none is open after a restart. (FR-18)
- [ ] No key opens or closes a record — `Enter` and `Esc` do what they did before. (FR-19)
- [ ] A tool row in an agent tab or workflow-details has no chevron. (FR-8)
- [x] `cargo test`: a `tool_result` round-trips through capture to a sidecar line matching `StepDetail`,
      for each of the four adapters, with absent fields absent. (FR-1, FR-9)
- [x] `npm test`: the panel's fold/`show all`/dropped-lines logic and the header's omit-when-absent
      rules are covered as pure functions. (FR-15, FR-17)

## Remediation

### 2026-08-25 — cohorte-loop round 1

- 2026-08-25 — 1 finding, all fixed (CRITICAL · conversation-blocks.ts · `hasDetail` dropped by the
  `tool.done` handler; now threaded through action, reducer and event mapper, with reducer tests)

### 2026-08-25 — /cohorte-fix (SHIP report)

- 2026-08-25 — 1 finding, all fixed (MEDIUM · step_detail.rs · `compute_output`'s tail-cut went empty
  when the cap window held no newline; now falls back to the raw window verbatim, with a regression test)

### 2026-08-26 — /cohorte-fix (REVIEW REPORT, round 2)

- 2026-08-26 — 5 findings, all fixed (CRITICAL · StepDetailPanel.tsx · `shell ↗` targeted pane 0 via
  the global store; now a required `onOpenShell` prop threaded `ConversationView → Turn → Block →
  ToolRail → ToolRow → StepDetailPanel`, supplied by `MainPaneBody` (`setMainTab`) and `SplitPane`
  (`onTab`) · HIGH · openai/runner.rs · capture-building extracted into the pure `openai_step_detail`
  helper, covered by two field-exact Bash/Read tests · MEDIUM · Block.tsx · fetch side effects moved
  out of the `setOpen` functional updater · MEDIUM · StepDetailPanel.tsx + conversation.css ·
  `stepHeaderSegments` replaced by `stepHeaderGroups` rendering tagged left/right spans with the
  outcome tint and `margin-left:auto` · MEDIUM · step_detail.rs · `build_body`'s generic truncation
  now delegates to `permissions::input_json`, `GENERIC_INPUT_CAP_CHARS` dropped)

### 2026-08-26 — /cohorte-fix (REVIEW REPORT, round 3)

- 2026-08-26 — 7 findings, all fixed (HIGH · openai/runner.rs · `resolve_and_run` now returns
  `Option<(String, bool)>` so a `GateDecision::Deny` / parked `PermissionDecision::Deny` threads
  `is_error: true` into `openai_step_detail`, with a denial test · MEDIUM · MainPaneBody.tsx +
  SplitPane.tsx · `onOpenShell` wrapped in `useCallback`, restoring the Turn/Block/ToolRow memo bail ·
  MEDIUM · conversation.css · `.step-detail` radius + `overflow: hidden` dropped (Flat 9a) · MEDIUM ·
  conversation.css · `.step-detail__cmd`/`__json` moved `--bg-panel` → `--bg-canvas`, restoring the
  tonal order under the `--bg-deep` header · MEDIUM · codex/runner.rs + grok/runner.rs · pure
  `codex_step_detail`/`grok_step_detail` extracted out of `apply()`, each with field-exact Bash +
  generic tests, closing the 4-of-4-adapters criterion · LOW · Block.tsx · comment reworded to the
  real FR-8 guarantee (`hasDetail` is never set on agent-tab/workflow lone rows, regardless of
  `sessionId`) · LOW · step_detail.rs · `#[allow(clippy::too_many_arguments)]` now carries its
  why/clears-when comment)

### 2026-08-26 — design-fidelity pass against turn 16a

Three departures from the mock, found by reading the built surface next to it:

- **The disclosure opened a second row.** `.toolrow` declares four grid columns; `ToolRow` rendered
  the chevron as a fifth child, so auto-placement wrapped it onto an implicit second row — under the
  glyph, and making an expandable row taller than an inert one. The chips and the disclosure now
  share one `.toolrow__meta` cell, and the grid is `grid-auto-flow: column` so an extra child can
  only ever spill sideways. (design brief §1)
- **Captured output was set as prose, not as terminal output.** The body now carries the SHELL tab's
  own metrics — `--font-mono`, 12.5px, the new `--terminal-line-height` token (1.35, the number
  `ShellTerminal.tsx` hands xterm), `tab-size: 8`, foreground `--text-bright` — so a log keeps the
  columns it was written with. The generic input-JSON band follows the same metrics. Neither band
  scrolls horizontally: both are `pre-wrap`, so a line too wide for the record wraps rather than
  hiding behind a scrollbar the reader has no reason to suspect. (design brief §2, §Responsive)
- **Escape sequences rendered as litter.** A step's output is raw bytes; the mock's coloured failure
  markers are what the tool's own SGR codes produce. `features/conversation/ansi.ts` resolves them
  onto the same sixteen tokens `features/shell/xterm-theme.ts` hands xterm (`.ansi-*` in
  conversation.css), swallows non-SGR CSI/OSC sequences, and treats `\r` as the line rewrite a cursor
  return is — so a progress bar reads as its last frame rather than as every frame. 18 unit tests.
  (design brief §2)

### 2026-08-26 — PowerShell steps + the input's description

- **PowerShell steps rendered as JSON.** `build_body` keyed the `'command'` body off `tool == "Bash"`
  alone, so on Windows — where every shell step is a `PowerShell` step — no shell step ever got the
  `$` line, the copy action or the `shell ↗` hand-off. The check is now a `COMMAND_TOOLS` set
  (`Bash`, `PowerShell`): the two tools share the `command` + `description` input shape, and a
  malformed call to either still falls back to `'generic'`. (FR-3)
- **The captured `description` was never rendered.** `StepCommand.description` has been in the
  contract and the capture since the feature shipped, and nothing read it. It is now a header segment
  between the tool and the cwd, in its own capitalisation and `--text-dim` — absent outright when
  blank or on a generic step, never a placeholder. (FR-3, FR-15, design brief §2)
