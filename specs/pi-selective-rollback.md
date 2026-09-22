---
id: pi-selective-rollback
feature_id: pi-selective-rollback
title: "03 · Remove the active Pi integration selectively"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [pi-rollback-inventory, pi-retirement-data-compatibility]
design_files: ["specs/design/pi-retirement.md", "Francois Redesign.dc.html", "Claude Terminal.dc.html"]
---

# 03 · Remove the active Pi integration selectively

## 1. Summary

Remove Pi executable integration after task02 makes persisted data read-only. Apply targeted changes in the current checkout; historical commits are evidence, never reset/revert targets.

## 2. Goals & non-goals

Remove Pi discovery/probes/RPC/process ownership/auth/setup/model/resource/queue/recovery execution and creation/migration flows. Preserve other runtimes, shared infrastructure with surviving consumers, release versions, native user data and historical specs.

## 3. User stories / flows

Creation/settings expose available surviving runtimes. Existing Pi sessions/accounts/profiles remain readable and unavailable under task02. No startup/UI/IPC path launches Pi.

## 4. Functional requirements

- **FR-1** Apply specs/reports/pi-core-rollback-inventory.md and frontend inventory. Protect later Codex commands dcc95e2, rate limits 428463a, catalog 204428d, earlier architecture cleanup and current versions.
- **FR-2** Delete active adapter/pi and account/pi code, moving minimal persisted DTOs/parsers into compatibility modules first. Remove Pi admission/recovery/profile-resource/model execution and dead private scaffolding; retain no executor just because its module also defined saved data.
- **FR-3** Remove Pi-exclusive Tauri registration and frontend wrapper together: runtime_installation, runtime_models, session_metrics, session_acknowledge_policy, session_submit, session_clear_queue, session_reconnect, session_new_from, account_add_pi, account_trust_pi, account_pi_setup, account_pi_refresh, profiles_copy_to_pi. Shared commands retain task02 guards. Lead removes matching command request/response exports; history DTOs and shared optional compatibility fields remain.
- **FR-4** Remove Pi setup/creation/model-policy/queue/recovery actions from accounts/profiles/session settings/composer and dead subscriptions/styles/tests. Keep historical transcript fields/renderers and unavailable banner. Retain shared login PTY lifecycle, navigator guard, button accessibility and status CSS fixes.
- **FR-5** adapter_for(Pi) remains explicit unavailable compatibility dispatch; never fallback. Retain Pi account/profile/runtime/null-protocol discriminators and raw retention. Capability checks for other runtimes stay intact.
- **FR-6** Remaining Pi references must be compatibility DTOs/parsers/raw retention/guards, historical transcript fields/renderers, their tests or historical specs. Shared normalized vocabulary is retained only for real surviving consumers or immediate task07 migration, with neutral ownership. No active probe, native history reader or executable resource policy remains.
- **FR-7** Historical Pi programme is superseded; retained shared-code findings remain outstanding until validated. No packaging/dependency/version/pipeline rollback absent a concrete Pi-only change.

## 5. API contract

No new wire shape. Existing Result<T>, session events and persisted discriminators remain. contract/pi-selective-rollback.ts identifies retired physical commands and imports shared compatibility types; no duplicate IPC domain. Removed Tauri commands have no runtime callable contract. Surviving shared commands reject resolved Pi targets with task02 RUNTIME_UNSUPPORTED before side effects. Read/list/local transcript contracts stay unchanged. Lead owns contract cleanup; implementers must not edit contract/.

## 6. Data & state / surface tasks

Core owns src-tauri/ and scripts/quality/: active Pi removal, main registrations, DTO extraction and data/reference tests. Frontend owns src/: UI/API/subscription removal, unavailable rendering and selector tests. Lead owns contract/ and specs. Apply task02 first within this integrated batch; no unrelated files reverted.

## 7. Edge cases & errors

Persisted data is not executable code. Missing Pi accounts/projects retain original references. Do not sweep staged attachments, admission sidecars or native files for retired records. Cached local transcript projection needs no native recovery. Windows spawn/WSL/env fixes and Codex probes survive.

## 8. Design brief

See specs/design/pi-retirement.md. Existing local design reuse/removal; preserve surviving controls and shared accessibility.

## 9. Acceptance criteria

- [ ] No Pi process/probe/setup/native recovery registration or execution path remains. (FR-2–5)
- [ ] Remaining Pi references have compatibility/history dispositions; creation offers no Pi. (FR-4–6)
- [ ] Task02 lossless/read-only tests pass after deletion. (FR-5)
- [ ] Claude/Codex/Grok/Francois commands/models/rate limits/accounts/profiles/attachments/shell/git/worktrees regressions pass. (FR-1)
- [ ] Frontend build/tests, Rust tests and quality gates recorded; no unrelated version/config changes. (FR-1,7)

## 10. Readiness

READY as an integrated 02+03 batch after task01 manifest; existing contract declarations remain read-only compatibility during removal. Report additional exclusive commands to lead for final export pruning.

## Remediation
