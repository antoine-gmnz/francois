// permission-guardrails — the offered approval actions and which of them write a
// rule. Shared by the transcript card (features/permissions) and the roster's
// inline Allow / Deny (features/sessions), so it lives here rather than being
// imported across feature folders.

import type { PermissionDecision } from '../../contract/permission-guardrails';

export interface PermissionAction {
  decision: PermissionDecision;
  /** The button face (§8.7) — one word, so all four fit one row next to the tier control. */
  short: string;
  /** The full sentence, carried as the button's `title` so the short face is never ambiguous. */
  label: string;
  /** Drives `pcard__btn--<variant>`; also the render grouping (allows first, denials after). */
  variant: 'allow' | 'always' | 'deny' | 'never';
  allow: boolean;
}

/**
 * The four card actions, in render order (§8.7): the two allows first, then the
 * two denials — the design brief's Allow / Always / Deny grouping, with `Never`
 * (always deny) completing the pair.
 */
export const PERMISSION_ACTIONS: PermissionAction[] = [
  { decision: 'allowOnce', short: 'Allow', label: 'allow once', variant: 'allow', allow: true },
  { decision: 'allowAlways', short: 'Always', label: 'always allow', variant: 'always', allow: true },
  { decision: 'denyOnce', short: 'Deny', label: 'deny once', variant: 'deny', allow: false },
  { decision: 'denyAlways', short: 'Never', label: 'always deny', variant: 'never', allow: false },
];

/** Absent is legacy; a supplied list is the authoritative offered subset. */
export function permissionActions(allowed?: PermissionDecision[]): PermissionAction[] {
  if (allowed === undefined) return PERMISSION_ACTIONS;
  const choices: PermissionAction[] = [...PERMISSION_ACTIONS, { decision: 'cancel', short: 'Cancel turn', label: 'Cancel turn', variant: 'deny', allow: false }];
  return choices.filter(action => allowed.includes(action.decision));
}

/**
 * True for the two decisions that write a rule — the only ones `tier` affects.
 * Drives the card's tier control: hovering a `*Once` action dims it, so the user
 * can see at a glance which buttons the tier choice actually applies to.
 */
export function writesRule(decision: PermissionDecision): boolean {
  return decision === 'allowAlways' || decision === 'denyAlways';
}
