// pi-transcript-events: RuntimeToolCall → ToolConversationBlock. Split out of
// conversation-blocks.ts (file-size cap); the transcript reducer consumes
// `runtimeToolBlock`, Block.tsx the status label.

import type { RuntimeToolCall } from '../../../contract/common';
// FR-1: glyphs come from `toolGlyphFor`, deliberately NOT `classifyToolStart`
// — that helper also turns Task/Agent into a SubagentConversationBlock, which
// FR-1 forbids here: a Pi tool named `Task` is never a subagent dispatch.
import { toolGlyphFor, type ToolConversationBlock } from '../../../contract/conversation-view';

const RUNTIME_TOOL_SUMMARY_MAX = 140;

/** FR-4: a bounded, single-line target string for the tool row — the first
 *  line of the (already 64 KiB-bounded) sanitized input preview, capped
 *  further so one long argument can never stretch the row. */
export function runtimeToolSummary(inputText: string): string {
  const firstLine = inputText.split('\n', 1)[0] ?? '';
  const trimmed = firstLine.trim();
  return trimmed.length > RUNTIME_TOOL_SUMMARY_MAX ? `${trimmed.slice(0, RUNTIME_TOOL_SUMMARY_MAX - 1)}…` : trimmed;
}

/**
 * FR-3 + design brief ("Status uses text as well as colour"): the word the
 * row states for a RuntimeToolCall status. 'pending'/'running' state nothing
 * yet — a tool is never SHOWN running during argument generation, and a
 * genuinely running call already reads as live via `isStreaming` (the
 * existing pulsing-dot treatment). Every terminal status states its own word,
 * so `failed` also drives the existing error-tone chip rule (toolResultChips).
 */
export function runtimeToolStatusLabel(status: RuntimeToolCall['status']): string {
  switch (status) {
    case 'pending':
    case 'running':
      return '';
    case 'succeeded':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'unknown':
      return 'unknown';
  }
}

/** FR-4/design brief §Data shown: the expanded detail's timing — the settled
 *  `completedAt - startedAt` once both are known (independent of `now`, so a
 *  finished call never keeps ticking), or the live `now - startedAt` while
 *  still in flight. `null` when the call never started (nothing to time). */
export function runtimeToolElapsedMs(tool: RuntimeToolCall, now: number): number | null {
  if (tool.startedAt === undefined) return null;
  return Math.max(0, (tool.completedAt ?? now) - tool.startedAt);
}

/** FR-1/FR-3/FR-4: build/refresh the tool block for one settle of a
 *  RuntimeToolCall — insert on first sight, replace in place on every later
 *  update (pending → running → succeeded/failed/cancelled/unknown). */
export function runtimeToolBlock(blockId: string, tool: RuntimeToolCall): ToolConversationBlock {
  const label = runtimeToolStatusLabel(tool.status);
  return {
    kind: 'tool',
    blockId,
    isStreaming: tool.status === 'running',
    ...toolGlyphFor(tool.name),
    bodyColor: '#8b93a3',
    tool: tool.name,
    summary: runtimeToolSummary(tool.inputText),
    ...(label ? { meta: label } : {}),
    execution: tool,
  };
}
