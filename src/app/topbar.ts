// design 10a (turn 10 — "the shipped topbar, below fullscreen") — the ranked
// session row's pure logic.
//
// The bar used to pack eleven things in SOURCE order, so the first casualty of a
// narrow window was whatever happened to sit in the middle: the worktree path
// cropped mid-string while the controls either side of it kept their full width.
// 10a's fix is that the order is DECLARED here, measured rather than guessed, and
// the row reads it — which is why this module exists at all rather than a pile of
// `width > 900 &&` in the component.
//
// Three things never appear in the order: the project chip, the status pill, the
// view segment and `Stop`. They are the controls whose absence would be dangerous
// (you cannot stop a turn you cannot see) or disorienting (you cannot tell which
// session you are looking at). Everything else leaves in a fixed sequence, and
// everything that leaves stays reachable — the path on the project chip's
// tooltip, the rest behind `⋯` (and, for extension tabs, behind `◈` — design 11a).
//
// The session title is the one elastic element: it takes the leftover width and
// ellipsises. Everything else is `flex-shrink: 0` in the CSS, which is what stops
// mid-string crops from coming back.

/** Anything that can leave the bar as it narrows. Never includes TOPBAR_NEVER_DROPS. */
export type TopbarItem =
  | 'path'
  | 'contextFigure'
  | 'branchName'
  | 'layoutSegments'
  | 'extLabels'
  | 'modelChip'
  | 'contextBar'
  | 'extTabs';

/**
 * The drop order, widest-first — 10a's list, with 11a's extension tabs slotted in
 * where that turn puts them ("pinned labels go icon-only first, then fold into
 * `◈`", joining last so a plugin tab outlives the readouts around it).
 *
 * `path` leads and is dropped at EVERY width: it is the least glanceable string in
 * the bar and the project chip's tooltip already carries it, so there is no width
 * at which spending a whole elastic column on it is the right trade.
 */
export const TOPBAR_DROP_ORDER = [
  'path',
  'contextFigure',
  'branchName',
  'layoutSegments',
  'extLabels',
  'modelChip',
  'contextBar',
  'extTabs',
] as const satisfies readonly TopbarItem[];

/**
 * The controls with no place in the order. Kept as data (rather than as an
 * absence) so the invariant "a never-drop is not also droppable" is testable.
 */
export const TOPBAR_NEVER_DROPS = ['projectChip', 'statusPill', 'views', 'stop'] as const;

export type TopbarTier = 'full' | 'medium' | 'compact';

/**
 * Window widths, not container widths. The row is full-bleed under the native
 * caption — it spans the window whatever the roster is doing — so `innerWidth` is
 * the honest measure and costs no ResizeObserver.
 *
 * The numbers sit between the three widths the mock draws (1280 / 980 / 720), not
 * on them: a breakpoint AT a drawn width would make that exact window size the
 * ambiguous one.
 */
export const TOPBAR_BREAKPOINTS = { full: 1120, medium: 840 } as const;

export function topbarTier(width: number): TopbarTier {
  // NaN fails both comparisons and lands on `compact` — the tier that renders
  // fewest things and so cannot overflow, which is the right way to be wrong.
  if (width >= TOPBAR_BREAKPOINTS.full) return 'full';
  if (width >= TOPBAR_BREAKPOINTS.medium) return 'medium';
  return 'compact';
}

/** How much of TOPBAR_DROP_ORDER has been consumed at each tier. */
const DROPPED_THROUGH: Record<TopbarTier, number> = {
  // `path` only — the mock's 1280 row.
  full: 1,
  // …+ the context figure, the branch name, the layout segments and the pinned
  // extension labels — the mock's 980 row.
  medium: 5,
  // …+ the model chip, the context bar and the extension tabs — the mock's 720.
  compact: TOPBAR_DROP_ORDER.length,
};

/** Everything gone at this tier. Always a prefix of the order, never a subset of one. */
export function topbarDropped(tier: TopbarTier): Set<TopbarItem> {
  return new Set(TOPBAR_DROP_ORDER.slice(0, DROPPED_THROUGH[tier]));
}

export function topbarShows(tier: TopbarTier, item: TopbarItem): boolean {
  return !topbarDropped(tier).has(item);
}

// ---------- the per-control step-downs ----------
// Three of the droppable items do not simply vanish at their tier: they degrade
// to a smaller form first. Expressed as their own three-state readouts rather than
// as extra order entries, because "shown smaller" is not "dropped" — the control
// is still in the bar and still one click from its full self.

/** name → glyph (`⑂`, path on the tooltip) → inside `⋯`. */
export function branchDisplay(tier: TopbarTier): 'name' | 'glyph' | 'overflow' {
  if (topbarShows(tier, 'branchName')) return 'name';
  return topbarShows(tier, 'contextBar') ? 'glyph' : 'overflow';
}

/** three segments → the active view plus a `▾` → inside `⋯`. */
export function layoutDisplay(tier: TopbarTier): 'segments' | 'menu' | 'overflow' {
  if (topbarShows(tier, 'layoutSegments')) return 'segments';
  return topbarShows(tier, 'contextBar') ? 'menu' : 'overflow';
}

/** bar + `180K/1M` → bar alone (the figure on its tooltip) → inside `⋯`. */
export function contextDisplay(tier: TopbarTier): 'bar+figure' | 'bar' | 'overflow' {
  if (topbarShows(tier, 'contextFigure')) return 'bar+figure';
  return topbarShows(tier, 'contextBar') ? 'bar' : 'overflow';
}

/** 11a: tile + label → tile alone → folded into `◈`, which keeps the open one's tile. */
export function extTabDisplay(tier: TopbarTier): 'labelled' | 'icon' | 'folded' {
  if (topbarShows(tier, 'extLabels')) return 'labelled';
  return topbarShows(tier, 'extTabs') ? 'icon' : 'folded';
}

/**
 * The status pill never leaves and never shrinks, but its LABEL does: 10a merges
 * the two clocks that used to say the same number, and at the narrowest width the
 * surviving clock carries the state on its own (the pill keeps its colour and its
 * dot, which is the part that was doing the work).
 */
export function showsStatusWord(tier: TopbarTier): boolean {
  return tier !== 'compact';
}

/**
 * What `⋯` has to carry, in drop order. `path` is excluded deliberately: it was
 * dropped to the project chip's tooltip, and offering it in two places would make
 * the menu the answer to a question it does not own.
 */
export function overflowItems(tier: TopbarTier): TopbarItem[] {
  // Read off the step-downs, not off `topbarDropped`: an item that degraded to a
  // glyph is still IN the bar, and listing it here too would put the branch in two
  // places at 980. Only a control that has left entirely belongs behind `⋯`.
  const out: TopbarItem[] = [];
  if (branchDisplay(tier) === 'overflow') out.push('branchName');
  if (layoutDisplay(tier) === 'overflow') out.push('layoutSegments');
  if (!topbarShows(tier, 'modelChip')) out.push('modelChip');
  if (contextDisplay(tier) === 'overflow') out.push('contextBar');
  return out;
}

/** `Opus 5 · bypass · 180K/1M · ⑂ feat-context-count · layout` — the `⋯` tooltip. */
export function overflowTooltip(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).join(' · ');
}
