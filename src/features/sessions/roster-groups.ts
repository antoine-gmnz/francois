// design 7a (the composite): the roster is GROUPED BY REPO rather than flat.
// "Repo" resolves to the session's project when it has one, and to the last
// segment of its cwd otherwise — which is what makes the grouping useful before
// anything has been registered in the Projects modal. Pure + unit-tested; the
// component (SessionListBody) only renders what these return.
//
// project-groups FR-11..FR-18: a SECOND, mixed-depth tier sits above the repo
// tier — a `ProjectGroup` node holding project nodes as its only children.
// `groupSessionsByRepo` stays exactly as it was (the repo-tier pass);
// `buildRoster` is the new entry point that wraps its output with group nodes.

import type { SessionMeta } from '../../../contract/common';
import type { ProjectGroup, ProjectMeta } from '../../../contract/projects';

export interface RosterProjectNode {
  /** Stable identity for React keys AND for the collapse record. */
  key: string;
  /** The heading — a project name, or the cwd's last segment. */
  label: string;
  /** Set for project-backed nodes only; `+` scopes a new session to it. */
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
): RosterProjectNode[] {
  const byKey = new Map<string, RosterProjectNode>();
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

// ---------- project-groups: the group tier (FR-11..FR-18) ----------

/** A thin heading over one or more `RosterProjectNode`s — never nested (FR-11). */
export interface RosterGroupNode {
  /** `group:<groupId>` — its own slot in the collapse record (FR-15). */
  key: string;
  label: string;
  groupId: string;
  projects: RosterProjectNode[];
  /** FR-14: sum over `projects`' session counts. */
  sessionCount: number;
}

export type RosterNode = RosterGroupNode | RosterProjectNode;

export function isGroupNode(n: RosterNode): n is RosterGroupNode {
  return 'groupId' in n;
}

/**
 * FR-11/12/13/14: the two-tier, mixed-depth roster. Starts from the repo-tier
 * pass (`groupSessionsByRepo`, unchanged) and wraps each project node whose
 * project names a KNOWN group (FR-18: a `groupId` the registry has not yet
 * resolved leaves the project top-level, never in an anonymous group) into
 * that group's node.
 *
 * A group node is emitted only once — at the position of its first member's
 * project node (FR-13) — and never enumerated from the registry directly
 * (FR-12): a group with no visible session simply has no project nodes to
 * carry it into the output.
 */
export function buildRoster(
  sessions: readonly SessionMeta[],
  projects: readonly ProjectMeta[],
  groups: readonly ProjectGroup[],
): RosterNode[] {
  const projectNodes = groupSessionsByRepo(sessions, projects);
  const groupById = new Map(groups.map((g) => [g.id, g] as const));
  const out: RosterNode[] = [];
  const groupNodeByKey = new Map<string, RosterGroupNode>();

  for (const node of projectNodes) {
    const project = node.projectId !== null ? projects.find((p) => p.id === node.projectId) : undefined;
    const group = project?.groupId !== undefined ? groupById.get(project.groupId) : undefined;
    if (!group) {
      out.push(node);
      continue;
    }
    const gkey = `group:${group.id}`;
    let gnode = groupNodeByKey.get(gkey);
    if (!gnode) {
      gnode = { key: gkey, label: group.name, groupId: group.id, projects: [], sessionCount: 0 };
      groupNodeByKey.set(gkey, gnode);
      out.push(gnode); // first appearance wins the position (FR-13)
    }
    gnode.projects.push(node);
    gnode.sessionCount += node.sessions.length;
  }
  return out;
}

/**
 * The rendered order, flattened. The sidebar's keyboard cursor indexes into a
 * flat list, so it has to walk the sessions in the order the GROUPED roster
 * actually paints them — not the order they arrived in.
 *
 * FR-17: a collapsed group's whole subtree is skipped outright; inside an
 * EXPANDED group, a project's own collapse state (FR-16) is honored
 * independently — the two key spaces share one flat `collapsed` set (FR-15).
 */
export function flattenGroups(nodes: readonly RosterNode[], collapsed: ReadonlySet<string> = new Set()): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const node of nodes) {
    if (collapsed.has(node.key)) continue; // a hidden row can't take the cursor
    if (isGroupNode(node)) {
      for (const p of node.projects) {
        if (collapsed.has(p.key)) continue;
        out.push(...p.sessions);
      }
      continue;
    }
    out.push(...node.sessions);
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
