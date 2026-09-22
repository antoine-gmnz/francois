import { describe, expect, it } from 'vitest';
import { tabClassName } from './Tab';

describe('tabClassName', () => {
  it('marks the selected tab', () => {
    expect(tabClassName(false)).toBe('tab');
    expect(tabClassName(true)).toBe('tab tab--selected');
  });

  it('adds the compact size and an extra class', () => {
    expect(tabClassName(true, 'sm', 'x')).toBe('tab tab--selected tab--sm x');
  });
});
