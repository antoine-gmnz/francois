// unbound-panes FR-14: a neutral, 2–3 char marker for a project — disambiguates
// two same-named sessions from different repos in the pane header, the grid
// rail tile, and the roster's pane badge (design brief §Project marker). Pure
// so it is unit-testable without a component renderer.

/**
 * Prefers initials across word boundaries (kebab/snake/space) — 'acme-api' →
 * 'AA', 'my project' → 'MP' — and falls back to the first three characters of
 * a single-word name. Never accent-colored by the caller (design: a
 * repeatable surface gets a neutral marker, never `--accent`).
 */
export function projectMarker(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 3).toUpperCase();
}
