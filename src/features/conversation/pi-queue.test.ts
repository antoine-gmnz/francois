import { describe, expect, it, vi } from 'vitest';
import type { RuntimeQueueEntry } from '../../../contract/common';
import { MAX_PENDING_INTENTS } from '../../../contract/pi-turn-controls';
import {
  canUnqueueIndividually,
  clearableCount,
  clearQueueState,
  exceedsMessageByteCap,
  getQueueEntries,
  isLocalOnly,
  isQueueFull,
  needsResend,
  queueEntryStatusLabel,
  setQueueEntries,
  shouldUnqueueAfterResend,
  subscribeQueueEntries,
  visibleQueueEntries,
} from './pi-queue';

function entry(overrides: Partial<RuntimeQueueEntry>): RuntimeQueueEntry {
  return {
    clientMessageId: 'c1',
    state: 'queued',
    delivery: 'normal',
    text: 'hello',
    attachmentIds: [],
    createdAt: 0,
    ...overrides,
  };
}

describe('getQueueEntries', () => {
  it('is empty for an unknown session', () => {
    expect(getQueueEntries('unknown-1')).toEqual([]);
  });
});

describe('setQueueEntries', () => {
  it('replaces the snapshot wholesale and notifies subscribers', () => {
    const listener = vi.fn();
    const unsub = subscribeQueueEntries('s1', listener);
    const entries = [entry({ clientMessageId: 'a' })];
    setQueueEntries('s1', entries);
    expect(getQueueEntries('s1')).toEqual(entries);
    expect(listener).toHaveBeenCalledTimes(1);
    setQueueEntries('s1', []); // an empty array clears the strip
    expect(getQueueEntries('s1')).toEqual([]);
    unsub();
    clearQueueState('s1');
  });
});

describe('clearQueueState', () => {
  it('drops the ledger snapshot', () => {
    setQueueEntries('s3', [entry({ clientMessageId: 'a', state: 'cancelled' })]);
    clearQueueState('s3');
    expect(getQueueEntries('s3')).toEqual([]);
  });

  it('is a no-op (and does not notify) for an already-empty session', () => {
    const listener = vi.fn();
    const unsub = subscribeQueueEntries('s4', listener);
    clearQueueState('s4');
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });
});

describe('isLocalOnly / needsResend', () => {
  it('only "admitting" is local-only (individually removable)', () => {
    expect(isLocalOnly(entry({ state: 'admitting' }))).toBe(true);
    expect(isLocalOnly(entry({ state: 'queued' }))).toBe(false);
  });

  it('cancelled/delivery-unknown/rejected all need an explicit resend', () => {
    expect(needsResend(entry({ state: 'cancelled' }))).toBe(true);
    expect(needsResend(entry({ state: 'delivery-unknown' }))).toBe(true);
    expect(needsResend(entry({ state: 'rejected' }))).toBe(true);
    expect(needsResend(entry({ state: 'queued' }))).toBe(false);
    expect(needsResend(entry({ state: 'admitting' }))).toBe(false);
  });
});

describe('canUnqueueIndividually (FR-5 amended: what a row state maps to)', () => {
  it('is true for a local-unsent intent', () => {
    expect(canUnqueueIndividually(entry({ state: 'admitting' }))).toBe(true);
  });

  it('is true for every recoverable terminal state', () => {
    expect(canUnqueueIndividually(entry({ state: 'cancelled' }))).toBe(true);
    expect(canUnqueueIndividually(entry({ state: 'delivery-unknown' }))).toBe(true);
    expect(canUnqueueIndividually(entry({ state: 'rejected' }))).toBe(true);
  });

  it('is false for a Pi-accepted queued row — only "Clear queued messages" applies', () => {
    expect(canUnqueueIndividually(entry({ state: 'queued' }))).toBe(false);
  });

  it('is false for a consumed row (never rendered in the strip anyway)', () => {
    expect(canUnqueueIndividually(entry({ state: 'consumed' }))).toBe(false);
  });
});

describe('shouldUnqueueAfterResend (FR-3 amended)', () => {
  it('unqueues the stale old entry once the new submit succeeds', () => {
    expect(shouldUnqueueAfterResend(true)).toBe(true);
  });

  it('keeps the old row when the resend itself failed', () => {
    expect(shouldUnqueueAfterResend(false)).toBe(false);
  });
});

describe('visibleQueueEntries', () => {
  it('drops consumed rows — the transcript block is authoritative for those', () => {
    const entries = [entry({ clientMessageId: 'a', state: 'consumed' }), entry({ clientMessageId: 'b', state: 'queued' })];
    expect(visibleQueueEntries(entries).map((e) => e.clientMessageId)).toEqual(['b']);
  });

  it('keeps recoverable terminal rows listed until the user removes them', () => {
    const entries = [entry({ clientMessageId: 'a', state: 'cancelled' }), entry({ clientMessageId: 'b', state: 'delivery-unknown' })];
    expect(visibleQueueEntries(entries).map((e) => e.clientMessageId)).toEqual(['a', 'b']);
  });
});

describe('clearableCount / isQueueFull', () => {
  it('counts only admitting and queued entries', () => {
    const entries = [
      entry({ clientMessageId: 'a', state: 'admitting' }),
      entry({ clientMessageId: 'b', state: 'queued' }),
      entry({ clientMessageId: 'c', state: 'cancelled' }),
      entry({ clientMessageId: 'd', state: 'delivery-unknown' }),
    ];
    expect(clearableCount(entries)).toBe(2);
  });

  it('is full at MAX_PENDING_INTENTS pending entries', () => {
    const entries = Array.from({ length: MAX_PENDING_INTENTS }, (_, i) => entry({ clientMessageId: String(i), state: 'queued' }));
    expect(isQueueFull(entries)).toBe(true);
    expect(isQueueFull(entries.slice(1))).toBe(false);
  });
});

describe('exceedsMessageByteCap', () => {
  it('is false for ordinary text', () => {
    expect(exceedsMessageByteCap('hello world')).toBe(false);
  });

  it('is true past the 1 MiB UTF-8 cap', () => {
    expect(exceedsMessageByteCap('a'.repeat(1024 * 1024 + 1))).toBe(true);
  });
});

describe('queueEntryStatusLabel', () => {
  it('labels every state', () => {
    expect(queueEntryStatusLabel(entry({ state: 'admitting' }))).toBe('sending…');
    expect(queueEntryStatusLabel(entry({ state: 'queued', queuePosition: 2 }))).toBe('queued #2');
    expect(queueEntryStatusLabel(entry({ state: 'queued' }))).toBe('queued');
    expect(queueEntryStatusLabel(entry({ state: 'consumed' }))).toBe('sent');
    expect(queueEntryStatusLabel(entry({ state: 'cancelled' }))).toBe('not sent — stopped');
    expect(queueEntryStatusLabel(entry({ state: 'delivery-unknown' }))).toBe('delivery unknown');
    expect(queueEntryStatusLabel(entry({ state: 'rejected' }))).toBe('rejected');
  });
});
