import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import { deriveRowCursor, type RowCursorAnchor } from './useRowCursorClamp';

// useRowCursorClamp itself is a thin React effect wrapper around
// deriveRowCursor() — there is no component renderer in this project's test
// setup (vitest, no jsdom), so the hook's own React glue is exercised only by
// usage in the sidebar; this file proves the framework-free core (FR-16).

function session(id: string): SessionMeta {
  return {
    id,
    name: id,
    cwd: '/tmp/repo',
    model: { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
  };
}

describe('deriveRowCursor', () => {
  it('resets to index 0 with no anchor when the list is empty', () => {
    expect(deriveRowCursor([], null, { index: 3, cursoredId: 's1' })).toEqual({ index: 0, cursoredId: null });
  });

  it('follows the cursored session to its new index when it moves (FR-16 case 4)', () => {
    const visible = [session('a'), session('b'), session('c')];
    // 'c' used to sit at index 0 (e.g. before a band move); it is now at 2.
    const result = deriveRowCursor(visible, null, { index: 0, cursoredId: 'c' });
    expect(result).toEqual({ index: 2, cursoredId: 'c' });
  });

  it('keeps the index when there is no anchor yet and it is still in range', () => {
    const visible = [session('a'), session('b')];
    expect(deriveRowCursor(visible, null, { index: 1, cursoredId: null })).toEqual({ index: 1, cursoredId: 'b' });
  });

  it('falls back to the active session when the anchored session disappears (FR-16 case 5/6)', () => {
    const visible = [session('a'), session('b')];
    const result = deriveRowCursor(visible, 'b', { index: 5, cursoredId: 'gone' });
    expect(result).toEqual({ index: 1, cursoredId: 'b' });
  });

  it('falls back to 0 when neither the anchor, the index, nor the active session resolve', () => {
    const visible = [session('a'), session('b')];
    const result = deriveRowCursor(visible, 'nowhere', { index: 9, cursoredId: 'gone' });
    expect(result).toEqual({ index: 0, cursoredId: 'a' });
  });

  it('prefers the anchored session over a stale-but-in-range index', () => {
    const visible = [session('a'), session('b'), session('c')];
    // index 0 is still "in range", but the anchor says the cursor was on 'b'.
    const result = deriveRowCursor(visible, null, { index: 0, cursoredId: 'b' });
    expect(result).toEqual({ index: 1, cursoredId: 'b' });
  });

  it('is a pure function of its inputs', () => {
    const visible = [session('a')];
    const anchor: RowCursorAnchor = { index: 0, cursoredId: null };
    deriveRowCursor(visible, null, anchor);
    expect(anchor).toEqual({ index: 0, cursoredId: null });
  });
});
