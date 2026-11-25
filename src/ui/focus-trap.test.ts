import { describe, expect, it } from 'vitest';
import { nextFocusIndex } from './focus-trap';

describe('nextFocusIndex', () => {
  it('advances on Tab', () => {
    expect(nextFocusIndex(3, 0, false)).toBe(1);
    expect(nextFocusIndex(3, 1, false)).toBe(2);
  });
  it('wraps to the first on Tab from the last', () => {
    expect(nextFocusIndex(3, 2, false)).toBe(0);
  });
  it('goes back on Shift+Tab and wraps to the last', () => {
    expect(nextFocusIndex(3, 2, true)).toBe(1);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
  });
  it('enters at the ends when focus is outside the list (-1)', () => {
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
  });
  it('returns -1 when nothing is focusable', () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
  });
});
