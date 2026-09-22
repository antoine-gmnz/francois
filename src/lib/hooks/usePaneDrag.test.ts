import { describe, expect, it } from 'vitest';
import { shouldScheduleDragFrame } from './usePaneDrag';

// usePaneDrag() itself wires DOM pointer-capture APIs — no DOM renderer is
// wired in this project's vitest setup (see useDismiss.test.ts), so the gate
// that decides whether a pointermove coalesces into an already-pending frame
// or schedules a new one is what gets exercised directly here.

describe('shouldScheduleDragFrame', () => {
  it('schedules a frame when none is pending', () => {
    expect(shouldScheduleDragFrame(false)).toBe(true);
  });

  it('does not schedule a second frame while one is already pending', () => {
    expect(shouldScheduleDragFrame(true)).toBe(false);
  });
});
