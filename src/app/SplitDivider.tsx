import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [dragging, setDragging] = useState(false);
  // Measured once per drag: the grid box cannot change mid-drag (only the
  // tracks inside it do), and re-reading it per pointermove would force a
  // layout flush on every frame.
  const gridBox = useRef<{ start: number; size: number } | null>(null);

  // While dragging, the pointer is over a transcript / a terminal / a diff —
  // every one of them would otherwise show a text caret and start selecting.
  useEffect(() => {
    if (!dragging) return;
    const cls = axis === 'x' ? 'app-resizing-x' : 'app-resizing-y';
    document.body.classList.add(cls);
    return () => document.body.classList.remove(cls);
  }, [dragging, axis]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const grid = e.currentTarget.parentElement;
      if (!grid || e.button !== 0) return;
      const box = grid.getBoundingClientRect();
      gridBox.current = axis === 'x' ? { start: box.left, size: box.width } : { start: box.top, size: box.height };
      // Pointer capture, not a window listener: the pointer leaving the handle —
      // or the window — keeps feeding this element, and release cleans up even
      // when the pointerup lands somewhere else entirely.
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      e.preventDefault();
    },
    [axis],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const box = gridBox.current;
      if (!dragging || !box) return;
      const pos = axis === 'x' ? e.clientX : e.clientY;
      setRatio(splitRatioFromDrag(pos, box.start, box.size, axis === 'x' ? MIN_SPLIT_PANE_PX : MIN_SPLIT_PANE_ROW_PX));
    },
    [dragging, setRatio, axis],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    gridBox.current = null;
    setDragging(false);
  }, []);

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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => setRatio(DEFAULT_SPLIT_RATIO)}
      onKeyDown={onKeyDown}
    />
  );
}
