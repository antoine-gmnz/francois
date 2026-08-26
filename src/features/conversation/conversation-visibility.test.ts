// What a HELD transcript does with the events it keeps receiving.
//
// The main pane no longer unmounts a transcript on a session or tab switch — it
// holds the last few mounted behind `display: none` (src/app/SessionViewHost.tsx),
// so `useConversationTranscript` now runs for sessions nobody is looking at. The
// rule that keeps that from costing the VISIBLE session anything is
// `shouldScheduleDeltaFlush`, exercised here against the coalescer's own buffer
// so the "buffered, never lost" half is proven rather than asserted.
//
// In its own file rather than appended to conversation-blocks.test.ts, which is
// already past the CLAUDE.md 1000-line cap (scripts/quality/oversized-baseline.json).

import { describe, expect, it } from 'vitest';
import {
  drainDeltas,
  pushDelta,
  shouldScheduleDeltaFlush,
  transcriptReducer,
  type DeltaChunk,
  type TranscriptState,
} from './conversation-blocks';

describe('shouldScheduleDeltaFlush', () => {
  it('schedules a frame for a visible transcript with none pending', () => {
    expect(shouldScheduleDeltaFlush(true, false)).toBe(true);
  });

  it('never schedules a second frame while one already owns the buffer (FR-5)', () => {
    expect(shouldScheduleDeltaFlush(true, true)).toBe(false);
  });

  it('never schedules one for a HIDDEN transcript — buffering is all it does', () => {
    expect(shouldScheduleDeltaFlush(false, false)).toBe(false);
    expect(shouldScheduleDeltaFlush(false, true)).toBe(false);
  });
});

describe('a hidden transcript buffers without dropping anything', () => {
  /** The hook's loop: buffer every chunk, schedule a flush only if allowed. */
  function receive(buffer: Map<string, DeltaChunk[]>, visible: boolean, chunks: DeltaChunk[]): number {
    let framePending = false;
    let scheduled = 0;
    for (const c of chunks) {
      pushDelta(buffer, 'b1', c.text, c.offset);
      if (shouldScheduleDeltaFlush(visible, framePending)) {
        framePending = true;
        scheduled += 1;
      }
    }
    return scheduled;
  }

  it('schedules nothing while hidden, then replays every chunk in order on the flush', () => {
    const buffer = new Map<string, DeltaChunk[]>();
    const chunks: DeltaChunk[] = [
      { text: 'he', offset: 0 },
      { text: 'llo', offset: 2 },
      { text: ' world', offset: 5 },
    ];
    expect(receive(buffer, false, chunks)).toBe(0);

    // Nothing was applied — and nothing was lost either: it is all still queued.
    const actions = drainDeltas(buffer);
    expect(actions).toEqual([{ t: 'deltaBatch', blockId: 'b1', chunks }]);

    // The flip to visible (or any non-delta event, or unmount) drains it, and
    // the text is byte-identical to having applied each chunk as it arrived.
    let state: TranscriptState = { blocks: [], windowSize: 200 };
    for (const a of actions) state = transcriptReducer(state, a);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: 'assistant', blockId: 'b1', text: 'hello world', isStreaming: true });
  });

  it('coalesces a visible transcript to ONE frame per burst, exactly as before', () => {
    const buffer = new Map<string, DeltaChunk[]>();
    const scheduled = receive(buffer, true, [
      { text: 'a', offset: 0 },
      { text: 'b', offset: 1 },
      { text: 'c', offset: 2 },
    ]);
    expect(scheduled).toBe(1);
    expect(drainDeltas(buffer)).toHaveLength(1);
  });
});
