// resizable-sidebar: the roster's right edge — drag to resize, arrow keys to
// nudge, double-click / Home to reset, and a live snap-collapse into the
// 46px rail below MIN_ROSTER_WIDTH. Sibling of SplitDivider (both on
// usePaneDrag, FR-13) but resizes the ROSTER rather than a main-pane split,
// and additionally owns the fold gesture (FR-6) that SplitDivider has no
// equivalent of.
//
// Invisible at rest, `cursor: col-resize`, tinted on hover/focus/drag — FR-2
// reuses `.app-split-divider`'s existing visual rules rather than restating
// them; no new chrome is drawn (spec §8).

import { useCallback } from 'react';
import { usePaneDrag } from '../lib/hooks/usePaneDrag';
import { DEFAULT_ROSTER_WIDTH, MIN_ROSTER_WIDTH, ROSTER_KEY_STEP_PX, rosterCap, rosterWidthFromDrag } from '../lib/rosterWidth';
import type { LayoutRegime } from '../lib/layoutStore';

export interface RosterDividerProps {
  regime: LayoutRegime;
  viewportWidth: number;
  /** The rendered (already clamped) width — what the handle reports via `aria-valuenow`. */
  renderedWidth: number;
  showLeftPane: boolean;
  toggleLeftPane: () => void;
  setRosterWidth: (px: number) => void;
  resetRosterWidth: () => void;
}

export default function RosterDivider({
  regime,
  viewportWidth,
  renderedWidth,
  showLeftPane,
  toggleLeftPane,
  setRosterWidth,
  resetRosterWidth,
}: RosterDividerProps) {
  const { dragging, handlers } = usePaneDrag({
    axis: 'x',
    // `.app-grid`'s content-box left — the handle's parent IS the grid
    // (RosterDivider sits directly in its middle track), so this is the
    // grid's own border-box left plus its left padding.
    measure: useCallback((handle) => {
      const grid = handle.parentElement;
      if (!grid) return null;
      const box = grid.getBoundingClientRect();
      const paddingLeft = parseFloat(getComputedStyle(grid).paddingLeft) || 0;
      return { start: box.left + paddingLeft, size: box.width };
    }, []),
    onDrag: useCallback(
      (pos, box) => {
        const { width, collapse } = rosterWidthFromDrag(pos, box.start, viewportWidth, regime);
        if (collapse) {
          // FR-6: crossing the threshold folds the roster mid-drag — WITHOUT
          // touching rosterWidth. Pointer capture is on this handle, so the
          // roster unmounting under the pointer does not end the drag.
          if (showLeftPane) toggleLeftPane();
        } else {
          if (!showLeftPane) toggleLeftPane();
          setRosterWidth(width);
        }
      },
      [viewportWidth, regime, showLeftPane, toggleLeftPane, setRosterWidth],
    ),
  });

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const next =
        e.key === 'ArrowLeft'
          ? renderedWidth - ROSTER_KEY_STEP_PX
          : e.key === 'ArrowRight'
            ? renderedWidth + ROSTER_KEY_STEP_PX
            : e.key === 'Home'
              ? DEFAULT_ROSTER_WIDTH
              : null;
      if (next === null) return;
      // The app's single-letter/arrow globals live on document — an arrow
      // here is a resize, not a list navigation (FR-10).
      e.preventDefault();
      e.stopPropagation();
      if (next === DEFAULT_ROSTER_WIDTH) resetRosterWidth();
      else setRosterWidth(next);
    },
    [renderedWidth, setRosterWidth, resetRosterWidth],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={Math.round(renderedWidth)}
      aria-valuemin={MIN_ROSTER_WIDTH}
      aria-valuemax={Math.round(Math.max(MIN_ROSTER_WIDTH, rosterCap(viewportWidth, regime)))}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className={'app-split-divider' + (dragging ? ' app-split-divider--dragging' : '')}
      // Grabbing the handle is a layout gesture (FR-12) — it never moves
      // focus between sessions, matching SplitDivider.
      onClick={(e) => e.stopPropagation()}
      {...handlers}
      onDoubleClick={() => resetRosterWidth()}
      onKeyDown={onKeyDown}
    />
  );
}
