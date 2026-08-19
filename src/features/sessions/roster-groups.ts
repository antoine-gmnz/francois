// What survives of the repo-grouped roster (design 7a + project-groups) now that
// design 12b groups pane [1] by STATE and nothing else: the two pure helpers that
// answer "which repo is this session's?" — the roster still names the project on
// a row, just as a tag rather than as a heading, and only when there is more than
// one to tell apart.
//
// "Repo" resolves to the session's project when it has one, and to the last
// segment of its cwd otherwise — which is what makes the label useful before
// anything has been registered in the Projects modal.
//
// Gone with the toggle: buildRoster / groupSessionsByRepo / flattenGroups, the
// group+project node types, and the collapse record they shared. The state tier's
// own record lives in state-groups.ts.

import type { SessionMeta } from '../../../contract/common';
import type { ProjectMeta } from '../../../contract/projects';

/**
 * Last path segment of an absolute path, for both separators and with trailing
 * separators ignored. Returns '' for a path that has no segment at all (''),
 * and the root itself for '/' — callers fall back to a generic heading.
 */
export function pathLeaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (trimmed === '') return '';
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Label for a session with no project — never a key collision with one that has. */
const UNGROUPED_LABEL = 'elsewhere';

/**
 * Which repo a session belongs to. Project-backed sessions key on the project
 * id, so two projects that happen to share a name stay apart; the rest key on
 * their cwd leaf, which is how a repo the user never registered is still named.
 */
export function groupKeyFor(
  session: SessionMeta,
  projects: readonly ProjectMeta[],
): { key: string; label: string; projectId: string | null } {
  if (session.projectId !== undefined) {
    const project = projects.find((p) => p.id === session.projectId);
    if (project) return { key: `project:${project.id}`, label: project.name, projectId: project.id };
    // A projectId the registry has not resolved yet (project_list still in
    // flight) must not collapse every such session under one anonymous label —
    // key on the id so the labelling is stable across the resolution.
    return { key: `project:${session.projectId}`, label: pathLeaf(session.cwd) || UNGROUPED_LABEL, projectId: session.projectId };
  }
  const leaf = pathLeaf(session.cwd);
  return leaf === '' ? { key: 'path:', label: UNGROUPED_LABEL, projectId: null } : { key: `path:${leaf}`, label: leaf, projectId: null };
}
