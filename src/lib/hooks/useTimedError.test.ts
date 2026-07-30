import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTimedHandle, createTimerHandle, scheduleTimedClear } from './useTimedError';

describe('createTimerHandle', () => {
  it('starts empty', () => {
    expect(createTimerHandle().current).toBeUndefined();
  });
});

describe('scheduleTimedClear / clearTimedHandle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs fn after ms', () => {
    const handle = createTimerHandle();
    const fn = vi.fn();
    scheduleTimedClear(handle, fn, 4000);
    vi.advanceTimersByTime(3999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a second schedule cancels the first timer (no early clip, FR-21)', () => {
    const handle = createTimerHandle();
    const first = vi.fn();
    const second = vi.fn();
    scheduleTimedClear(handle, first, 4000);
    vi.advanceTimersByTime(2000);
    scheduleTimedClear(handle, second, 4000); // a new failure lands mid-window
    vi.advanceTimersByTime(4000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clearTimedHandle cancels a pending timer and resets the handle', () => {
    const handle = createTimerHandle();
    const fn = vi.fn();
    scheduleTimedClear(handle, fn, 4000);
    clearTimedHandle(handle);
    expect(handle.current).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('clearTimedHandle on an empty handle is a safe no-op', () => {
    const handle = createTimerHandle();
    expect(() => clearTimedHandle(handle)).not.toThrow();
  });
});
