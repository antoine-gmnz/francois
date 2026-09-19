---
id: pi-rpc-sessions
title: Pi RPC process and session lifecycle
status: shipped
branch: feat/pi-rpc-sessions
created: 2026-09-18
depends_on: [pi-runtime-boundary, pi-runtime-distribution]
reviewed_base: 82c093da3ce4728b0cf2ad3de2bef4ade1d36826
reviewed_digest: 494f86cae83321a3
---

# Pi RPC process and session lifecycle

## 1. Summary

Implement a private Rust Pi RPC adapter with one persistent child per connected session.
The existing process-per-turn implementation cannot directly own this lifetime; extend
the seam from task 01. See [audit](research/pi-integration-audit.md) for upstream sources.

## 2. Goals & non-goals

- Goals: connect, send, stream, observe failure and shut down without orphaning children.
- Non-goals: model/auth UI, transcript rendering, automatic crash prompt replay, SDK sidecar,
  or running Pi's RPC `bash` as François's interactive shell.

## 3. User stories / flows

A validated test account/session starts Pi in its selected cwd/worktree. Sending text
produces activity through the existing session channel. When the run settles, the session
becomes idle and the child remains available. Removing the session or quitting tears it down.
Until task 10 the ordinary New Session UI cannot select this incomplete runtime.

## 4. Functional requirements

- FR-1: Spawn certified executable with `--mode rpc`, explicit provider/model, owned
  session directory, and the launch policy described below. Keep stdin open. Separate
  stdout protocol from bounded/sanitized stderr diagnostics. Never hold the session lock
  while spawning, waiting for a response, reading, or joining a thread.
- FR-2: Implement LF-only framing, tolerate CRLF, preserve U+2028/U+2029 within strings,
  buffer fragmented UTF-8 correctly. Hard cap one record at 32 MiB, 32 outstanding
  commands and 64 KiB sanitized stderr ring per child. Oversize/malformed mandatory
  response fails that connection explicitly instead of silently losing conversation data.
- FR-3: Core request UUIDs map to expected command, deadline and response consumer.
  Late/duplicate replies cannot complete a different command. Replies may interleave
  with events. Valid unknown event kinds are counted and ignored with one diagnostic
  notice per kind/generation; missing fields in known events are protocol failures.
- FR-4: Initialize using get_state; snapshot runtime ID and sessionFile. No model call or
  user prompt is needed for the handshake. A request success is acceptance only;
  `agent_settled` governs completion, not process exit or every `turn_end`/`agent_end`.
  A run includes retries/compaction/continuations. Capability probes are a no-op for this
  MVP: the Pi wire protocol audit (`wire.rs`) names no probe RPC, and every capability
  stays hardcoded unavailable — consistent with this feature's non-goals (no MCP/
  subagents/skills/model/auth UI for Pi). Revisit once a certified capture supplies a
  real probe shape.
- FR-5: Serialize user-affecting controls through one per-session dispatcher. Initialization
  deadline 15 s; read-only commands 10 s; prompt acceptance 30 s; compaction 180 s.
  Deadlines are cancellation-aware and configurable only in internal tests initially.
- FR-6: EOF/crash during a run marks it interrupted/error once, settles partial blocks,
  and rejects outstanding requests. Do not resend accepted/ambiguous prompts. User-initiated
  reconnect uses task 05's recorded reference, never a fresh thread fallback.
- FR-7: Shutdown stops admissions, clears queues and aborts, closes stdin, waits up to
  5 s, then terminates the tracked process tree and joins readers. Pi has no assumed
  `shutdown` RPC command. Removing a session and app exit invoke the same owner.
- FR-8: Logs include origin, sessionId, generation, requestId, command name, duration,
  exit status, and frame/error counts; exclude raw frames, prompt text, auth material,
  full tool output and complete environment. Retain existing diagnostics facilities.
- FR-9: Cwd/worktree and native/WSL environment are snapshotted. Diff/git/PTY stay under
  their existing ownership. Failure to spawn Pi cannot clean up a user-owned worktree.
- FR-10: Baseline launch uses `--no-extensions`, no `-e` arguments, and explicit
  `--no-approve` unless the session's project-resource choice permits otherwise (task 09).
  Do not invoke `pi install`/`pi update`. Test that configured global/project packages do
  not defeat disabled extension loading or cause unapproved installation at connection.
  If the certified release cannot satisfy this, fail preflight; do not claim isolation.

## 5. API contract

No new public RPC pass-through command. Existing `session_create`, `session_send`,
`session_remove`, `session_list`, and `session_interrupt` dispatch to the adapter.
Inputs/outputs remain in `contract/session-engine.ts`, amended by tasks 06/08.
Creation errors add `RUNTIME_UNAVAILABLE`, `RUNTIME_INCOMPATIBLE`, `RUNTIME_TIMEOUT`,
`RUNTIME_PROTOCOL_ERROR`, `MODEL_UNAVAILABLE`; send adds `RUNTIME_EXITED`,
`PROVIDER_AUTH_FAILED`, `PROVIDER_UNAVAILABLE`. Removal is idempotent after child exit.

Use task 01's Rust `RuntimeSessionControl` and the existing core → frontend
`francois://session/event` runtime envelope. Emit `run.state` starting/running/idle/stopping/
failed and `failure` with `RuntimeFailure`. Session statuses map starting/running/stopping
to existing busy status, idle to idle, failed to error; no `awaiting_approval` is invented.

Private wire types belong only in `session/adapter/pi/wire.rs`:
`PiCommand { id, type, ...validated fields }`, `PiResponse { id, command, success,
data?, error? }`, and the certified event union. They are not contract exports.

Internal state machine:
`disconnected → starting → idle ↔ running → stopping → disconnected`; any connected
state can fail. Each reconnection increments generation. `agent_end` alone does not
transition to idle. Once a failure wins, later EOF/reader errors cannot emit a second
terminal result. Core IDs, rather than content hashes, correlate commands.

## 6. Data & state

The adapter owns Child/stdin, reader/writer workers, pending response map, generation,
run state and bounded diagnostics. The engine owns the Arc handle and metadata; Pi owns
the runtime conversation. Production access remains disabled until dependent tasks land.

Expected files: new `session/adapter/pi/{mod,wire,process,dispatcher}.rs`,
`session/adapter/mod.rs`, `session/{mod,turn,status}.rs`, lifecycle commands, `process_util.rs`.
Keep each module focused; no changes to Claude NDJSON parser to accept Pi variants.

## 7. Edge cases & errors

Unknown command response ID: discard and diagnose. Wrong command for known ID: fail
protocol. Provider auth/outage errors use their origin only if structured evidence permits;
unclassifiable text stays a runtime failure. Never infer authentication from a substring
such as “token”. Timeout after acceptance is ambiguous, not permission to replay.
Windows/WSL process cleanup must be exercised; stopping the UI spinner is not proof of kill.

## 8. Design brief

No new visual surface. Existing session status/error presentation consumes normalized state;
task 04 designs notices, task 08 designs controls.

## 9. Acceptance criteria

- [ ] Fake child covers fragmented UTF-8, interleaved replies, duplicates and unknown events (FR-2–3).
  Interleaved-reply coverage is missing (round-2 review MEDIUM) — parked as `deferred:pi-rpc-sessions`
  in `specs/refactor-backlog.md`, not verified.
- [x] Two prompts use one child; a multi-tool run stays busy until settled (FR-4).
- [x] Startup/response timeout, crash and stderr flood remain bounded and resolve once (FR-5–6).
- [x] Removal/exit leave no tracked descendants; independent shell remains alive (FR-7–9).
- [ ] Configured test extensions never execute under baseline policy (FR-10).
  No test proves a configured package can't defeat the baseline lock (round-2 review MEDIUM) — parked
  as `deferred:pi-rpc-sessions` in `specs/refactor-backlog.md`, not verified.
- [x] Sanitized real captures identify the certified artifact; provisional fixtures are labelled.
- [x] Cargo adapter/command tests and existing session tests pass on the supported matrix.

## Remediation

### 2026-09-19 — review round 1 (REVISE: 1 CRITICAL, 2 HIGH, 6 MEDIUM)

- 2026-09-19 — 7 findings, all fixed (core: `dispatcher.rs` fail-whole-connection on timeout/write-failure + structured diagnostic logging + stderr digest-only logging; `process_util.rs` SAFETY comments; `process.rs`/`runtime.rs` new coverage). FR-4 capability-probe finding resolved by spec sign-off (FR-4 amended above: no probe RPC exists in the wire protocol audit; capability probes are a documented no-op for this MVP).

Deferred (not re-dispatched — out of scope, pre-existing, shared with `extensions::provider::kill_group`):
- [ ] MEDIUM · `src-tauri/src/process_util.rs:654` · quality · `own_process_group`/`kill_tree` are no-ops for tree cleanup on Windows (`Child::kill` only, no job object) — Pi child's grandchildren can be orphaned on Windows despite FR-7/Edge-cases §7. Fix: wire a Windows job object into `process_util` (cross-cutting task, not specific to this feature).
