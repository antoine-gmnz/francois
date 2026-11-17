import { describe, expect, it } from 'vitest';
import { resolveSection } from './resolve-section';

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
