import { describe, expect, it } from 'vitest';
import { deepEqual } from './deep-equal';

describe('deepEqual', () => {
  it('is key-order-insensitive, unlike the JSON.stringify comparison it replaces', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
  });

  it('answers false on a nested difference at any depth', () => {
    expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(false);
    expect(deepEqual({ a: [1, 2, 3] }, { a: [1, 2, 4] })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: '1' })).toBe(false);
  });

  it('compares arrays by position and length', () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    // An array is never equal to an object that happens to carry its indices.
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });

  it('answers false when one side has an extra defined key', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  // JSON.stringify drops an `undefined` value entirely, and the callers compare
  // two snapshots of the same wire shape — one of which may have been rebuilt
  // in the store (`{ ...session, effort: undefined }`) rather than parsed. So an
  // explicitly-undefined key must keep reading as absent, or the no-op guard
  // this backs would mint a new array for an identical payload.
  it('reads an explicitly-undefined key as absent, exactly like JSON.stringify did', () => {
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1, b: 2 })).toBe(false);
  });

  it('handles null, primitives and mixed types without throwing', () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
    expect(deepEqual(undefined, null)).toBe(false);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(true, false)).toBe(false);
  });

  it('short-circuits on reference identity without walking the value', () => {
    const shared = { deep: { deeper: [1, 2, 3] } };
    expect(deepEqual(shared, shared)).toBe(true);
  });
});
