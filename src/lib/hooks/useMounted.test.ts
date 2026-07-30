import { describe, expect, it } from 'vitest';
import { createMountedRef } from './useMounted';

// useMounted() itself is a one-line useEffect/useRef wrapper around
// createMountedRef() — there is no component renderer in this project's test
// setup (vitest, node env, no jsdom), so the hook's own React glue is exercised
// only by usage in the app; this file proves the framework-free half it wraps.

describe('createMountedRef', () => {
  it('starts true', () => {
    const { ref } = createMountedRef();
    expect(ref.current).toBe(true);
  });

  it('dispose() flips it to false', () => {
    const { ref, dispose } = createMountedRef();
    dispose();
    expect(ref.current).toBe(false);
  });

  it('dispose() is idempotent', () => {
    const { ref, dispose } = createMountedRef();
    dispose();
    dispose();
    expect(ref.current).toBe(false);
  });

  it('each call returns an independent ref', () => {
    const a = createMountedRef();
    const b = createMountedRef();
    a.dispose();
    expect(a.ref.current).toBe(false);
    expect(b.ref.current).toBe(true);
  });

  it('guards a late async result the way every call site does', async () => {
    const { ref, dispose } = createMountedRef();
    const applied: number[] = [];
    const resolveLate = () =>
      Promise.resolve().then(() => {
        if (ref.current) applied.push(1);
      });
    const p = resolveLate();
    dispose(); // unmount races the promise
    await p;
    expect(applied).toEqual([]); // discarded — mirrors FR-9/FR-28-style guards
  });
});
