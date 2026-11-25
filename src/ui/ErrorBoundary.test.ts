import { describe, expect, it } from 'vitest';
import { ErrorBoundary, shouldReset } from './ErrorBoundary';

describe('ErrorBoundary.getDerivedStateFromError', () => {
  it('captures the thrown error', () => {
    const err = new Error('boom');
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err });
  });
});

describe('shouldReset', () => {
  it('clears a held error when the reset key changes', () => {
    expect(shouldReset('a', 'b', true)).toBe(true);
    expect(shouldReset(null, 's1', true)).toBe(true);
  });
  it('keeps the error while the key is unchanged', () => {
    expect(shouldReset('a', 'a', true)).toBe(false);
    expect(shouldReset(undefined, undefined, true)).toBe(false);
  });
  it('does nothing when there is no error', () => {
    expect(shouldReset('a', 'b', false)).toBe(false);
  });
});
