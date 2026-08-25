// split-by-4 / unbound-panes: the pane list's pure selectors over a PaneSlot
// array — paneCount/layoutRegime/clampPaneIndex/paneIndicesOf/
// focusedSessionId/focusedTab/visibleSessionIds/isShellVisible/
// splitCandidates/clampToPaneTab/promotionTarget/railOrder, plus the chrome
// predicates (canOpenShellPane/projectShellPaneCount/shellPaneEligibleProjects/
// railPinnedCount). None of these touch the store or localStorage — see
// split-by-4.test.ts for the store slice and split-by-4-persistence.test.ts
// for parseSplitState.

import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../contract/common';

import {
  canOpenShellPane,
  clampPaneIndex,
  clampToPaneTab,
  focusedSessionId,
  focusedTab,
  isShellVisible,
  layoutModeState,
  layoutRegime,
  MAX_PANES,
  paneCount,
  paneIndicesOf,
  paneSessionIdAt,
  paneTabAt,
  panesWithout,
  panesWithoutStaleProjects,
  projectShellPaneCount,
  shellPaneEligibleProjects,
  promotionTarget,
  railOrder,
  railPinnedCount,
  splitCandidate,
  splitCandidates,
  visibleSessionIds,
  type PaneSlot,
} from './layoutStore';

function meta(id: string, lastActivityAt: number, status: SessionMeta['status'] = 'idle'): SessionMeta {
  return {
    id,
    name: id,
    cwd: '/repo',
    model: { id: 'm', label: 'M' },
    status,
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
    allowGit: false,
  };
}

function sessionPane(sessionId: string | null, tab = 'session'): PaneSlot {
  return { kind: 'session', sessionId, tab } as PaneSlot;
}

function shellPane(projectId: string, shellId: string | null = null): PaneSlot {
  return { kind: 'shell', projectId, shellId };
}

/** The minimum a pane reader needs — cast at the call sites, not here. */
function panes(activeSessionId: string | null, mainTab: string, extraPanes: PaneSlot[], lastFocusedSessionId: string | null = null) {
  return { activeSessionId, mainTab, extraPanes, lastFocusedSessionId } as unknown as Parameters<typeof visibleSessionIds>[0] &
    Parameters<typeof focusedSessionId>[0];
}

// ── pure selectors ──────────────────────────────────────────────────────────

describe('layoutRegime (FR-3)', () => {
  it('maps the pane count to the two chromes', () => {
    expect(layoutRegime(0)).toBe('single'); // defensive: never reached
    expect(layoutRegime(1)).toBe('single');
    expect(layoutRegime(2)).toBe('split');
    expect(layoutRegime(3)).toBe('grid');
    expect(layoutRegime(4)).toBe('grid');
  });
});

describe('layoutModeState — the ▯ / ▯▯ / ⊞ segmented control (FR-15)', () => {
  const at = (panes: number, canSplit = true) => ({
    single: layoutModeState(1, panes, canSplit),
    split: layoutModeState(2, panes, canSplit),
    grid: layoutModeState(MAX_PANES, panes, canSplit),
  });

  it('lights exactly one button per layout, ⊞ across the whole grid range', () => {
    expect([at(1).single.on, at(1).split.on, at(1).grid.on]).toEqual([true, false, false]);
    expect([at(2).single.on, at(2).split.on, at(2).grid.on]).toEqual([false, true, false]);
    expect([at(3).single.on, at(3).split.on, at(3).grid.on]).toEqual([false, false, true]);
    expect([at(4).single.on, at(4).split.on, at(4).grid.on]).toEqual([false, false, true]);
  });

  it('AT THREE PANES every button still does something — ⊞ is lit but a fourth pane is missing', () => {
    expect(at(3).single.actionable).toBe(true); // → 1
    expect(at(3).split.actionable).toBe(true); // → 2
    expect(at(3).grid.actionable).toBe(true); // → 4, even though it reads as pressed
  });

  it('is a no-op only when the target IS the current count', () => {
    expect(at(1).single.actionable).toBe(false);
    expect(at(2).split.actionable).toBe(false);
    expect(at(4).grid.actionable).toBe(false);
    // …and at 3 panes NO button is the current count, so none is inert
    expect(Object.values(at(3)).every((m) => m.actionable)).toBe(true);
  });

  it('gates only ENTERING a split on a splittable scope — never leaving or resizing one', () => {
    expect(at(1, false).split.disabled).toBe(true);
    expect(at(1, false).grid.disabled).toBe(true);
    expect(at(1, false).single.disabled).toBe(false);
    // already split with an unsplittable scope: still steerable
    expect(at(3, false).split.disabled).toBe(false);
    expect(at(3, false).split.actionable).toBe(true);
    expect(at(3, false).grid.actionable).toBe(true);
    expect(at(3, false).single.actionable).toBe(true);
  });
});

describe('clampPaneIndex (FR-12)', () => {
  it('clamps into 0..count-1', () => {
    expect(clampPaneIndex(3, 2)).toBe(1);
    expect(clampPaneIndex(1, 4)).toBe(1);
    expect(clampPaneIndex(0, 1)).toBe(0);
  });

  it('treats a negative, fractional or non-integer index as 0', () => {
    expect(clampPaneIndex(-1, 4)).toBe(0);
    expect(clampPaneIndex(1.5, 4)).toBe(0);
    expect(clampPaneIndex(NaN, 4)).toBe(0);
  });
});

describe('paneCount / paneSessionIdAt / paneTabAt / paneIndicesOf (FR-1, unbound-panes FR-4/FR-5)', () => {
  const s = panes('s1', 'diff', [sessionPane('s2', 'shell'), sessionPane('s3', 'session')]);

  it('counts pane 0 plus the extras', () => {
    expect(paneCount({ extraPanes: [] } as never)).toBe(1);
    expect(paneCount(s)).toBe(3);
  });

  it('reads pane 0 off activeSessionId/mainTab and the rest off extraPanes', () => {
    expect(paneSessionIdAt(s, 0)).toBe('s1');
    expect(paneTabAt(s, 0)).toBe('diff');
    expect(paneSessionIdAt(s, 2)).toBe('s3');
    expect(paneTabAt(s, 1)).toBe('shell');
  });

  it('clamps pane 0 out of a tab a pane cannot show', () => {
    expect(paneTabAt(panes('s1', 'overview', []), 0)).toBe('session');
    expect(paneTabAt(panes('s1', 'agents', []), 0)).toBe('session');
  });

  it('KEEPS a dynamic tab below the grid, and flattens it inside it (fix-agent-view FR-3/FR-13)', () => {
    expect(paneTabAt(panes('s1', 'agent:a1', []), 0)).toBe('agent:a1');
    expect(paneTabAt(panes('s1', 'agent:a1', [sessionPane('s2', 'diff')]), 0)).toBe('agent:a1');
    const grid = panes('s1', 'agent:a1', [sessionPane('s2', 'workflow:w1'), sessionPane('s3', 'diff')]);
    expect(paneTabAt(grid, 0)).toBe('session');
    expect(paneTabAt(grid, 1)).toBe('session');
    expect(paneTabAt(grid, 2)).toBe('diff'); // built-ins are untouched
  });

  it('answers null for an out-of-range pane', () => {
    expect(paneSessionIdAt(s, 9)).toBeNull();
    expect(paneTabAt(s, 9)).toBe('session');
  });

  it('a shell-kind pane contributes no session and no PaneTab', () => {
    const withShell = panes('s1', 'session', [shellPane('p1'), sessionPane('s3', 'diff')]);
    expect(paneSessionIdAt(withShell, 1)).toBeNull();
    expect(paneTabAt(withShell, 1)).toBe('session'); // never actually rendered — kind decides chrome
  });

  it('locates every pane showing a session — unbound-panes FR-5: duplicates are legitimate', () => {
    expect(paneIndicesOf(s, 's1')).toEqual([0]);
    expect(paneIndicesOf(s, 's3')).toEqual([2]);
    expect(paneIndicesOf(s, 'nope')).toEqual([]);

    const dup = panes('s1', 'session', [sessionPane('s1', 'diff'), sessionPane('s2', 'session')]);
    expect(paneIndicesOf(dup, 's1')).toEqual([0, 1]);
  });
});

describe('focusedSessionId / focusedTab (FR-13, unbound-panes FR-12 fallback)', () => {
  const s = panes('s1', 'diff', [sessionPane('s2', 'shell'), sessionPane('s3', 'session')]);

  it('is the focused pane’s session and tab', () => {
    expect(focusedSessionId({ ...s, focusedPaneIndex: 0 })).toBe('s1');
    expect(focusedSessionId({ ...s, focusedPaneIndex: 2 })).toBe('s3');
    expect(focusedTab({ ...s, focusedPaneIndex: 1 })).toBe('shell');
  });

  it('equals activeSessionId when not split, so every consumer is unchanged', () => {
    const single = panes('s1', 'overview', []);
    expect(focusedSessionId({ ...single, focusedPaneIndex: 0 })).toBe('s1');
    expect(focusedTab({ ...single, focusedPaneIndex: 0 })).toBe('overview');
  });

  it('clamps a stale focused index rather than reading past the list', () => {
    expect(focusedSessionId({ ...s, focusedPaneIndex: 7 })).toBe('s3');
  });

  it('unbound-panes FR-12: falls back to lastFocusedSessionId when the focused pane is a shell', () => {
    const withShell = panes('s1', 'session', [shellPane('p1')], 's1');
    expect(focusedSessionId({ ...withShell, focusedPaneIndex: 1 })).toBe('s1');
  });

  it('an EMPTY session pane focused answers null even with a lastFocusedSessionId on file', () => {
    const withEmpty = panes('s1', 'session', [sessionPane(null)], 's1');
    expect(focusedSessionId({ ...withEmpty, focusedPaneIndex: 1 })).toBeNull();
  });

  it('is null when no session pane has ever been focused this run', () => {
    const withShell = panes(null, 'session', [shellPane('p1')], null);
    expect(focusedSessionId({ ...withShell, focusedPaneIndex: 1 })).toBeNull();
  });
});

describe('visibleSessionIds (FR-26, unbound-panes FR-5: duplicates count once, shells contribute nothing)', () => {
  it('lists every pane’s session once', () => {
    expect(visibleSessionIds(panes('s1', 'session', [sessionPane('s2'), sessionPane('s3', 'diff')]))).toEqual([
      's1',
      's2',
      's3',
    ]);
  });

  it('is just the active session when not split', () => {
    expect(visibleSessionIds(panes('s1', 'session', []))).toEqual(['s1']);
    expect(visibleSessionIds(panes(null, 'session', []))).toEqual([]);
  });

  it('the same session in two panes counts once', () => {
    expect(visibleSessionIds(panes('s1', 'session', [sessionPane('s1', 'diff'), sessionPane('s2')]))).toEqual([
      's1',
      's2',
    ]);
  });

  it('a shell pane contributes nothing', () => {
    expect(visibleSessionIds(panes('s1', 'session', [shellPane('p1'), sessionPane('s2')]))).toEqual(['s1', 's2']);
  });
});

describe('isShellVisible (FR-25)', () => {
  it('is true for pane 0 on SHELL, whatever the other panes show', () => {
    expect(isShellVisible(panes('s1', 'shell', [sessionPane('s2', 'diff')]), 's1')).toBe(true);
    expect(isShellVisible(panes('s1', 'diff', [sessionPane('s2', 'diff')]), 's1')).toBe(false);
  });

  it('is true for ANY pane on SHELL — not just the focused one', () => {
    const s = panes('s1', 'session', [sessionPane('s2', 'shell')]);
    expect(isShellVisible(s, 's2')).toBe(true);
    expect(isShellVisible(s, 's1')).toBe(false);
  });

  it('is false throughout the grid chrome — no pane there renders a shell (FR-9)', () => {
    const s = panes('s1', 'shell', [sessionPane('s2', 'shell'), sessionPane('s3', 'shell')]);
    expect(isShellVisible(s, 's1')).toBe(false);
    expect(isShellVisible(s, 's3')).toBe(false);
  });

  it('a shell-KIND pane never registers as a session’s SHELL tab', () => {
    const s = panes('s1', 'session', [shellPane('p1')]);
    expect(isShellVisible(s, 's1')).toBe(false);
  });
});

describe('splitCandidates / splitCandidate (unbound-panes FR-3: no scope argument — the WHOLE fleet)', () => {
  const list = [meta('a', 10), meta('b', 50), meta('c', 30), meta('d', 40)];

  it('returns the n most recently active sessions no pane holds', () => {
    expect(splitCandidates(list, ['b'], 2).map((m) => m.id)).toEqual(['d', 'c']);
    expect(splitCandidates(list, [], 3).map((m) => m.id)).toEqual(['b', 'd', 'c']);
  });

  it('returns fewer than n rather than padding, and nothing for n <= 0', () => {
    expect(splitCandidates(list, ['a', 'b', 'c'], 3).map((m) => m.id)).toEqual(['d']);
    expect(splitCandidates(list, [], 0)).toEqual([]);
  });

  it('does not mutate the input order', () => {
    const copy = list.slice();
    splitCandidates(list, [], 4);
    expect(list).toEqual(copy);
  });

  it('splitCandidate is the single-slot case', () => {
    expect(splitCandidate(list, 'b')?.id).toBe('d');
    expect(splitCandidate([meta('a', 1)], 'a')).toBeNull();
    expect(splitCandidate([], null)).toBeNull();
  });
});

describe('promotionTarget (unbound-panes FR-8)', () => {
  it('picks the first SESSION-kind pane, skipping shells', () => {
    expect(promotionTarget([shellPane('p1'), sessionPane('s2'), shellPane('p2')])).toBe(1);
    expect(promotionTarget([sessionPane('s1'), shellPane('p1')])).toBe(0);
  });

  it('is null when there is no session pane to promote', () => {
    expect(promotionTarget([shellPane('p1'), shellPane('p2')])).toBeNull();
    expect(promotionTarget([])).toBeNull();
  });
});

describe('railOrder (unbound-panes FR-15)', () => {
  const list = [meta('a', 10), meta('b', 50), meta('c', 30), meta('d', 40)];

  it('pins paned sessions to the top, both groups by lastActivityAt desc', () => {
    expect(railOrder(list, ['a', 'c']).map((m) => m.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('is plain recency order with nothing paned', () => {
    expect(railOrder(list, []).map((m) => m.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('never disagrees with splitCandidates’ own order', () => {
    expect(railOrder(list, []).map((m) => m.id)).toEqual(splitCandidates(list, [], list.length).map((m) => m.id));
  });
});

describe('clampToPaneTab (FR-20)', () => {
  it('keeps the three tabs a pane can show', () => {
    expect(clampToPaneTab('session')).toBe('session');
    expect(clampToPaneTab('diff')).toBe('diff');
    expect(clampToPaneTab('shell')).toBe('shell');
  });

  it('clamps overview and the dissolved panel tabs to session', () => {
    expect(clampToPaneTab('overview')).toBe('session');
    for (const panel of ['agents', 'mcp', 'skills', 'workflows'] as const) {
      expect(clampToPaneTab(panel)).toBe('session');
    }
  });

  it('passes the dynamic tabs through — they are PaneTab members (fix-agent-view FR-3)', () => {
    expect(clampToPaneTab('agent:a1')).toBe('agent:a1');
    expect(clampToPaneTab('workflow:run-1')).toBe('workflow:run-1');
  });
});

describe('panesWithout (FR-27)', () => {
  it('drops every SESSION pane on that session, leaving shell panes untouched', () => {
    const list: PaneSlot[] = [sessionPane('s2'), sessionPane('s3', 'diff'), shellPane('p1')];
    expect(panesWithout(list, 's2')).toEqual([sessionPane('s3', 'diff'), shellPane('p1')]);
    expect(panesWithout(list, 'nope')).toHaveLength(3);
  });
});

describe('panesWithoutStaleProjects (unbound-panes FR-17)', () => {
  it('drops a shell pane whose project is no longer registered', () => {
    const list: PaneSlot[] = [shellPane('p1'), shellPane('p2'), sessionPane('s1')];
    expect(panesWithoutStaleProjects(list, new Set(['p1']))).toEqual([shellPane('p1'), sessionPane('s1')]);
  });

  it('leaves session panes alone regardless of the registry', () => {
    const list: PaneSlot[] = [sessionPane('s1')];
    expect(panesWithoutStaleProjects(list, new Set())).toEqual(list);
  });
});

// ── unbound-panes FR-9 / FR-15 chrome predicates ────────────────────────────

describe('canOpenShellPane (unbound-panes FR-9)', () => {
  it('needs room in the grid AND at least one registered project', () => {
    expect(canOpenShellPane(1, 2)).toBe(true);
    expect(canOpenShellPane(3, 1)).toBe(true);
    expect(canOpenShellPane(MAX_PANES, 2)).toBe(false); // no room
    expect(canOpenShellPane(1, 0)).toBe(false); // nothing to root a shell at
  });
});

describe('projectShellPaneCount / shellPaneEligibleProjects (unbound-panes edge case 4: SHELL_LIMIT_REACHED, per-owner cap)', () => {
  it('counts only shell-kind panes rooted at that project — session panes and other projects never count', () => {
    const extraPanes = [shellPane('p1'), sessionPane('s2'), shellPane('p2'), shellPane('p1')];
    expect(projectShellPaneCount(extraPanes, 'p1')).toBe(2);
    expect(projectShellPaneCount(extraPanes, 'p2')).toBe(1);
    expect(projectShellPaneCount(extraPanes, 'p3')).toBe(0);
  });

  it('drops a dead-root project (unchanged behavior) and one already at the shell cap', () => {
    const projects = [
      { id: 'p1', rootExists: true },
      { id: 'p2', rootExists: true },
      { id: 'p3', rootExists: false },
    ];
    const extraPanes = Array.from({ length: 6 }, () => shellPane('p1'));
    expect(shellPaneEligibleProjects(projects, extraPanes).map((p) => p.id)).toEqual(['p2']);
  });

  it('offers a project right up to the cap boundary, and drops it exactly at 6', () => {
    const projects = [{ id: 'p1', rootExists: true }];
    expect(shellPaneEligibleProjects(projects, Array.from({ length: 5 }, () => shellPane('p1')))).toHaveLength(1);
    expect(shellPaneEligibleProjects(projects, Array.from({ length: 6 }, () => shellPane('p1')))).toHaveLength(0);
  });
});

describe('railPinnedCount (unbound-panes FR-15 / design brief hairline)', () => {
  const list = [meta('a', 10), meta('b', 50), meta('c', 30)];

  it('counts the paned sessions actually present, which is where the hairline goes', () => {
    expect(railPinnedCount(list, ['a', 'c'])).toBe(2);
    expect(railPinnedCount(list, [])).toBe(0);
  });

  it('ignores a paned id with no session in the list (a stale pane, FR-16 no phantom row)', () => {
    expect(railPinnedCount(list, ['a', 'ghost'])).toBe(1);
  });

  it('never reports a hairline when EVERY tile is pinned — there is no `rest` to separate', () => {
    expect(railPinnedCount(list, ['a', 'b', 'c'])).toBe(0);
  });
});
