// Composer message history (specs/message-history.md §5) — arrow-up recall for
// the SESSION composer. Entirely frontend, entirely in memory: no IPC channel,
// no contract type, no persistence (FR-11/FR-12). The pure half below is the
// unit-test target; the only state is the module-scoped per-session map at the
// bottom, which is what makes history survive a session switch (ConversationView
// is keyed by sessionId and remounts).

/** One session's sent-message history: oldest first, newest last. Max 100 (FR-1d). */
export type History = readonly string[];

/** Where the composer is in a walk. `null` = not browsing (FR-3/FR-6). */
export interface Browse {
  /** Index into History of the entry currently shown. */
  index: number;
  /** The composer text set aside when browsing began; restored by FR-6. */
  draft: string;
}

/** FR-1d — the cap. Appending past it drops the oldest entry. */
export const MAX_ENTRIES = 100;

/** FR-1a — true when `text`'s first non-whitespace char is '/'. */
export function isSlashEntry(text: string): boolean {
  return text.trimStart().startsWith('/');
}

/** FR-1/1a/1c/1d — returns the next history, unchanged when the entry is not recordable. */
export function appendEntry(history: History, text: string): History {
  if (isSlashEntry(text)) return history; // FR-1a
  if (history.length > 0 && history[history.length - 1] === text) return history; // FR-1c
  const next = [...history, text];
  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next; // FR-1d
}

/** FR-2 — caret is on the first logical line and nothing is selected. */
export function atFirstLine(value: string, selectionStart: number, selectionEnd: number): boolean {
  if (selectionStart !== selectionEnd) return false;
  // "Logical" line, not visual: soft wrapping is deliberately ignored (§7).
  return !value.slice(0, selectionStart).includes('\n');
}

/** FR-5 — caret is on the last logical line and nothing is selected. */
export function atLastLine(value: string, selectionStart: number, selectionEnd: number): boolean {
  if (selectionStart !== selectionEnd) return false;
  return !value.slice(selectionStart).includes('\n');
}

/**
 * FR-3/FR-4 — one step older. `browse` is the current state (null = not browsing),
 * `current` the composer's live text (saved as the draft on entry).
 * Returns null when there is nothing to do (empty history), so the caller falls through.
 */
export function recallPrev(
  history: History,
  browse: Browse | null,
  current: string,
): { browse: Browse; text: string; changed: boolean } | null {
  if (history.length === 0) return null; // FR-2: fall through to caret movement
  if (browse === null) {
    // FR-3 — enter browsing on the newest entry, the live text becomes the draft.
    const index = history.length - 1;
    return { browse: { index, draft: current }, text: history[index], changed: true };
  }
  // FR-4 — one older; at the oldest we still intercept (so the key event is still
  // consumed and the browse state stays put), but `changed: false` tells the
  // caller no text/caret movement is coming — pressing ArrowUp again once already
  // at the oldest entry must leave the caret exactly where the user left it.
  const index = Math.max(0, browse.index - 1);
  return { browse: { index, draft: browse.draft }, text: history[index], changed: index !== browse.index };
}

/**
 * FR-6 — one step newer. Returns `browse: null` + the saved draft when stepping past
 * the newest entry. Returns null when not browsing, so the caller falls through.
 */
export function recallNext(
  history: History,
  browse: Browse | null,
): { browse: Browse | null; text: string } | null {
  if (browse === null) return null; // FR-5: fall through to caret movement
  if (browse.index >= history.length - 1) {
    // Past the newest — leave browsing and restore the draft (possibly empty).
    return { browse: null, text: browse.draft };
  }
  const index = browse.index + 1;
  return { browse: { index, draft: browse.draft }, text: history[index] };
}

// ---------- the per-session store (FR-11) ----------
//
// A plain module map, not a zustand slice: nothing renders from it, so it needs
// no reactivity, and keeping it here keeps the feature inside
// src/features/conversation/ per the layout convention (§6). Entries for a
// closed session are not evicted — bounded per session by MAX_ENTRIES, and a
// reload clears everything.

const EMPTY: History = Object.freeze([] as string[]);

const histories = new Map<string, History>();

/** FR-11 — this session's history, oldest first. Empty for an unknown session. */
export function getHistory(sessionId: string): History {
  return histories.get(sessionId) ?? EMPTY;
}

/** FR-1 — record a successfully sent message as this session's newest entry. */
export function recordSent(sessionId: string, text: string): void {
  const next = appendEntry(getHistory(sessionId), text);
  histories.set(sessionId, Object.freeze(next.slice()));
}
