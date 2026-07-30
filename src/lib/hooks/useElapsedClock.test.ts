import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startElapsedClock } from './useElapsedClock';

describe('startElapsedClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule anything when inactive', () => {
    const onTick = vi.fn();
    const cleanup = startElapsedClock(false, 1000, onTick);
    expect(cleanup).toBeUndefined();
    vi.advanceTimersByTime(5000);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('ticks once per intervalMs while active', () => {
    const onTick = vi.fn();
    startElapsedClock(true, 1000, onTick);
    vi.advanceTimersByTime(3500);
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it('honors a custom interval (e.g. OverviewView\'s 30s cadence)', () => {
    const onTick = vi.fn();
    startElapsedClock(true, 30_000, onTick);
    vi.advanceTimersByTime(29_999);
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('the returned cleanup stops further ticks', () => {
    const onTick = vi.fn();
    const cleanup = startElapsedClock(true, 1000, onTick);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
    cleanup?.();
    vi.advanceTimersByTime(5000);
    expect(onTick).toHaveBeenCalledTimes(1);
  });
});
