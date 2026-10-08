// code-editor FR-9 (donated from the parked c21a3e6): per-line markers against HEAD,
// computed in the frontend from the HEAD blob each open returns. A plain line diff: trim
// the common head and tail, then an LCS over what is left (capped — past the cap the whole
// middle reads as modified, which is still the right answer to "did this region change").

export interface GutterMarks {
  /** 1-based lines of the current text. */
  added: number[];
  modified: number[];
  /** Lines whose TOP edge carries a deletion notch (clamped to the last line). */
  deleted: number[];
}

const LCS_CELL_CAP = 4_000_000;

function lines(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

export function gutterMarks(head: string, text: string): GutterMarks {
  const a = lines(head);
  const b = lines(text);
  const marks: GutterMarks = { added: [], modified: [], deleted: [] };

  let lead = 0;
  while (lead < a.length && lead < b.length && a[lead] === b[lead]) lead++;
  let trail = 0;
  while (trail < a.length - lead && trail < b.length - lead && a[a.length - 1 - trail] === b[b.length - 1 - trail]) trail++;
  const am = a.slice(lead, a.length - trail);
  const bm = b.slice(lead, b.length - trail);

  const hunk = (removed: number, addedFrom: number, addedCount: number) => {
    // addedFrom is 0-based within bm; the line number in `text` is lead + addedFrom + 1.
    const first = lead + addedFrom + 1;
    if (addedCount === 0) {
      if (removed > 0) marks.deleted.push(Math.min(first, Math.max(b.length, 1)));
      return;
    }
    const modified = Math.min(removed, addedCount);
    for (let i = 0; i < addedCount; i++) (i < modified ? marks.modified : marks.added).push(first + i);
  };

  if (am.length === 0 || bm.length === 0 || am.length * bm.length > LCS_CELL_CAP) {
    hunk(am.length, 0, bm.length);
    return marks;
  }

  const w = bm.length + 1;
  const dp = new Uint32Array((am.length + 1) * w);
  for (let i = am.length - 1; i >= 0; i--) {
    for (let j = bm.length - 1; j >= 0; j--) {
      dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let removed = 0;
  let addStart = 0;
  let added = 0;
  const flush = () => {
    if (removed > 0 || added > 0) hunk(removed, addStart, added);
    removed = 0;
    added = 0;
  };
  while (i < am.length || j < bm.length) {
    if (i < am.length && j < bm.length && am[i] === bm[j]) {
      flush();
      i++;
      j++;
      addStart = j;
    } else if (j < bm.length && (i === am.length || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) {
      if (added === 0) addStart = j;
      added++;
      j++;
    } else {
      removed++;
      i++;
    }
  }
  flush();
  return marks;
}
