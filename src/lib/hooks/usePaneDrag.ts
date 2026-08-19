// Shared pointer-drag mechanics (resizable-sidebar FR-13): pointer capture,
// the once-per-drag measured box, the `app-resizing-x`/`-y` body class, and
// the `dragging` flag. Extracted so `SplitDivider` and the new
// `RosterDivider` share ONE implementation — two near-identical pointer-drag
// copies where only one gets a fix is exactly what this forbids.
//
// The measured box is read once per drag, at `pointerdown`, from the handle's
// own DOM position (`measure`) — re-reading it on every `pointermove` would
// force a layout flush on every frame, and the grid box cannot change mid-drag
// (only the tracks inside it do). What the position MEANS (a split ratio, a
// roster width in px) stays entirely with the caller's `onDrag`.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PaneDragBox {
  start: number;
  size: number;
}

export function usePaneDrag(opts: {
  /** 'x' drags left/right (reads clientX); 'y' drags up/down (reads clientY). */
  axis: 'x' | 'y';
  /** Measured once per drag from the handle element. `null` aborts the drag. */
  measure: (handle: HTMLElement) => PaneDragBox | null;
  /** Called on every `pointermove` while dragging, with the pointer position on `axis`. */
  onDrag: (pos: number, box: PaneDragBox) => void;
}): {
  dragging: boolean;
  handlers: Pick<React.DOMAttributes<HTMLDivElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>;
} {
  const { axis, measure, onDrag } = opts;
  const [dragging, setDragging] = useState(false);
  const box = useRef<PaneDragBox | null>(null);

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
      if (e.button !== 0) return;
      const measured = measure(e.currentTarget);
      if (!measured) return;
      box.current = measured;
      // Pointer capture, not a window listener: the pointer leaving the handle
      // — or the window — keeps feeding this element, and release cleans up
      // even when the pointerup lands somewhere else entirely.
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      e.preventDefault();
    },
    [measure],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const current = box.current;
      if (!dragging || !current) return;
      onDrag(axis === 'x' ? e.clientX : e.clientY, current);
    },
    [dragging, axis, onDrag],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    box.current = null;
    setDragging(false);
  }, []);

  return {
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
