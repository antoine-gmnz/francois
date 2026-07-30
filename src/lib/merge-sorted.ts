// Shared "insert-or-replace into a sorted array" (REFACTOR.md audit: the same
// algorithm at agent-tab.ts's `mergeAgentBlock` — sorted by `blockOrdinal(blockId)`
// — and agent-trail.ts's `mergeStep` — sorted by `step.seq`). Both: find an
// existing item with the same key and replace it in place (how a `meta` fill
// lands without appending a second row/card); otherwise scan backward from the
// end while the previous item's key is greater, and splice the new item in
// there. Neither mutates its input.

/**
 * Insert `item` into `list` at its sorted position by `keyOf`, or replace the
 * existing element whose key equals `keyOf(item)` in place. Returns a new
 * array; `list` is never mutated.
 *
 * Faithful to both existing call sites: replacing preserves the array's
 * length and every other element's position (agent-tab's "`meta` fill" case);
 * inserting keeps the array sorted ascending by `keyOf`, appending when the
 * new key is the largest and prepending when it's the smallest.
 */
export function mergeSorted<T>(list: T[], item: T, keyOf: (item: T) => number): T[] {
  const key = keyOf(item);
  const i = list.findIndex((x) => keyOf(x) === key);
  if (i >= 0) {
    const next = list.slice();
    next[i] = item;
    return next;
  }
  const next = list.slice();
  let at = next.length;
  while (at > 0 && keyOf(next[at - 1]) > key) at--;
  next.splice(at, 0, item);
  return next;
}
