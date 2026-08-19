// design 10a — the ranked topbar's pure logic. Written first: the whole point of
// 10a is that the drop order is DECLARED rather than emergent from source order,
// so the order and its tier cutoffs are the part worth pinning down.

import { describe, expect, it } from 'vitest';
import {
  TOPBAR_BREAKPOINTS,
  TOPBAR_DROP_ORDER,
  TOPBAR_NEVER_DROPS,
  branchDisplay,
  contextDisplay,
  extTabDisplay,
  layoutDisplay,
  overflowItems,
  overflowTooltip,
  showsStatusWord,
  topbarDropped,
  topbarShows,
  topbarTier,
} from './topbar';

describe('topbarTier', () => {
  it('maps the three widths the mock draws to the three tiers', () => {
    expect(topbarTier(1280)).toBe('full');
    expect(topbarTier(980)).toBe('medium');
    expect(topbarTier(720)).toBe('compact');
  });

  it('is inclusive at each breakpoint and monotonic across it', () => {
    expect(topbarTier(TOPBAR_BREAKPOINTS.full)).toBe('full');
    expect(topbarTier(TOPBAR_BREAKPOINTS.full - 1)).toBe('medium');
    expect(topbarTier(TOPBAR_BREAKPOINTS.medium)).toBe('medium');
    expect(topbarTier(TOPBAR_BREAKPOINTS.medium - 1)).toBe('compact');
  });

  it('degrades to compact for a nonsense width rather than throwing', () => {
    expect(topbarTier(0)).toBe('compact');
    expect(topbarTier(-1)).toBe('compact');
    expect(topbarTier(Number.NaN)).toBe('compact');
  });
});

describe('the drop order', () => {
  it('is the order the mock measured, widest-first', () => {
    expect([...TOPBAR_DROP_ORDER]).toEqual([
      'path',
      'contextFigure',
      'branchName',
      'layoutSegments',
      'extLabels',
      'modelChip',
      'contextBar',
      'extTabs',
    ]);
  });

  it('never drops the three controls whose absence would be dangerous', () => {
    expect([...TOPBAR_NEVER_DROPS]).toEqual(['projectChip', 'statusPill', 'views', 'stop']);
    for (const item of TOPBAR_NEVER_DROPS) {
      expect(TOPBAR_DROP_ORDER).not.toContain(item as never);
    }
  });

  it('drops the path at EVERY width — it lives on the project chip tooltip now', () => {
    expect(topbarShows('full', 'path')).toBe(false);
    expect(topbarShows('medium', 'path')).toBe(false);
    expect(topbarShows('compact', 'path')).toBe(false);
  });

  it('drops a strict prefix of the order, so nothing outranks something wider', () => {
    const full = topbarDropped('full');
    const medium = topbarDropped('medium');
    const compact = topbarDropped('compact');
    for (const item of full) expect(medium.has(item)).toBe(true);
    for (const item of medium) expect(compact.has(item)).toBe(true);
    expect(compact.size).toBe(TOPBAR_DROP_ORDER.length);
  });

  it('reproduces the mock at 1280: everything but the path', () => {
    expect(topbarShows('full', 'contextFigure')).toBe(true);
    expect(topbarShows('full', 'branchName')).toBe(true);
    expect(topbarShows('full', 'layoutSegments')).toBe(true);
    expect(topbarShows('full', 'extLabels')).toBe(true);
    expect(topbarShows('full', 'modelChip')).toBe(true);
    expect(topbarShows('full', 'contextBar')).toBe(true);
  });

  it('reproduces the mock at 980: figure, branch name, layout segments and ext labels go', () => {
    expect(topbarShows('medium', 'contextFigure')).toBe(false);
    expect(topbarShows('medium', 'branchName')).toBe(false);
    expect(topbarShows('medium', 'layoutSegments')).toBe(false);
    expect(topbarShows('medium', 'extLabels')).toBe(false);
    // …and the bar, the model chip and the tabs themselves are still there.
    expect(topbarShows('medium', 'contextBar')).toBe(true);
    expect(topbarShows('medium', 'modelChip')).toBe(true);
    expect(topbarShows('medium', 'extTabs')).toBe(true);
  });
});

describe('the per-control displays', () => {
  it('steps the branch from name to glyph to the overflow menu', () => {
    expect(branchDisplay('full')).toBe('name');
    expect(branchDisplay('medium')).toBe('glyph');
    expect(branchDisplay('compact')).toBe('overflow');
  });

  it('steps the layout control from segments to a single button to the overflow menu', () => {
    expect(layoutDisplay('full')).toBe('segments');
    expect(layoutDisplay('medium')).toBe('menu');
    expect(layoutDisplay('compact')).toBe('overflow');
  });

  it('steps the context readout from bar+figure to bar to the overflow menu', () => {
    expect(contextDisplay('full')).toBe('bar+figure');
    expect(contextDisplay('medium')).toBe('bar');
    expect(contextDisplay('compact')).toBe('overflow');
  });

  it('steps extension tabs from labelled to icon-only to folded into the menu', () => {
    expect(extTabDisplay('full')).toBe('labelled');
    expect(extTabDisplay('medium')).toBe('icon');
    expect(extTabDisplay('compact')).toBe('folded');
  });

  it('keeps the status word until the compact tier, where the clock alone carries it', () => {
    expect(showsStatusWord('full')).toBe(true);
    expect(showsStatusWord('medium')).toBe(true);
    expect(showsStatusWord('compact')).toBe(false);
  });
});

describe('overflowItems', () => {
  it('is empty while nothing has been dropped into a menu', () => {
    // The path is dropped but never reachable from `⋯` — it is on the project
    // chip's tooltip, which is a different affordance entirely.
    expect(overflowItems('full')).toEqual([]);
    expect(overflowItems('medium')).toEqual([]);
  });

  it('carries exactly what the compact bar stopped rendering, in drop order', () => {
    expect(overflowItems('compact')).toEqual(['branchName', 'layoutSegments', 'modelChip', 'contextBar']);
  });
});

describe('overflowTooltip', () => {
  it('joins the parts the way the mock writes them', () => {
    expect(overflowTooltip(['Opus 5', 'bypass', '180K/1M', '⑂ feat-context-count', 'layout'])).toBe(
      'Opus 5 · bypass · 180K/1M · ⑂ feat-context-count · layout',
    );
  });

  it('drops blanks so an absent branch never leaves a dangling separator', () => {
    expect(overflowTooltip(['Opus 5', '', null, undefined, 'layout'])).toBe('Opus 5 · layout');
    expect(overflowTooltip([])).toBe('');
  });
});
