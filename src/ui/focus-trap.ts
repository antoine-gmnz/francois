// Focus-trap helpers for dialogs: the focusable-element query and the pure
// "where does Tab go next" computation (wraps at both ends).

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** Next focus index for Tab / Shift+Tab over `count` focusables. `current` is
 * the index of the focused one, or -1 when focus is outside the list. */
export function nextFocusIndex(count: number, current: number, shiftKey: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shiftKey ? count - 1 : 0;
  return shiftKey ? (current - 1 + count) % count : (current + 1) % count;
}
