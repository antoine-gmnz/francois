---
id: process-runtime-events
feature_id: process-runtime-events
title: "07 · Apply normalized native runtime effects through one session sink"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [pi-selective-rollback, process-runtime-boundaries, process-session-use-cases]
design_files: []
---

# 07 · Normalized native events and state application

## 1. Summary

Move Codex exec's real effect application out of adapter/codex/runner.rs into a session-owned outer bridge behind a framework-free normalized effect sink. Reuse its Translator fixtures, block helpers and public SessionEvent. This is the first production consumer for05;08/09 use the same vocabulary.

## 2. Goals & non-goals

Native decoding stays in adapters, state changes stay in session, publication/storage remain outer effects. Preserve existing transcript and command-inspect rendering. Do not rewrite every event or serialize vendor payloads into a new public schema. No UI redesign or blanket reducer rewrite.

## 3. Internal contract

- RuntimeEventEnvelope { scope: RuntimeScope, sequence: u64, event: RuntimeEvent }. Sequence is monotonic per generation/turn, assigned by the owning adapter, beginning at1. RuntimeEventSink: Send + Sync, publish(RuntimeEventEnvelope) -> ApplyOutcome; ApplyOutcome is Applied, Duplicate, Stale, or Closed. The sink cannot return Engine/AppHandle or general mutation callbacks.
- RuntimeEvent is a session-owned enum, reusing neutral fields from current Codex Effect and SessionEvent: ResumeAnchor; Assistant delta/final; ToolStarted; ToolCompleted including optional normalized StepDetail; Usage; PermissionAsked; QuestionAsked; RequestResolved; TurnFinished; TurnFailed. Existing DTOs may be reused rather than duplicated. ResumeAnchor is an opaque native thread string; vendor request ids stay private in the adapter pending map.
- Tool completion carries normalized detail, tool/result metadata and explicit affects_workspace flag. Session applies diff refresh through an outward effect, rather than inferring all future providers from native event names. Preserve current Codex Edit semantics.
- Usage distinguishes context_used_tokens (occupancy), optional aggregate input/output and optional monetary cost. Missing is unknown, not zero. Do not sum successive context snapshots or confuse account rate limits with turn usage. Reuse RuntimeMetrics where appropriate; no new metrics panel.
- RequestAsked contains existing PermissionAsk/SessionQuestion values and application block id. RequestResolved contains block id, kind and outcome answered/allowed/denied/cancelled as appropriate; delivery resolution never means successful tool execution. Optional native choices/secret fields are introduced by09 contract before consumer dispatch.

## 4. Functional requirements

- **FR-1** Adapt Codex Translator output to the shared enum, moving its private Effect vocabulary inward or mapping once at adapter boundary. Its decoder/translator imports no Tauri or Engine. Move runner apply logic into a session bridge; runner publishes normalized effects only, with no app.state::<Engine>, transcript writes or Tauri emits.
- **FR-2** Application validates envelope scope before any state/effect. Ignore an already applied sequence; reject older-generation, replaced-turn and after-close output. Accept increasing sequence without requiring a contiguous stream (a producer may intentionally omit unsupported events). Generation closure records terminal state; duplicate terminal events have no second completion/persist.
- **FR-3** The reducer/state decision runs without I/O; existing Session/Engine remain storage. Return explicit effects for metadata/transcript append, detail append, anchor persistence, event publish and diff refresh. Outer application performs these in current observable order, releasing Engine locks before I/O. Append detail before publishing ToolCompleted so hasDetail is correct immediately.
- **FR-4** Persist newly received resume anchors immediately through existing atomic session writer. Preserve Codex exec thread resume and responseModeSent semantics. A stale anchor event cannot change a new owner.
- **FR-5** Keep block bounds/finalization, context accounting and completion/error text behavior. Whole Codex exec messages remain whole messages; do not invent streaming deltas. Existing locally cached history never inserts live pending requests. Runtime resolution/cancellation updates current authority and card projection once.
- **FR-6** Pending requests are keyed by scope+application block id; adapter-private native id maps cannot be rebuilt by reading historical cards. Turn close/disconnect cancels current requests once. Replayed request asks do not reactivate completed ids within that scope.
- **FR-7** Put Claude-specific usage extraction beside Claude translation, while preserving existing ContextTracker fixtures and latest-parent-request occupancy logic. Generic lifecycle should consume normalized usage; it must not inspect message_start/cache_creation_input_tokens or vendor result envelopes once08 completes. Transitional references are explicitly owned by08, not declared finished in07.
- **FR-8** Add a targeted architecture assertion for migrated Codex runner/translator and application module. Keep legacy runtime bridge observable and scoped; task15 assesses final native boundaries.

## 5. IPC contract

No wire-shape change for07. contract/process-runtime-events.ts re-exports shared SessionEvent, SessionMeta, PermissionAsk, SessionQuestion and RuntimeMetrics. Rust normalized events are private application input, not a second UI protocol. Existing common.ts and feature contracts stay canonical;09 owns additive native request field deltas.

## 6. Ownership

Core: session event/application modules, Codex runner/translator mapping, outer persistence/emission bridge and tests. Frontend: no code changes required for this slice; existing store/event tests verify compatibility. Lead: contract/spec. Task08 owns full Claude migration, task09 Codex App Server transport.

## 7. Acceptance tests

- [ ] Existing Codex fixtures produce equivalent public block/events/resume/context/detail effects through production sink.
- [ ] Duplicate sequence, old generation, replaced turn and late output after close produce no mutation/publication/storage effect.
- [ ] Terminal duplication yields one completion; empty/partial/error runs retain honest status and output.
- [ ] Tool detail is appended before completion publication; file edit still requests diff refresh.
- [ ] Pending request replay/resolution/close is deterministic; historical cards remain inert without live native ownership.
- [ ] Missing usage stays unknown; last parent context wins over aggregates; nonparent usage does not inflate context.
- [ ] Native adapters contain no Engine/AppHandle lookups after their assigned migration;07 proves Codex exec path,08 proves Claude.
- [ ] Existing frontend event/store suite and relevant core Codex/retirement suites pass without new public shapes.

## 8. Design

Existing transcript, roster and usage UI reused without change. No design approval dependency.

## 9. Readiness

READY as integrated05/06/07 core slice after rollback verification. The first consumer is current Codex exec, then09 changes transport. This task does not claim live native request support until09 fake-protocol and authenticated evidence is recorded separately.

## Remediation
