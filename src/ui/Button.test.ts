import { describe, expect, it } from 'vitest';
import { buttonClassName } from './Button';

describe('buttonClassName', () => {
  it('maps variant to its modifier class', () => {
    expect(buttonClassName('ghost', false)).toBe('btn btn--ghost');
    expect(buttonClassName('primary', false)).toBe('btn btn--primary');
  });

  it('adds is-disabled when disabled', () => {
    expect(buttonClassName('primary', true)).toBe('btn btn--primary is-disabled');
    expect(buttonClassName('primary', undefined)).toBe('btn btn--primary');
  });

  it('appends an extra className last', () => {
    expect(buttonClassName('ghost', false, 'create-btn')).toBe('btn btn--ghost create-btn');
  });
});
