// Pure halves of useLoginPty (see its own comment) — the hook itself needs a
// DOM renderer and is not unit-tested here, matching useElapsedClock/
// useDismiss/useMounted's split.

import { describe, expect, it } from 'vitest';
import { createPtyByteSink, shouldStartAttempt } from './useLoginPty';

describe('createPtyByteSink', () => {
  it('buffers writes until a writer registers, then flushes them in order', () => {
    const sink = createPtyByteSink();
    sink.write('a');
    sink.write('b');
    const received: string[] = [];
    sink.registerWriter((data) => received.push(data));
    expect(received).toEqual(['a', 'b']);
  });

  it('forwards writes immediately once a writer is registered', () => {
    const sink = createPtyByteSink();
    const received: string[] = [];
    sink.registerWriter((data) => received.push(data));
    sink.write('c');
    expect(received).toEqual(['c']);
  });

  it('never replays a chunk twice across register + later writes', () => {
    const sink = createPtyByteSink();
    sink.write('a');
    const received: string[] = [];
    sink.registerWriter((data) => received.push(data));
    sink.write('b');
    expect(received).toEqual(['a', 'b']);
  });
});

describe('shouldStartAttempt', () => {
  it('is true the first time an attempt is seen', () => {
    const ref = { current: null as number | null };
    expect(shouldStartAttempt(ref, 0)).toBe(true);
    expect(ref.current).toBe(0);
  });

  it('is false on a repeat of the same attempt (StrictMode double-invoke)', () => {
    const ref = { current: null as number | null };
    shouldStartAttempt(ref, 0);
    expect(shouldStartAttempt(ref, 0)).toBe(false);
  });

  it('is true again once the attempt number changes (a genuine retry)', () => {
    const ref = { current: null as number | null };
    shouldStartAttempt(ref, 0);
    expect(shouldStartAttempt(ref, 1)).toBe(true);
    expect(ref.current).toBe(1);
  });
});
