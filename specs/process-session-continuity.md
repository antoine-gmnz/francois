---
id: process-session-continuity
feature_id: process-session-continuity
title: "10 · Preserve native identity and app transcript across process restarts"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [claude-process-adapter, codex-process-adapter, process-runtime-events]
design_files: []
---

# 10 · Native session continuity

## 1. Summary

Complete the storage side of05/07 using the existing atomic sessions writer, quarantine reader and transcript files. Francois persists its session metadata and cached projection; Claude/Codex own native conversation files. This is a targeted continuity integration/test slice, not a persistence schema rewrite.

## 2. Behavior

- **FR-1** Keep existing persisted keys and runtime/account identity. Existing claudeSessionId remains the durable opaque native anchor for compatible readers even when its internal accessor gets a neutral name. No automatic history import, provider conversion or native file rewriting.
- **FR-2** Resume uses the same runtime/account home and returned native thread reference. Existing Codex exec anchors resume through09 App Server; existing Claude anchors through08 -p --resume. Missing account or unavailable binary yields existing actionable error; never choose a different account/runtime because the saved one is missing.
- **FR-3** Persist new native anchor before any subsequent turn depends on it. Keep responseModeSent scoped to that anchor. Apply storage/publication outside Engine locks through the existing outer port implementation; successful persisted write and failed atomic write remain distinguishable. Existing malformed-file quarantine, version behavior and raw retired Pi roundtrip remain untouched.
- **FR-4** Local cached transcript is immediately readable without native process startup. Restart cannot restore actionable permission/question ownership from disk; historical unresolved cards are cancelled/inert until a new live native request is emitted. Secret answers remain redacted under09.
- **FR-5** After crash or EOF keep finalized blocks and available partial output. Never replay a user message whose native acceptance/effects are uncertain. New explicit user turn may resume valid native context; invalid native resume does not silently create fresh context. Existing explicit new/fresh workflow creates its own identity and retains old history.
- **FR-6** Validate scope before committing async anchor/settings results. Moved cwd/worktree uses existing host/resolution errors; do not repair native history or change account ownership automatically. Old Pi records/files/defaults retain02 guards through every storage call.
- **FR-7** Do not duplicate the storage port introduced05/07. If that implementation already meets these behaviors, this task adds missing fixtures/coverage and records exact evidence rather than refactoring it again.

## 3. Contract / ownership

No IPC or disk schema delta. contract/process-session-continuity.ts re-exports existing shared types. Core owns storage bridge/continuity tests; frontend only existing history/recovery behavior if actual regression requires it. Existing resume failure banner is reused; no new recovery wizard.

## 4. Acceptance

- [ ] Pre-Pi, mixed retired Pi, Claude and Codex records survive load/save without discriminator/anchor/account drift; malformed/unknown data retains existing quarantine behavior.
- [ ] Fake storage failure does not publish a persisted-anchor success or discard original file; successful anchor writes happen before dependent turn.
- [ ] Crash after partial output, completed output and pending request preserves honest projection, no actionable historical asks or automatic prompt replay.
- [ ] Existing exec-created Codex id resumes through native App Server with same home; Claude restart uses same native id. Fake tests and real isolated smoke are recorded separately.
- [ ] Missing account, unavailable binary, moved worktree and invalid native reference fail explicitly with no fresh fallback; explicit fresh action preserves old session.
- [ ] Existing persistence/transcript bounds and retirement suites pass.

## 5. Readiness

READY after08/09; reuse the already built storage boundary and fix only proven gaps. Live probe has demonstrated exec-to-App-Server identity compatibility, but product integration must still prove its own route.

## Remediation
