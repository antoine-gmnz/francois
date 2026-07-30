import { describe, expect, it } from 'vitest';
import { selectedChipIndex, type ChipOption } from './ChipGroup';

const permissionOptions: ChipOption<string>[] = [
  { value: 'default', label: 'default' },
  { value: 'plan', label: 'plan' },
  { value: 'bypassPermissions', label: 'bypass', danger: true },
];

describe('selectedChipIndex', () => {
  it('finds the option matching the current value', () => {
    expect(selectedChipIndex(permissionOptions, 'plan')).toBe(1);
    expect(selectedChipIndex(permissionOptions, 'bypassPermissions')).toBe(2);
  });

  it('returns -1 when no option matches (e.g. an unselected effort of "")', () => {
    const effortOptions: ChipOption<string>[] = [
      { value: '', label: 'default' },
      { value: 'high', label: 'high' },
    ];
    expect(selectedChipIndex(effortOptions, 'medium')).toBe(-1);
    expect(selectedChipIndex(effortOptions, '')).toBe(0);
  });
});
