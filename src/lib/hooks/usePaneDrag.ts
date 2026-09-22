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
//
// `onDrag` is coalesced to one call per animation frame (fix/animation-smoothness):
// a WebView2 pointermove stream can fire well above 60Hz, and both callers'
// `onDrag` end up in a zustand setter that persists to `localStorage` on every
// non-no-op call (layoutStore's `setSplitRatio`/`setRosterWidth`) — a
// synchronous disk write per pointermove is exactly the kind of main-thread
// stall that reads as dragging "lag". Buffering the latest position and
// flushing it once per frame (same rAF-batching idiom as the transcript's
// delta buffer in useConversationTranscript) keeps the visual result
// identical — the divider still tracks the pointer — while capping the write
// rate to the display's own refresh.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PaneDragBox {
  start: number;
  size: number;
}

/** True iff a new frame should be scheduled — i.e. none is already pending. */
export function shouldScheduleDragFrame(framePending: boolean): boolean {
  return !framePending;
}

export function usePaneDrag(opts: {
  /** 'x' drags left/right (reads clientX); 'y' drags up/down (reads clientY). */
  axis: 'x' | 'y';
  /** Measured once per drag from the handle element. `null` aborts the drag. */
  measure: (handle: HTMLElement) => PaneDragBox | null;
  /** Called at most once per animation frame while dragging, with the latest pointer position on `axis`. */
  onDrag: (pos: number, box: PaneDragBox) => void;
}): {
  dragging: boolean;
  handlers: Pick<React.DOMAttributes<HTMLDivElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>;
} {
  const { axis, measure, onDrag } = opts;
  const [dragging, setDragging] = useState(false);
  const box = useRef<PaneDragBox | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<{ pos: number; box: PaneDragBox } | null>(null);

  // While dragging, the pointer is over a transcript / a terminal / a diff —
  // every one of them would otherwise show a text caret and start selecting.
  useEffect(() => {
    if (!dragging) return;
    const cls = axis === 'x' ? 'app-resizing-x' : 'app-resizing-y';
    document.body.classList.add(cls);
    return () => document.body.classList.remove(cls);
  }, [dragging, axis]);

  const cancelPendingFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    pendingRef.current = null;
  }, []);

  // Unmounting mid-drag (e.g. the roster folding under the pointer, FR-6)
  // must not leave a stray rAF callback that fires after the component is
  // gone — it would call a stale `onDrag` closure.
  useEffect(() => cancelPendingFrame, [cancelPendingFrame]);

  const flushFrame = useCallback(() => {
    frameRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) onDrag(pending.pos, pending.box);
  }, [onDrag]);

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
      pendingRef.current = { pos: axis === 'x' ? e.clientX : e.clientY, box: current };
      if (shouldScheduleDragFrame(frameRef.current !== null)) {
        frameRef.current = requestAnimationFrame(flushFrame);
      }
    },
    [dragging, axis, flushFrame],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      box.current = null;
      cancelPendingFrame();
      setDragging(false);
    },
    [cancelPendingFrame],
  );

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
