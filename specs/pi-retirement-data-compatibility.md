---
id: pi-retirement-data-compatibility
feature_id: pi-retirement-data-compatibility
title: "02 · Preserve stored data when Pi becomes unavailable"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [pi-rollback-inventory]
design_files: ["specs/design/pi-retirement.md", "Francois Redesign.dc.html", "Claude Terminal.dc.html"]
---

# 02 · Preserve stored data when Pi becomes unavailable

## 1. Summary

Retire Pi execution without losing saved sessions, transcripts, accounts, profiles or defaults. The user authorized implementation on 2026-09-21 after approving the native-process diagram. This spec freezes the compatibility prerequisite to selective removal; it does not retire another runtime.

## 2. Goals & non-goals

Keep mixed registries readable and preserve Pi records. No conversion to another provider, native-file deletion, credential changes, automatic defaults substitution, new IPC shapes or redesign.

## 3. User stories / flows

Opening a Pi session displays its existing local transcript and unavailable banner. Runtime actions and historical permission/question cards are inert. New Session with a saved Pi default displays that unavailable selection and requires an explicit available account/profile choice. Surviving runtimes behave as before.

## 4. Functional requirements

- **FR-1** Retain AgentRuntime::Pi / `agentRuntime: 'pi'`, account kind Pi, Pi profile settings and nullable Pi protocol strictly as compatibility vocabulary. Missing legacy fields retain current defaults; missing and explicit null remain distinct.
- **FR-2** Load Pi sessions into a listable typed display projection, retaining original raw JSON separately. Persist the raw retired record verbatim in semantic JSON value terms, rather than serializing the typed projection; never duplicate rows. Unknown/malformed optional Pi payloads survive. Existing unknown-runtime preservation remains intact.
- **FR-3** Never remap retired Pi accountId to default, including absent accounts. Retain project/account/profile references and defaults unchanged on load/save. Keep profile-v2 migration backups/unknown-row passthrough and account Pi records.
- **FR-4** Pi capabilities are unconditionally false regardless of stored/live effectiveCapabilities. Metadata projects settled read-only status; historical pending/running status cannot imply a live process or actionable request. Raw status/pending/native-resume information remains on disk.
- **FR-5** Reject Pi execution/mutation with RUNTIME_UNSUPPORTED before process spawn, probe, native-history/credential access, worktree creation or registry write. Includes create/send/submit/queue/control/model/settings/reconnect/newFrom; Pi account trust/setup/refresh/default/removal/rename and Pi profile create/update/copy/remove. List/local transcript/metadata reads remain allowed. Unresolved identifiers retain existing missing-id errors.
- **FR-6** Startup/hydration/paging/settings/account-list/shutdown never reconnect or probe Pi. Preserve dangling project links; skip Pi sweep_staged, diff-watcher startup and admission-sidecar hydration. Staged attachment bytes and sidecar files remain untouched. Read only existing Francois transcript projection; unavailable projection uses existing empty state without reading native Pi history. External installations/config/history remain untouched.
- **FR-7** Banner text: `Pi is unavailable in this version. Saved history is read-only.` Remove active input/recovery controls. Historical permission/question cards and roster inline approvals cannot dispatch. Retained Pi account/profile rows say `Unavailable`; saved selections remain visible until explicitly replaced. Rendering never mutates defaults.
- **FR-8** Preserve Claude/Codex/Grok/Francois execution, models, account isolation, attachments, transcript paging, shell/git/worktrees and release versions.

## 5. API contract

No fields/channels/enums/success envelopes added or removed. Canonical existing shapes: contract/common.ts, session-engine.ts, multi-account.ts, session-profiles.ts, pi-session-durability.ts. The feature contract re-exports them and records this behavioral override.

All surviving `francois:session:*`, `francois:account:*`, `francois:profiles:*` signatures keep their `Result<T>`. A resolved Pi target on a mutating/executing verb returns `{ ok: false, error: { code: 'RUNTIME_UNSUPPORTED', message: 'Pi is unavailable in this version. Saved history is read-only.' } }`, without native paths/credentials/detail. Missing targets retain SESSION_NOT_FOUND / ACCOUNT_NOT_FOUND / PROFILE_NOT_FOUND. Other runtime validation/errors are unchanged. No new event channel; existing session.meta may expose settled display metadata without rewriting raw Pi data.

Session creation whose omitted account resolves to a saved Pi default fails identically; explicit available account proceeds under existing validation. A Pi profile never silently becomes legacy. Core is enforcement authority; frontend availability is presentation.

## 6. Data & state / surface tasks

Core owns src-tauri/src/session/{persistence.rs,persistence/,mod.rs,runtime.rs,commands/,adapter/mod.rs}, account and profiles registries/commands. Extract serializable Pi DTOs from executable modules where required; keep one raw retired-record map plus inert typed display projection.

Frontend owns src/lib capability/store/API/default helpers and conversation/accounts/profiles/sessions components. Guard selectors, event replay, permission/question cards and roster controls. Lead owns contract/ and specs; implementers import contracts read-only.

## 7. Edge cases & errors

Keep per-record quarantine and atomic-write failures as before. Saved true capabilities/pending asks remain inert. Pi defaults remain stored even if unavailable. Retired Pi mutations, including deletion, are rejected in this batch to preserve raw records and external data. Surviving runtime deletion remains unchanged.

## 8. Design brief

Reuse existing resume/limit notice structure, EmptyPane, account/profile rows and transcript renderers. Local design evidence is accepted for removal/reuse under user authorization and existing project precedent.

> Full brief: specs/design/pi-retirement.md.

## 9. Acceptance criteria

- [ ] Pre-Pi/Pi-era/mixed fixtures load; raw Pi JSON round-trips including malformed optional values and missing-account references. (FR-1–3)
- [ ] Missing project/account references remain exact, staged attachment bytes survive startup, and admission sidecar spy observes zero writes. (FR-3,6)
- [ ] Execution/native-file spies observe zero Pi activity during load/list/hydrate/create/send/reconnect/default resolution/mutation. (FR-4–6)
- [ ] Stale true capabilities, historical pending cards and roster approvals cannot dispatch controls. (FR-4,7)
- [ ] Frontend pure tests cover explicit selection after unavailable defaults and unaffected surviving runtimes. (FR-7–8)
- [ ] Focused TDD evidence plus frontend build/typecheck/tests and Rust tests recorded; distinguish unrelated baseline failures.

## 10. Readiness

READY for core/frontend using existing canonical shapes. Inventory findings confirm raw retention and typed unavailable projection are feasible. No claim about inaccessible conversation contents is required.

## Remediation
