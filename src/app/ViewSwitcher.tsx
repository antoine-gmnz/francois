// The view switcher — Figma "View switcher" (193:26406), "01 · Session /
// Running" (131:185). Sits in the session header between the spacer and
// `Stop`, replacing the old `Tab`/`TabGroup` pair (session-header.css's
// `.tab-group`/`.tab`, still used elsewhere). Same three underlying tabs —
// see view-switcher.ts for the pure logic (segment order, arrow-key nav, the
// changed-files badge/dot rules, and the indicator's geometry).
//
// The sliding indicator is computed, never measured off the segments
// themselves: CSS transitions on padding/width change LAYOUT throughout the
// transition, so reading a segment's `offsetLeft`/`offsetWidth` right after
// flipping its `--selected` class would still return the transition's START
// values (the old segment still expanded, the new one still collapsed) — the
// indicator would land in the wrong spot and stay there until the next
// resize. `indicatorGeometry` derives the rect arithmetically from the box
// model instead; the one runtime input is each segment's REVEAL width (its
// label + badge's natural, unclipped size), measured off an
// `inline-flex; width: max-content` span that the animation never touches.
// Because the indicator, the segment's padding and the reveal all share the
// same duration and easing, and the indicator's width is a linear sum of the
// other two, all three stay in lockstep through the spring's overshoot.

import { Diff, MessageSquare, SquareTerminal, type LucideIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { MainTab } from '../lib/store';
import {
  VIEW_SWITCHER_SEGMENTS,
  changeBadgeLabel,
  indicatorGeometry,
  nextViewSwitcherIndex,
  showsChangeDot,
  viewSwitcherIndex,
  type ViewSwitcherTab,
} from './view-switcher';
import './view-switcher.css';

const SEGMENT_ICONS: Record<ViewSwitcherTab, LucideIcon> = {
  session: MessageSquare,
  diff: Diff,
  shell: SquareTerminal,
};

export interface ViewSwitcherProps {
  /** The focused pane's main tab — an agent/workflow tab leaves every segment unselected. */
  active: MainTab;
  /** Changed-file count (diff-view's badge source), for the dot and the active-segment count. */
  diffCount: number;
  onSelect: (tab: ViewSwitcherTab) => void;
}

export default function ViewSwitcher({ active, diffCount, onSelect }: ViewSwitcherProps): JSX.Element {
  const activeIndex = viewSwitcherIndex(active);
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const revealRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [revealWidths, setRevealWidths] = useState<number[]>(() => VIEW_SWITCHER_SEGMENTS.map(() => 0));
  // Gates every transition (indicator, padding, reveal) — off for the very
  // first paint so mount never animates in from a phantom position.
  const [ready, setReady] = useState(false);
  // The indicator fades out (opacity), rather than unmounting, when an
  // agent/workflow tab is active — so it holds the LAST built-in view's rect
  // while hidden instead of snapping to a stale default on the way back.
  const lastGeometry = useRef({ left: 2, width: 0 });

  const measureReveals = () => {
    setRevealWidths(VIEW_SWITCHER_SEGMENTS.map((_, i) => revealRefs.current[i]?.offsetWidth ?? 0));
  };

  // Mount: measure once, then keep measuring — a ResizeObserver on the reveal
  // spans catches label/badge width changes from any source (content, font
  // swap, count changing digits), so this is the one source of truth.
  useLayoutEffect(() => {
    measureReveals();
    const observer = new ResizeObserver(() => measureReveals());
    revealRefs.current.forEach((el) => el && observer.observe(el));
    document.fonts?.ready.then(measureReveals).catch(() => {});
    const id = requestAnimationFrame(() => setReady(true));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(id);
    };
     
  }, []);

  // The badge's digit count changes the diff segment's reveal width even
  // while it stays hidden (inactive) — re-measure explicitly rather than
  // waiting on the ResizeObserver to notice the (still-clipped) span resize.
  useLayoutEffect(() => {
    measureReveals();
     
  }, [diffCount]);

  const geometry = indicatorGeometry(activeIndex, revealWidths);
  if (geometry) lastGeometry.current = geometry;
  const indicatorStyle: CSSProperties = {
     
    transform: `translateX(${lastGeometry.current.left}px)`,
     
    width: `${lastGeometry.current.width}px`,
  };

  const select = (index: number) => {
    const seg = VIEW_SWITCHER_SEGMENTS[index];
    if (!seg) return;
    onSelect(seg.tab);
  };

  const onSegmentKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = nextViewSwitcherIndex(index, e.key === 'ArrowRight' ? 1 : -1);
    select(next);
    segmentRefs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label="view" className={ready ? 'view-switcher view-switcher--ready' : 'view-switcher'}>
      <span
        aria-hidden="true"
        className={geometry ? 'view-switcher__indicator' : 'view-switcher__indicator view-switcher__indicator--hidden'}
        style={indicatorStyle}
      />
      {VIEW_SWITCHER_SEGMENTS.map((seg, i) => {
        const selected = seg.tab === active;
        const Icon = SEGMENT_ICONS[seg.tab];
        const badge = seg.tab === 'diff' ? changeBadgeLabel(diffCount) : null;
        const showDot = seg.tab === 'diff' && showsChangeDot(diffCount, active);
        return (
          <button
            key={seg.tab}
            ref={(el) => {
              segmentRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={seg.label}
            title={`${seg.label} · ${seg.key}`}
            tabIndex={selected ? 0 : -1}
            className={selected ? 'view-switcher__segment view-switcher__segment--selected' : 'view-switcher__segment'}
            onClick={() => select(i)}
            onKeyDown={(e) => onSegmentKeyDown(e, i)}
          >
            <Icon size={16} className="view-switcher__icon" />
            <span
              className="view-switcher__reveal"
               
              style={{ '--reveal-w': `${revealWidths[i] ?? 0}px` } as CSSProperties}
            >
              <span
                className="view-switcher__reveal-inner"
                ref={(el) => {
                  revealRefs.current[i] = el;
                }}
              >
                <span className="view-switcher__label">{seg.label}</span>
                {badge && <span className="view-switcher__badge">{badge}</span>}
              </span>
            </span>
            {showDot && <span className="view-switcher__dot" />}
          </button>
        );
      })}
    </div>
  );
}
