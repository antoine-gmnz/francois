// Quick open's fuzzy matcher (code-editor flow 5 → code-editor-workspace FR-11, donated from the parked c21a3e6): a
// case-insensitive subsequence match over the whole path, scored so that basename hits,
// consecutive runs and word-boundary hits win. Small on purpose — 20 000 paths × a short query.

export interface FuzzyHit {
  score: number;
  /** Indices into the path of the matched characters (for highlighting). */
  indices: number[];
}

const BOUNDARY = /[/._\-\s]/;

export function fuzzyMatch(query: string, path: string): FuzzyHit | null {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const baseStart = path.lastIndexOf('/') + 1;
  // Prefer matching inside the basename: try the basename alone first, then the whole path.
  return matchFrom(q, p, path, baseStart, baseStart) ?? matchFrom(q, p, path, 0, baseStart);
}

function matchFrom(q: string, p: string, raw: string, from: number, baseStart: number): FuzzyHit | null {
  const indices: number[] = [];
  let pos = from;
  let score = 0;
  let prev = -2;
  for (const ch of q) {
    const at = p.indexOf(ch, pos);
    if (at < 0) return null;
    indices.push(at);
    score += 1;
    if (at === prev + 1) score += 4; // consecutive
    if (at === 0 || BOUNDARY.test(raw[at - 1])) score += 3; // word start
    if (at >= baseStart) score += 2; // inside the basename
    prev = at;
    pos = at + 1;
  }
  // Shorter paths first among equals.
  return { score: score - raw.length * 0.01, indices };
}
