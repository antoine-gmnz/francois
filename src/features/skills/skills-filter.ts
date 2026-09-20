import type { SkillInfo } from '../../../contract/common';
import { isSkillRunnable, skillInvocationLabel } from './skills-loaded';

/** Filters the skill list against a "/" filter query, matching against every
 *  field a row actually DISPLAYS: name, description, the rendered invocation
 *  label (pr-142 §B3 — a Pi colon command like '/skill:deploy' must be
 *  findable by its own spelling, not just its derived `name`), and, for an
 *  unloaded row only, `unavailableReason` (the text that row shows in place of
 *  the description). A blank query returns the list unchanged — pure
 *  extraction of SkillsPanel's `visible` memo. */
export function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  if (!query) return skills;
  const q = query.toLowerCase();
  return skills.filter((skill) => {
    const runnable = isSkillRunnable(skill);
    const fields = [skill.name, skill.description, skillInvocationLabel(skill), !runnable ? skill.unavailableReason : undefined];
    return fields.some((f) => f?.toLowerCase().includes(q));
  });
}

/** Clamps a selected-row index into `[0, length - 1]` (or 0 when empty) after the
 *  filtered/visible list changes — pure extraction of SkillsPanel's clamp effect. */
export function clampSelection(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1));
}
