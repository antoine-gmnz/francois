import { describe, expect, it } from 'vitest';
import type { SkillInfo } from '../../../contract/common';
import { clampSelection, filterSkills } from './skills-filter';

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return { name: 'pdf-reader', description: 'read & parse PDFs', installed: true, ...overrides };
}

describe('filterSkills', () => {
  const skills = [
    skill({ name: 'pdf-reader', description: 'read & parse PDFs' }),
    skill({ name: 'web-search', description: 'search the web' }),
    skill({ name: 'notes', description: 'take PDF-adjacent notes' }),
  ];

  it('returns the list unchanged for a blank query', () => {
    expect(filterSkills(skills, '')).toBe(skills);
  });

  it('matches on name, case-insensitively', () => {
    expect(filterSkills(skills, 'WEB').map((s) => s.name)).toEqual(['web-search']);
  });

  it('matches on description', () => {
    expect(filterSkills(skills, 'parse').map((s) => s.name)).toEqual(['pdf-reader']);
  });

  it('matches multiple entries', () => {
    expect(filterSkills(skills, 'pdf').map((s) => s.name)).toEqual(['pdf-reader', 'notes']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterSkills(skills, 'zzz')).toEqual([]);
  });

  // pr-142 §B3: rows DISPLAY skillInvocationLabel(skill) and, when unloaded,
  // unavailableReason — the filter must match what is actually shown.
  it('matches the displayed invocation label, not just the derived name', () => {
    const withInvocation = [skill({ name: 'deploy', invocation: '/skill:deploy', description: '' })];
    expect(filterSkills(withInvocation, 'skill:deploy').map((s) => s.name)).toEqual(['deploy']);
  });

  it('matches unavailableReason for an unloaded row', () => {
    const unloaded = [skill({ name: 'deploy', loaded: false, unavailableReason: 'resource policy disabled', description: '' })];
    expect(filterSkills(unloaded, 'resource policy').map((s) => s.name)).toEqual(['deploy']);
  });

  it('does not match unavailableReason for a loaded row (it is never shown)', () => {
    const loaded = [skill({ name: 'deploy', loaded: true, unavailableReason: 'stale text nobody sees', description: '' })];
    expect(filterSkills(loaded, 'stale text')).toEqual([]);
  });
});

describe('clampSelection', () => {
  it('keeps an index already in range', () => {
    expect(clampSelection(2, 5)).toBe(2);
  });

  it('clamps an index past the end to the last row', () => {
    expect(clampSelection(9, 5)).toBe(4);
  });

  it('clamps a negative index to 0', () => {
    expect(clampSelection(-3, 5)).toBe(0);
  });

  it('clamps to 0 when the list is empty', () => {
    expect(clampSelection(3, 0)).toBe(0);
  });
});
