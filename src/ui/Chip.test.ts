import { describe, expect, it } from 'vitest';
import { chipClassName } from './Chip';

describe('chipClassName', () => {
  it('is just the base class when neither selected nor danger', () => {
    expect(chipClassName(false, false)).toBe('chip');
  });

  it('adds both modifiers independently', () => {
    expect(chipClassName(true, false)).toBe('chip chip--selected');
    expect(chipClassName(false, true)).toBe('chip chip--danger');
    expect(chipClassName(true, true)).toBe('chip chip--selected chip--danger');
  });

  it('appends an extra className last', () => {
    expect(chipClassName(true, true, 'runtime-chip')).toBe('chip chip--selected chip--danger runtime-chip');
  });
});
