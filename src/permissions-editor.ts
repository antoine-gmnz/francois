// permission-guardrails — pure rules-editor logic (FR-26..FR-28), extracted from
// PermissionsModal.tsx so filtering, grouping, the effect vocabulary and the
// mutation flow are unit-testable without the DOM.
//
// The core already returns the list in spec order (FR-17: deny → ask → allow,
// local before global, file order within a tier) and re-reads it after every
// mutation (FR-18), so nothing here re-sorts — it only slices the given order
// into render groups and never invents an order of its own.

import type { Result } from '../contract/common';
import type { PermissionEffect, PermissionRule, PermissionTier } from '../contract/permission-guardrails';

/** §8.12: the glyph and section label of each effect. */
export const EFFECT_ORDER: PermissionEffect[] = ['deny', 'ask', 'allow'];

export function effectGlyph(effect: PermissionEffect): string {
  return effect === 'deny' ? '⊘' : effect === 'ask' ? '?' : '✓';
}

/** §8.13: the uppercase section label above a non-empty effect group. */
export function effectLabel(effect: PermissionEffect): string {
  return effect.toUpperCase();
}

/** §8.12: the tier chip on a row, and the "move it" action's label. */
export function otherTier(tier: PermissionTier): PermissionTier {
  return tier === 'global' ? 'local' : 'global';
}

export function moveLabel(tier: PermissionTier): string {
  return tier === 'global' ? '→ project' : '→ global';
}

/**
 * FR-28: substring filter over BOTH the human label and the raw pattern — a user
 * who remembers "git" and a user who remembers `Bash(git…)` must both find the
 * rule. Case-insensitive; an empty/whitespace query matches everything.
 */
export function filterRules(rules: PermissionRule[], query: string): PermissionRule[] {
  const q = query.trim().toLowerCase();
  if (q === '') return rules;
  return rules.filter(
    (r) => r.label.toLowerCase().includes(q) || r.pattern.toLowerCase().includes(q),
  );
}

export interface RuleGroup {
  effect: PermissionEffect;
  rules: PermissionRule[];
}

/**
 * FR-27/§8.13: one group per NON-EMPTY effect, in EFFECT_ORDER, preserving the
 * core's order within each group.
 */
export function groupRules(rules: PermissionRule[]): RuleGroup[] {
  return EFFECT_ORDER.map((effect) => ({ effect, rules: rules.filter((r) => r.effect === effect) })).filter(
    (g) => g.rules.length > 0,
  );
}

/** FR-28: the line shown when there is nothing to list. */
export const EMPTY_RULES_TEXT = 'no permission rules yet — decide "always" on an approval card to create one';

/**
 * FR-28: what the body renders — distinguishes "no rules at all" from "the
 * filter matched nothing", which are different problems for the user.
 */
export function emptyText(totalRules: number, filtered: number, query: string): string | null {
  if (filtered > 0) return null;
  if (totalRules === 0) return EMPTY_RULES_TEXT;
  return `no rule matches “${query.trim()}”`;
}

// ---------- mutation flow (FR-18/FR-28) ----------

export interface MutateArgs {
  /** One bound permissions_* mutation; every one resolves the fresh list. */
  call: () => Promise<Result<PermissionRule[]>>;
  setRules: (rules: PermissionRule[]) => void;
  setError: (message: string | null) => void;
  setBusy: (v: boolean) => void;
}

/**
 * FR-18/FR-28: run one mutation, adopt the freshly re-read list it returns, and
 * surface any failure inline. The modal never throws and never keeps a stale
 * list: a failed mutation leaves the previous list rendered with the error above
 * it, which is the current truth as far as this call knows.
 */
export async function applyMutation(a: MutateArgs): Promise<void> {
  a.setBusy(true);
  try {
    const res = await a.call();
    if (res.ok) {
      a.setRules(res.data);
      a.setError(null);
    } else {
      a.setError(res.error.message);
    }
  } catch (e) {
    a.setError(e instanceof Error ? e.message : String(e));
  } finally {
    a.setBusy(false);
  }
}
