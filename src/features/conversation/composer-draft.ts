// Composer drafts — the unsent prompt text, kept per session across a session
// switch. ConversationView is keyed by sessionId, so switching away eventually
// unmounts it and its `input` useState dies with it; without this map a
// half-typed prompt would vanish the moment the user looks at another session.
//
// "Eventually", since the main pane's `SessionViewHost` now HOLDS the last few
// sessions' views mounted — inside that window the composer's own state
// survives and this map is never consulted. It is what covers everything past
// it: the fourth session back, and any session whose view was evicted.
//
// Same shape as ./message-history's store, and for the same reasons: a plain
// module map rather than a zustand slice (nothing renders from it — the composer
// seeds its own state from it on mount), and no persistence, so a reload starts
// clean.

const drafts = new Map<string, string>();

/** This session's unsent composer text. Empty string when there is none. */
export function getDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? '';
}

/**
 * Records this session's unsent composer text. An empty draft is *removed*
 * rather than stored: a sent (or cleared) composer must leave nothing behind,
 * and a session the user only ever looked at should not hold a map entry.
 */
export function setDraft(sessionId: string, text: string): void {
  if (text === '') drafts.delete(sessionId);
  else drafts.set(sessionId, text);
}

/**
 * Drops a session's draft. Called when the session itself goes away
 * (useSessionFleetSync.dropDerived), alongside the other per-session frontend
 * bookkeeping — nothing else evicts, so a draft otherwise lives as long as the
 * process.
 */
export function clearDraft(sessionId: string): void {
  drafts.delete(sessionId);
}
