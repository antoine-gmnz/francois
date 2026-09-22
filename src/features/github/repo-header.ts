// github-page FR-2 — pure text helpers for RepoHeader.tsx's meta line
// (`<branch> · up to date | ↑n ↓m · fetched <relative>`).

import type { AheadBehind } from '../../../contract/github-page';

/** 'up to date' when the branch has no upstream or matches it exactly;
 *  '↑n ↓m' otherwise. */
export function upstreamText(upstream: AheadBehind | null): string {
  if (!upstream || (upstream.ahead === 0 && upstream.behind === 0)) return 'up to date';
  return `↑${upstream.ahead} ↓${upstream.behind}`;
}

/** 'fetched <relative>', or null when the repo has never been fetched. */
export function fetchedText(lastFetchedAt: number | undefined, now: number = Date.now()): string | null {
  if (lastFetchedAt === undefined) return null;
  return `fetched ${fetchedRelative(lastFetchedAt, now)}`;
}

function fetchedRelative(then: number, now: number): string {
  const ms = Math.max(0, now - then);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

/** The repo title's two-tone parts: muted `owner/` (absent without an owner)
 *  and the strong repo name. */
export function repoTitleParts(owner: string | undefined, name: string): { owner: string; name: string } {
  return { owner: owner ? `${owner}/` : '', name };
}
