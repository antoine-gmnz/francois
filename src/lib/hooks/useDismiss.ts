// Shared Escape-key / outside-mousedown dismissal (REFACTOR.md audit: 6 divergent
// copies — ProjectsModal (Escape only, with an inline-edit-first branch owned by
// the caller's own `onEscape`), McpPanel's DetailPopover (outside-mousedown only)
// and AttachOverlay (Escape, mixed into a bigger arrow-nav listener), Sidebar's
// context menu (click + Escape, no ref-containment check), ProjectSwitcher and
// RemoteControlBadge (Escape, ProjectSwitcher also click), ModelPicker (both,
// ref-containment + capture-phase Escape).
//
// `isEscapeKey`/`isOutsideTarget` are the pure, DOM-shaped predicates (testable
// without a renderer); `useDismiss` is the React wrapper that wires them to
// `window` listeners for the lifetime the caller says it should run.
//
// Design notes for the later rewiring pass:
//  - Outside-click detection here is ref-containment on `mousedown` (McpPanel /
//    ModelPicker's mechanism), not Sidebar/ProjectSwitcher's "any window `click`
//    reaches here because the popup's own content stops propagation" trick.
//    `mousedown` fires before a `click` handler's `stopPropagation()` could ever
//    matter, so containment-checking is a strict, self-contained replacement —
//    Sidebar/ProjectSwitcher can adopt it by passing a ref to their popup content
//    instead of relying on inner `stopPropagation()`.
//  - ProjectsModal's Escape branches to "revert the inline edit" vs "close the
//    modal" depending on its OWN `editIndex` state; that branching is caller
//    logic and belongs entirely inside the `onEscape` callback passed in — this
//    hook only decides WHEN Escape fires, never what it means.
//  - McpPanel's AttachOverlay mixes Escape with ArrowUp/ArrowDown/Enter in one
//    capture-phase listener; this hook only replaces the Escape branch of that
//    — the arrow/Enter handling stays call-site code.

import { useEffect, type RefObject } from 'react';

/** True for the key that should dismiss (matches every existing call site). */
export function isEscapeKey(e: Pick<KeyboardEvent, 'key'>): boolean {
  return e.key === 'Escape';
}

/** True when `target` is outside `container` — the ref-containment check. */
export function isOutsideTarget(container: HTMLElement | null, target: EventTarget | null): boolean {
  return !!container && !container.contains(target as Node | null);
}

export interface UseDismissOptions {
  /** Called on an Escape keydown. Omit to skip Escape handling entirely. */
  onEscape?: () => void;
  /** Called on a mousedown outside `ref.current`. Omit to skip outside-click handling. */
  onOutsideClick?: () => void;
  /** Gate — no listeners attach while false (mirrors every `if (!open) return;` guard). Default true. */
  enabled?: boolean;
}

/**
 * Attaches (only while `enabled`) a capture-phase `keydown` listener that fires
 * `onEscape` on Escape, and a `mousedown` listener that fires `onOutsideClick`
 * when the target is outside `ref.current`. Either callback can be omitted to
 * get only the other behaviour. Cleans up on unmount / option change.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, options: UseDismissOptions): void {
  const { onEscape, onOutsideClick, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!onEscape || !isEscapeKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!onOutsideClick) return;
      if (isOutsideTarget(ref.current, e.target)) onOutsideClick();
    };

    if (onEscape) window.addEventListener('keydown', onKeyDown, true);
    if (onOutsideClick) window.addEventListener('mousedown', onMouseDown);
    return () => {
      if (onEscape) window.removeEventListener('keydown', onKeyDown, true);
      if (onOutsideClick) window.removeEventListener('mousedown', onMouseDown);
    };
  }, [enabled, onEscape, onOutsideClick, ref]);
}
