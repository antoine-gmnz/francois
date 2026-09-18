---
id: pi-runtime-boundary
title: Pi runtime boundary and shared contracts
status: shipped
branch: feat/pi-runtime-boundary
created: 2026-09-18
depends_on: []
reviewed_base: 9ec326e0e481fd3a67431f20a15271393165ee77
reviewed_digest: 9547a196075966f6
---

# Pi runtime boundary and shared contracts

## 1. Summary

Extend the existing `SessionAdapter` / `TurnControl` boundary for a session-scoped Pi
process. Keep Pi wire DTOs private to Rust. This is the foundation for the ten tasks in
[_roadmap-pi-integration.md](_roadmap-pi-integration.md); source evidence and the architecture
comparison are in [the audit](research/pi-integration-audit.md).

## 2. Goals & non-goals

- Goals: separate runtime from provider/model, represent effective capabilities and errors,
  support persistent child ownership without changing existing runtime behaviour.
- Non-goals: enabling Pi creation, shipping a new harness, replacing PTY/git, introducing
  an async framework, exposing raw Pi objects to React, or removing a current runtime.

## 3. User stories / flows

An existing session opens and behaves as before. Later Pi features can represent a
provider unknown to François without a Claude model alias, fabricated permission state,
or a second frontend event listener. This foundational task adds no new user action.

## 4. Functional requirements

- FR-1: Add `pi` to the existing `AgentRuntime` enum and preserve exhaustive dispatch.
  `runtime: native|wsl` retains its execution-environment meaning. Runtime is derived
  from account kind at creation and remains immutable; task 06 adds the selectable account.
- FR-2: `protocol` remains the provider API dialect, not the Pi RPC transport. For Pi
  it is `null` because Pi owns that implementation detail; legacy values/defaults remain.
  Provider/model identity is the explicit pair in §5, not an encoded provider enum.
- FR-3: Extend the adapter with session-scoped control; a Pi idle child is not a running
  turn. Ordinary legacy adapters continue spawning per turn. Keep synchronous worker
  threads and release registry locks before process I/O.
- FR-4: Core owns effective session capabilities. Existing static tables are defaults;
  a live snapshot can narrow them based on installation/model/configuration. An absent
  snapshot for Pi enables no action. Components call `sessionCapability` only.
- FR-5: Add the ordered runtime envelope to the existing event channel. Pi-specific
  wire fields never enter it. One child reader orders events per session; consumers
  reject old generations and duplicates. Tasks 04/05 add transcript replay semantics.
- FR-6: Structured errors identify application/runtime/provider/tool origin, retryability
  and correlation, without raw provider credentials or RPC bodies.
- FR-7: Keep shell handles, git operations and worktree metadata independent of adapter
  availability. A failed Pi child never closes an independently owned PTY.
- FR-8: Compile all existing adapters and serializers; Pi remains unavailable until the
  production readiness gate in task 10. No catch-all fallback to Claude is permitted.

## 5. API contract

Amend `contract/common.ts` and `contract/multi-provider-seam.ts` in place; do not create
duplicate runtime vocabularies. Move `RuntimeCapability`, `CapabilityState` and
`RuntimeCapabilities` into `common.ts` and re-export from `multi-provider-seam.ts`.
Keep all existing capability keys; add `steering`, `followUps`, `resumableSessions`,
`modelSwitching`, `images`, `contextMetrics`, `costMetrics`. Legacy runtime defaults
retain existing model selection and image attachments (`modelSwitching` and `images`
available); live snapshots may narrow them. Pi defaults remain unavailable without
a snapshot. `permissions` continues
to mean François-enforced approval cards, never merely a CLI permission option.

Exact additions to `common.ts`:

```ts
// Amend existing aliases, retaining every existing member.
type AgentRuntime = 'claude-code' | 'francois' | 'codex' | 'grok' | 'pi';
type ProviderProtocol = 'anthropic' | 'openai' | null;
interface RuntimeModelRef { providerId: string; modelId: string }
interface RuntimeFailure {
  origin: 'application' | 'runtime' | 'provider' | 'tool';
  code: ErrorCode;
  message: string;
  retryable: boolean;
  requestId?: string;
  toolCallId?: string;
}
interface RuntimeEventEnvelope {
  type: 'runtime.event';
  sessionId: SessionId;
  generation: string; // core-minted UUID per child connection
  sequence: number; // positive safe integer, increasing within generation
  runId?: string; // core UUID per user-triggered agent run
  requestId?: string; // core UUID per command, when correlation is known
  at: number; // epoch milliseconds, observation time
  event: RuntimeEventPayload;
}
type RuntimeEventPayload =
  | { kind: 'run.state'; state: 'starting' | 'running' | 'idle' | 'stopping' | 'failed' }
  | { kind: 'capabilities'; capabilities: RuntimeCapabilities }
  | { kind: 'failure'; failure: RuntimeFailure };
```

Extend existing `SessionEvent` with `RuntimeEventEnvelope`. Add optional `runtimeModel`,
`effectiveCapabilities`, `runtimeGeneration` to `SessionMeta`; Pi must supply all three
after successful initialization. `AppError` gains optional `runtimeFailure: RuntimeFailure`.
`RuntimeEventPayload` is extended by tasks 04, 07 and 08, in this same canonical file.
All strings are bounded/validated at core ingress; provider/model IDs are nonempty
strings up to 256 UTF-8 bytes, treated as opaque exact identifiers. Failure messages
are limited to 1024 UTF-8 bytes and capability reasons to 512 UTF-8 bytes; both
reject unsafe display controls at ingress.

New codes in existing `ErrorCode`: `RUNTIME_UNAVAILABLE`, `RUNTIME_INCOMPATIBLE`,
`RUNTIME_PROTOCOL_ERROR`, `RUNTIME_TIMEOUT`, `RUNTIME_EXITED`, `RUNTIME_UNSUPPORTED`,
`PROVIDER_AUTH_FAILED`, `PROVIDER_UNAVAILABLE`, `MODEL_UNAVAILABLE`, `TOOL_FAILED`.
Use `INVALID_INPUT`, `SESSION_NOT_FOUND`, `INTERNAL` for their existing meanings.

No new Tauri command. Existing `francois:session:list` / `session_list` returns
`Result<SessionMeta[]>`; `francois:session:event` / `francois://session/event` carries
the amended union core → frontend. Authorization remains the local desktop IPC boundary.

Rust-only interface additions (in `session/adapter/mod.rs`, default implementations
return `RUNTIME_UNSUPPORTED` for unsupported operations):

```rust
trait RuntimeSessionControl: Send + Sync {
    fn submit(&self, input: RuntimeSubmission) -> Result<SubmissionReceipt, AppError>;
    fn cancel(&self) -> Result<(), AppError>;
    fn shutdown(&self) -> Result<(), AppError>;
}
// Add to SessionAdapter; existing preflight/begin_turn/models remain.
fn connect_session(&self, ctx: RuntimeConnectContext)
    -> Result<std::sync::Arc<dyn RuntimeSessionControl>, AppError>;
```

`RuntimeConnectContext` is an immutable snapshot of sessionId, absolute cwd, execution
environment/distro, accountId, approved launch policy, exact model pair, profile snapshot,
and optional core-private resume reference. No lock guard or secret is carried into UI.
`RuntimeSubmission` and `SubmissionReceipt` are Rust mirrors of task 08's shared message
input/receipt; before task 08 only normal text submission is supported internally.
The public `AgentRuntime` name remains the enum, not a second trait.

## 6. Data & state

`Engine` owns one optional runtime connection per Pi session in memory; `Session.current`
continues to represent an active turn. Never persist process IDs, stdin handles or a live
generation. Persist runtime/model identity with metadata; transient capabilities are
revalidated at connection. Shared-type serialization tests cover missing legacy fields.

Expected files: `contract/{common,multi-provider-seam}.ts`,
`src-tauri/src/session/{mod,adapter/mod,turn,status,events}.rs`, `src-tauri/src/ipc.rs`,
`src/lib/{runtimeCapability,session-events,sessionsStore}.ts`.

## 7. Edge cases & errors

Unknown persisted runtime: retain record for recovery, report `RUNTIME_UNSUPPORTED`,
never reinterpret as Claude. A missing Pi capability snapshot disables execution actions
with “Runtime is not connected.” A stale generation cannot update a newly connected session.
Missing legacy `protocol` keeps existing migration defaults; explicit Pi `null` is retained.

## 8. Design brief

No new visual surface. Existing capability notice components consume the new snapshot.

## 9. Acceptance criteria

- [x] Existing runtime/account derivation and resume tests still pass (FR-1–3).
- [x] Rust/TS round-trips distinguish missing legacy dialect from explicit Pi null (FR-2).
- [x] A mocked Pi session has an idle connection without showing a running turn (FR-3).
- [x] Missing/false capabilities prevent actions in core and UI (FR-4).
- [x] Duplicate/out-of-generation events do not mutate a focused session (FR-5).
- [x] Failures retain origin and sanitized correlation; no raw DTO reaches `src/` (FR-6).
- [ ] Shell/diff tests run with an unavailable runtime (FR-7).
- [x] Targeted vitest and cargo tests, `tsc --noEmit`, and normal quality checks pass.

## Remediation

### 2026-09-18 · review round 9 (REVISE · 3 findings)

- 2026-09-18 — 3 findings, all fixed; runtime_event applies accepted run.state/failure to the Session before any later session.meta (running/failure → capabilities regressions); dropSessionExtStreams restored in removal cleanup with its tests; agent/workflow updates routed by agent.sessionId/run.sessionId again with cross-session tests. Frontend 2601 passed / 3 skipped; Rust 1538 passed / 3 ignored; tsc, eslint, clippy, fmt clean. Re-review pending.

### 2026-09-18 · review round 8 (REVISE · 5 findings)

- 2026-09-18 — 5 findings, all fixed; hydration preserves accepted failure/run-state mutations; duplicate/unknown-session patch guards restored; assistant delta coalescing and golden assertions restored; shell 8 ms emission window, final drain/disposal/unwind handling restored; indexed transcript upserts preserve last-write-wins and first-occurrence ordering. Frontend 2596 passed / 3 skipped; Rust 1534 passed / 3 ignored; typecheck, lint, conventions, cargo check/clippy/format pass (existing lint/convention warnings). Manual runtime re-test and re-review pending.

### 2026-09-18 · review round 7 (REVISE · 4 findings)

- 2026-09-18 — 4 findings, all fixed; atomic model-switch capability validation, hydration reconciliation preserving live generations/capabilities/removals, canonical persisted-model validation and exhaustive ErrorCode validation. Frontend 2590 passed / 3 skipped; Rust 1522 passed / 3 ignored; aggregate quality pass. Re-review pending.

### 2026-09-18 · review round 6 (REVISE · 5 findings)

- 2026-09-18 — 5 findings, all fixed; restored settings/carry-over, lazy command inspection and bounded persistent hosts with capability/visibility guards; separated legacy sandbox selection from approval capabilities and guarded effort mutation under lock. Frontend 2587 passed / 3 skipped; Rust 1519 passed / 3 ignored; aggregate quality pass. Native/visual re-test and re-review pending.

### 2026-09-18 · preflight round 1 (BLOCK · 2 findings)

- 2026-09-18 — 2 findings, all fixed

### 2026-09-18 · preflight round 2 (BLOCK · 1 finding)

- 2026-09-18 — 1 finding, all fixed; capability/runtime expectations updated in contract/multi-provider-seam.test.ts, targeted tests and full preflight pass.

### 2026-09-18 · review round 3 (REVISE · 7 findings)

- 2026-09-18 — 7 findings, all fixed; authoritative frontend generation, core connection lifecycle, capability guards, persisted runtime recovery, structured failures, validated snapshots and ordered envelopes. Frontend/Rust tests and full quality pass.

### 2026-09-18 · review round 4 (REVISE · 7 findings)

- 2026-09-18 — 7 findings, all fixed; model/image capability gates, generation-bound producers, authoritative metadata batches, canonical legacy defaults, bounded validated failures and panic-free constructor. Frontend 2499 tests; Rust 1457 tests; quality/check/clippy/format pass.

### 2026-09-18 · review round 5 (REVISE · 6 findings)

- 2026-09-18 — 6 findings, all fixed; target-session palette and Remote Control guards, restored settings/detail IPC and sidecars, image staging/submission revalidation, atomic single/all runtime retirement. Frontend 2506 tests; Rust 1517 tests; aggregate quality/check/clippy/format pass. Surface handoffs and verification logs in specs/reports; re-review pending.
