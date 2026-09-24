---
id: github-ci-logs
feature_id: github-ci-logs
title: GitHub CI logs — live job steps and in-app step logs
status: frozen
branch: feat/github-ci-logs
created: 2026-09-24
depends_on: [github-page, webview-hardening]
reviewed_base:
reviewed_digest:
contract: contract/github-page.ts   # extended in place (decision 2026-08-04 api: one file per domain)
design_files: []
---

# GitHub CI logs — live job steps and in-app step logs

## 1. Summary

The GitHub page's check lists (PR detail **Checks** card, commit detail **Checks on this commit**)
show a name, a state and a duration; the only way to learn *what is happening* is "View log", which
leaves the app. This feature makes each GitHub Actions check expandable into its **job steps**, live
while the job runs, and each finished step into its **log**, rendered in-app, opening on the failure.
It also carries the failure into "Fix in a new session" and adds "Re-run failed jobs".

## 2. Goals & non-goals

**Goals**
- See which step a running job is on, and how long each step took, without leaving the app.
- Read a finished step's log in-app; on a failure, land on the failing step at its first error.
- Hand the failing lines to the agent fixing the PR; re-run failed jobs behind a confirm.

**Non-goals**
- **Streaming the log of a job that is still running.** GitHub's public API serves job logs only
  once the job completes; the web UI's live feed is undocumented and is not used (decision
  2026-08-11 api). Running jobs show live *steps*; their log appears when the job ends.
- Steps/logs for non-Actions checks (third-party apps, commit statuses): they keep **Open on GitHub**.
- The GitHub page's **Checks** tab (stays "Coming soon"), workflow-run listing, dispatching
  workflows, re-running successful jobs, cancelling runs, log search, artifacts.
- Any redesign outside the two check lists.

## 3. User stories / flows

1. PR detail opens with a failing check → that job is already expanded, its failed step open, the log
   scrolled to the first error line.
2. A check is running → its row shows `› <current step> · 1m12s`; expanding it shows steps ticking
   through live; when the job ends, its failed step (if any) opens.
3. User clicks **Fix in a new session** → the first message carries the failing step's error excerpt.
4. User clicks **Re-run failed** → confirm names the workflows → runs re-queue → checks go pending and
   live polling resumes.
5. Commit detail: the same list in the narrow side card; opening a step's log opens it in a modal.

## 4. Functional requirements

### Check list (shared by PR and commit detail)
- FR-1 One component, `CheckRunList` (`src/features/github/`), replaces both current check renderings.
  Header: the rollup chip (existing) + a count line `3 passed · 1 failed · 1 running` (zero terms
  omitted) replacing the static "CI · GitHub Actions" label.
- FR-2 Row order: failed → running/pending → passed → skipped; name order within a group.
- FR-3 A check with `jobId` (an Actions job) gets a disclosure caret (`▸`/`▾`) and toggles its steps
  on click / Enter / Space. A check without `jobId` has no caret and shows a ghost **Open on GitHub**
  when `detailsUrl` exists (on every state, not only failed — replaces "View log").
- FR-4 A running Actions row (collapsed) shows its current step: `› <step name> · <elapsed>`, where the
  current step is the first `running` step, else the first `queued` one; elapsed ticks every second
  from `startedAt` (`useElapsedClock`).
- FR-5 **Auto-expand**, once per detail open (not re-applied after the user collapses): the first failed
  Actions job expands and its first failed step's log opens (FR-10). With no failure, nothing expands.

### Steps
- FR-6 Expanded job: header `<workflowName> / <job name>` (workflowName omitted when absent), attempt
  chip `attempt n` only when `runAttempt > 1`, ghost **Open on GitHub** (`htmlUrl`). Then one row per
  step: state glyph (Orbit when running), `number`, name, duration (live elapsed when running); a
  failed step's row uses the danger tone. Skipped steps render dimmed.
- FR-7 Step data comes from `github_get_job`, fetched on expand; a job that is not `completed` is
  re-fetched every **5 s** while expanded and the view is visible (FR-14).
- FR-8 A step is clickable only when the job is `completed` and the step is not `skipped`/`queued`.
  On a running job, a finished step's row shows a muted `log when the job finishes` on hover/focus.

### Log viewer
- FR-9 Opening a step fetches `github_get_step_log`; one step log open per job (opening another
  closes the first). PR detail renders it inline under the step row, height-capped (brief §8), own
  scroll. Commit detail renders it in a `Modal` (wide), since the side card is too narrow.
- FR-10 Rendering: monospace, line numbers from `LogLine.n`; `error` lines danger-tinted, `warning`
  lines warn-tinted, `command` lines dimmed, `debug` hidden; `groupStart…groupEnd` spans fold to one
  row (`▸ <group title>`), collapsed by default **except** a group containing `firstErrorLine`. On open
  the view scrolls so `firstErrorLine` sits ~5 lines from the top; with none, to the bottom.
- FR-11 When `droppedLines > 0` a notice heads the log: `Showing the last <lines.length> of <totalLines>
  lines · Open on GitHub for the full log` (decision 2026-08-25 data: never present a capped slice as
  complete).
- FR-12 **Copy** (icon button) copies the open step's returned lines as plain text (group markers
  removed), with the FR-11 notice as a first line when lines were dropped. Toast/tooltip "Copied".

### Liveness
- FR-13 While any check in the list is `pending`, the list re-fetches `github_list_checks` for the
  detail's full sha every **10 s**. Updated rows keep their expansion state (keyed by `jobId`, else
  `name`). A job that turns `completed` while expanded re-runs FR-5's step-opening for itself if it
  failed and the user has no step log open in it.
- FR-14 All polling (FR-7, FR-13) stops when nothing is pending, the detail unmounts or changes
  PR/commit, or `document.visibilityState === 'hidden'` (resumes on visible, with an immediate fetch).
  A fetch in flight is never overlapped by the next tick (`useLatestRequest` semantics).

### Actions
- FR-15 **Fix in a new session** (PR detail, existing FR-6 of github-page) gains a failure excerpt: for
  up to 3 failed Actions jobs, fetch the first failed step's log (5 s budget total); the first message
  is the existing sentence followed, per job, by `` `<job> › <step>`: `` and a fenced block holding
  `failureExcerpt()` — 60 lines ending 10 lines after `firstErrorLine`, or the last 60 lines when
  there is none; ≤ 150 lines across all jobs. Any fetch failure/timeout drops that job's excerpt
  silently; with none, the message is today's.
- FR-16 **Re-run failed** (ghost, beside Fix in the PR card's danger footer): shown when ≥ 1 failed
  check has a `runId` and every check sharing that `runId` is non-pending. Confirm modal: "Re-run
  failed jobs in <workflow names>?" → `github_rerun_failed` once per distinct `runId`. On success, the
  list re-fetches immediately (checks go pending → FR-13 polling). Errors inline in the modal. Not
  offered in commit detail.

### Demo
- FR-17 `VITE_FRANCOIS_DEMO=1` serves fixtures for the three read verbs (a failed job with an error
  inside a group, a running job whose steps advance on each poll, a passed job, an external status).

## 5. API contract

All additions go in `contract/github-page.ts` (same `github` domain). Rust mirrors with serde,
`rename_all = "camelCase"`. Every verb resolves scope with the existing `resolve_scope(cwd)` +
`require_gh`, runs `gh` through the bounded runner, and resolves to `Result` — never rejects.

```ts
// ---------- checks (amended) ----------
export interface CheckRun {
  name: string;
  state: CheckState;
  durationMs?: number;
  summary?: string;
  detailsUrl?: string;
  /** Actions job id (== check-run id). Present only for GitHub Actions jobs; absent ⇒ no steps/log. */
  jobId?: number;
  /** Actions workflow run id; present iff jobId is. */
  runId?: number;
  /** epoch ms; lets a pending row tick its elapsed clock. */
  startedAt?: number;
}

export interface PullDetail extends PullSummary {
  // …existing fields…
  headOid: string; // NEW — full 40-char head sha (headSha stays the 7-char display form)
}

// ---------- francois:github:listChecks → github_list_checks ----------
// Check runs (`GET repos/{o}/{n}/commits/{sha}/check-runs?per_page=100`) + commit statuses
// (`…/commits/{sha}/status`, statuses map to CheckRun without jobId). Used for polling (FR-13).
export interface GithubListChecksRequest extends GithubScope {
  sha: string; // full 40-hex; anything else → INVALID_INPUT
}
export type GithubListChecksResponse = Result<CheckRun[]>;

// ---------- francois:github:getJob → github_get_job ----------
// `GET repos/{o}/{n}/actions/jobs/{jobId}`.
export type StepState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled';

export interface JobStep {
  number: number; // GitHub's 1-based step number
  name: string;
  state: StepState;
  startedAt?: number;
  durationMs?: number; // completed steps only
}

export interface CheckJob {
  jobId: number;
  runId: number;
  runAttempt: number;
  name: string;
  workflowName?: string;
  state: CheckState;
  completed: boolean; // status === 'completed' — the only state in which a log exists
  startedAt?: number;
  durationMs?: number;
  steps: JobStep[]; // ordered by number
  htmlUrl: string;
}
export interface GithubGetJobRequest extends GithubScope { jobId: number }
export type GithubGetJobResponse = Result<CheckJob>;

// ---------- francois:github:getStepLog → github_get_step_log ----------
// `gh api repos/{o}/{n}/actions/jobs/{jobId}/logs` (follows the redirect, plain text).
export type LogLineKind =
  | 'plain' | 'command' | 'error' | 'warning' | 'notice' | 'debug' | 'groupStart' | 'groupEnd';

export interface LogLine {
  n: number; // 1-based line number within the step (stable across the dropped-head cap)
  text: string; // sanitized, `##[kind]` marker and timestamp removed; groupStart text = group title
  kind: LogLineKind;
}

export interface StepLog {
  jobId: number;
  stepNumber: number; // 0 = the whole job (segmentation fallback)
  lines: LogLine[]; // at most 5,000 — the LAST ones
  totalLines: number; // before the cap
  droppedLines: number; // totalLines − lines.length
  firstErrorLine?: number; // LogLine.n of the first 'error' line in the step
}
export interface GithubGetStepLogRequest extends GithubScope {
  jobId: number;
  stepNumber: number; // ≥ 0
}
export type GithubGetStepLogResponse = Result<StepLog>;

// ---------- francois:github:rerunFailed → github_rerun_failed ----------
// `gh run rerun <runId> --failed`. The only write verb in this feature.
export interface GithubRerunFailedRequest extends GithubScope { runId: number }
export type GithubRerunFailedResponse = Result<null>;
```

**`ErrorCode` additions** (`contract/common.ts`, beside `GH_UNAVAILABLE | GH_FAILED`):
- `GH_LOG_NOT_READY` — job not completed (getStepLog).
- `GH_LOG_GONE` — GitHub returns 404/410 for the log of a completed job (retention expired / deleted).
- `GH_LOG_TOO_LARGE` — raw log exceeds the 32 MiB output cap (detail: `{ capBytes }`).

**Error cases, all verbs**: `GH_UNAVAILABLE` (no/unauthenticated gh, non-GitHub remote), `GH_FAILED`
(gh non-zero; detail `{ code, stderr }` — e.g. rerun of an in-progress run, job id not in this repo),
`INVALID_INPUT` (sha not 40-hex, `jobId`/`runId` ≤ 0, `stepNumber` < 0 or not a step of the job),
timeout via the runner's existing code. Timeouts: 15 s for listChecks/getJob/rerun, 30 s for the log.

**Core rules**
- `jobId`/`runId` are set on a `CheckRun` only when the check is an Actions job: from the check-runs
  API when `app.slug == "github-actions"` (`id`, run id parsed from `details_url`); from `gh pr view`'s
  `statusCheckRollup` by parsing `detailsUrl` `…/actions/runs/{runId}/job/{jobId}`. Parse failure ⇒
  both absent. `get_pull` / `get_commit` populate them too, so the first render is expandable.
- **Sanitize in the core** (decision 2026-08-04 security): strip ANSI/VT escapes and C0 controls
  except tab, drop the leading RFC 3339 timestamp, truncate a line at 2,000 chars with `…`.
- **Kinds**: `##[error]`, `##[warning]`, `##[notice]`, `##[debug]`, `##[command]`, `##[group]`,
  `##[endgroup]` prefixes map to kinds; also `::error`-style annotations echoed in plain text → `error`.
- **Segmentation**: each timestamped line goes to the step with the greatest `startedAt ≤ timestamp`
  (step times floored to the second). Untimestamped lines follow the previous line. If the job has no
  step timings, or `stepNumber` is requested but the segment is empty while the job log is not,
  return `stepNumber: 0` with the whole job — the frontend labels it "Full job log".
- **Cache**: logs of completed jobs are immutable; keep the last 8 parsed job logs in memory (LRU keyed
  by `owner/name#jobId`) so opening sibling steps does not re-download. Never written to disk.

## 6. Data & state

- No persistence. Expansion, open step and auto-expand-applied flag are component state keyed by the
  detail's `(number | sha)`; they reset when the detail changes.
- Pure helpers (vitest): `checkRowOrder`, `checkCountLine`, `currentStep(job)`, `canOpenStep`,
  `foldGroups(lines)`, `failureExcerpt(log)`, `rerunTargets(checks)`, `pollingActive(...)` in
  `src/features/github/ci-logs.ts`.
- API wrappers in `src/lib/api.ts`: `githubListChecks`, `githubGetJob`, `githubGetStepLog`,
  `githubRerunFailed`.
- Core: `src-tauri/src/github/actions.rs` (verbs + mapping) and `actions_log.rs` (sanitize, kinds,
  segmentation, cap, cache), each with `#[cfg(test)]` covering parse fixtures.

## 7. Edge cases & errors

- Matrix jobs: one row per job (names already distinct, e.g. `test (ubuntu, 20)`).
- Re-run in progress: `runAttempt` bumps; getJob of the old `jobId` still returns the old attempt —
  FR-13's list refresh brings the new `jobId`, the old expansion is dropped (key no longer present).
- Log fetch errors render inside the log area: NOT_READY → "Log available when the job finishes";
  GONE → "GitHub no longer keeps this log" + Open on GitHub; TOO_LARGE → "Log too large to show
  (> 32 MiB)" + Open on GitHub; others → message + Retry. getJob errors render in the expanded area
  with Retry; polling continues.
- `gh` rate-limited → `GH_FAILED`; polling backs off to 60 s after two consecutive failures, resets
  on success.
- `gh` unavailable → lists come from nothing (commit detail already hides checks); no carets.
- Cancelled job → state `failed` (existing mapping); its `cancelled` steps render with a muted ×.

## 8. Design brief

Inline accordion inside the existing Checks card (Graphite & Signal). Collapsed rows unchanged
except the caret and the running row's `› step · elapsed`; expanded job indents a step list; an open
step reveals a recessed mono log panel (max 420px, own scroll) with a thin toolbar (Copy · Open on
GitHub · dropped-lines notice). Colour stays state-only: cyan running, red failed/error lines, `--warn`
for warnings, everything else graphite. Commit detail opens the log in a wide modal.

> full brief: specs/design/github-ci-logs.md

## 9. Acceptance criteria

- AC-1 A PR with a failed Actions job opens with that job expanded, its failed step's log open and the
  first error line visible without scrolling.
- AC-2 A running job's row shows the current step and a ticking elapsed; expanded, steps change state
  within ~5 s of GitHub; when the job ends with a failure its failed step opens by itself.
- AC-3 A third-party check / commit status has no caret and an Open on GitHub button.
- AC-4 Clicking a finished step of a running job does nothing and explains why.
- AC-5 A log over 5,000 lines shows the last 5,000 and states the true total.
- AC-6 Log text never contains ANSI escapes or control characters (core test on a fixture with them).
- AC-7 Copy puts the step's plain text on the clipboard.
- AC-8 Fix in a new session's first message contains the failing step's excerpt (≤ 60 lines per job,
  ≤ 150 total); with gh failing it still starts, with today's message.
- AC-9 Re-run failed asks first, calls `gh run rerun <id> --failed` once per run, and the checks go
  pending and live.
- AC-10 No gh call is made while the window is hidden or when nothing is pending.
- AC-11 Core tests: rollup/check-runs → jobId/runId parsing; getJob mapping; kind mapping, group
  markers, timestamp segmentation, stepNumber-0 fallback, 5,000-line cap totals; argv validation.

## Remediation
