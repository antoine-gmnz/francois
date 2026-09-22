import { describe, expect, it } from 'vitest';
import { buttonClassName } from './Button';

describe('buttonClassName', () => {
  it('maps kind to its modifier class (Figma Kind)', () => {
    expect(buttonClassName('primary', 'md', false)).toBe('btn btn--primary');
    expect(buttonClassName('secondary', 'md', false)).toBe('btn btn--secondary');
    expect(buttonClassName('ghost', 'md', false)).toBe('btn btn--ghost');
    expect(buttonClassName('attention', 'md', false)).toBe('btn btn--attention');
    expect(buttonClassName('danger', 'md', false)).toBe('btn btn--danger');
  });

  it('adds the Sm size modifier', () => {
    expect(buttonClassName('secondary', 'sm', false)).toBe('btn btn--secondary btn--sm');
  });

  it('adds is-disabled when disabled', () => {
    expect(buttonClassName('primary', 'md', true)).toBe('btn btn--primary is-disabled');
    expect(buttonClassName('primary', 'md', undefined)).toBe('btn btn--primary');
  });

  it('appends an extra className last', () => {
    expect(buttonClassName('ghost', 'sm', false, 'create-btn')).toBe('btn btn--ghost btn--sm create-btn');
  });
});
