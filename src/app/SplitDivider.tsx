import { useCallback } from 'react';
import { usePaneDrag } from '../lib/hooks/usePaneDrag';
import {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_PANE_PX,
  MIN_SPLIT_PANE_ROW_PX,
  MIN_SPLIT_RATIO,
  splitRatioFromDrag,
} from '../lib/layoutStore';
import { useStore } from '../lib/store';
import type { GridArea } from './appShell';

/** One arrow key press — a coarse-but-predictable 2% of the main cell. */
const KEY_STEP = 0.02;

export interface SplitDividerProps {
  /** 'x' splits the two COLUMNS (drag left/right); 'y' splits the two ROWS. */
  axis: 'x' | 'y';
  /** Explicit placement — the 2×2 regimes cannot use auto-placement (appShell). */
  area?: GridArea;
}

/**
 * The grab handle between panes: drag to resize, arrow keys to nudge,
 * double-click to go back to an even split.
 *
 * It occupies the split grid's gutter TRACK rather than sitting on top of a
 * `gap`, so the 12px the cards are drawn apart by is the hit area itself — no
 * invisible overlay stealing clicks from a pane's edge. Where the two handles
 * cross in the 2×2, the column one is rendered last and so takes the crossing.
 */
export default function SplitDivider({ axis, area }: SplitDividerProps) {
  const ratio = useStore((s) => (axis === 'x' ? s.splitRatio : s.splitRowRatio));
  const setRatio = useStore((s) => (axis === 'x' ? s.setSplitRatio : s.setSplitRowRatio));

  const { dragging, handlers } = usePaneDrag({
    axis,
    measure: useCallback(
      (handle) => {
        const grid = handle.parentElement;
        if (!grid) return null;
        const box = grid.getBoundingClientRect();
        return axis === 'x' ? { start: box.left, size: box.width } : { start: box.top, size: box.height };
      },
      [axis],
    ),
    onDrag: useCallback(
      (pos, box) => {
        setRatio(splitRatioFromDrag(pos, box.start, box.size, axis === 'x' ? MIN_SPLIT_PANE_PX : MIN_SPLIT_PANE_ROW_PX));
      },
      [setRatio, axis],
    ),
  });

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      const next =
        e.key === back
          ? ratio - KEY_STEP
          : e.key === forward
            ? ratio + KEY_STEP
            : e.key === 'Home' || e.key === 'Enter'
              ? DEFAULT_SPLIT_RATIO
              : null;
      if (next === null) return;
      // The app's single-letter globals live on document — an arrow here is a
      // resize, not a list navigation.
      e.preventDefault();
      e.stopPropagation();
      setRatio(next);
    },
    [ratio, setRatio, axis],
  );

  return (
    <div
      role="separator"
      // The separator's OWN orientation: the column handle is a vertical line.
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={axis === 'x' ? 'Resize columns' : 'Resize rows'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
      aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
      tabIndex={0}
      title="Drag to resize · double-click to even out"
      className={
        (axis === 'x' ? 'app-split-divider' : 'app-split-divider app-split-divider--y') +
        (dragging ? ' app-split-divider--dragging' : '')
      }
      style={area}
      // The panes focus themselves on click (FR-12); grabbing a divider is a
      // layout gesture and must not move the keyboard between sessions.
      onClick={(e) => e.stopPropagation()}
      {...handlers}
      onDoubleClick={() => setRatio(DEFAULT_SPLIT_RATIO)}
      onKeyDown={onKeyDown}
    />
  );
}
