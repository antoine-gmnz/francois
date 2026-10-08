---
id: codex-subagents
title: Display Codex code-mode subagents
kind: patch
status: shipped
branch: fix/codex-subagents
reviewed_base: ccb00ec79e74676d179be0e3a9346e6896ed091a
reviewed_digest: 41a4306eb8649533
---

# Display Codex code-mode subagents

Codex 0.159.2 emits `subAgentActivity` items for code-mode agents. Read-only inspection
of installed Codex's generated protocol and existing session threads confirmed these
carry `agentThreadId`, `agentPath` and `kind`; accompanying collaboration items can
have empty `receiverThreadIds`. Francois previously ignored activity items entirely.

## Behavior

- Discover children from `subAgentActivity`, use the agent path's name and publish the
  existing `SubagentStarted` / `agent.update` projection for tabs and Activity.
- Subscribe to each newly discovered child's native thread and project its transcript.
- Map started/interacted to running, completed to done, interrupted to error.
- Deduplicate activity items per application turn generation, including replayed
  start/completion items after a follow-up has begun.
- Release a held parent turn completion when its final child completes through an
  activity item, as well as through child thread notifications.
- Preserve legacy `collabAgentToolCall` handling and its receiver-based lifecycle.
- Ignore invalid/unknown activity kinds and missing identities; retain the existing
  child limit and generation/turn isolation.

No public IPC contract changes and no frontend changes. Existing historical agent
registries are not reconstructed on app restart by this patch.

## Validation

Regression tests use a native wire fixture based on the installed 0.159.2 shapes:
agent discovery/name/replay/restart states, empty collaboration receivers, child
transcript projection, and parent completion arriving before its child's completion.
Full Rust suite, clippy and focused frontend agent/event/tab tests are required.
Native events were inspected read-only; a graphical/manual app run is not claimed.
