import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  splitRatioFromDrag,
} from '../lib/layoutStore';
import { useStore } from '../lib/store';

/** One arrow key press — a coarse-but-predictable 2% of the main cell. */
const KEY_STEP = 0.02;

/**
 * The grab handle between the two split panes: drag to resize, ⇦/⇨ to nudge,
 * double-click to go back to 50/50.
 *
 * It occupies the split grid's gutter COLUMN rather than sitting on top of a
 * `gap`, so the 12px the two cards are drawn apart by is the hit area itself —
 * no invisible overlay stealing clicks from either pane's edge.
 */
export default function SplitDivider() {
  const ratio = useStore((s) => s.splitRatio);
  const setSplitRatio = useStore((s) => s.setSplitRatio);
  const [dragging, setDragging] = useState(false);
  // Measured once per drag: the grid box cannot change mid-drag (only this
  // handle's own column does), and re-reading it per pointermove would force a
  // layout flush on every frame.
  const gridBox = useRef<{ left: number; width: number } | null>(null);

  // While dragging, the pointer is over a transcript / a terminal / a diff —
  // every one of them would otherwise show a text caret and start selecting.
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('app-resizing');
    return () => document.body.classList.remove('app-resizing');
  }, [dragging]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const grid = e.currentTarget.parentElement;
    if (!grid || e.button !== 0) return;
    const box = grid.getBoundingClientRect();
    gridBox.current = { left: box.left, width: box.width };
    // Pointer capture, not a window listener: the pointer leaving the handle —
    // or the window — keeps feeding this element, and release cleans up even
    // when the pointerup lands somewhere else entirely.
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const box = gridBox.current;
      if (!dragging || !box) return;
      setSplitRatio(splitRatioFromDrag(e.clientX, box.left, box.width));
    },
    [dragging, setSplitRatio],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    gridBox.current = null;
    setDragging(false);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const next =
        e.key === 'ArrowLeft'
          ? ratio - KEY_STEP
          : e.key === 'ArrowRight'
            ? ratio + KEY_STEP
            : e.key === 'Home' || e.key === 'Enter'
              ? DEFAULT_SPLIT_RATIO
              : null;
      if (next === null) return;
      // The app's single-letter globals live on document — an arrow here is a
      // resize, not a list navigation.
      e.preventDefault();
      e.stopPropagation();
      setSplitRatio(next);
    },
    [ratio, setSplitRatio],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
      aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
      tabIndex={0}
      title="Drag to resize · double-click to even out"
      className={dragging ? 'app-split-divider app-split-divider--dragging' : 'app-split-divider'}
      // The panes focus themselves on click (FR-5); grabbing the divider is a
      // layout gesture and must not move the keyboard between sessions.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => setSplitRatio(DEFAULT_SPLIT_RATIO)}
      onKeyDown={onKeyDown}
    />
  );
}
