import { afterEach, describe, expect, it, vi } from 'vitest';
import { onDiffFileRequest, requestDiffFile, takePendingDiffFile } from './diff-focus';

afterEach(() => {
  // Drain whatever a test left behind.
  takePendingDiffFile('s1');
  takePendingDiffFile('s2');
});

describe('diff-focus', () => {
  it('holds a request until the matching session takes it, once', () => {
    requestDiffFile('s1', 'src/a.ts');
    expect(takePendingDiffFile('s2')).toBeNull();
    expect(takePendingDiffFile('s1')).toBe('src/a.ts');
    expect(takePendingDiffFile('s1')).toBeNull();
  });

  it('a newer request replaces an older one', () => {
    requestDiffFile('s1', 'a');
    requestDiffFile('s1', 'b');
    expect(takePendingDiffFile('s1')).toBe('b');
  });

  it('notifies live listeners and unsubscribes', () => {
    const fn = vi.fn();
    const off = onDiffFileRequest(fn);
    requestDiffFile('s1', 'x');
    expect(fn).toHaveBeenCalledWith({ sessionId: 's1', path: 'x' });
    off();
    requestDiffFile('s1', 'y');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
