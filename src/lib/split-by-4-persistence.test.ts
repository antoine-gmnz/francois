// split-by-4 / unbound-panes: parseSplitState's normalization (three
// generations of the persisted shape, shell panes, index-0 coercion) and
// initialLastFocusedSessionId's early-hydration fallback. See
// split-by-4.test.ts for the store slice that actually round-trips this
// through localStorage, and split-by-4-selectors.test.ts for the pure
// derived-state selectors.

import { describe, expect, it } from 'vitest';

import { initialLastFocusedSessionId, MAX_PANES, parseSplitState, type PaneSlot } from './layoutStore';

function sessionPane(sessionId: string | null, tab = 'session'): PaneSlot {
  return { kind: 'session', sessionId, tab } as PaneSlot;
}

function shellPane(projectId: string, shellId: string | null = null): PaneSlot {
  return { kind: 'shell', projectId, shellId };
}

// ── persistence ─────────────────────────────────────────────────────────────

describe('parseSplitState (FR-23, unbound-panes FR-17)', () => {
  const NOT_SPLIT = { extraPanes: [], focusedPaneIndex: 0 };

  it('defaults to not-split for null input and malformed JSON', () => {
    expect(parseSplitState(null)).toEqual(NOT_SPLIT);
    expect(parseSplitState('{oops')).toEqual(NOT_SPLIT);
  });

  it('defaults to not-split for a non-object value (array, number, string, null)', () => {
    expect(parseSplitState('[1,2]')).toEqual(NOT_SPLIT);
    expect(parseSplitState('42')).toEqual(NOT_SPLIT);
    expect(parseSplitState('"hi"')).toEqual(NOT_SPLIT);
    expect(parseSplitState('null')).toEqual(NOT_SPLIT);
  });

  it('degrades a record with no usable panes to not-split', () => {
    expect(parseSplitState(JSON.stringify({ focusedPaneIndex: 2 }))).toEqual(NOT_SPLIT);
    expect(parseSplitState(JSON.stringify({ extraPanes: [] }))).toEqual(NOT_SPLIT);
    expect(parseSplitState(JSON.stringify({ extraPanes: [{ sessionId: 7 }, null, 'x'] }))).toEqual(NOT_SPLIT);
  });

  it('reads a bare {sessionId, tab} record (the split-by-4 shape, no `kind`) as a session pane', () => {
    expect(parseSplitState(JSON.stringify({ extraPanes: [{ sessionId: 's2', tab: 'diff' }] }))).toEqual({
      extraPanes: [sessionPane('s2', 'diff')],
      focusedPaneIndex: 0,
    });
  });

  it('reads the union shape’s session AND shell variants', () => {
    expect(
      parseSplitState(
        JSON.stringify({
          extraPanes: [
            { kind: 'session', sessionId: 's2', tab: 'diff' },
            { kind: 'shell', projectId: 'p1' },
          ],
        }),
      ),
    ).toEqual({ extraPanes: [sessionPane('s2', 'diff'), shellPane('p1')], focusedPaneIndex: 0 });
  });

  it('drops a shell entry with no usable projectId', () => {
    expect(parseSplitState(JSON.stringify({ extraPanes: [{ kind: 'shell' }] }))).toEqual(NOT_SPLIT);
  });

  it('defaults an unknown tab and clamps the focused index rather than trusting them', () => {
    expect(
      parseSplitState(JSON.stringify({ extraPanes: [{ sessionId: 's2', tab: 'overview' }], focusedPaneIndex: 9 })),
    ).toEqual({ extraPanes: [sessionPane('s2', 'session')], focusedPaneIndex: 1 });
  });

  it('unbound-panes FR-5: NO LONGER drops a duplicate session pane — duplicates are legitimate', () => {
    expect(
      parseSplitState(
        JSON.stringify({ extraPanes: [{ sessionId: 's2', tab: 'diff' }, { sessionId: 's2', tab: 'shell' }] }),
      ).extraPanes,
    ).toEqual([sessionPane('s2', 'diff'), sessionPane('s2', 'shell')]);
  });

  it('caps the list at MAX_PANES - 1 extras', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ sessionId: `s${i}`, tab: 'session' }));
    expect(parseSplitState(JSON.stringify({ extraPanes: many })).extraPanes).toHaveLength(MAX_PANES - 1);
  });

  it('round-trips a fully valid record', () => {
    const rec = { extraPanes: [sessionPane('s2', 'shell'), sessionPane('s3', 'diff')], focusedPaneIndex: 2 };
    expect(parseSplitState(JSON.stringify(rec))).toEqual(rec);
  });

  it('reads a LEGACY split-session record as one extra pane', () => {
    expect(parseSplitState(JSON.stringify({ splitSessionId: 's2', splitTab: 'diff', focusedSide: 'right' }))).toEqual({
      extraPanes: [sessionPane('s2', 'diff')],
      focusedPaneIndex: 1,
    });
    expect(parseSplitState(JSON.stringify({ splitSessionId: 's2', splitTab: 'nope', focusedSide: 'left' }))).toEqual({
      extraPanes: [sessionPane('s2', 'session')],
      focusedPaneIndex: 0,
    });
  });

  it('degrades a legacy not-split record to not-split', () => {
    expect(parseSplitState(JSON.stringify({ splitSessionId: null, splitTab: 'diff', focusedSide: 'left' }))).toEqual(
      NOT_SPLIT,
    );
  });

  it('FR-17: shellId is never carried by a persisted record — it round-trips as null every time', () => {
    const parsed = parseSplitState(JSON.stringify({ extraPanes: [{ kind: 'shell', projectId: 'p1', shellId: 'ignored' }] }));
    expect(parsed.extraPanes).toEqual([shellPane('p1', null)]);
  });
});

describe('initialLastFocusedSessionId (unbound-panes FR-12: seeding lastFocusedSessionId from the hydrated split BEFORE any focus subscription runs)', () => {
  it('not split ⇒ null (pane 0 is always empty this early — sessions arrive over the fleet sync)', () => {
    expect(initialLastFocusedSessionId({ extraPanes: [], focusedPaneIndex: 0 })).toBeNull();
  });

  it('reads the focused extra pane’s session directly when it is a session pane', () => {
    expect(
      initialLastFocusedSessionId({ extraPanes: [sessionPane('s2'), sessionPane('s3')], focusedPaneIndex: 2 }),
    ).toBe('s3');
  });

  it('a persisted focusedPaneIndex on a SHELL pane falls back to the first session-holding pane, not null', () => {
    expect(
      initialLastFocusedSessionId({ extraPanes: [shellPane('p1'), sessionPane('s2')], focusedPaneIndex: 1 }),
    ).toBe('s2');
  });

  it('a persisted focusedPaneIndex on an EMPTY session pane also falls back', () => {
    expect(
      initialLastFocusedSessionId({ extraPanes: [sessionPane(null), sessionPane('s2')], focusedPaneIndex: 1 }),
    ).toBe('s2');
  });

  it('no session pane anywhere ⇒ null', () => {
    expect(initialLastFocusedSessionId({ extraPanes: [shellPane('p1'), sessionPane(null)], focusedPaneIndex: 2 })).toBeNull();
  });
});
