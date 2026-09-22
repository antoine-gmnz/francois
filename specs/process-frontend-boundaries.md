---
id: process-frontend-boundaries
feature_id: process-frontend-boundaries
title: "13 · Remove the touched shared-state dependency on agent feature helpers"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [pi-selective-rollback, process-runtime-boundaries]
design_files: []
---

# 13 · Frontend session boundary cleanup

## 1. Summary

Remove the verified sessionsStore -> features/agents/agent-tab production dependency while09 adapts existing request cards. Move genuinely shared pure tab identity/state helpers into src/lib and update consumers. Preserve UI behavior and avoid a repo-wide dependency rewrite.

## 2. Scope and behavior

- **FR-1** Pure agent-tab identity, refs, close/drop/eviction and transcript-hydration helpers currently in features/agents/agent-tab.ts are consumed by shared store and feature UI. Place them in one appropriately named src/lib module, with only contract/shared dependencies; update all direct production/test consumers. No shared helper imports a feature component or vendor runtime decoder.
- **FR-2** Preserve exact open/close/eviction cap, displayed-pane protection, session-switch/removal cleanup and async hydration race semantics. Existing golden/pure tests move imports and must remain meaningful rather than being replaced by import-only assertions.
- **FR-3**09 request cards consume canonical common types and existing typed IPC wrappers. Stores preserve optional native question/permission fields and read-only Pi policy; frontend never parses native JSON-RPC. Two panes share one request projection; core remains once-only authority.
- **FR-4** Keep shell/extension/overview domain dependencies outside this slice unless this move directly requires a caller adjustment. Record remaining shared-to-feature edges as scoped follow-up evidence; do not move unrelated features wholesale to inflate architectural completion.
- **FR-5** Remove only now-unused active Pi wrappers already assigned02/03; retain normalized runtime-model display helper with surviving consumer and compatibility DTOs. No new public facade/barrel or duplicate tab state registry.

## 3. Contract / ownership / design

No IPC delta beyond09's separately authored optional fields. contract/process-frontend-boundaries.ts re-exports canonical shared types. Frontend owns src/lib module move, imports and09 request store consistency. Core unchanged. No design change; existing panes/roster/transcript controls stay intact.

## 4. Acceptance

- [ ] sessionsStore and shared tab store import no features/agents/agent-tab at runtime; helper has no src/features imports.
- [ ] Agent-tab/session-store tests retain existing pane/eviction/session-close/hydration behavior.
- [ ]09 request projection tests preserve ids/offered choices/secret redaction/nonblocking semantics; Pi remains inert.
- [ ] Typecheck/build/ESLint and relevant tests pass; remaining unrelated shared-to-feature production imports listed in report with no claim of wholesale elimination.

## 5. Readiness

READY now for frontend alongside09. Prior10–12 dependencies were unnecessarily broad for this independent proven import cleanup and are removed. Larger UI/capability changes remain their own tasks.

## Remediation
