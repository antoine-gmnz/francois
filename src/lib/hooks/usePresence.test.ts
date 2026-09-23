import { describe, expect, it } from 'vitest';
import { presenceOf } from './usePresence';

describe('presenceOf', () => {
  it('is present and not exiting while open', () => {
    expect(presenceOf(true, true)).toEqual({ present: true, exiting: false });
    // First render of an open thing, before the effect has marked it lingering.
    expect(presenceOf(true, false)).toEqual({ present: true, exiting: false });
  });

  it('stays present and exiting after closing, until the exit elapses', () => {
    expect(presenceOf(false, true)).toEqual({ present: true, exiting: true });
  });

  it('is gone once closed and done lingering', () => {
    expect(presenceOf(false, false)).toEqual({ present: false, exiting: false });
  });
});
