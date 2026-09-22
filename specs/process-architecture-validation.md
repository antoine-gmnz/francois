---
id: process-architecture-validation
feature_id: process-architecture-validation
title: "15 · Verify native architecture boundaries and complete the programme evidence"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [process-session-continuity, process-native-capabilities, process-settings-and-metrics, process-frontend-boundaries, legacy-runtime-scope]
design_files: []
---

# 15 · Native architecture validation

## 1. Summary

Enforce the actual native boundaries built05–13 and reconcile all sixteen programme tasks with tested evidence. Review the final paths and close genuine gaps; do not assert a clean architecture from an unused interface or an ADR alone.

## 2. Scope

- **FR-1** Add/update existing scripts/quality architecture checks against the actual production application and native adapter paths. Application modules import neither Tauri, Engine, process handles nor concrete provider adapters/vendor DTOs. Claude/Codex adapters do not acquire Engine/AppHandle or publish/persist directly; vendor parsing stays adapter-owned and process creation uses process_util supervision.
- **FR-2** Assert no sibling native-adapter dependency, duplicate session registry/event bus, second active native turn-start seam or custom Francois tool executor for Claude/Codex. Existing test harness utilities are testing infrastructure, not forbidden production agent harnesses. Explicit Grok/Francois compatibility bridge is documented outer infrastructure and excluded only by named scope, not a blanket directory exemption.
- **FR-3** Frontend shared tab/session helpers no longer import feature-owned agent-tab code; no frontend code parses native protocol. Report remaining unrelated shared-to-feature edges and distinguish runtime vs type-only imports. Do not broaden unrelated baseline cleanup.
- **FR-4** Run final required Rust/frontend/contract/convention checks against integrated code once upstream batches settle. Resolve actual regressions; no repeated exhaustive suite solely to accumulate evidence. Record known skips/baseline warnings honestly.
- **FR-5** Exercise native start/output/permission/question/interrupt/resume through actual adapter/session boundary with deterministic fake processes; isolated real native probes verify installed protocol separately. Test cross-session/generation/duplicate/stale replies, secret redaction, startup cancellation and process cleanup. Record app UI/native roundtrip smoke and any external missing prerequisite distinctly from schema fixtures.
- **FR-6** Verify absence of active Pi commands/modules/side effects and retention of raw Pi data/read-only UI. Protected Claude/Codex/Grok/Francois behavior retains tests. Review sanitized diffs for accidental generated native history, auth/session files or probe artifacts in tracked files.
- **FR-7** Update programme roadmap/status and per-task result evidence: decision/inventory tasks00/01, implementation02–13, preserve/defer14, validation15. A tested reused behavior can satisfy a task with exact evidence; unimplemented requirement/external smoke gap stays open. SHIP verdict means review readiness, not release/commit.

## 3. Contract / ownership

No new IPC fields. contract/process-architecture-validation.ts is a canonical re-export marker. Core owns scripts/quality/native boundary assertions and native integration tests; frontend owns shared import and UI/store checks; lead owns review/status/metrics reconciliation. Root orchestrates. Existing pipeline commands remain authoritative.

## 4. Acceptance

- [ ] A deliberately forbidden test import fails the targeted architecture check; integrated allowed paths pass.
- [ ] Current native production flows use the intended application/sink/supervision seam; no unused façade masking old callbacks.
- [ ] Complete meaningful test/build/lint/convention results recorded with exact scope and known skips.
- [ ] Fake protocol, standalone live protocol and product integration evidence clearly separated; no smoke claim inferred from generated schema.
- [ ] All16 tasks have concrete completion or explicitly outstanding acceptance evidence; no release claim without release action.

## 5. Readiness

READY as final integrated validation after dependencies. Any new fix follows source ownership and existing TDD; no blanket architecture rewrite.

## Remediation
