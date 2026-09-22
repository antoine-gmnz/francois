---
id: claude-process-adapter
feature_id: claude-process-adapter
title: "08 · Route the existing Claude process through native application ports"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [process-session-use-cases, process-child-supervision, process-runtime-events]
design_files: []
---

# 08 · Claude native process adapter

## 1. Summary

Migrate the existing claude -p integration to05/06/07 without changing its native protocol or user behavior. Claude retains its model/tool loop; Francois owns session commands, projection and the supervised child.

## 2. Existing behavior / scope

Reuse adapter/claude_code.rs, stdio.rs, stream/, spawn/env helpers, ContextTracker and golden fixtures. Keep per-turn process lifetime and existing resume-between-turns, not a speculative session-long Claude process. Preserve account homes, Windows/WSL, profiles, model/effort, response mode, attachments, allowGit and permission rules, observed tools/subagents/workflows/MCP, post-result cleanup and native resume recovery.

## 3. Functional requirements

- **FR-1** Claude implements the same framework-free native turn-start port as Codex, receiving immutable execution context and RuntimeEventSink. No native adapter/decoder reaches Engine through AppHandle. Existing specialized observation can publish typed session effects through the same sink; do not create a provider-to-Engine callback escape hatch.
- **FR-2** Preserve current argv: -p, --output-format stream-json, --input-format stream-json, --permission-prompt-tool stdio, partial messages and current verbose/model/profile/effort/permission/response flags. User content rides stdin JSON, never shell interpolation. No positional prompt, custom tool executor, SDK or extra agent loop.
- **FR-3** Provider decoder owns Claude stream/control envelope parsing and usage extraction. Apply normalized assistant/tool/request/anchor/usage/terminal effects through07. Keep latest parent-request context occupancy and current aggregate fallback; don't count subagent windows in parent usage.
- **FR-4** Native request ids are adapter-private and mapped to application block ids within RuntimeScope. Existing control_response response shape and original tool input are preserved. Once-only claim belongs to the owning live adapter; historical pending cards cannot claim it. Preserve Applied/NotPending/ChannelClosed behavior and rule-first Always failure semantics.
- **FR-5** Route permission/question replies through05. Preserve Claude option labels/multi-select/Other behavior and nonsecret stored answers. No Codex question id or approval choice mapping leaks into Claude. Pending drains on turn death/stop/close resolve cancelled once; no late generation event revives them.
- **FR-6** Use06 transport ownership for spawn/read/write/cancel/reap, preserving post-result EOF handling and current retry decision. Native resume failure is explicit; never silently discard a valid anchor or replay uncertain user effects. Old saved Claude sessions remain compatible.
- **FR-7** Move remaining Claude-shaped result/context decoding out of generic session/turn.rs. Keep generic lifecycle compatibility exports only where surviving consumers require them, with implementation delegated to provider translation; no duplicated parser.
- **FR-8** Preserve existing non-native Francois/Grok execution through the documented outer bridge. Tests don't read the user's live skill directories or write account settings; inject fixtures at touched seams.

## 4. Contract

No IPC delta. contract/claude-process-adapter.ts re-exports05/07 shared vocabulary. Core-private RuntimeScope/RuntimeEventSink/TurnControl are the single seam specified there. Do not author another runtime engine or public event format.

## 5. Ownership / design

Core owns adapter/stream/stdio migration, application effect mapping, process ownership and tests. Frontend unchanged; current transcript/cards remain reused. Lead owns contract/spec. Existing output/observation breadth is preserved, not removed to simplify the boundary.

## 6. Acceptance

- [ ] Existing argv/env/resume/attachment and Claude stream golden expectations pass through actual migrated production path.
- [ ] Fake child proves start/output/permission allow+deny/question reply/stop/failure, exact response correlation and once-only write; secret-native09 fields do not alter legacy Claude payloads.
- [ ] Two simultaneous scopes cannot cross-answer; close and late EOF produce one terminal outcome and no orphan child.
- [ ] Golden usage/agent/tool observation projections remain equivalent; generic application imports no vendor protocol strings/types.
- [ ] Native adapter/decoder contain no AppHandle/Engine lookup or direct persistence/Tauri event publication.
- [ ] Record installed CLI version and non-authenticated protocol smoke separately from authenticated two-turn+restart/resume smoke using isolated temporary workspace. If account/network unavailable, record exact limitation and leave that acceptance unchecked; do not equate fixture tests with live evidence.

## 7. Readiness

READY after integrated05/06/07 seam gates. This task preserves proven native protocol and scope; no inaccessible shared-chat content is assumed.

## Remediation
