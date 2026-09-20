import { describe, expect, it } from 'vitest';
import {
  clearTurnProgress,
  compactionBannerText,
  dismissCompactionProgress,
  getCompactionProgress,
  getRetryProgress,
  retryBannerText,
  setCompactionProgress,
  setRetryProgress,
  type CompactionProgress,
  type RetryProgress,
} from './pi-turn-progress';

describe('compaction progress', () => {
  it('is null for an unknown session', () => {
    expect(getCompactionProgress('unknown')).toBeNull();
  });

  it('started/failed are held; completed clears itself', () => {
    setCompactionProgress('s1', { kind: 'compaction', state: 'started', automatic: false });
    expect(getCompactionProgress('s1')?.state).toBe('started');
    setCompactionProgress('s1', { kind: 'compaction', state: 'failed', automatic: false, message: 'boom' });
    expect(getCompactionProgress('s1')?.state).toBe('failed');
    setCompactionProgress('s1', { kind: 'compaction', state: 'completed', automatic: false });
    expect(getCompactionProgress('s1')).toBeNull();
    clearTurnProgress('s1');
  });

  it('dismissCompactionProgress clears a failed banner and notifies once', () => {
    setCompactionProgress('s2', { kind: 'compaction', state: 'failed', automatic: true, message: 'x' });
    dismissCompactionProgress('s2');
    expect(getCompactionProgress('s2')).toBeNull();
    dismissCompactionProgress('s2'); // idempotent no-op
    clearTurnProgress('s2');
  });
});

describe('retry progress', () => {
  it('waiting/running are held; finished clears itself', () => {
    setRetryProgress('s3', { kind: 'retry', state: 'waiting', attempt: 1 });
    expect(getRetryProgress('s3')?.state).toBe('waiting');
    setRetryProgress('s3', { kind: 'retry', state: 'running', attempt: 2 });
    expect(getRetryProgress('s3')?.attempt).toBe(2);
    setRetryProgress('s3', { kind: 'retry', state: 'finished', attempt: 2 });
    expect(getRetryProgress('s3')).toBeNull();
    clearTurnProgress('s3');
  });
});

describe('clearTurnProgress', () => {
  it('drops both records and notifies once when either was set', () => {
    setCompactionProgress('s4', { kind: 'compaction', state: 'started', automatic: false });
    setRetryProgress('s4', { kind: 'retry', state: 'waiting', attempt: 1 });
    clearTurnProgress('s4');
    expect(getCompactionProgress('s4')).toBeNull();
    expect(getRetryProgress('s4')).toBeNull();
  });

  it('is a no-op for a session with nothing set', () => {
    clearTurnProgress('s5'); // must not throw
    expect(getCompactionProgress('s5')).toBeNull();
  });
});

describe('compactionBannerText (FR-8)', () => {
  it('null ⇒ no banner', () => {
    expect(compactionBannerText(null)).toBeNull();
  });

  it('started shows progress text', () => {
    const p: CompactionProgress = { kind: 'compaction', state: 'started', automatic: true };
    expect(compactionBannerText(p)).toBe('Compacting conversation…');
  });

  it('failed shows the message when present, else a generic line', () => {
    const withMessage: CompactionProgress = { kind: 'compaction', state: 'failed', automatic: false, message: 'boom' };
    expect(compactionBannerText(withMessage)).toBe('Compaction failed: boom');
    const noMessage: CompactionProgress = { kind: 'compaction', state: 'failed', automatic: false };
    expect(compactionBannerText(noMessage)).toBe('Compaction failed.');
  });

  it('completed never reaches the banner (setCompactionProgress already clears it)', () => {
    const p: CompactionProgress = { kind: 'compaction', state: 'completed', automatic: true };
    expect(compactionBannerText(p)).toBeNull();
  });
});

describe('retryBannerText (FR-8)', () => {
  it('null ⇒ no banner', () => {
    expect(retryBannerText(null)).toBeNull();
  });

  it('shows the attempt number', () => {
    const p: RetryProgress = { kind: 'retry', state: 'running', attempt: 3 };
    expect(retryBannerText(p)).toBe('Retrying (attempt 3)…');
  });
});
