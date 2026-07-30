import { describe, expect, it } from 'vitest';
import { isEscapeKey, isOutsideTarget } from './useDismiss';

// useDismiss() itself just wires these two predicates to `window` listeners —
// there is no DOM/component renderer in this project's vitest setup, so the
// predicates (the actual decision logic every divergent copy reimplemented) are
// what gets exercised directly here.

describe('isEscapeKey', () => {
  it('is true for Escape', () => {
    expect(isEscapeKey({ key: 'Escape' })).toBe(true);
  });

  it('is false for any other key', () => {
    expect(isEscapeKey({ key: 'Enter' })).toBe(false);
    expect(isEscapeKey({ key: 'a' })).toBe(false);
    expect(isEscapeKey({ key: 'Tab' })).toBe(false);
  });
});

// Minimal contains()-shaped stand-in for HTMLElement — no jsdom is wired.
function fakeContainer(containsTarget: boolean): HTMLElement {
  return { contains: () => containsTarget } as unknown as HTMLElement;
}
const fakeTarget = {} as EventTarget;

describe('isOutsideTarget', () => {
  it('is true when the container does not contain the target', () => {
    expect(isOutsideTarget(fakeContainer(false), fakeTarget)).toBe(true);
  });

  it('is false when the container contains the target (a click inside)', () => {
    expect(isOutsideTarget(fakeContainer(true), fakeTarget)).toBe(false);
  });

  it('is false when there is no container yet (nothing to be outside of)', () => {
    expect(isOutsideTarget(null, fakeTarget)).toBe(false);
  });

  it('is true for a null target against a real container', () => {
    expect(isOutsideTarget(fakeContainer(false), null)).toBe(true);
  });
});
