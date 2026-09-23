// The view switcher — redesign "Graphite & Signal", Figma component set "View
// switcher" (193:26406), placed in the session header between the spacer and
// `Stop`. Replaces the `Tab`/`TabGroup` pair the header used to draw the three
// built-in views with (VIEWS in the old SessionHeader.tsx): same three
// underlying tabs (session ↔ Conversation, diff ↔ Changes, shell ↔ Terminal),
// same click targets — new chrome, indicator and keyboard model.
//
// Pure logic lives here so it is testable without a DOM: the segment list and
// its order, arrow-key navigation between segments, the changed-files badge's
// visibility rule, and the sliding indicator's geometry (computed
// arithmetically from each segment's box model — see indicatorGeometry below
// for why it is NOT read off the animating DOM). The component
// (ViewSwitcher.tsx) owns measuring each segment's reveal width and the
// CSS-driven animation itself, neither of which is unit-testable.

/** The three built-in main-pane tabs a session always has. */
export type ViewSwitcherTab = 'session' | 'diff' | 'shell';

export interface ViewSwitcherSegment {
  tab: ViewSwitcherTab;
  label: string;
  /** The existing single-letter shortcut (buildShortcutActions / useAppShortcuts), shown on the tooltip only. */
  key: string;
}

/** Figma's fixed order: Conversation, Changes, Terminal. */
export const VIEW_SWITCHER_SEGMENTS: readonly ViewSwitcherSegment[] = [
  { tab: 'session', label: 'Conversation', key: '2' },
  { tab: 'diff', label: 'Changes', key: 'd' },
  { tab: 'shell', label: 'Terminal', key: 't' },
] as const;

/**
 * The segment index for a main tab, or -1 for an agent/workflow tab
 * (`agent:…`, `workflow:…`) — those have no segment of their own (they are
 * their own chips beside this control), so nothing is selected and
 * `indicatorGeometry` reads -1 as "hide the indicator".
 */
export function viewSwitcherIndex(tab: string): number {
  return VIEW_SWITCHER_SEGMENTS.findIndex((s) => s.tab === tab);
}

/** Arrow-left/right between segments, wrapping at both ends. */
export function nextViewSwitcherIndex(current: number, direction: -1 | 1, length: number = VIEW_SWITCHER_SEGMENTS.length): number {
  if (length <= 0) return 0;
  return (current + direction + length) % length;
}

/** The Changes count badge's text — hidden (null) at 0, exactly like Tab's `count`. */
export function changeBadgeLabel(count: number): string | null {
  return count > 0 ? String(count) : null;
}

/** Whether the unread-changes dot shows: pending changes, and Changes isn't the active segment. */
export function showsChangeDot(count: number, activeTab: string): boolean {
  return count > 0 && activeTab !== 'diff';
}

// ---------- indicator geometry ----------
// The indicator's rect is computed ARITHMETICALLY from each segment's own box
// model, never measured off the animating DOM (a CSS transition on
// padding/width changes LAYOUT throughout the transition, so a `useLayoutEffect`
// reading `offsetLeft`/`offsetWidth` right after the class flip would still see
// the transition's START values — the old segment still expanded, the new one
// still collapsed — and the indicator would land in the wrong spot until the
// next resize). The one runtime input is each segment's REVEAL — the natural,
// unclipped width of its label + badge — which the component measures off an
// `inline-flex; width: max-content` span that is never itself animated.

/** Figma "View switcher" 193:26406's box model, in px. */
const CONTAINER_PADDING = 2;
const SEGMENT_GAP = 2;
const ICON_SIZE = 16;
const INACTIVE_PADDING = 5;
const ACTIVE_PADDING = 8;
const REVEAL_MARGIN = 6;

/** icon + 2×inactive padding — every non-active segment's fixed width. */
const INACTIVE_WIDTH = ICON_SIZE + INACTIVE_PADDING * 2;
/** icon + 2×active padding + the reveal's margin — everything but the reveal itself. */
const ACTIVE_BASE_WIDTH = ICON_SIZE + ACTIVE_PADDING * 2 + REVEAL_MARGIN;

export interface IndicatorRect {
  left: number;
  width: number;
}

/**
 * The active segment's rect. `revealWidths[i]` is segment `i`'s label+badge
 * natural width (0 when not yet measured — the indicator is briefly narrower
 * than its target for one frame on mount, never wrong once measured). Every
 * segment before the active one is inactive (only one segment is ever active),
 * so `left` is a closed form: the container's padding plus `activeIndex` fixed
 * inactive segments, each followed by a gap.
 *
 * Returns null for -1 (no built-in view is selected — an agent/workflow tab
 * is active); the caller fades the indicator out rather than unmounting it.
 */
export function indicatorGeometry(activeIndex: number, revealWidths: readonly number[]): IndicatorRect | null {
  if (activeIndex < 0) return null;
  const revealWidth = revealWidths[activeIndex] ?? 0;
  return {
    left: CONTAINER_PADDING + activeIndex * (INACTIVE_WIDTH + SEGMENT_GAP),
    width: ACTIVE_BASE_WIDTH + revealWidth,
  };
}
