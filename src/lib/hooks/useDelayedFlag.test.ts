import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDelayedFlag } from './useDelayedFlag';

describe('startDelayedFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule anything when inactive', () => {
    const onFlip = vi.fn();
    const cleanup = startDelayedFlag(false, 140, onFlip);
    expect(cleanup).toBeUndefined();
    vi.advanceTimersByTime(1000);
    expect(onFlip).not.toHaveBeenCalled();
  });

  it('flips true after the delay while active', () => {
    const onFlip = vi.fn();
    startDelayedFlag(true, 140, onFlip);
    vi.advanceTimersByTime(139);
    expect(onFlip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it('never flips when active goes false before the delay (cleanup cancels the pending timer)', () => {
    const onFlip = vi.fn();
    const cleanup = startDelayedFlag(true, 140, onFlip);
    vi.advanceTimersByTime(100);
    cleanup?.(); // mirrors the effect re-running because `active` became false
    vi.advanceTimersByTime(1000);
    expect(onFlip).not.toHaveBeenCalled();
  });

  it('the returned cleanup clears the timer on unmount / an active identity change', () => {
    const onFlip = vi.fn();
    const cleanup = startDelayedFlag(true, 140, onFlip);
    cleanup?.();
    vi.advanceTimersByTime(500);
    expect(onFlip).not.toHaveBeenCalled();
  });

  it('honors a custom delay', () => {
    const onFlip = vi.fn();
    startDelayedFlag(true, 500, onFlip);
    vi.advanceTimersByTime(499);
    expect(onFlip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlip).toHaveBeenCalledTimes(1);
  });
});
