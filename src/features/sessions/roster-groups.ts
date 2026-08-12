// design 7a (the composite): the roster is GROUPED BY REPO rather than flat.
// "Repo" resolves to the session's project when it has one, and to the last
// segment of its cwd otherwise — which is what makes the grouping useful before
// anything has been registered in the Projects modal. Pure + unit-tested; the
// component (SessionListBody) only renders what these return.

import type { SessionMeta } from '../../../contract/common';
import type { ProjectMeta } from '../../../contract/projects';

export interface RosterGroup {
  /** Stable identity for React keys AND for the collapse record. */
  key: string;
  /** The heading — a project name, or the cwd's last segment. */
  label: string;
  /** Set for project-backed groups only; `+` scopes a new session to it. */
  projectId: string | null;
  sessions: SessionMeta[];
}

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

/** Heading for a session with no project — never a key collision with one that has. */
const UNGROUPED_LABEL = 'elsewhere';

/**
 * Which group a session belongs to. Project-backed sessions key on the project
 * id, so two projects that happen to share a name stay apart; the rest key on
 * their cwd leaf, which is how a repo the user never registered still groups.
 */
export function groupKeyFor(
  session: SessionMeta,
  projects: readonly ProjectMeta[],
): { key: string; label: string; projectId: string | null } {
  if (session.projectId !== undefined) {
    const project = projects.find((p) => p.id === session.projectId);
    if (project) return { key: `project:${project.id}`, label: project.name, projectId: project.id };
    // A projectId the registry has not resolved yet (project_list still in
    // flight) must not collapse every such session into one anonymous group —
    // key on the id so the grouping is stable across the resolution.
    return { key: `project:${session.projectId}`, label: pathLeaf(session.cwd) || UNGROUPED_LABEL, projectId: session.projectId };
  }
  const leaf = pathLeaf(session.cwd);
  return leaf === '' ? { key: 'path:', label: UNGROUPED_LABEL, projectId: null } : { key: `path:${leaf}`, label: leaf, projectId: null };
}

/**
 * Group `sessions` for the roster. Groups appear in the order their FIRST
 * session does, and sessions keep their incoming order inside a group — so the
 * roster tracks whatever order the fleet store already imposes rather than
 * inventing a second one.
 */
export function groupSessionsByRepo(
  sessions: readonly SessionMeta[],
  projects: readonly ProjectMeta[],
): RosterGroup[] {
  const byKey = new Map<string, RosterGroup>();
  const order: string[] = [];
  for (const session of sessions) {
    const { key, label, projectId } = groupKeyFor(session, projects);
    const existing = byKey.get(key);
    if (existing) {
      existing.sessions.push(session);
    } else {
      byKey.set(key, { key, label, projectId, sessions: [session] });
      order.push(key);
    }
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * The rendered order, flattened. The sidebar's keyboard cursor indexes into a
 * flat list, so it has to walk the sessions in the order the GROUPED roster
 * actually paints them — not the order they arrived in.
 */
export function flattenGroups(groups: readonly RosterGroup[], collapsed: ReadonlySet<string> = new Set()): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const group of groups) {
    if (collapsed.has(group.key)) continue; // a hidden row can't take the cursor
    out.push(...group.sessions);
  }
  return out;
}

// ---------- collapse record (localStorage) ----------

export const COLLAPSED_GROUPS_KEY = 'francois.collapsedRosterGroups';

/** Pure, exported for tests: anything malformed degrades to "nothing collapsed". */
export function parseCollapsedGroups(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

export function loadCollapsedGroups(): Set<string> {
  try {
    return parseCollapsedGroups(localStorage.getItem(COLLAPSED_GROUPS_KEY));
  } catch {
    return new Set();
  }
}

export function persistCollapsedGroups(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...keys]));
  } catch {
    /* ignore */
  }
}
