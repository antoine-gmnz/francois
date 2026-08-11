// The SESSION welcome header's pure half — every sentence and every row it
// renders, derived from state the app already holds plus the one repo probe
// (contract/session-welcome.ts). Split out from WelcomeBlock.tsx so the wording
// and the selection rules are unit-tested; the component only lays them out.

import type { SessionMeta } from '../../../contract/common';
import { formatRelativeTime, isTerminalStatus } from '../../../contract/fleet-board';
import type { ClaudeMdBrief, GitBrief } from '../../../contract/session-welcome';

/**
 * One run of text in a header sentence. `strong` is the mock's brighter tone —
 * the noun the sentence is actually about (the filename, the branch, the
 * command), never the whole line.
 */
export interface Segment {
  text: string;
  strong?: boolean;
}

/**
 * `formatRelativeTime` is built for space-constrained cards, so it says 'now'
 * rather than '0s' — which reads as "now ago" the moment you suffix it. Prose
 * needs the other form.
 */
export function agoPhrase(then: number, now: number = Date.now()): string {
  const age = formatRelativeTime(then, now);
  return age === 'now' ? 'just now' : `${age} ago`;
}

/** "CLAUDE.md found — 41 lines, last edited 6d ago.", or the invitation to write one. */
export function claudeMdSegments(md: ClaudeMdBrief | undefined, now: number = Date.now()): Segment[] {
  if (!md) {
    return [{ text: 'No CLAUDE.md here yet — run ' }, { text: '/init', strong: true }, { text: ' to write one.' }];
  }
  const lines = `${md.lines} ${md.lines === 1 ? 'line' : 'lines'}`;
  return [
    { text: 'CLAUDE.md', strong: true },
    { text: ` found — ${lines}, last edited ${agoPhrase(md.modifiedAt, now)}.` },
  ];
}

/**
 * "Working on router-adapter, 4 commits ahead of main." — or the branch alone
 * when there is nothing to count, and null when the session is not in a repo at
 * all (the header then drops the line rather than stating an absence nobody
 * asked about).
 */
export function workingOnSegments(git: GitBrief | undefined): Segment[] | null {
  if (!git) return null;
  if (git.detached) {
    return [{ text: 'Detached at ' }, { text: git.branch, strong: true }, { text: '.' }];
  }
  const head: Segment[] = [{ text: 'Working on ' }, { text: git.branch, strong: true }];
  // `ahead: 0` is the everyday case on a fresh branch; "0 commits ahead of main"
  // is noise, so it reads exactly like a repo with no trunk to compare against.
  if (git.base === undefined || !git.ahead) return [...head, { text: '.' }];
  const commits = `${git.ahead} ${git.ahead === 1 ? 'commit' : 'commits'}`;
  return [...head, { text: `, ${commits} ahead of ${git.base}.` }];
}

/**
 * The identity line under the mark: model · account · branch. Parts with nothing
 * to say are dropped rather than rendered blank, so a session with no account
 * label and no branch still reads as a sentence.
 */
export function identityParts(input: {
  model?: string;
  account?: string;
  branch?: string;
}): string[] {
  const parts: string[] = [];
  if (input.model) parts.push(input.model);
  if (input.account) parts.push(input.account);
  // ⎇ is the branch glyph the sidebar already uses (SessionListBody) — one glyph
  // for one concept across the app.
  if (input.branch) parts.push(`⎇ ${input.branch}`);
  return parts;
}

/** A finished session, as the "Recent in this repo" list states it. */
export interface RecentEntry {
  id: string;
  name: string;
  /** false ⇒ it ended in an error; the row marks it differently. */
  done: boolean;
  /** Compact age of its last activity — '2d'. */
  age: string;
}

/**
 * The sessions that ran here before: FINISHED ones only (a running session is on
 * the fleet board, not in a history list), newest first, this one excluded.
 *
 * "Here" is the project when the session has one — a project is rooted at a
 * directory, so its sessions share the repo even when their cwds differ — and
 * the exact cwd otherwise, which is the only thing an unlinked session knows
 * about its own repo.
 */
export function recentInRepo(
  sessions: readonly SessionMeta[],
  current: SessionMeta,
  now: number = Date.now(),
  limit = 3,
): RecentEntry[] {
  const sameRepo = (s: SessionMeta) =>
    current.projectId ? s.projectId === current.projectId : !s.projectId && s.cwd === current.cwd;
  return sessions
    .filter((s) => s.id !== current.id && isTerminalStatus(s.status) && sameRepo(s))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit)
    .map((s) => ({ id: s.id, name: s.name, done: s.status === 'done', age: formatRelativeTime(s.lastActivityAt, now) }));
}
