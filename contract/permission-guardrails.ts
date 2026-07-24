// contract/permission-guardrails.ts — approval cards for gated tool calls +
// the rules editor over Claude Code's own settings.json.
// Authored from specs/permission-guardrails.md §5.
//
// Physical Tauri binding: `francois:permissions:<verb>` → command
// `permissions_<verb_snake_case>`. The ask/resolved events ride the EXISTING
// francois://session/event channel (common.ts SessionEvent) — they are
// transcript blocks scoped to a session, exactly like question cards.
//
// PermissionAsk/PermissionRule/PermissionTier/PermissionEffect are shared
// vocabulary (the SessionEvent union in common.ts needs them, and common.ts
// never imports from feature files), so they are DECLARED in common.ts and
// re-exported here — the same placement rule session-questions §5.3 uses.

import type { BlockId, PermissionAsk, PermissionRule, PermissionTier, SessionId } from './common';

export type { PermissionAsk, PermissionEffect, PermissionRule, PermissionTier } from './common';

/** What the user clicked on an approval card (FR-6). */
export type PermissionDecision = 'allowOnce' | 'denyOnce' | 'allowAlways' | 'denyAlways';

/** Card lifecycle. Exactly one resolution per ask (FR-10). */
export type PermissionState = 'pending' | 'allowed' | 'denied' | 'cancelled';

export interface PermissionConversationBlock {
  kind: 'permission';
  blockId: BlockId;
  /** true iff state === 'pending' (FR-25). */
  isStreaming: boolean;
  ask: PermissionAsk;
  state: PermissionState;
  /** Present iff the decision wrote a rule (FR-22); omitted, never null. */
  rule?: PermissionRule;
}

// ---------- francois:permissions:decide ----------

export interface DecidePermissionRequest {
  sessionId: SessionId;
  blockId: BlockId;
  decision: PermissionDecision;
  /** Default 'local' (FR-6); ignored by the *Once decisions. */
  tier?: PermissionTier;
}

// ---------- rules editor (FR-17/FR-18/FR-19) ----------
// Every mutation returns the FRESHLY RE-READ list so the editor is never stale.

export interface ListRulesRequest {
  sessionId: SessionId;
}

export interface SetRuleEnabledRequest {
  sessionId: SessionId;
  ruleId: string;
  enabled: boolean;
}

export interface RemoveRuleRequest {
  sessionId: SessionId;
  ruleId: string;
}

export interface SetRuleTierRequest {
  sessionId: SessionId;
  ruleId: string;
  tier: PermissionTier;
}
