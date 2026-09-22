---
id: legacy-runtime-scope
feature_id: legacy-runtime-scope
title: "14 · Preserve existing runtimes outside the Pi rollback"
status: in-review
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [process-runtime-decisions, pi-rollback-inventory]
design_files: []
---

# 14 · Existing runtime scope decision

## Decision

Keep Grok native CLI and existing Francois/OpenAI-compatible execution, accounts, sessions and data operational. Retire only Pi in02/03. The user selected native Claude/Codex architecture and rollback of Pi; they did not authorize removal of these other existing runtimes. No new Francois model/tool harness is added by this programme.

## Architectural consequence

05–09 migrate native Claude/Codex through the application ports. Existing Grok/Francois may retain a clearly identified outer compatibility bridge; inward application modules cannot import that bridge.15 records its exact remaining dependencies instead of claiming every existing runtime was rewritten. A future explicitly scoped retirement needs its own data/recovery/user behavior spec and tests.

## Evidence and acceptance

Core/frontend inventories identify existing execution and persistence consumers.02/03 retain their runtime/account discriminators and regression fixtures.09 has no fallback that sends a native Codex request to the Francois loop. No account registry rewrite, new session remapping, credential deletion or history conversion occurs to simplify this programme.

Documentation decision complete; implementation scope is preserve/defer, not unimplemented removal. This is not a claim of a released build. The inaccessible shared conversation does not justify inventing further retirement authorization.
