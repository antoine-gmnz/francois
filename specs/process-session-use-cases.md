---
id: process-session-use-cases
feature_id: process-session-use-cases
title: "05 · Extract native session commands behind explicit ports"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [pi-selective-rollback, process-runtime-boundaries]
design_files: []
---

# 05 · Native session application commands

## 1. Summary

Extract the native runtime lifecycle and reply decisions into framework-free session application code. Refine the existing SessionAdapter/TurnControl seam. Implement together with task07, first against the existing Codex exec transport, so the seam has a real consumer before native App Server replaces that transport.

## 2. Goals & non-goals

The session application owns lifecycle, current generation and user-command routing. Native adapters own transport, vendor ids and execution. Reuse Engine storage, immutable TurnContext, existing IPC errors and transcript. This task does not move unrelated project/worktree/profile CRUD, redesign every command, rewrite Grok/Francois or add an agent harness.

## 3. Existing behavior to retain

Keep account/model preflight, protected Codex catalog/usage behavior, response-mode snapshots, attachments, worktree host, resume anchor and rollback read-only guards. Existing native commands keep their public request/result types. Claude Always decisions still write the authorized rule before consuming a request; a failed rule write keeps the ask pending. Pi cannot enter this application path.

## 4. Functional requirements

- **FR-1** Add a cohesive child of session for application values/ports/use cases; its production imports include no Tauri, Engine, concrete adapter, vendor wire DTO or process handle. Existing IPC AppError and neutral domain values are allowed. Do not create a second session registry.
- **FR-2** Introduce RuntimeScope { session_id: String, turn_id: String, generation: u64 }. turn_id is the existing application turn/block id, not a native id. Generation increases whenever a new runtime owner is installed, including retry/reconnect. A scope is valid only while its generation/turn is current and not closed.
- **FR-3** The application receives a SessionStatePort with explicit snapshot, begin/start claim, control lookup, finish/close claim and settings-revision compare-and-apply operations. Implement the port over existing Engine in an outer bridge. No callback accepting Engine/AppHandle or generic service locator crosses inward. Snapshot contains runtime, status, scope, immutable TurnContext and settings revision; process/account configuration is resolved outside before start and is immutable thereafter.
- **FR-4** RuntimePort refines SessionAdapter: preflight(&TurnContext) -> Result<(), AppError>; begin_turn(TurnContext, Arc<dyn RuntimeEventSink>) -> Result<Arc<dyn TurnControl>, AppError>. Remove AppHandle from migrated runtime entry points. Supply immutable resolved execution configuration and narrow account/auth collaborators at outer composition. Model/usage probes remain existing services; they are not agent-turn orchestration.
- **FR-5** Framework-free commands cover start, interrupt, close, answer_question, decide_permission and settings-result acceptance. Tauri handlers resolve dependencies, map input shape and call these entry points; Engine locks are never held during transport, process, persistence or rule I/O. Publish/persist through explicit effect ports after the state transition.
- **FR-6** Answer/permission routes resolve the live control for session+current scope and authorize by its pending request state, never transcript contents. Existing block ids remain IPC correlation. Duplicate calls write at most once, equal vendor request ids in separate sessions stay isolated, stale scope/closed session does no write. Preserve existing QUESTION_NOT_PENDING/PERMISSION_NOT_PENDING/SESSION_NOT_FOUND/RUNTIME_UNSUPPORTED errors.
- **FR-7** Retain ControlAck Applied, NotPending and ChannelClosed; add AwaitingConfirmation for transports whose response acceptance requires a later server notification. Applied means the transport's existing confirmed delivery semantics only, never successful tool execution. AwaitingConfirmation returns command success but keeps the card pending and consumes the write claim; duplicate clicks cannot write again. A later normalized request-resolution event closes it. Failed or uncertain writes are not retried automatically.
- **FR-8** Retain rule-first Claude Always semantics behind an injected PermissionRulePort. Authorization comes from a current pending pattern. Runtime-specific choices are validated before this port. Codex cannot invoke Claude rule persistence; native decision choices are introduced in09. Secret answers introduced in09 may flow transiently to the owning adapter but never generic durable/logging effects.
- **FR-9** Interrupt targets the current turn once. Close invalidates scope before cleanup, cancels pending requests once, and stops late effects. Closing during start causes the newly returned handle to be terminated instead of installed. A stale settings completion is ignored/rejected and cannot overwrite a newer user setting.
- **FR-10** Wire RuntimePort implementations at existing outer composition. Grok/Francois may use a clearly named transitional legacy bridge; no inward module imports it. Task07 migrates Codex exec event application; task08 migrates Claude fully; task09 swaps Codex native transport through these same ports. No second event bus or parallel lifecycle registry.

## 5. API contract

No IPC delta. Canonical contract/process-session-use-cases.ts re-exports existing requests/types. Core-private types are declared once inside session; names above are binding responsibilities, and splitting value/trait files follows PIPELINE layout. Internal trait refinements must compile with every existing runtime consumer through an explicit outer bridge. The public SessionAdapter name may remain for RuntimePort to avoid duplicate interfaces; there must be one native turn-start port when08/09 finish.

## 6. Ownership

Core: session application module, outer Engine/Tauri bridge, native adapters, command delegation, main composition and meaningful tests. Frontend: no change required in this slice. Lead: specs/contracts. Do not edit unrelated modules merely to replace every legacy callback.

## 7. Acceptance tests

- [ ] Headless fake runtime/state/effect ports exercise start -> output -> completion through production use cases.
- [ ] Close during blocked start destroys returned child/control, installs nothing and rejects late output.
- [ ] Two sessions with same request id route replies to their own control; duplicate, expired and stale-generation replies write zero additional bytes.
- [ ] Rule write failure leaves Claude pending; unsupported/native choices cannot write Claude settings.
- [ ] Applied/ChannelClosed/AwaitingConfirmation produce distinct honest card behavior and no automatic replay.
- [ ] Concurrent settings completions commit only current revision; immutable running context stays unchanged.
- [ ] Existing Codex command/catalog/usage, Claude decisions, retirement and persistence tests pass.
- [ ] Production application import check rejects Tauri/Engine/process/concrete adapters; no unused framework-free wrapper standing beside the real path.

## 8. Design

No new UI. Existing transcript/controls and IPC retain behavior. Future native choice/secret fields are separately specified in09.

## 9. Readiness

READY after02/03 core gates, dispatched as one integrated core batch with07 and06. Task04 becomes implementation-evidenced only when this real path and08/09 consumers pass. Numeric timeouts/process ownership are in06. No authenticated CLI run is inferred from fake-port tests.

## Remediation
