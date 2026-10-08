// Go to file's fuzzy matcher (code-editor flow 5, donated from the parked c21a3e6): a
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

export interface RankedPath extends FuzzyHit {
  path: string;
}

export interface Ranking {
  /** Recent files that exist in `paths` (most recent first) — the RECENT group. */
  recent: string[];
  items: RankedPath[];
}

export function rankPaths(paths: readonly string[], query: string, recent: readonly string[], limit = 50): Ranking {
  const present = new Set(paths);
  const recents = recent.filter((r) => present.has(r));
  const recentRank = new Map(recents.map((r, i) => [r, i]));
  if (query.trim() === '') {
    const rest = paths.filter((p) => !recentRank.has(p));
    const items = [...recents, ...rest].slice(0, limit).map((path) => ({ path, score: 0, indices: [] as number[] }));
    return { recent: recents, items };
  }
  const hits: RankedPath[] = [];
  for (const path of paths) {
    const hit = fuzzyMatch(query, path);
    if (!hit) continue;
    // Recent files ride a bonus big enough to settle near-ties, small enough not to beat a clearly better match.
    const bonus = recentRank.has(path) ? 3 : 0;
    hits.push({ path, score: hit.score + bonus, indices: hit.indices });
  }
  hits.sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
  return { recent: recents, items: hits.slice(0, limit) };
}
