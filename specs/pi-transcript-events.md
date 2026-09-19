---
id: pi-transcript-events
title: Pi transcript and event normalization
status: in-review
branch: feat/pi-transcript-events
created: 2026-09-18
depends_on: [pi-runtime-boundary, pi-rpc-sessions]
reviewed_base:
reviewed_digest:
design_files: []
---

# Pi transcript and event normalization

## 1. Summary

Normalize Pi activity into François text, tool, attachment and notice blocks, with
deterministic live/replay ordering. Use [the audited RPC sources](research/pi-integration-audit.md),
not the Claude stream parser. This task owns normalization, not Pi conversation persistence.

## 2. Goals & non-goals

- Goals: first-class transcript, complete tool lifecycle, correct partial/delta assembly,
  image input references, bounded rendering and meaningful errors.
- Non-goals: raw Pi JSON in React, fabricated subagents, custom extension UI, exposing
  private provider reasoning/signatures, or importing arbitrary external Pi conversations.

## 3. User stories / flows

Send a prompt with an image. Read streaming assistant text and tool progress. Expand a
tool with mouse or keyboard to inspect sanitized inputs/output. A failed tool visibly
fails while the agent may continue. Reopen or page backwards and see the same block order.

## 4. Functional requirements

- FR-1: Add the event mappings below to `session/adapter/pi/normalize.rs`. Tool names are
  preserved verbatim; glyph classification never renames the underlying tool or invokes
  Claude-specific subagent parsing because a name happens to match `Task`.
- FR-2: Build assistant text from message_start and indexed content deltas. A final
  message replaces accumulated content authoritatively. Use UTF-16 offsets at IPC as the
  existing delta contract does. Each text content slot has its own stable blockId;
  text_end finalizes that slot and message_end reconciles slots in original content order.
  Multiple content blocks and surrogate pairs are tested.
- FR-3: Tool-call argument generation is not execution. Track pending → running →
  succeeded/failed/cancelled; a tool result must settle the matching call exactly once.
  Treat Pi tool progress as a snapshot unless the certified field is explicitly a delta.
- FR-4: Retain useful sanitized generic metadata: tool call identity, input/output text,
  timing and completion. Private Pi metadata stays in the adapter, not opaque executable
  objects in UI. Bound input/output previews to 64 KiB each with `truncated=true`.
- FR-5: Thinking/signature content is not rendered as assistant prose. Unsupported content
  becomes a neutral notice or an attachment placeholder, never silently text-concatenated.
- FR-6: Normalized blocks share the existing paged transcript. One core block identity
  survives streaming, finalization and recovery; task 05 records native-entry associations.
  A queued prompt appears beside the composer, not in the transcript until consumed.
- FR-7: Reuse existing attachment ingest/asset scopes. Encode validated images in Rust
  as Pi image content; never transmit base64 back to React. Reject unsupported model image
  input before submission. File paths remain explicit user attachments, not guessed URLs.
- FR-8: Retain frame batching and single-listener routing. Hydration buffers live events,
  merges by stable ID/checkpoint, then drains; no duplicate message or lost final block.
  A sequence gap triggers rehydration/reconciliation rather than appending after a missing delta.
- FR-9: Crash/stop finalizes partial assistant output as interrupted and running tools as
  cancelled/unknown outcome, never succeeded. Streamed text need not imply a durable Pi entry.

## 5. API contract

Amend `contract/conversation-view.ts` for block additions and `common.ts` for shared
payloads/events. Existing `conversation_get_transcript` still returns `Result<TranscriptPage>`.
Add shared types in `common.ts` (import them into conversation-view):

```ts
interface RuntimeToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  inputText: string;
  outputText: string;
  inputTruncated: boolean;
  outputTruncated: boolean;
  startedAt?: number;
  completedAt?: number;
}
interface RuntimeAttachmentRef {
  id: string; // existing core attachment ID
  name: string;
  mimeType: string;
  state: 'available' | 'missing';
}
// Add to RuntimeEventPayload:
type TranscriptRuntimePayload =
  | { kind: 'message.user'; blockId: BlockId; text: string; attachments: RuntimeAttachmentRef[]; clientMessageId?: string }
  | { kind: 'assistant.delta'; blockId: BlockId; contentIndex: number; text: string; offset: number }
  | { kind: 'assistant.complete'; blockId: BlockId; text: string; outcome: 'complete' | 'interrupted' | 'error' }
  | { kind: 'tool.update'; blockId: BlockId; tool: RuntimeToolCall }
  | { kind: 'notice'; blockId: BlockId; tone: 'info' | 'warning' | 'error'; text: string };
```

Extend `ToolConversationBlock` with optional `execution: RuntimeToolCall` (required for
Pi-produced tool blocks); extend user blocks with optional attachments, assistant blocks
with optional outcome. Add `NoticeConversationBlock { kind:'notice'; blockId; isStreaming:false;
at?:number; tone:'info'|'warning'|'error'; text:string }` to the existing union.
No raw input/output JSON is parsed/executed in the webview; display bounded text.

| Pi event / field | François normalized output |
|---|---|
| agent_start | runtime run.state running; allocate run ID if needed |
| message_start user | message.user only when accepted into actual conversation |
| message_start assistant + text deltas | assistant.delta keyed by message/content index |
| text_end / message_end assistant | authoritative assistant.complete, deduplicated |
| toolcall_start/delta/end | pending tool input, using stable toolCallId |
| tool_execution_start | tool.update running, actual startedAt |
| tool_execution_update | replace progress snapshot for that call |
| tool_execution_end isError | failed or succeeded tool.update with output |
| message_end toolResult | reconcile same call; do not append a second tool row |
| turn_end | internal assistant/tool round boundary; not whole-run completion |
| agent_end | low-level boundary; preserve busy state until settled |
| agent_settled | run.state idle after pending finalizations |
| compaction_start/end, retry events | task 08 progress / neutral notices |
| queue_update | task 08 pending intent state; not transcript text |
| malformed known event | failure RUNTIME_PROTOCOL_ERROR |
| valid unknown event | bounded diagnostic; no speculative capabilities |

All event additions use the task 01 envelope on `francois://session/event`.
Existing attachment errors are retained; add `RUNTIME_UNSUPPORTED` when vision is unavailable.

## 6. Data & state

Core reducer owns ordered blocks, active content slots and tool-call → block lookup.
Display projection is derived, bounded as in transcript-scale, and persisted by task 05.
Tool input/output may contain user data; sanitize in core before both IPC and projection
write. Do not log it. Known secret-pattern filtering is best effort, not a confidentiality guarantee.

Expected files: `session/adapter/pi/normalize.rs`, `session/{blocks,events,persistence}.rs`,
`contract/{common,conversation-view}.ts`, `src/features/conversation/{Block,conversation-blocks,
useConversationTranscript}.tsx|ts`, `src/lib/session-events.ts`, attachment ingest.

## 7. Edge cases & errors

Missing final message: preserve interrupted partial text. Duplicate final output: upsert.
Unknown tool names: generic tool icon and text. Missing image after restart: “Attachment
unavailable,” keeping the user message. Oversize image retains existing ingest limits;
32 MiB frame budget includes encoded data. Oversize authoritative message fails the
connection explicitly rather than dropping a mandatory block without explanation.

## 8. Design brief

Reuse transcript typography and tool rows; add expandable details, state labels and notices.
> full brief: specs/design/pi-transcript-events.md

## 9. Acceptance criteria

- [ ] Fixtures cover text/tool interleaving, Unicode, final correction, failures and unknown tools.
- [ ] A tool is not shown running during argument generation; terminal result is single (FR-3).
- [ ] Live and rebuilt transcripts match IDs/order/content after duplicate events (FR-6/8).
- [ ] Image support is model-gated; missing files and sanitized outputs render safely (FR-4/7).
- [ ] Thinking data does not leak into assistant prose (FR-5).
- [ ] One event listener/frame batching and existing bounded scrollback tests still pass.
- [ ] Rust reducer fixtures, TS reducer/formatting tests, and manual keyboard expansion pass.

## Remediation

### 2026-09-19 — round 1

- 2026-09-19 — 8 findings (2 CRITICAL / 1 HIGH / 2 MEDIUM / 3 LOW), all fixed

### 2026-09-19 — round 2

- 2026-09-19 — 3 findings (1 CRITICAL / 1 HIGH / 1 MEDIUM), all fixed

### 2026-09-19 — round 3

- 2026-09-19 — 4 findings (1 MEDIUM / 3 LOW), all fixed

### 2026-09-19 — round 4

- 2026-09-19 — 5 findings (1 HIGH / 3 MEDIUM / 1 LOW), all fixed

### 2026-09-19 — round 5

- 2026-09-19 — 7 findings (1 CRITICAL / 1 HIGH / 4 MEDIUM / 1 LOW), all fixed

### 2026-09-19 — round 6

- 2026-09-19 — 6 findings (1 HIGH / 1 MEDIUM / 4 LOW), all fixed
