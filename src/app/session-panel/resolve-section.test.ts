import { describe, expect, it } from 'vitest';
import { resolveSection, visibleSections } from './resolve-section';

const changes = { id: 'changes', label: 'Changes' };
const activity = { id: 'activity', label: 'Activity' };

describe('resolveSection', () => {
  it('returns the persisted tab when it is registered', () => {
    expect(resolveSection([changes, activity], 'activity')).toBe(activity);
  });

  it('falls back to the first section for a tab nobody registered yet', () => {
    expect(resolveSection([changes, activity], 'plan')).toBe(changes);
  });

  it('is null with no sections at all', () => {
    expect(resolveSection([], 'changes')).toBeNull();
  });
});

describe('resolveSection with invisible sections (cohorte-integration FR-67)', () => {
  const cohorte = { id: 'cohorte', label: 'Cohorte', visible: (s: { detected: boolean }) => s.detected };

  it('skips a section that hides itself, falling back to the first visible one', () => {
    expect(resolveSection([changes, cohorte], 'cohorte', { detected: false })).toBe(changes);
    expect(resolveSection([changes, cohorte], 'cohorte', { detected: true })).toBe(cohorte);
  });

  it('hides a conditional section with no session', () => {
    expect(visibleSections([changes, cohorte], null as { detected: boolean } | null)).toEqual([changes]);
  });
});
