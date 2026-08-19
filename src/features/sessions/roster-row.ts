// design 12b: the two strings a state-grouped roster row needs that are not
// already a formatted figure.
//
//  - `askLine`  what a WAITING row says it wants, split into a lead and the
//               thing itself, because the thing is set as CODE ("Wants to run
//               `git push --force`") and the lead is not.
//  - `rowTitle` everything 12b took OFF the row — path, branch, model, context —
//               folded into the hover title, so nothing is lost, only moved.
//
// Pure; the components below assemble DOM around them.

import type { PermissionAsk, SessionMeta } from '../../../contract/common';
import { formatContextTokens } from '../../../contract/conversation-view';
import type { SessionDerived } from '../../../contract/fleet-board';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import { abbreviate } from '../../lib/path';
import { pathLeaf } from './roster-groups';
import { worktreeChipLabel } from './worktree';

export interface AskLine {
  /** Prose, ends without punctuation: 'Wants to run'. */
  lead: string;
  /** The thing being asked for, set as code. '' ⇒ render the lead alone. */
  code: string;
}

/** Lead phrasing per tool. The unlisted long tail names the tool instead of
 *  inventing a verb for it — 'Wants to use Playwright' is honest, 'wants to
 *  run' would not be. */
const ASK_LEAD: Record<string, string> = {
  Bash: 'Wants to run',
  Read: 'Wants to read',
  Edit: 'Wants to edit',
  MultiEdit: 'Wants to edit',
  Write: 'Wants to write',
  NotebookEdit: 'Wants to edit',
  WebFetch: 'Wants to fetch',
  WebSearch: 'Wants to search',
  Grep: 'Wants to search',
  Glob: 'Wants to search',
};

/** Tools whose summary is a path — shortened to the leaf, like the activity line. */
const PATH_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const MAX_CODE = 48;

export function askLine(ask: PermissionAsk): AskLine {
  const tool = ask.toolName.trim();
  const lead = ASK_LEAD[tool] ?? `Wants to use ${tool || 'a tool'}`;
  const flat = ask.summary.replace(/\s+/g, ' ').trim();
  if (flat === '') return { lead, code: '' };
  const text = PATH_TOOLS.has(tool) ? (pathLeaf(flat) || flat) : flat;
  return { lead, code: text.length > MAX_CODE ? `${text.slice(0, MAX_CODE - 1)}…` : text };
}

/**
 * The row's hover title. 12b drops the cwd line, the model chip and the context
 * figure from the quiet rows and the branch line from all of them — this is
 * where they go. Segments that say nothing (no worktree, no context limit) are
 * left out rather than rendered as a dash.
 */
export function rowTitle(session: SessionMeta, home: string): string {
  const parts: string[] = [session.name];
  const cwd = displayWslCwd(session.cwd) ?? abbreviate(session.cwd, home);
  if (cwd) parts.push(cwd);
  if (session.worktree) parts.push(worktreeChipLabel(session.worktree));
  if (session.model.label) parts.push(session.model.label);
  if (session.contextLimitTokens > 0) {
    parts.push(`${formatContextTokens(session.contextUsedTokens)}/${formatContextTokens(session.contextLimitTokens)}`);
  }
  return parts.join(' · ');
}

/**
 * split-by-4 FR-22: what a paned row's badge reads. At two panes the positions
 * are the names the user already has for them (turn 5b's `left` / `right`);
 * above that the badge is the pane NUMBER, which is also what `⌘<n>` and the
 * pane header say.
 */
export function paneBadgeLabel(paneIndex: number, paneCount: number): string {
  if (paneCount === 2) return paneIndex === 0 ? 'left' : 'right';
  return String(paneIndex + 1);
}

/**
 * The settled row's third line: what this session's working tree is carrying.
 * `null` ⇒ there is nothing to say and the line is not rendered — a clean tree
 * is the normal state of a session you have finished with, and a row that says
 * "0 files" every time is the repetition 12b exists to remove.
 *
 * Note the design also draws a "ready to review" variant for a clean tree with
 * committed work. That needs a commits-ahead probe the roster does not run (see
 * GitBrief.ahead, which only `francois:project:repoBrief` produces), so a clean
 * tree renders no line at all rather than a claim this cannot substantiate.
 */
export interface WorkLine {
  added: number;
  deleted: number;
  note: string;
}

export function workLine(derived: SessionDerived | undefined): WorkLine | null {
  if (!derived) return null;
  const { fileCount, addedLines, deletedLines } = derived;
  if (fileCount === null || fileCount <= 0) return null;
  if (addedLines === null || deletedLines === null) return null;
  return {
    added: addedLines,
    deleted: deletedLines,
    note: `${fileCount} ${fileCount === 1 ? 'file' : 'files'}, uncommitted`,
  };
}

/** Compact line count — the design's own `+1.2K` for four figures and up. */
export function formatLineCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`;
}

/** Fill fraction of the context bar, clamped to 0..1. 0 when there is no limit
 *  to measure against (an unknown window is not a full one). */
export function contextFraction(session: SessionMeta): number {
  if (session.contextLimitTokens <= 0) return 0;
  return Math.max(0, Math.min(1, session.contextUsedTokens / session.contextLimitTokens));
}
