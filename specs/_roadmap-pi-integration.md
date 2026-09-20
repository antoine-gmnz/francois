# Pi integration — task map and specification review

Created 2026-09-18 from `francois-pi-integration-spec-brief.md` supplied by the user.
Scope: François product only. This is a specification programme, not implementation.

## State

All ten specifications were validated by the user and frozen on 2026-09-18. Their board
cards move to Ready to build, subject to the dependency order below. Eight associated
design briefs are frozen with them. No runtime implementation or live certification is
claimed: protocol captures and platform certification remain implementation acceptance
gates. Existing board tasks are neither cancelled nor silently superseded.

## Implementation order

| # | Task / spec | Outcome | Dependencies |
|---|---|---|---|
| 01 | [pi-runtime-boundary](pi-runtime-boundary.md) | Extend the existing adapter, shared types and capabilities | none |
| 02 | [pi-runtime-distribution](pi-runtime-distribution.md) | Discover and certify an external Pi installation | 01 |
| 03 | [pi-rpc-sessions](pi-rpc-sessions.md) | Supervise a persistent RPC child and start a conversation | 01, 02 |
| 04 | [pi-transcript-events](pi-transcript-events.md) | Render normalized text, tools, images and notices | 01, 03 |
| 05 | [pi-session-durability](pi-session-durability.md) | Reopen the same Pi conversation after restart | 03, 04 |
| 06 | [pi-provider-auth](pi-provider-auth.md) | Pin a Pi credential directory to an account/session | 01, 02, 03 |
| 07 | [pi-models-metrics](pi-models-metrics.md) | Discover/select models and show honest usage | 04, 06 |
| 08 | [pi-turn-controls](pi-turn-controls.md) | Steer, queue follow-ups, stop and compact | 03, 04, 05 |
| 09 | [pi-skills-capabilities](pi-skills-capabilities.md) | Run available skills; gate unsupported functionality | 06, 07, 08 |
| 10 | [pi-migration-rollout](pi-migration-rollout.md) | Migrate profile schema and release the complete loop | 05–09 |

Tasks 05 and 06 can be implemented independently after 04/03 respectively; 07 and 08
can then progress independently. Task 10 is the production enablement gate. Earlier
tasks must keep incomplete Pi creation unavailable to ordinary users.
Each change to an existing IPC domain updates its existing contract file, as required
by the project's decision journal. The table below assigns ownership of additions.

| Contract area | Owning task |
|---|---|
| Runtime identity, capabilities, error detail, event envelope | 01 |
| Installation diagnostics / compatibility manifest | 02 |
| Lifecycle and child ownership | 03 |
| Normalized transcript blocks and message/tool events | 04 |
| Resume references, projection checkpoint and recovery | 05 |
| Pi account kind, auth observations and setup PTY | 06 |
| Model descriptors, model selection and metrics | 07 |
| Queue/control input and events | 08 |
| Skills and supported action matrix | 09 |
| Profile discriminator and migration status | 10 |

## Validated product choices — 2026-09-18

1. Retain the existing runtimes during the first Pi release. Old sessions remain
   visible and resumable with their original runtime; there is no history conversion.
   The user explicitly approved coexistence for this release.
2. Integrate through a Rust-owned Pi RPC subprocess. Do not add a Node SDK sidecar.
3. Initially require a separately installed, explicitly certified Pi version.
   François neither silently installs nor updates Pi.
4. Pi owns credentials and conversation files. François owns UI metadata and a
   rebuildable transcript projection; no second authoritative conversation log.
5. Baseline Pi sessions have no François permission gate or claimed sandbox.
   Arbitrary Pi extensions stay disabled in this MVP; skills/templates are supported.
6. Project defaults continue to own account/model/effort. Profiles own prompts and
   runtime-specific tool/instruction configuration, preserving the existing journal rule.

## Research and evidence

[Current-state and Pi audit](research/pi-integration-audit.md) records concrete modules,
the RPC/JSON/SDK decision, ownership, source links, and the security model.
Research checked 2026-09-18; upstream source snapshot identifies itself as 0.85.1.
This is not proof that every feature on upstream main is in the published 0.85.1 package.
Task 02 certifies an immutable release artifact before production enablement. Wire fixtures
derived from docs are explicitly provisional until compared to a real Pi process.

## Coverage of the supplied brief

| Brief concern | Spec owner |
|---|---|
| Runtime abstraction, architecture options, domain interface | 01 + audit |
| Installation, Node, platforms, version drift | 02 |
| Process startup/shutdown, crashes, protocol faults, observability | 03 |
| Streaming, text/deltas, tools/results, images, event ordering | 04 |
| Session identity, trees, resume, corruption, upgrade recovery | 05 |
| API keys, OAuth, local providers, multiple credential profiles | 06 |
| Model picker, defaults, unavailable models, token/context/cost | 07 |
| Messages, steering, follow-ups, stop, compaction | 08 |
| Skills, MCP, agents, workflow/Remote Control gaps, extension trust | 09 |
| Profile/account/settings migration, acceptance matrix, rollout | 10 |
| Shell, git, diff, worktree independence | 01, 03, 10 |
| Security and accurate claims | audit, 03, 06, 09 |

## Existing backlog overlap

- `provider-model-catalogs` / `provider-usage-metrics`: 07 adds the Pi path only.
- `provider-effective-capabilities`: 01/09 add runtime-reported capability snapshots;
  reconcile shared type changes before either implementation merges.
- `provider-session-continuity`: 05/08 specify Pi continuity; existing runtime scope remains.
- `provider-settings-parity` / `provider-input-parity`: 04/10 cover Pi inputs/profiles.
- `capability-registry`: 09 supports Pi discovery without replacing a general registry.
- `provider-mcp-runtime`, `provider-agent-control`, `provider-workflow-runtime`, and
  `provider-remote-continuity`: no parity promise in this MVP, and no new implementation
  tasks to recreate those systems. Re-evaluate those cards separately; this freeze does not change them.

## Deferred beyond these ten tasks

Native approval interception, arbitrary Pi extension/package management, MCP/subagent/
workflow parity, branch-tree editing, Remote Control parity, managed/bundled Pi, and
exact subscription plan meters. Those are explicitly uncommitted follow-ups, not hidden
acceptance requirements. No legacy runtime is removed by this frozen programme.
