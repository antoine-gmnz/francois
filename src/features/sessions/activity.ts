// design 12b: a RUNNING row carries a live one-line "what is it doing right
// now" — `editing UsageBar.tsx` — instead of the model chip and the cwd every
// row repeated. It is derived from the session stream's `tool.start` (tool +
// summary), which the roster already receives for every session; nothing new
// crosses the contract.
//
// Pure so the phrasing is unit-tested rather than eyeballed in a screenshot.

import { pathLeaf } from './roster-groups';

/**
 * Present participle per tool. Anything unlisted falls back to the tool's own
 * name lowercased, which reads acceptably for the long tail (`todowrite …`)
 * and — more importantly — never lies about what ran.
 */
const VERB: Record<string, string> = {
  Read: 'reading',
  Edit: 'editing',
  MultiEdit: 'editing',
  Write: 'writing',
  NotebookEdit: 'editing',
  Bash: 'running',
  BashOutput: 'watching',
  Grep: 'searching',
  Glob: 'finding',
  Search: 'searching',
  WebFetch: 'fetching',
  WebSearch: 'searching',
  Task: 'delegating',
  Agent: 'delegating',
  TodoWrite: 'planning',
  Workflow: 'orchestrating',
  Skill: 'running',
};

/** Tools whose summary IS a path — only these get shortened to the leaf, so a
 *  Bash command or a search pattern is never mangled by path logic. */
const PATH_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Hard cap: the row is ~260px and already ellipsises, but an unbounded tool
 *  summary (a whole heredoc) would still be held in the store per session. */
const MAX = 64;

/**
 * The activity line for a live `tool.start`. Returns '' when there is nothing
 * worth saying, so a caller can treat empty as "render no line" rather than
 * having to special-case a placeholder.
 */
export function activityLabel(tool: string, summary: string): string {
  const verb = VERB[tool] ?? tool.trim().toLowerCase();
  if (verb === '') return '';
  const detail = activityDetail(tool, summary);
  return detail === '' ? verb : `${verb} ${detail}`;
}

function activityDetail(tool: string, summary: string): string {
  // Collapse newlines/runs of spaces: a multi-line Bash command must not push
  // the row to three lines before CSS ever sees it.
  const flat = summary.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  const text = PATH_TOOLS.has(tool) ? (pathLeaf(flat) || flat) : flat;
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}
