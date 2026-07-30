import type { SkillInfo } from '../../../contract/common';

/** Filters the skill list against a "/" filter query (name or description, case-insensitive).
 *  A blank query returns the list unchanged — pure extraction of SkillsPanel's `visible` memo. */
export function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  if (!query) return skills;
  const q = query.toLowerCase();
  return skills.filter((skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q));
}

/** Clamps a selected-row index into `[0, length - 1]` (or 0 when empty) after the
 *  filtered/visible list changes — pure extraction of SkillsPanel's clamp effect. */
export function clampSelection(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1));
}
