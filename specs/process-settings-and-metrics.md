---
id: process-settings-and-metrics
feature_id: process-settings-and-metrics
title: "12 · Preserve account, model and usage ownership through native processes"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [claude-process-adapter, codex-process-adapter]
design_files: []
---

# 12 · Native account, settings and usage integration

## 1. Summary

Verify and close targeted gaps in the shipped account/model/effort/rate-limit behavior when native turns use05–09. Preserve existing login/catalog/usage services and UI; do not build a second settings or credential system.

## 2. Behavior

- **FR-1** Resolve account home, executable environment, Windows/WSL host and authentication through existing account services before native startup. Carry an immutable execution snapshot into the adapter. Never use default account/ambient home because a selected account is unavailable; report the existing typed error.
- **FR-2** Preserve Claude login lifecycle and Codex login/cache invalidation already shipped. Native process reuse is account-bound; account/model changes cannot cause one session to read another account's catalogs/usage or native history. Retirement guards prevent any Pi login/probe/mutation.
- **FR-3** Model/effort selection uses the current native catalog, stable model ids and display labels. Preserve unavailable saved selection until explicit replacement; no invented model or silent effort downgrade. Current running turn keeps its immutable snapshot; newer settings apply on next native turn through supported fields.05 revision checks reject stale async catalog/settings completion.
- **FR-4** Preserve response-mode, profiles/system instructions and account defaults without translating Claude-only flags into Codex unsupported arguments. Use existing compatibility validation and explicit unavailable hints. New native approval-policy mapping follows09 while sandbox semantics stay unchanged.
- **FR-5** Keep Codex account rate limits, model catalog probes and interactive command behavior from shipped changes. Account quotas are not per-turn token counts. Session usage distinguishes context occupancy, aggregate usage and optional cost; absent native figures remain unknown, stale saved figures stay labeled stale.
- **FR-6** Cache keys include owning account/runtime/settings identity where required by existing code. Explicit refresh invalidates only the intended cache; delayed responses for a previous account/session do not replace current selection/usage. Removing a surviving account retains existing cleanup semantics; retired Pi data is preserved.
- **FR-7** Reuse already-correct08/09 code and current UI. This task may finish as a tested integration report when there are no gaps; it must cite concrete paths/tests rather than changing files to satisfy a task count.

## 3. Contract / ownership / design

No IPC delta. Existing multi-account, model catalog/settings, common metrics and09 request fields remain canonical; contract/process-settings-and-metrics.ts re-exports shared vocabulary. Core owns account snapshot/catalog/settings/usage integration tests; frontend only selection/cache/usage regressions. Existing settings sheet/account modal/usage display reused without new controls.

## 4. Acceptance

- [ ] Two isolated native accounts launch/resume under their own homes with no environment/catalog/usage crossover; account removal or unavailable auth cannot silently fall back.
- [ ] Existing Codex model/effort/interactive command/rate-limit regression suites remain green; Claude login/profile/response behavior retained.
- [ ] Changing settings during a turn affects next turn only; stale async completions don't revert a newer selection.
- [ ] Unknown/unsupported model and metrics are represented honestly; context occupancy isn't a turn aggregate and limits aren't token usage.
- [ ] Saved Pi defaults/accounts/profiles remain read-only/unavailable and explicit available replacement works.
- [ ] Evidence report identifies reused code, actual fixes and fake vs live checks; no authenticated data/secret fixtures are committed.

## 5. Readiness

READY after08/09; keep changes limited to demonstrated integration gaps.

## Remediation
