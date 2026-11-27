// Render-time compaction of duplicate consecutive tool rows — split out of
// conversation-blocks.ts (file-size cap). Pure; no reducer state is touched.

import type { ConversationBlock, ToolConversationBlock } from '../../../contract/conversation-view';

// ---------- render-time compaction of duplicate tool rows ----------

/** The core's tool_meta line-change shape: `+N −M` (U+2212 minus). */
const LINE_CHANGE_META = /^\+(\d+) −(\d+)$/;

/**
 * Collapse runs of consecutive tool blocks that are identical except for their
 * meta (e.g. repeated `Edit  src/a.ts` rows) into one row. Line-change metas
 * (`+N −M`) sum across the run; other metas keep the newest value. Render-time
 * only — reducer state stays one block per event so blockId-keyed upserts
 * (toolDone replay, out-of-order arrivals) are untouched.
 *
 * The newest block represents the run: its blockId keys the row and its
 * streaming state wins (a still-streaming edit shows the run total so far).
 * A call that did not settle cleanly never merges — see `breaksToolRun` — so a
 * failure is never absorbed into a neighbouring success. Two Pi rows are
 * additionally held apart by their execution id: each `tool.update` is its own
 * call, and folding two of them would hide one from the transcript entirely.
 */
export function compactBlocks(blocks: ConversationBlock[]): ConversationBlock[] {
  const out: ConversationBlock[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (
      b.kind === 'tool' &&
      prev !== undefined &&
      prev.kind === 'tool' &&
      prev.tool === b.tool &&
      prev.summary === b.summary &&
      prev.execution?.id === b.execution?.id &&
      !breaksToolRun(prev) &&
      !breaksToolRun(b)
    ) {
      out[out.length - 1] = mergeToolRun(prev, b);
      continue;
    }
    out.push(b);
  }
  return out;
}

/**
 * Whether this row must stay visible on its own. The two runtimes are read
 * differently ON PURPOSE:
 *  - a Pi block carries the normalized lifecycle, so the STATUS answers —
 *    never the displayed word, which is presentation;
 *  - a plain Claude block has no status: an explicit `tone` (hook-diagnostics)
 *    or, on older blocks, the exact `error` meta marks a failure. Any other is
 *    free-form — a Task row's is the first line of the subagent's own result —
 *    so matching words inside it would break a run on prose.
 */
function breaksToolRun(b: ToolConversationBlock): boolean {
  // plan-view: each TodoWrite is a distinct snapshot of the plan — flipping a
  // step to in-progress keeps the same `N steps · M done` summary, and merging
  // would drop the newer checklist (and the latest-plan card with it). Same for a row's images (tool-images).
  if (b.plan !== undefined || (b.images?.length ?? 0) > 0) return true;
  if (b.execution !== undefined) {
    const { status } = b.execution;
    return status === 'failed' || status === 'cancelled' || status === 'unknown';
  }
  return b.tone !== undefined || b.meta === 'error';
}

function mergeToolRun(acc: ToolConversationBlock, b: ToolConversationBlock): ToolConversationBlock {
  const am = acc.meta !== undefined ? LINE_CHANGE_META.exec(acc.meta) : null;
  const bm = b.meta !== undefined ? LINE_CHANGE_META.exec(b.meta) : null;
  const meta =
    am && bm
      ? `+${Number(am[1]) + Number(bm[1])} −${Number(am[2]) + Number(bm[2])}`
      : (b.meta ?? acc.meta);
  return meta !== undefined ? { ...b, meta } : { ...b };
}
