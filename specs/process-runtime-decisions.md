---
id: process-runtime-decisions
feature_id: process-runtime-decisions
title: "00 · Reconcile native-process architecture and existing backlog"
status: in-review
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: []
design_files: []
---

# 00 · Architecture decisions

## 1. Summary

The user authorized implementation by agents on 2026-09-21. Native Claude/Codex execution stays inside their CLI processes. Francois owns session orchestration and presentation; independent provider adapters translate output and replies.

## 2. Goals & non-goals

Reuse existing adapters, account isolation, models, persistence, shared transcript/cards and architectural inversions. Remove Pi execution selectively. Do not add a new Francois/Pi/SDK agent loop. Existing Grok and Francois/OpenAI execution is outside retirement scope and remains operational.

## 3. Source traceability

The supplied image `.francois/attachments/0a513ecb/pasted-20260921-205417.png` was read directly. Native process, IN/OUT, matching adapters, transcript, permission/question return path are source requirements. Sibling adapters and session-owned pending state are the assistant's explicit corrections accepted by the subsequent user instruction to execute tasks. Shared ChatGPT conversation remains inaccessible (earlier HTTP 403); no additional decision is attributed to it.

## 4. Decisions and ownership

- **D1 / tasks02–03:** Pi is a retired executable runtime; preserve local/raw histories, accounts, profiles and defaults. No blanket git revert, release downgrade or external-data deletion.
- **D2 / tasks04–08:** Native Claude process uses existing `claude -p` stream/control integration. Preserve initial per-turn process lifetime and resume identity while replacing framework coupling. No SDK sidecar or substitute tool loop.
- **D3 / task09:** Existing `codex exec --json` is the protected rollback baseline, not sufficient evidence for native interactive replies. Evaluate and implement supported Codex App Server stdio for native turn/permission/question round-trips, reusing shipped account/model/usage code. Version-specific schema/captures determine exact protocol; no guessed wire methods or free-text approval prompt.
- **D4 / tasks05,07,11:** Application state owns session/turn/request liveness. Adapters own native correlation/encoding. Common cards are projections; rendering/replaying them cannot answer a request. Replies route through owning session and adapter.
- **D5 / tasks06,09,10:** Process owner never crosses session/account homes. Keep per-turn Claude lifetime; a Codex App Server connection is session-scoped unless measured schema constraints require a documented change. Native thread identity outlives process; session id is not native thread id. No shared mutable account-wide conversation.
- **D6 / task14:** Preserve Grok/Francois runtime and data; certify no regression and exclude them from the new Claude/Codex process-contract migration unless an adapter bridge is needed. The target prohibits adding a new custom harness; it does not authorize deleting unrelated shipped runtimes.

## 5. API contract

No IPC change. Future changes amend existing domains rather than duplicate common session/account/profile types. Retired Pi uses existing RUNTIME_UNSUPPORTED. Native questions/permissions initially reuse existing `session_answer_question` and `permissions_decide` payloads; additive capability distinctions require coordinated contracts before dispatch.

## 6. Backlog reconciliation

| Existing work | Disposition |
|---|---|
| Pi integration programme | Superseded by selective retirement; preserve historical specs and shared findings |
| core-architecture-fixes/wave3 | Retain module map, typed errors, spawn facade, profile removal observer inversion and quality ratchets |
| codex-model-catalog / commands / rate limits | Keep shipped code and regression tests; no duplicate implementation |
| codex-interactive-session | Amend through task09 after schema validation; native return path remains required |
| capability/registry, MCP/agents/workflows parity | Reconcile under task11 with native transport evidence; do not create a second registry or tool loop |
| continuity/settings/usage/input parity | Reuse completed pieces and cover remaining behavior in tasks08–13 |
| Grok/Francois parity | Retain operational scope; task14 validates rather than retires |

## 7. Errors / open evidence

An inaccessible shared conversation limits source completeness but does not block independently specified work. If installed native transport lacks a required operation, record evidence and an explicit remaining task; do not mark programme complete by disabling a feasible native feature.

## 8. Design

Architecture only; current product UI is reused. Image evidence does not specify new controls or layout.

## 9. Acceptance criteria

- [x] Diagram requirements and assistant choices traced separately.
- [x] Pi retirement and retained runtime scope explicit.
- [x] Existing shipped work protected; no source conversation contents invented.
- [x] Transport assumptions recorded; native bidirectional Codex validation remains task09 acceptance.

## Remediation
