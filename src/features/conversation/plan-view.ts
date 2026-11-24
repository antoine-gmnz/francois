// plan-view — the session's plan, drawn as a card in the transcript (the
// Claude app's plan view).
//
// Every plan-touching call (`TodoWrite`, `TaskCreate`, `TaskUpdate`) carries
// the WHOLE list as it stands after it, so a six-step plan worked through
// would paint a dozen near-identical checklists. Only the latest one is drawn
// as a card; every earlier call stays a compact tool row (`3 steps · 1 done`,
// `Boil water`, `#1 → completed`). These helpers are pure; PlanCard is DOM
// assembly only.

import type { PlanItem } from '../../../contract/common';
import type { ConversationBlock } from '../../../contract/conversation-view';

/** The blockId of the last tool call that set a plan, or null when none did. */
export function latestPlanBlockId(blocks: readonly ConversationBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === 'tool' && b.plan !== undefined && b.plan.length > 0) return b.blockId;
  }
  return null;
}

/** What a step reads as: the present-continuous form while it is the one in flight. */
export function planStepLabel(item: PlanItem): string {
  if (item.status === 'in_progress' && item.activeForm !== undefined && item.activeForm !== '') {
    return item.activeForm;
  }
  return item.content;
}
