---
id: process-native-capabilities
feature_id: process-native-capabilities
title: "11 · Gate native controls from implemented transport capabilities"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [claude-process-adapter, codex-process-adapter]
design_files: []
---

# 11 · Native capability and control integration

## 1. Summary

Align existing capability selectors and backend guards with the implemented Claude/Codex native transports. Reuse the seventeen-key RuntimeCapabilities map; do not invent UI parity or a local tool executor. If08/09 already satisfy a requirement, record their tests and add only the missing integration evidence.

## 2. Behavior

- **FR-1** Keep one explicit supported-control matrix per runtime and distinguish it from the current live snapshot. Missing snapshot preserves legacy behavior except Codex native permissions/questions remain disabled until the negotiated live transport exists. Pi remains unconditionally unavailable even if cached fields say otherwise.
- **FR-2** Preserve shipped Claude capabilities, Codex interactiveCommands/usageBar/modelSwitching/images and existing Grok/Francois policy. Codex native permissions becomes an allowed implemented capability ceiling, but not an enabled absent-snapshot default. Receive/reply/native request state is validated again in backend; a frontend true flag never authorizes an unknown request.
- **FR-3** Available approval choices come from the current native request, not only runtime-wide permissions. Codex cancel is explicit Cancel turn; absent availableDecisions preserves version-verified behavior, never grants policy amendments/Always. Question control uses the same live request authority and09 opaque id/Other/secret/blocking behavior.
- **FR-4** Build effective snapshots from implemented adapter methods and successful required initialization/account/transport state. Clear/invalidate live availability on generation replacement/connection loss. Give bounded actionable unavailable reasons distinguishing unsupported operation from a supported transport that is currently disconnected; never expose native paths/credentials in a reason.
- **FR-5** Skills/MCP/subagents/workflows/remote-control panels keep supported native observation and existing controls. Do not advertise a launch/message/stop/install capability merely because a native item was observed. New Codex parity outside proven adapter methods remains unavailable with an honest reason; no Francois SDK/tool-loop fallback. Existing Claude native resources remain operational through08.
- **FR-6** Shared frontend selector and backend guard agree for every current key under no snapshot, valid live snapshot, stale/invalid snapshot and retired runtime. Existing command-specific validation remains authoritative. Capabilities do not rewrite saved profile/account/default data.

## 3. Contract / ownership / design

No new keys or IPC shapes: canonical common.RuntimeCapabilities and09 optional request fields. Core owns negotiated capability generation/backend guards; frontend owns selectors and card/panel availability. Existing hints/styles reused. contract/process-native-capabilities.ts re-exports the canonical vocabulary.

## 4. Acceptance

- [ ] Table-driven core/frontend tests cover all keys for Claude/Codex/Pi plus existing Grok/Francois defaults; stale/invalid snapshots never enable Pi or an unimplemented control.
- [ ] Native approval/question request reaches actionable existing card only in current live scope; after disconnect/restart old card remains inert.
- [ ] Supported native controls produce corresponding adapter writes/effects, unsupported controls produce no side effects; no alternate local tool execution exists.
- [ ] Observed resources never imply unsupported control actions. Existing Claude resources and Codex shipped commands/usage retain regression coverage.
- [ ] Report matrix cites actual implementation/fixture/native-probe evidence separately; don't describe standalone protocol smoke as application UI roundtrip.

## 5. Readiness

READY after08/09, with explicit reuse/no-op acceptance for capabilities already implemented there. Core/frontend may review together; only actual gaps require edits.

## Remediation
