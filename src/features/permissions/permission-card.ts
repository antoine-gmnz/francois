// permission-guardrails — pure approval-card logic (FR-20..FR-23), extracted
// from PermissionCard.tsx so the decision flow, the tier vocabulary, the state
// chrome and the composer-placeholder rule are unit-testable without the DOM.

import type { Result } from '../../../contract/common';
import type { ConversationBlock } from '../../../contract/conversation-view';
import type {
  PermissionAsk,
  PermissionDecision,
  PermissionRule,
  PermissionState,
  PermissionTier,
} from '../../../contract/permission-guardrails';
import { writesRule } from '../../lib/permission-actions';

// ---------- vocabulary (§8) ----------

/** FR-20: how a tier reads on the card's tier control and on an editor chip. */
export function tierLabel(tier: PermissionTier): string {
  return tier === 'global' ? 'all projects' : 'this project';
}

/** §8.12: the compact form used in chips, where the row is already narrow. */
export function tierChip(tier: PermissionTier): string {
  return tier === 'global' ? 'global' : 'project';
}

/**
 * §8.6: the tier control is only meaningful for the two `*Always` actions.
 * `hovered === null` (nothing hovered) keeps it at full strength.
 */
export function tierControlDimmed(hovered: PermissionDecision | null): boolean {
  return hovered !== null && !writesRule(hovered);
}

/**
 * §8.2: how long the ask has been sitting there, shown at the right of the
 * header row. Measured from when the card first rendered — the transcript
 * carries no timestamp, so a card restored from a persisted transcript restarts
 * its clock rather than lying about a precise wall time.
 */
export function relativeAge(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * §8.4: whether the disclosure caret has anything to reveal. A pending card
 * always does (the writes-rule line lives in the detail); a resolved one only
 * when the ask carried an input dump or a cwd.
 */
export function hasDetail(ask: PermissionAsk, pending: boolean): boolean {
  return pending || ask.inputJson !== '' || ask.cwd !== '';
}

/**
 * FR-20: the sentence under a pending card describing the rule an "always"
 * decision would write — the whole point of the tier control being visible
 * BEFORE the user commits.
 */
export function ruleSentence(ask: PermissionAsk, tier: PermissionTier): string {
  return `${ask.patternLabel} · ${tierLabel(tier)}`;
}

/** FR-22: the sentence a resolved card shows when its decision wrote a rule. */
export function writtenRuleSentence(rule: PermissionRule): string {
  const verb = rule.effect === 'deny' ? 'always deny' : rule.effect === 'ask' ? 'always ask' : 'always allow';
  return `${verb} — ${rule.label} · ${tierChip(rule.tier)}`;
}

// ---------- state chrome (§8.1/8.2) ----------

/** FR-22: the `— …` note appended to the header row of a resolved card. */
export function stateNote(state: PermissionState): string | null {
  switch (state) {
    case 'allowed':
      return '— allowed';
    case 'denied':
      return '— denied';
    case 'cancelled':
      return '— cancelled';
    default:
      return null;
  }
}

/**
 * §8.1: the card's class list. `pending` carries the amber stop chrome; the
 * resolved states recolor the left edge (or dim the whole card for
 * `cancelled`), and `in flight` dims to 0.7 while a decision is on the wire
 * (FR-21).
 */
export function cardClass(state: PermissionState, inFlight: boolean): string {
  const parts = ['pcard', `pcard--${state}`];
  if (state === 'pending' && inFlight) parts.push('pcard--inflight');
  return parts.join(' ');
}

// ---------- decision flow (FR-21) ----------

export interface DecideArgs {
  decision: PermissionDecision;
  tier: PermissionTier;
  /** Bound francois:permissions:decide call. */
  decide: (decision: PermissionDecision, tier: PermissionTier) => Promise<Result<null>>;
  /** Card in-flight flag (opacity 0.7 + clicks ignored while true). */
  setInFlight: (v: boolean) => void;
  /** Card-local inline error line (null clears it). */
  setError: (message: string | null) => void;
  /** true when the block was already resolved by an event (the §7 #6 race). */
  isResolved: () => boolean;
  /** setTimeout injection point (fake in tests). */
  schedule: (fn: () => void, ms: number) => void;
}

/**
 * FR-21: one `permissions_decide` call; further clicks are ignored while it is in
 * flight. On success the card STAYS in flight — the `permission.resolved` event
 * flips it. On failure (`ok: false` or a transport rejection) the message shows
 * inline for 4 s and the card re-enables, UNLESS an event already resolved it —
 * never an alert, never a stuck card.
 */
export async function submitDecision(a: DecideArgs): Promise<void> {
  a.setInFlight(true);
  a.setError(null);
  let failure: string | null = null;
  try {
    const res = await a.decide(a.decision, a.tier);
    if (!res.ok) failure = res.error.message;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  if (failure === null) return;
  if (a.isResolved()) return; // an event won the race — leave the resolved card alone
  a.setInFlight(false);
  a.setError(failure);
  a.schedule(() => a.setError(null), 4000);
}

// ---------- composer placeholder (FR-23) ----------

/** True while any pending approval card exists in the visible transcript. */
export function hasPendingPermissionBlock(blocks: ConversationBlock[]): boolean {
  return blocks.some((b) => b.kind === 'permission' && b.state === 'pending');
}
