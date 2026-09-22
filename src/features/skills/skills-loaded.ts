// pi-skills-capabilities FR-1/FR-8 — pure display helpers for a runtime-listed
// skill row: the exact invocation text, whether the row is runnable, and the
// project-resources status line that distinguishes "no skills" from "project
// resources are disabled" (FR-8). Extracted so the exact-spelling rule (FR-1)
// and the distinguishing rule (FR-8) are unit-testable without the DOM.

import type { SkillInfo } from '../../../contract/common';

/**
 * FR-1: the exact command text, spelling preserved (`/skill:review`) — never
 * rebuilt from `name`. Absent `invocation` ⇒ the legacy `/name` (commands) or
 * bare `name` (skills) every other runtime already renders.
 */
export function skillInvocationLabel(skill: Pick<SkillInfo, 'name' | 'kind' | 'invocation'>): string {
  if (skill.invocation) return skill.invocation;
  return skill.kind === 'command' ? `/${skill.name}` : skill.name;
}

/** FR-1: `loaded: false` rows are visible but not runnable. Absent ⇒ runnable
 *  (every other runtime carries no `loaded` field at all). */
export function isSkillRunnable(skill: Pick<SkillInfo, 'loaded'>): boolean {
  return skill.loaded !== false;
}

/**
 * pr-142 §B1: a Pi row's `name` is DERIVED from `invocation` by stripping `/`
 * and `skill:` — so `/skill:deploy` and `/deploy` both derive to `deploy` and
 * collide as a React `key`. `invocation` is unique per listed entry; fall back
 * to `kind:name` (never bare `name` alone) for every other runtime, which
 * carries no `invocation` at all.
 */
export function skillRowKey(skill: Pick<SkillInfo, 'name' | 'kind' | 'invocation'>): string {
  return skill.invocation ?? `${skill.kind ?? 'skill'}:${skill.name}`;
}
