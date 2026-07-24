// permission-guardrails — pure approval-card logic (FR-20..FR-23), extracted
// from PermissionCard.tsx so the decision flow, the tier vocabulary, the state
// chrome and the composer-placeholder rule are unit-testable without the DOM.

import type { Result } from '../contract/common';
import type { ConversationBlock } from '../contract/conversation-view';
import type {
  PermissionAsk,
  PermissionDecision,
  PermissionRule,
  PermissionState,
  PermissionTier,
} from '../contract/permission-guardrails';

// ---------- vocabulary (§8) ----------

/** FR-20: how a tier reads on the card's tier control and on an editor chip. */
export function tierLabel(tier: PermissionTier): string {
  return tier === 'global' ? 'all projects' : 'this project';
}

/** §8.12: the compact form used in chips, where the row is already narrow. */
export function tierChip(tier: PermissionTier): string {
  return tier === 'global' ? 'global' : 'project';
}

/** The four card actions, in render order (§8.7). */
export const PERMISSION_ACTIONS: { decision: PermissionDecision; label: string; allow: boolean }[] = [
  { decision: 'allowOnce', label: 'allow once', allow: true },
  { decision: 'denyOnce', label: 'deny once', allow: false },
  { decision: 'allowAlways', label: 'always allow', allow: true },
  { decision: 'denyAlways', label: 'always deny', allow: false },
];

/**
 * True for the two decisions that write a rule — the only ones `tier` affects.
 * Drives the card's tier control: hovering a `*Once` action dims it, so the user
 * can see at a glance which buttons the tier choice actually applies to.
 */
export function writesRule(decision: PermissionDecision): boolean {
  return decision === 'allowAlways' || decision === 'denyAlways';
}

/**
 * §8.6: the tier control is only meaningful for the two `*Always` actions.
 * `hovered === null` (nothing hovered) keeps it at full strength.
 */
export function tierControlDimmed(hovered: PermissionDecision | null): boolean {
  return hovered !== null && !writesRule(hovered);
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
 * §8.1: the card's class list. `pending` carries the amber stop edge; the
 * resolved states recolor it (or dim the whole card for `cancelled`), and
 * `in flight` dims to 0.7 while a decision is on the wire (FR-21).
 */
export function cardClass(state: PermissionState, inFlight: boolean): string {
  const parts = ['pcard', `pcard-${state}`];
  if (state === 'pending' && inFlight) parts.push('pcard-inflight');
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
