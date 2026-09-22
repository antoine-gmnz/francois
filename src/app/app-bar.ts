// Pure helpers for the app bar (AppBar.tsx) — redesign "Graphite & Signal",
// Figma "App bar" 126:158.

import type { MainTab } from '../lib/store';

/** The three nav pills. Everything that is not one of the two app-scoped
 *  destinations (Overview, GitHub) is "Sessions". */
export type AppNav = 'overview' | 'github' | 'sessions';

export function activeNav(mainTab: MainTab): AppNav {
  if (mainTab === 'overview') return 'overview';
  if (mainTab === 'github') return 'github';
  return 'sessions';
}

/**
 * The account avatar's two letters: the first letter of the first two words of
 * the account label (words split on spaces, dots, dashes, underscores and the
 * `@` of an email), or the first two letters of a one-word label.
 */
export function accountInitials(label: string): string {
  const local = label.trim();
  if (local === '') return '?';
  const words = local.split(/[\s._@-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
}
