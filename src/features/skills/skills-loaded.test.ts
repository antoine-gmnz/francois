import { describe, expect, it } from 'vitest';
import type { SkillInfo } from '../../../contract/common';
import { isSkillRunnable, skillInvocationLabel, skillRowKey } from './skills-loaded';

const skill = (extra: Partial<SkillInfo> = {}): SkillInfo => ({
  name: 'review',
  description: '',
  installed: true,
  ...extra,
});

describe('skillInvocationLabel (FR-1)', () => {
  it('renders the exact invocation, spelling preserved, when present', () => {
    expect(skillInvocationLabel(skill({ invocation: '/skill:review' }))).toBe('/skill:review');
    expect(skillInvocationLabel(skill({ name: 'summarize', invocation: '/summarize' }))).toBe('/summarize');
  });

  it('never rebuilds the invocation from name when one is given, even if they would disagree', () => {
    expect(skillInvocationLabel(skill({ name: 'review', invocation: '/skill:review-thoroughly' }))).toBe(
      '/skill:review-thoroughly',
    );
  });

  it('falls back to the legacy /name for a command, and bare name for a skill', () => {
    expect(skillInvocationLabel(skill({ name: 'deploy', kind: 'command' }))).toBe('/deploy');
    expect(skillInvocationLabel(skill({ name: 'pdf-reader', kind: 'skill' }))).toBe('pdf-reader');
    expect(skillInvocationLabel(skill({ name: 'pdf-reader' }))).toBe('pdf-reader');
  });
});

describe('isSkillRunnable (FR-1)', () => {
  it('is runnable when loaded is absent (every non-Pi runtime)', () => {
    expect(isSkillRunnable(skill())).toBe(true);
  });

  it('is runnable when loaded: true', () => {
    expect(isSkillRunnable(skill({ loaded: true }))).toBe(true);
  });

  it('is NOT runnable when loaded: false — visible, not runnable', () => {
    expect(isSkillRunnable(skill({ loaded: false }))).toBe(false);
  });
});

describe('skillRowKey (pr-142 §B1)', () => {
  it('uses invocation, so a colon command and a bare command with the same derived name stay distinct', () => {
    const skillCmd = skill({ name: 'deploy', invocation: '/skill:deploy', kind: 'command' });
    const userCmd = skill({ name: 'deploy', invocation: '/deploy', kind: 'command' });
    expect(skillRowKey(skillCmd)).not.toBe(skillRowKey(userCmd));
  });

  it('falls back to kind:name for a non-Pi entry (no invocation)', () => {
    expect(skillRowKey(skill({ name: 'pdf-reader', kind: 'skill' }))).toBe('skill:pdf-reader');
  });

  it('falls back to skill:name when kind is absent too', () => {
    expect(skillRowKey(skill({ name: 'pdf-reader' }))).toBe('skill:pdf-reader');
  });
});
