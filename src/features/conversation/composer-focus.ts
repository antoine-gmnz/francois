// Who owns the caret in a split — the SESSION-tab counterpart of ShellTerminal's
// `canFocus` focus/blur (ShellTerminal.tsx). Selecting a pane means "I want to
// type here", so the pane that takes focus hands the caret to its composer
// rather than asking for a second click on the input.

export interface ComposerFocusInput {
  /** Was this pane's composer inert on the previous render? */
  wasInert: boolean;
  /** Is it inert now? (split-session FR-6 — the unfocused pane's strip) */
  inert: boolean;
  /** Is a non-collapsed text selection live in the document? */
  hasSelection: boolean;
}

/**
 * True only on the inert → live edge, i.e. the moment this pane takes focus.
 *
 * Not on every render with `inert === false`: clicking anywhere inside the
 * ALREADY focused pane re-runs the click handler, and stealing the caret then
 * would fight the user (a click in the transcript, a click on a card's button).
 *
 * Not while a selection is live either: the click that focused the pane may be
 * the mouseup of a drag-select in the transcript, and `.focus()` on the textarea
 * collapses the document selection (mac-text-selection).
 */
export function shouldFocusComposer({ wasInert, inert, hasSelection }: ComposerFocusInput): boolean {
  return wasInert && !inert && !hasSelection;
}

/** `hasSelection` for the predicate above, read off the live document. */
export function documentHasSelection(): boolean {
  const sel = typeof window === 'undefined' ? null : window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim() !== '';
}
