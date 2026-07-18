---
id: session-engine
title: Session Engine
status: frozen
created: 2026-07-18
depends_on: []
---

# Session Engine

## 1. Summary

The session engine is the Rust core of Francois: it owns the registry of Claude Code sessions (`SessionMeta`), spawns and supervises one Claude Code process per session (primary integration: the Rust core spawns `claude -p --output-format stream-json --include-partial-messages` per turn and parses its NDJSON output; escape hatch if stream-json proves insufficient: a bundled Node sidecar, shipped as a Tauri sidecar binary, running `@anthropic-ai/claude-agent-sdk`), and normalizes everything that process says into the `SessionEvent` stream broadcast on `francois:session:event`. Every other feature — sessions-sidebar, conversation-view, diff-view, agents-panel, mcp-panel, command-palette, cli-companion — is a client of this engine: they read `SessionMeta`/`SessionEvent` and call its IPC channels; they never talk to the Claude Code process directly. This spec is the authority on `SessionEvent` emission semantics (ordering, block/agent id allocation, streaming, tool-lifecycle summary/meta derivation, subagent progress estimation) and on the exact request/response contract for session lifecycle, sending, interrupting, model switching, and context compaction.

### Integration paths

Two ways the engine talks to Claude Code, both normalized to the exact same `SessionEvent` output:

- **Primary — stream-json CLI spawn**: `claude -p --output-format stream-json --include-partial-messages` is a one-shot invocation — it does not stay resident between turns. The Rust core spawns a **new child process per turn**, passing `--resume <claude_session_id>` (captured from the previous turn's `system init`/`result` message) and `--model <modelId>` to keep conversation continuity across per-turn process invocations. In this path, "the process" for a given turn exists only while that turn is in flight; there is no resident process while `status === 'idle'`.
- **Escape hatch — Agent SDK sidecar**: if stream-json proves insufficient, a bundled Node sidecar (packaged as a Tauri sidecar binary) running `@anthropic-ai/claude-agent-sdk`'s `query()` (or equivalent) gives a persistent, resumable conversation object per session. The SDK spawns the `claude` binary under the hood over stdio using the same structured protocol as the CLI path above; the core treats it as an opaque "session process."

Both paths are normalized internally to one event vocabulary before mapping to `SessionEvent` (see §5.4): `system.init`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta` (usage), `message_stop`, `tool_result` (harness-injected), `result` (turn/process summary). The rest of this spec describes behavior in terms of that normalized vocabulary; which path produced it is an implementation detail invisible to consumers of `SessionEvent`.

## 2. Goals & non-goals

- **Goals**:
  - Own the single source of truth for `SessionMeta` (creation, status, model, context usage, timestamps) across the app's lifetime.
  - Spawn/supervise exactly one Claude Code process (per-turn CLI child, or an SDK query via the sidecar escape hatch) per session entry.
  - Define and implement precise `running`/`idle`/`done`/`error` status semantics.
  - Emit the `SessionEvent` stream with exact, documented ordering, block/agent id allocation, and tool summary/meta derivation rules, so every consumer renders identically without re-deriving semantics.
  - Expose IPC channels for list/create/remove/send/interrupt/switchModel/compact/models, all returning `Result<T>`.
  - Persist session identity (name, cwd, model) across relaunches; restore as `idle` sessions.
  - Maintain an in-memory, per-session transcript block buffer so a feature that owns transcript hydration can rebuild a view without replaying the whole event history.
- **Non-goals**:
  - Any UI. Rendering the transcript, session list, diff, agents, MCP status, and skills lives in `conversation-view`, `sessions-sidebar`, `diff-view`, `agents-panel`, `mcp-panel`, `skills-panel` respectively.
  - PTY-backed shell terminals — that's `shell-terminal`; this engine never manages a PTY, and `session:remove` does not touch any PTY (shell-terminal owns its own teardown).
  - Git diff computation/staging/commit — `diff-view`.
  - MCP server attach/detach and skill invocation *initiation* — `mcp-panel`/`skills-panel`/`command-palette` own those flows; this engine only forwards the connection/tool state the CLI/SDK already reports for servers already configured for the session.
  - Command palette command registry/UI — `command-palette`; it calls into this engine's IPC channels like any other consumer.
  - Transcript/message persistence across relaunches (v1). Only session identity (name, cwd, model) is persisted; conversation history is not, by design (see §6).
  - The IPC channel that hydrates `conversation-view`'s transcript UI from the in-memory block buffer described in §6 is **owned and specified by the `conversation-view` spec** — this spec only guarantees the buffer exists, its shape, and its lifecycle; it does not define that channel's name or payload.

## 3. User stories / flows

There is no UI to click through here — these flows describe the observable contract other features (and, transitively, the user) drive through this engine's IPC/events.

### 3.1 Create a session

1. User picks "+ new session" in sessions-sidebar (`n`) or "New session" in the command palette, and supplies a working directory (and optionally a name / model).
2. Caller invokes `francois:session:create` with `{ cwd, name?, modelId? }`.
3. Engine validates `cwd` exists and is a directory (else `INVALID_INPUT`), validates `modelId` if given is in the model catalog (else `INVALID_INPUT`), then eagerly prepares the per-turn CLI path (or spawns the underlying SDK query, escape hatch) for that `cwd`+model.
4. If spawn fails (binary missing, not authenticated, etc.) the call resolves `ok:false` with `SPAWN_FAILED`; no registry entry is created and no `session.meta` is emitted.
5. On success, a new `SessionMeta` is registered with `status: 'idle'`, the call resolves `ok:true` with that `SessionMeta`, the engine emits `session.meta`, and persists the session identity to disk.

### 3.2 Send a message and watch a turn run

1. User types in the SESSION input bar (conversation-view) and submits.
2. Caller invokes `francois:session:send` with `{ sessionId, text }`.
3. If a turn is already in flight (`status: 'running'`), the text is appended to that session's FIFO queue; the call resolves immediately with `{ queued: true, queuePosition }`.
4. Otherwise the engine allocates a `BlockId`, emits `message.user`, transitions to `status: 'running'` (emits `session.status`), and submits the text as a new turn.
5. As the model streams a text content block, the engine allocates a `BlockId` for it and emits a run of `assistant.delta` events (each carrying an incremental text chunk), closed by `assistant.done`.
6. When the model calls a tool, the engine allocates a `BlockId` for that tool_use block; once the tool's full input is known it emits `tool.start` (with a derived `summary`); once the tool's result arrives it emits `tool.done` (with a derived `meta`). If the tool is `Task` (subagent dispatch), the engine additionally mints an `AgentId` and drives an `agent.update` lifecycle (§5.4) alongside the ordinary `tool.start`/`tool.done` pair.
7. Steps 5–6 repeat for every content block in the turn, in the order the model produced them.
8. When the turn ends, the engine emits `context.usage`, and — if the queue is non-empty — immediately starts the next queued turn (repeat from step 4, no observable `idle` blip); otherwise it transitions to `status: 'idle'` (emits `session.status`).

### 3.3 Interrupt a running turn

1. User interrupts (a hotkey/button surfaced by conversation-view; out of scope for this spec).
2. Caller invokes `francois:session:interrupt` with `{ sessionId }`.
3. If `status !== 'running'`, this is a no-op: resolves `ok:true`, nothing else happens.
4. If `status === 'running'`, the engine aborts the in-flight turn, closes any block left open (`assistant.done` for an open text block, `tool.done` with `meta: 'interrupted'` for an open tool block), and then applies the same turn-completion routing as step 8 above (drain the queue if non-empty, else go `idle`). An interrupt is not an error and does not clear the queue.

### 3.4 Switch model mid-session

1. User picks "Switch model" from the command palette and chooses sonnet/opus/haiku.
2. Caller invokes `francois:session:switchModel` with `{ sessionId, modelId }`.
3. Engine validates the session exists, is not `done`/`error`, and `modelId` is a known catalog entry.
4. `SessionMeta.model` is updated immediately and `session.meta` is emitted, so the UI reflects the new selection right away. An in-flight turn (if any) keeps running on the model it started with; the new model is used starting with the next turn submitted to the CLI/SDK.

### 3.5 Compact context

1. User picks "Compact context" from the command palette.
2. Caller invokes `francois:session:compact` with `{ sessionId }`.
3. If a turn is in flight, the call resolves `ok:false` with `SESSION_ALREADY_RUNNING` (compaction is not queued behind messages — the caller retries once idle).
4. If idle, the engine transitions to `status: 'running'` (emits `session.status`), asks the CLI/SDK to compact the conversation history, then emits `context.usage` with the reduced `usedTokens`, and returns to `status: 'idle'` (emits `session.status`).

### 3.6 Remove a session

1. User removes a session (sessions-sidebar / command palette action; out of scope for this spec's UI).
2. Caller invokes `francois:session:remove` with `{ sessionId }`.
3. Engine aborts any in-flight turn, kills the underlying process/query, discards the queue, deletes the registry entry and its persisted identity, and emits exactly one `session.removed`. No further `SessionEvent` for that `sessionId` is emitted afterward.

### 3.7 Relaunch the app

1. User quits and reopens Francois.
2. On startup, the engine reads the persisted session list from disk and registers one `SessionMeta` per entry with `status: 'idle'`, a fresh `startedAt`/`lastActivityAt`, `contextUsedTokens: 0`, and no live underlying process yet (spawned lazily on first `send`, see §4). No `session.meta` replay happens automatically at this point — the app-shell/sessions-sidebar bootstrap by calling `francois:session:list` on mount, which (per §4) also triggers the replay.
3. The restored session's conversation is empty; there is no memory of the pre-relaunch transcript (v1 does not persist transcripts).

## 4. Functional requirements

### Registry & status

- **FR-1**: The engine maintains a single in-process registry keyed by `SessionId`, holding one record per session that is a superset of the public `SessionMeta` (see §6 for the runtime-only fields).
- **FR-2**: `SessionStatus` is defined precisely as:

  | Status | Meaning | Entered when |
  |---|---|---|
  | `running` | A turn, or a compaction, is currently in flight for this session. | A turn starts (§3.2 step 4) or a compaction starts (§3.5 step 4). |
  | `idle` | The underlying process/query is ready and awaiting the next user input. | Session created/restored; a turn or compaction completes with no queued follow-up; after an interrupt whose queue is empty. |
  | `done` | The session ended cleanly and will not run further turns, but was not removed. | The underlying SDK query (escape-hatch sidecar path) reports it has closed/completed on its own initiative (not via `interrupt`/`remove`, and not a crash). **v1 limitation**: reachable only via the escape-hatch Agent SDK sidecar path — the primary stream-json CLI path (per-turn process) has no persistent object that can signal "conversation over" between turns, so a stream-json-path session in v1 only reaches a terminal state via explicit `remove` or via `error`; it never spontaneously becomes `done`. |
  | `error` | Spawn, stream, or process failure. `errorMessage` is set. | Spawn fails (create-time or lazy first-send); the process/query crashes or the stream reports a fatal error mid-turn or mid-compaction. |

- **FR-3**: `session.status` (the lightweight event) is emitted on every status transition. `session.meta` (the full snapshot) is **not** re-emitted merely for a status change — consumers merge `session.status` into their locally held copy of `SessionMeta`.
- **FR-4**: `session.meta` (full snapshot) is emitted on: session creation (§3.1), session restore-from-persistence at startup is **not** individually broadcast (see FR-9 — restored sessions become visible via the `list` replay, since nothing is listening yet at process boot), `francois:session:list` replay (FR-9), and `switchModel` (model field change, FR-23). It is the only event that carries the `model` field, so it is the only way a model change is observed.
- **FR-5**: `lastActivityAt` is updated in the registry on every `SessionEvent` emitted for that session (including deltas), but updating it does not itself trigger a `session.meta` broadcast — the value is reflected the next time `session.meta` is emitted or `francois:session:list` is called.
- **FR-6**: `startedAt` is set once, at session creation or at restore time (restore uses the relaunch timestamp, not the original creation time, since it is not persisted — see §6). Elapsed-time display is derived by the frontend from `startedAt`/`Date.now()`; the engine does not tick or broadcast elapsed time.

### Create / list / models / remove

- **FR-7**: `francois:session:create` validates `cwd` via a filesystem stat: it must exist and be a directory. Failure → `INVALID_INPUT`.
- **FR-8**: If `modelId` is provided and is not a member of the model catalog (§5.2), `create` fails with `INVALID_INPUT`. If omitted, the first catalog entry is used as the default.
- **FR-9**: `create` eagerly prepares the per-turn CLI path (or spawns the underlying SDK query, escape hatch) before resolving. Spawn failure (binary not found, not authenticated, process exits non-zero before producing a valid `system.init`) resolves `ok:false` with `SPAWN_FAILED` and creates no registry entry; success resolves `ok:true` with the new `SessionMeta` (`status: 'idle'`), emits `session.meta`, and persists the identity (name, cwd, modelId).
- **FR-10**: Duplicate `create` calls with the same `cwd` are allowed; each session is a fully independent registry entry with its own process/query and conversation.
- **FR-11**: `francois:session:list` resolves `ok:true` with the full current `SessionMeta[]` in registry (creation) order.
- **FR-12**: Calling `francois:session:list` is the subscribe signal for the event channel: immediately before the invoke resolves, the engine re-emits one `session.meta` per registry entry, in registry order, on `francois:session:event`. This lets any freshly attached listener (a newly mounted window/component) converge without a dedicated subscribe handshake.
- **FR-13**: `francois:session:models` resolves `ok:true` with the static v1 model catalog (§5.2); it does not depend on a live process and always succeeds barring `INTERNAL`.
- **FR-14**: `francois:session:remove` aborts any in-flight turn, kills the process/query, discards the queue, deletes the registry entry and its persisted identity, and emits exactly one `session.removed`. Unknown `sessionId` → `SESSION_NOT_FOUND` (including calling `remove` twice on the same id).

### Send / turn lifecycle

- **FR-15**: `send` on an unknown `sessionId` → `SESSION_NOT_FOUND`.
- **FR-16**: `send` with empty or whitespace-only `text` → `INVALID_INPUT`.
- **FR-17**: `send` when `status` is `done` or `error` → `SESSION_NOT_RUNNING` (there is no live process to accept input; the caller must create a new session).
- **FR-18**: `send` when `status === 'running'` enqueues `text` onto that session's FIFO queue (cap 20 — see FR-44) and resolves `ok:true` with `{ queued: true, queuePosition }` (1-based position after enqueue). No turn is started or blocked touched by this call.
- **FR-19**: `send` when `status === 'idle'`: if the session has no live underlying process/query yet (a restored session's first `send`), the engine lazily spawns it first, synchronously as part of handling the call. Spawn failure resolves the call `ok:false` with `SPAWN_FAILED` **and** sets `status: 'error'` + emits `session.error` then `session.status` (so subscribers other than the caller also learn the session is now broken). On spawn success (or if already spawned), the engine emits `message.user` (new `BlockId`), transitions to `status: 'running'` (emits `session.status`), submits the text as a new turn, and resolves `ok:true` with `{ queued: false }`.
- **FR-20**: Turn completion (no more content blocks; a terminal usage/result signal received): if the queue is non-empty, the engine immediately dequeues the next entry and submits it as a new turn — `message.user` is emitted for it, `status` remains `running`, and no `session.status` idle transition is observed in between. If the queue is empty, the engine transitions to `status: 'idle'` and emits `session.status`.
- **FR-21**: `context.usage` is emitted once per completed turn (success or interrupted-with-usage-available), derived per §5.4.

### Interrupt

- **FR-22**: `interrupt` on an unknown `sessionId` → `SESSION_NOT_FOUND`.
- **FR-23**: `interrupt` when `status !== 'running'` (`idle`, `done`, or `error`) is a no-op: resolves `ok:true` with `null`, no events emitted.
- **FR-24**: `interrupt` when `status === 'running'` aborts the current turn (SIGINT then SIGTERM-on-timeout for the per-turn CLI child, or SDK abort for the sidecar escape hatch), closes any block left open (`assistant.done` for an open text block; `tool.done` with `meta: 'interrupted'` for an open tool block), then applies FR-20's completion routing. An interrupted turn is treated as a normal (non-error) completion for queue-draining purposes.

### Switch model

- **FR-25**: `switchModel` on an unknown `sessionId` → `SESSION_NOT_FOUND`; unknown `modelId` → `INVALID_INPUT`; `status` `done`/`error` → `SESSION_NOT_RUNNING`.
- **FR-26**: Otherwise, `SessionMeta.model` is updated immediately regardless of `running`/`idle` and `session.meta` is emitted; the call resolves `ok:true` with the updated `SessionMeta`. The new model applies starting with the next turn submitted to the CLI/SDK; an in-flight turn is unaffected.

### Compact

- **FR-27**: `compact` on an unknown `sessionId` → `SESSION_NOT_FOUND`; `status` `done`/`error` → `SESSION_NOT_RUNNING`; `status === 'running'` → `SESSION_ALREADY_RUNNING` (rejected outright, not queued).
- **FR-28**: `compact` when `status === 'idle'` transitions to `running` (emits `session.status`), invokes the CLI/SDK's compaction, emits `context.usage` with the reduced `usedTokens`/`limitTokens` on completion, then transitions back to `idle` (emits `session.status`). The call resolves `ok:true` with `null` once the full cycle completes.

### Event ordering & id allocation

- **FR-29**: All `SessionEvent`s for a given `sessionId` are emitted in the exact order they logically occur (FIFO per session). There is no ordering guarantee across different sessions' events.
- **FR-30**: `assistant.delta.text` is an incremental chunk (append semantics) — consumers concatenate deltas in arrival order to reconstruct the full text. It is never the cumulative text so far.
- **FR-31**: `BlockId` allocation: exactly one per user-submitted turn (`message.user`, allocated at turn start — i.e. at dequeue/send time, not at enqueue time), one per contiguous assistant text content block (`assistant.delta`\*/`assistant.done`), and one per tool_use content block (`tool.start`/`tool.done`). IDs are fresh uuid v4s, never reused.
- **FR-32**: `AgentId` allocation is independent of `BlockId`: one `AgentId` is minted per `Task` tool dispatch, at the same moment as that call's `BlockId`, but tracked in a separate registry (`AgentInfo` keyed by `AgentId`) — the transcript block and the agent record are two different objects referencing the same dispatch.
- **FR-33**: `tool.start` is emitted once per tool_use block, only once its full input JSON has been assembled (not at the first partial input token) — `summary` is derived from the complete input (§5.4). `tool.done` is emitted once per tool_use block, when its paired `tool_result` arrives.
- **FR-34**: On a process crash or fatal stream error mid-turn, the engine first closes any currently-open block exactly as in FR-24 (so nothing is left open indefinitely), then emits `session.error` (carrying an `AppError`), then `session.status` with `status: 'error'`. Any still-queued messages are discarded (the session is no longer usable — see §7).

### Tool / subagent / MCP mapping

- **FR-35**: `summary` (on `tool.start`) and `meta` (on `tool.done`) for known tools are derived exactly per the mapping table in §5.4; tools not listed there use the documented fallback rule.
- **FR-36**: The `Edit`/`MultiEdit` `+N −M` counts are computed by the deterministic common-affix line-trim algorithm in §5.4 — no external diff library is required.
- **FR-37**: On a `Task` tool dispatch, the engine mints an `AgentId`, creates `AgentInfo { status: 'running', progress: 0, name: <subagent_type>, task: <description> }`, and emits `agent.update` immediately (in addition to the ordinary `tool.start` for that same call).
- **FR-38**: While an agent is `running` with no explicit progress signal from the CLI/SDK, its `progress` ramps on a fixed timer per the formula in §5.4, re-emitted via `agent.update` at most every 2000ms; `progress` is monotonically non-decreasing per agent and capped at 90 until the subagent finishes.
- **FR-39**: On the `Task`'s `tool_result`, the engine sets `status: 'done'`, `progress: 100`, updates `task` to a short result excerpt (§5.4), emits a final `agent.update`, stops the ramp timer, and emits the paired `tool.done`.
- **FR-40**: If the session errors/crashes while an agent is `running`, that agent's `status` is set to `'error'` and a final `agent.update` is emitted (progress left unchanged).
- **FR-41**: On session process init, and on any subsequent MCP connection-state change reported by the CLI/SDK, the engine emits `mcp.update` per server mirroring the reported `status`/`toolCount`/`errorMessage` (tool count derived per §5.4's prefix-grouping rule) — no engine-side heuristics beyond that grouping.

### Persistence

- **FR-42**: After any `create`, `remove`, or `switchModel` call that changes the persisted subset of fields (`{ id, name, cwd, modelId }`), the engine (re)writes the full session list to `sessions.json` under the Tauri app data dir (`app_data_dir()`).
- **FR-43**: On app start, the engine reads `sessions.json`; a missing or unparsable file is treated as an empty list (no error surfaced to the user). One registry entry is created per persisted record with `status: 'idle'`, fresh `startedAt`/`lastActivityAt` (`Date.now()` at boot), `contextUsedTokens: 0`, `contextLimitTokens` from the catalog for the persisted `modelId` (falling back to the default model if that id is no longer in the catalog), and **no live process/query** — it is spawned lazily on the first `send` (FR-19). Conversation history is never persisted; a restored session's transcript starts empty.

### Limits

- **FR-44**: The per-session send queue is capped at 20 pending entries. A `send` call while the queue is already at the cap resolves `ok:false` with `INVALID_INPUT` and does not enqueue.
- **FR-45**: `SPAWN_FAILED` messages distinguish, where the underlying failure allows it, "binary not found" from "not authenticated" causes (see §7), so the UI can show an actionable message without further engine calls.

## 5. API contract

Mechanism: shared TypeScript interfaces in `contract/session-engine.ts`, importing shared vocabulary from `contract/common.ts` and never redefining it. All request/response channels follow the app-wide convention: `invoke('session_<verb>', payload)` → `Promise<Result<T>>` (frontend → core; Tauri command `session_<verb>` bound to logical channel `francois:session:<verb>`). The event channel follows the app-wide convention: one channel per domain, `francois:session:event` (Tauri event `francois://session/event`), core → frontend, payload a `SessionEvent` (already defined in `contract/common.ts` — this spec does not add members to that union).

This feature does not need to extend `ErrorCode` — it uses only existing members: `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, `SESSION_ALREADY_RUNNING`, `SPAWN_FAILED`, `INVALID_INPUT`, `INTERNAL`.

### 5.1 Request/response channels

| Channel | Payload | `Result<T>` data | Error codes |
|---|---|---|---|
| `francois:session:list` | *(none)* | `SessionMeta[]` | `INTERNAL` |
| `francois:session:create` | `SessionCreateInput` | `SessionMeta` | `INVALID_INPUT`, `SPAWN_FAILED`, `INTERNAL` |
| `francois:session:remove` | `SessionRemoveInput` | `null` | `SESSION_NOT_FOUND`, `INTERNAL` |
| `francois:session:send` | `SessionSendInput` | `SessionSendOutput` | `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, `INVALID_INPUT`, `SPAWN_FAILED`, `INTERNAL` |
| `francois:session:interrupt` | `SessionInterruptInput` | `null` | `SESSION_NOT_FOUND`, `INTERNAL` |
| `francois:session:switchModel` | `SessionSwitchModelInput` | `SessionMeta` | `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, `INVALID_INPUT`, `INTERNAL` |
| `francois:session:compact` | `SessionCompactInput` | `null` | `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, `SESSION_ALREADY_RUNNING`, `INTERNAL` |
| `francois:session:models` | *(none)* | `ModelInfo[]` | `INTERNAL` |

**Model catalog (v1, static)** — returned by `francois:session:models`; also the valid set for `create.modelId`/`switchModel.modelId`. `contextLimitTokens` is not part of `ModelInfo` (that type is fixed in `common.ts`); the engine tracks the context window per model internally and reflects it in `SessionMeta.contextLimitTokens`.

| `id` | `label` | internal context window |
|---|---|---|
| `claude-sonnet-4-5` | `Sonnet 4.5` | 200,000 tokens |
| `claude-opus-4` | `Opus 4` | 200,000 tokens |
| `claude-haiku-4` | `Haiku 4` | 200,000 tokens |

`claude-sonnet-4-5` is the default when `create` omits `modelId`.

### 5.2 Types (`contract/session-engine.ts`)

```ts
import type {
  SessionId,
  SessionMeta,
} from './common';

/** francois:session:create */
export interface SessionCreateInput {
  cwd: string; // absolute path; must exist and be a directory
  name?: string; // defaults to basename(cwd)
  modelId?: string; // defaults to 'claude-sonnet-4-5'; must be a session:models entry
}

/** francois:session:remove */
export interface SessionRemoveInput {
  sessionId: SessionId;
}

/** francois:session:send */
export interface SessionSendInput {
  sessionId: SessionId;
  text: string; // non-empty after trim
}

export interface SessionSendOutput {
  queued: boolean; // true if a turn was already in flight and this text was enqueued
  queuePosition?: number; // 1-based FIFO position; present iff queued === true
}

/** francois:session:interrupt */
export interface SessionInterruptInput {
  sessionId: SessionId;
}

/** francois:session:switchModel */
export interface SessionSwitchModelInput {
  sessionId: SessionId;
  modelId: string;
}

/** francois:session:compact */
export interface SessionCompactInput {
  sessionId: SessionId;
}
```

`francois:session:list` and `francois:session:models` take no payload; their `Result<T>` shapes (`SessionMeta[]`, `ModelInfo[]`) are already fully expressed by existing `common.ts` types and need no additional request type.

### 5.3 Event channel

`francois:session:event` carries `SessionEvent` (defined in `contract/common.ts`, reproduced here for reference only — this spec never redefines it):

```ts
export type SessionEvent =
  | { type: 'session.meta'; meta: SessionMeta }
  | { type: 'session.status'; sessionId: SessionId; status: SessionStatus }
  | { type: 'session.removed'; sessionId: SessionId }
  | { type: 'message.user'; sessionId: SessionId; blockId: BlockId; text: string }
  | { type: 'assistant.delta'; sessionId: SessionId; blockId: BlockId; text: string }
  | { type: 'assistant.done'; sessionId: SessionId; blockId: BlockId }
  | { type: 'tool.start'; sessionId: SessionId; blockId: BlockId; tool: string; summary: string }
  | { type: 'tool.done'; sessionId: SessionId; blockId: BlockId; meta: string }
  | { type: 'agent.update'; agent: AgentInfo }
  | { type: 'mcp.update'; sessionId: SessionId; server: McpServerInfo }
  | { type: 'context.usage'; sessionId: SessionId; usedTokens: number; limitTokens: number }
  | { type: 'session.error'; sessionId: SessionId; error: AppError };
```

Quick emission index (full semantics in §4 and §5.4):

| Member | Emitted when |
|---|---|
| `session.meta` | Create, `list` replay (once per registry entry), `switchModel` |
| `session.status` | Every status transition (FR-3) |
| `session.removed` | `remove` completes |
| `message.user` | A turn starts (fresh send, or a dequeued queued message) |
| `assistant.delta` | Each text delta chunk within an assistant text content block |
| `assistant.done` | A text content block closes (normally or via interrupt/crash closure) |
| `tool.start` | A tool_use block's input is fully assembled |
| `tool.done` | The paired `tool_result` arrives (or synthetic closure on interrupt/crash) |
| `agent.update` | Task dispatch, progress ramp tick, completion, or error closure |
| `mcp.update` | Session init, or an MCP server status change |
| `context.usage` | End of every completed turn; end of a compaction |
| `session.error` | Spawn failure via `send`'s lazy path, or a crash/fatal stream error |

### 5.4 CLI/SDK → `SessionEvent` mapping

Normalized source vocabulary (see §1): `system.init`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta` (usage), `message_stop`, `tool_result`, `result`.

| Source event | Condition | `SessionEvent` emitted | Field derivation |
|---|---|---|---|
| `system.init` | Session process/query ready | *(none directly)* | Captures `claude_session_id` (for CLI `--resume`), `cwd`, initial `tools`/`mcp_servers` list for the mcp.update pass below |
| `system.init` `mcp_servers[]` | Once, and again on any reported change | `mcp.update` (one per server) | `server.name`; `status`/`toolCount`/`errorMessage` mirrored from the CLI/SDK's reported state; `toolCount` = count of entries in `tools[]` whose name matches `mcp__<server>__*` |
| `content_block_start` (`type: 'text'`) | New assistant text block | *(none — `BlockId` allocated silently; first delta reveals it)* | — |
| `content_block_delta` (`text_delta`) | Text chunk for an open text block | `assistant.delta` | `text` = the delta chunk verbatim (incremental, not cumulative) |
| `content_block_stop` (text block) | Text block closes | `assistant.done` | `blockId` of that block |
| `content_block_start` (`type: 'tool_use'`) | New tool_use block | *(none — `BlockId` allocated silently, input buffered)* | — |
| `content_block_delta` (`input_json_delta`) | Partial tool input | *(none — buffered internally)* | Accumulated into the full input JSON |
| `content_block_stop` (tool_use block) | Full input JSON assembled | `tool.start` | `tool` = tool name; `summary` per the per-tool rules below |
| `content_block_start` (`type: 'tool_use'`, `name: 'Task'`) | Subagent dispatch | `agent.update` (in addition to the `tool.start` above) | Mint `AgentId`; `AgentInfo{ status:'running', progress:0, name: input.subagent_type ?? input.description, task: input.description, sessionId }` |
| Ramp timer, every 2000ms while a `Task` agent is `running` | No explicit progress signal | `agent.update` | `progress = min(90, round((now - dispatchedAt) / 90000 * 90))`, monotonically non-decreasing |
| `tool_result` (harness-injected `user` message) | Matched to its `tool_use_id` → `BlockId` | `tool.done` | `meta` per the per-tool rules below; if `is_error`, `meta` per the error rule below |
| `tool_result` for a `Task` tool_use | Subagent finished | `agent.update` (in addition to `tool.done`) | `status:'done', progress:100`; `task` = first line of the result text (≤80 chars), else unchanged |
| `message_delta` / final `result` usage | Turn (or compaction) completes | `context.usage` | `usedTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens`; `limitTokens` = catalog constant (§5.1) for the session's current model |
| `result` (turn ends, no error) | See FR-20 | `session.status` (`running`→`running` if queue non-empty, else `running`→`idle`) | — |
| `result` (subtype indicates fatal error) or process/query error | Mid-turn failure | `session.error` then `session.status` (`error`) | Per FR-34; `AppError.code` = `INTERNAL` (unless caused by a lazy-spawn failure, in which case `SPAWN_FAILED`), `message` = actionable description (§7) |

**Per-tool `summary` (tool.start) / `meta` (tool.done) derivation:**

| Tool | `summary` | `meta` |
|---|---|---|
| `Read` | Path of `input.file_path`, relative to session `cwd` if under it, else absolute | `'<N> lines'`, N = line count of the returned file content |
| `Grep` | `input.pattern`, truncated to 60 chars | Content mode: `'<matches> matches · <files> files'` (matches = result line count; files = count of distinct file-path prefixes across result lines). Files-only mode: `'<files> files'`. Zero results: `'no matches'` |
| `Glob` | `input.pattern` | `'<N> files'`, N = result count |
| `Edit` / `MultiEdit` | Path of `input.file_path`, relative to `cwd` if under it | `'+<N> −<M>'` per the diff algorithm below (summed across all edits for `MultiEdit`) |
| `Write` | Path of `input.file_path`, relative to `cwd` if under it | `'<N> lines'`, N = line count of `input.content` |
| `Bash` | `input.command`, newlines collapsed to spaces, truncated to 60 chars | Success: `'<N> lines'` of stdout, or `'done'` if stdout is empty. Non-zero exit: `'exit <code>'` |
| `Task` | `input.subagent_type` (fallback `input.description`) | First line of the result text (≤80 chars), fallback `'done'` |
| `WebFetch` / `WebSearch` | `input.url` / `input.query` | `'done'` on success, `'error'` on failure |
| *(any other tool)* | First string-valued property of `input` (fallback: `JSON.stringify(input)`), truncated to 60 chars | `'done'` on success, `'error'` on failure |
| *(any tool, error result)* | *(as above)* | `'error'` (all rules above are overridden by this when `tool_result.is_error === true`) |

**Edit/MultiEdit line-diff algorithm** (deterministic, no external diff library): split `old_string` and `new_string` on `\n`. Trim the common leading lines (equal at the same index) and the common trailing lines (equal counting from the end), without letting the two trims overlap. The remaining old-line count is `M` (the `−` count); the remaining new-line count is `N` (the `+` count); `meta = '+<N> −<M>'` (a true no-op edit yields `'+0 −0'`).

## 6. Data & state

**Owned in the Rust core (this feature):**

- `SessionRegistry: Map<SessionId, InternalSessionRecord>`, where `InternalSessionRecord` is a superset of the public `SessionMeta`:
  - the public `SessionMeta` fields (id, name, cwd, model, status, contextUsedTokens, contextLimitTokens, startedAt, lastActivityAt, errorMessage?)
  - `queue: string[]` — pending `send` text, FIFO, capped at 20 (FR-44)
  - a handle to the live underlying process/query (the current per-turn CLI child process, or an SDK query object via the sidecar escape hatch; `undefined` while idle on the CLI path, or before the first lazy spawn of a restored session)
  - `openBlock?: { blockId: BlockId; kind: 'text' | 'tool' }` — tracks the currently-open block for interrupt/crash closure (FR-24/FR-34)
  - `toolUseIndex: Map<string, BlockId>` — maps the CLI/SDK's `tool_use_id` to the `BlockId` allocated for it, for pairing `tool_result` → `tool.done`
  - `agents: Map<AgentId, AgentInfo>` — this session's subagent records, plus each running agent's ramp-timer handle
  - `blockBuffer: TranscriptBlock[]` — an ordered, in-memory record of every block emitted for this session so far (one entry per `message.user`, per closed assistant text block with its concatenated final text, per tool call with its `tool`/`summary`/`meta`), rebuilt from nothing on process start (never persisted, per FR-43). This buffer is the integration point for `conversation-view`'s own transcript-hydration channel (owned by that feature's spec, not this one) — this spec guarantees the buffer's existence, ordering, and content shape (mirroring the corresponding `SessionEvent`s) but not the IPC surface that reads it, since that surface's shape is `conversation-view`'s to define.
  - `mcpServers: Map<string, McpServerInfo>` — last known status per server, for the `mcp.update` replay-on-init and for answering any future "current state" query another feature might add.

- Persisted subset (`sessions.json` under the Tauri app data dir, `app_data_dir()`): `Array<{ id: SessionId; name: string; cwd: string; modelId: string }>`. Nothing else (no status, no timestamps, no transcript, no context usage) is persisted — see FR-43 and the non-goals in §2.

**Not owned here:**

- Frontend-side state (sessions-sidebar's list view-model, conversation-view's transcript view-model, agents-panel's card list, mcp-panel's server list) — each of those features owns its own store (zustand), populated by calling `francois:session:list`/`francois:session:models` on mount and merging `SessionEvent`s thereafter, per the merge pattern implied by FR-3/FR-4 (`session.status`, `context.usage`, and `session.error` update individual fields of a locally held `SessionMeta` copy; `session.meta` replaces it wholesale).
- Elapsed time display (`SessionMeta.startedAt` → frontend-computed `mm:ss`, ticking client-side; FR-6).
- Git state, PTY state, skills catalog — owned by `diff-view`, `shell-terminal`, `skills-panel` respectively; this engine has no data or hooks for any of them.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| `claude` binary not found on `PATH` | `create`/lazy-spawn resolves `ok:false`, `code: 'SPAWN_FAILED'`, `message` along the lines of "Claude Code CLI not found. Install it and ensure `claude` is on PATH." No registry entry (for `create`); for lazy-spawn, session → `error` (FR-19). |
| `claude` found but not authenticated | Spawn succeeds at the OS level but the process exits/streams an auth error before a usable `system.init`. `SPAWN_FAILED`, `message` along the lines of "Not logged in to Claude Code. Run `claude` once in a terminal to authenticate." |
| `cwd` does not exist / is a file, not a directory | `create` → `INVALID_INPUT` before any spawn attempt (FR-7). |
| `cwd` deleted after the session was created | The next turn's process/query fails with a filesystem error mid-turn → treated as a crash (FR-34): open block closed, `session.error` + `session.status: 'error'`, queue discarded. The session must be removed and recreated; there is no repair-in-place. |
| Process crashes mid-turn (any reason) | Any open block is closed (`assistant.done`, or `tool.done` with `meta: 'interrupted'`), then `session.error` then `session.status: 'error'`, `errorMessage` set from the `AppError.message`; queued messages are discarded (FR-34). |
| Duplicate `create` on the same `cwd` | Allowed — sessions are fully independent processes/conversations even when they share a working directory (FR-10). |
| `interrupt` when `idle`/`done`/`error` | No-op, `ok:true`, no events (FR-23). |
| `send` queue at cap (20 pending) | 21st concurrent `send` while running → `ok:false`, `INVALID_INPUT`, message noting the queue is full; nothing enqueued (FR-44). |
| `send`/`switchModel`/`compact`/`interrupt`/`remove` on unknown `sessionId` | `SESSION_NOT_FOUND`. |
| `send`/`switchModel`/`compact` on a `done`/`error` session | `SESSION_NOT_RUNNING` — there is no live process; a new session must be created. |
| `compact` while a turn is in flight | `SESSION_ALREADY_RUNNING`, rejected outright (not queued) — retry once idle. |
| `create`/`switchModel` with an unknown `modelId` | `INVALID_INPUT`. |
| `remove` while a turn is in flight | The in-flight turn is aborted the same way `interrupt` would, then teardown proceeds; only `session.removed` is emitted (no separate `session.status`/`session.error` — the session is gone). |
| Restored session never sent to (idle since app boot) | No process/query is ever spawned for it — spawn only happens lazily on the first `send` (FR-19, FR-43). |
| `sessions.json` missing or unparsable at startup | Treated as an empty list; app boots with zero restored sessions; no error surfaced to the user (FR-43). |

## 8. Design brief

Backend feature — no UI. All strings this engine produces (status dots, model labels, context usage, tool `summary`/`meta` one-liners, agent progress) are rendered by `sessions-sidebar`, `conversation-view`, `agents-panel`, and `mcp-panel`; see those specs' design briefs for the visual treatment (`Claude Terminal.dc.html` §SIDEBAR, §MAIN/SESSION tab, §AGENTS, §MCP SERVERS).

## 9. Acceptance criteria

- [ ] `create` with a valid, existing `cwd` resolves `ok:true` with `SessionMeta.status === 'idle'` and emits exactly one `session.meta`. (FR-7, FR-9)
- [ ] `create` with a non-existent or non-directory `cwd` resolves `ok:false`, `error.code === 'INVALID_INPUT'`, and creates no registry entry. (FR-7)
- [ ] `create` when the `claude` binary cannot be spawned resolves `ok:false`, `error.code === 'SPAWN_FAILED'`, with an actionable `message` distinguishing "not found" from "not authenticated" where determinable. (FR-9, FR-45)
- [ ] Two `create` calls with the same `cwd` both succeed and produce two independent `SessionMeta` entries. (FR-10)
- [ ] `send` on an idle session emits, in order, `session.status(running)`, `message.user`, one or more `assistant.delta`/`tool.start`/`tool.done` events, `context.usage`, and finally `session.status(idle)`. (FR-19, FR-20, FR-21, FR-29)
- [ ] `send` while a turn is in flight resolves `ok:true` with `{ queued: true, queuePosition: 1 }` for the first queued message, and does not start a new turn until the in-flight one completes. (FR-18, FR-20)
- [ ] `send` queued past the 20-entry cap resolves `ok:false`, `error.code === 'INVALID_INPUT'`. (FR-44)
- [ ] `send` on a `done`/`error` session resolves `ok:false`, `error.code === 'SESSION_NOT_RUNNING'`. (FR-17)
- [ ] `interrupt` on a running session aborts the in-flight turn, closes any open block, and — if the queue is non-empty — starts the next queued turn without an observable idle transition. (FR-24, FR-20)
- [ ] `interrupt` on an idle, done, or error session resolves `ok:true` and emits nothing. (FR-23)
- [ ] `switchModel` updates `SessionMeta.model` and emits `session.meta` immediately, without disturbing an in-flight turn. (FR-26)
- [ ] `compact` on an idle session cycles `session.status(running)` → `context.usage` (reduced `usedTokens`) → `session.status(idle)`. (FR-28)
- [ ] `compact` while a turn is in flight resolves `ok:false`, `error.code === 'SESSION_ALREADY_RUNNING'`. (FR-27)
- [ ] A `Read` tool call's `tool.start.summary` is the file path relative to `cwd`, and its `tool.done.meta` matches `'<N> lines'`. (FR-35)
- [ ] A `Grep` tool call's `tool.done.meta` matches `'<matches> matches · <files> files'` in content mode. (FR-35)
- [ ] An `Edit` tool call's `tool.done.meta` matches `'+<N> −<M>'` as computed by the common-affix line-diff algorithm. (FR-36)
- [ ] A `Task` tool call mints a distinct `AgentInfo`, ramps `progress` monotonically capped at 90 while `running`, then jumps to `progress: 100`, `status: 'done'` on completion. (FR-37, FR-38, FR-39)
- [ ] `remove` kills the process/query, discards the queue, and emits exactly one `session.removed`; no further `SessionEvent` referencing that `sessionId` is observed afterward. (FR-14)
- [ ] Restarting the app restores every persisted session as `status: 'idle'` with the same `id`/`name`/`cwd`/`model`, a fresh `startedAt`, and an empty transcript. (FR-43)
- [ ] Calling `francois:session:list` also re-emits one `session.meta` per registry entry on `francois:session:event`, in registry order, before the invoke resolves. (FR-12)
- [ ] A process crash mid-turn closes any open block, discards the queue, sets `status: 'error'` with `errorMessage` set, and emits `session.error` followed by `session.status`. (FR-34)

## Remediation

(Empty until a review returns findings.)
