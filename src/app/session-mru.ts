// The main pane's held-session list — the pure half of `SessionViewHost`.
//
// The host keeps the heavy per-session bodies (the transcript, the PTY
// terminals) MOUNTED across a session switch and across a main-tab switch,
// hidden with `display: none` rather than unmounted, so coming back to a
// session costs a style flip instead of a `getTranscript` round trip, a full
// markdown re-parse and a destroy/recreate of every xterm with its scrollback
// replayed. What bounds that is this list: at most `MRU_CAP` sessions are held,
// most-recently-viewed first, and whatever falls off the end unmounts for real
// (React's own cleanup runs the existing unlisten/dispose paths).
//
// Framework-free and kept out of the .tsx on purpose: this project has no
// component renderer in its test setup (REFACTOR-CONVENTIONS.md), so the
// eviction order and the removal pruning are only testable as plain data.

/**
 * How many sessions the main pane holds at once. Three is the fleet size the
 * roster is built around (design 12b) and the point where holding more starts
 * costing more memory than the switch it saves: every held entry keeps a live
 * `session.*` subscription, a transcript reducer of up to `RENDER_WINDOW`
 * blocks, and — once its SHELL tab has been opened — one xterm per shell.
 */
export const MRU_CAP = 3;

/** Referentially stable "nothing held" — see the no-op rule below. */
const EMPTY: readonly string[] = [];

/**
 * Element-wise equality, so both helpers can hand the SAME array back when
 * nothing moved. That stability is load-bearing, not cosmetic: the host derives
 * its list during render and writes it to state only when it actually changed,
 * and a fresh array every render would be an infinite render loop.
 */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Moves (or inserts) `activeId` at the front and drops everything past `cap`.
 *
 * `activeId: null` — no session selected — leaves the list alone rather than
 * clearing it: "select a session" is a state the user leaves again, and the
 * views held behind it are exactly what makes that return instant.
 */
export function mruAdvance(list: readonly string[], activeId: string | null, cap: number): readonly string[] {
  if (activeId === null) return list;
  const size = Math.max(0, cap);
  if (size === 0) return list.length === 0 ? list : EMPTY;
  const next = [activeId, ...list.filter((id) => id !== activeId)].slice(0, size);
  return sameOrder(next, list) ? list : next;
}

/**
 * Drops entries whose session no longer exists — a removed session must not
 * keep a hidden transcript subscribed to a stream that will never speak again.
 * Order among the survivors is preserved (removal is not a visit).
 */
export function mruPrune(list: readonly string[], liveIds: Iterable<string>): readonly string[] {
  const live = new Set(liveIds);
  const next = list.filter((id) => live.has(id));
  return next.length === list.length ? list : next;
}
