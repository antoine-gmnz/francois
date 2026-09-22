---
id: pi-rollback-inventory
feature_id: pi-rollback-inventory
title: "01 · Inventory Pi changes and protect unrelated work"
status: in-review
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: []
design_files: []
---

# 01 · Pi rollback inventory

## 1. Summary

Core and frontend agents audited Pi commits 2439d23/f13cfe7/4b9567b/b2627f4 against current 9441e6b and pre-Pi reference 82c093d. Reports classify executable removal, shared retention and stored-data compatibility; neither reference is a reset target.

## 2. Goals & non-goals

Identify selective rollback paths and protect later Codex commands/catalog/quotas, shared UI/process/persistence fixes and current release versions. Inventory alone does not certify implementation.

## 3. Deliverables

- `specs/reports/pi-core-rollback-inventory.md`: function-level hunk dispositions, stored formats and six verification groups.
- `specs/reports/pi-frontend-rollback-inventory.md`: 160-path index, removed UI/API, retained accessibility/store/login/default logic and baseline checks.

## 4. Functional requirements

Every affected subtree/mixed-file function has remove/retain/compatibility disposition. Pi raw records, missing references, staged attachments, native files and schema-v2 profiles survive. Default resolution and card/roster interactivity must be guarded explicitly; a hidden composer alone is insufficient.

## 5. API contract

None; inventory-only task. Tasks02–03 retain common wire shapes and coordinate removed Pi physical commands.

## 6. Ownership

Reports authored by core_inventory and frontend_inventory; spec/contract lead freezes behavior from findings. Implementation belongs to surface agents.

## 7. Risks

Blanket reverts lose unrelated fixes. Typed deserialization alone loses malformed optional Pi fields. Generic startup currently resolves missing account/project links and sweeps attachments/sidecars: retirement must bypass those paths. Profile→project observer inversion and bounded process probing are shared improvements.

## 8. Design

No new UI. Existing local design supports removal/read-only treatment.

## 9. Acceptance criteria

- [x] Four Pi commits audited; selective function/path dispositions recorded.
- [x] Later Codex and earlier architecture changes explicitly protected.
- [x] Regression matrix covers sessions/accounts/profiles/transcripts/attachments/shell/git/worktrees.
- [x] Task02/03 contracts and acceptance checks incorporate compatibility hazards.

## Remediation
