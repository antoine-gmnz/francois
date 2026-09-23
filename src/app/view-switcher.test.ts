import { describe, expect, it } from 'vitest';
import {
  VIEW_SWITCHER_SEGMENTS,
  changeBadgeLabel,
  indicatorGeometry,
  nextViewSwitcherIndex,
  showsChangeDot,
  viewSwitcherIndex,
} from './view-switcher';

describe('VIEW_SWITCHER_SEGMENTS', () => {
  it('is Conversation, Changes, Terminal, in that order', () => {
    expect(VIEW_SWITCHER_SEGMENTS.map((s) => s.tab)).toEqual(['session', 'diff', 'shell']);
    expect(VIEW_SWITCHER_SEGMENTS.map((s) => s.label)).toEqual(['Conversation', 'Changes', 'Terminal']);
  });
});

describe('viewSwitcherIndex', () => {
  it('finds the segment for a built-in tab', () => {
    expect(viewSwitcherIndex('session')).toBe(0);
    expect(viewSwitcherIndex('diff')).toBe(1);
    expect(viewSwitcherIndex('shell')).toBe(2);
  });

  it('is -1 for an agent/workflow tab — those have no segment of their own', () => {
    expect(viewSwitcherIndex('agent:123')).toBe(-1);
    expect(viewSwitcherIndex('workflow:456')).toBe(-1);
  });
});

describe('nextViewSwitcherIndex', () => {
  it('moves right and wraps past the last segment', () => {
    expect(nextViewSwitcherIndex(0, 1, 3)).toBe(1);
    expect(nextViewSwitcherIndex(1, 1, 3)).toBe(2);
    expect(nextViewSwitcherIndex(2, 1, 3)).toBe(0);
  });

  it('moves left and wraps past the first segment', () => {
    expect(nextViewSwitcherIndex(0, -1, 3)).toBe(2);
    expect(nextViewSwitcherIndex(1, -1, 3)).toBe(0);
  });

  it('defaults length to the real segment count', () => {
    expect(nextViewSwitcherIndex(2, 1)).toBe(0);
  });

  it('degrades to 0 rather than dividing by zero', () => {
    expect(nextViewSwitcherIndex(0, 1, 0)).toBe(0);
  });
});

describe('changeBadgeLabel', () => {
  it('hides at 0, shows the count otherwise', () => {
    expect(changeBadgeLabel(0)).toBeNull();
    expect(changeBadgeLabel(7)).toBe('7');
    expect(changeBadgeLabel(184)).toBe('184');
  });
});

describe('showsChangeDot', () => {
  it('shows only when there are pending changes and Changes is not the active segment', () => {
    expect(showsChangeDot(3, 'session')).toBe(true);
    expect(showsChangeDot(3, 'shell')).toBe(true);
    expect(showsChangeDot(3, 'diff')).toBe(false);
    expect(showsChangeDot(0, 'session')).toBe(false);
  });
});

describe('indicatorGeometry', () => {
  // Figma "View switcher" 193:26406's three drawn states: Conversation active
  // → left 2 w 112 (revealWidth 74), Changes active → left 30 w 108 (revealWidth
  // 70), Terminal active → left 58 w 86 (revealWidth 48).
  const revealWidths = [74, 70, 48];

  it('matches the mock exactly for each of the three drawn states', () => {
    expect(indicatorGeometry(0, revealWidths)).toEqual({ left: 2, width: 112 });
    expect(indicatorGeometry(1, revealWidths)).toEqual({ left: 30, width: 108 });
    expect(indicatorGeometry(2, revealWidths)).toEqual({ left: 58, width: 86 });
  });

  it('is null for -1 — no built-in view selected, an agent/workflow tab is active', () => {
    expect(indicatorGeometry(-1, revealWidths)).toBeNull();
  });

  it('treats an unmeasured reveal (0) as its base width, not NaN', () => {
    expect(indicatorGeometry(0, [0, 0, 0])).toEqual({ left: 2, width: 38 });
  });

  it('falls back to 0 for a reveal width missing from the array', () => {
    expect(indicatorGeometry(0, [])).toEqual({ left: 2, width: 38 });
  });
});
