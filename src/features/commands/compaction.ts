// audit C4 — the transcript divider a context compaction leaves (the
// `compaction` CommandCard). Pure, so the copy is unit-tested.

import type { CommandCard } from '../../../contract/common';
import { formatContextTokens } from '../../../contract/conversation-view';

type CompactionCard = Extract<CommandCard, { kind: 'compaction' }>;

/** "Context compacted · auto · 150K tokens before" — the size only when reported. */
export function compactionLabel(card: CompactionCard): string {
  const parts = ['Context compacted', card.trigger];
  if (card.preTokens !== undefined && card.preTokens > 0) parts.push(`${formatContextTokens(card.preTokens)} tokens before`);
  return parts.join(' · ');
}
