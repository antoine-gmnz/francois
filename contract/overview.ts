// contract/overview.ts — overview (main tab OVERVIEW, the cross-project dashboard).
// Frontend-only, exactly like fleet-board: NO IPC command, NO francois://…/event
// member, NO ErrorCode is defined here. The dashboard aggregates state the fleet
// board already collects (the session cache + its per-session SessionDerived map)
// plus the project registry, and adds one new piece of state — the activity log,
// an in-memory ring buffer fed by the SAME session-event subscription the board
// owns. Nothing is persisted: the log starts empty at every launch.
//
// Imports shared vocabulary from common.ts / projects.ts / fleet-board.ts and
// never redefines it. Every function below is pure and unit-tested in
// src/features/overview/overview.test.ts.

import type { ProjectId, SessionId, SessionMeta, SessionStatus } from './common';
import type { ProjectMeta } from './projects';
import type { SessionDerived } from './fleet-board';

/** Per-session derived figures, keyed by session id — the fleet board's map (FR-4). */
export type DerivedMap = ReadonlyMap<SessionId, SessionDerived>;

// ---------- status roll-up ----------

/** One counter per SessionStatus. Keys are exhaustive so a render can index blind. */
export type StatusCounts = Record<SessionStatus, number>;

export function emptyStatusCounts(): StatusCounts {
  return { running: 0, idle: 0, done: 0, error: 0 };
}

/** Tally a session list by status. Unknown statuses (forward compat) are skipped. */
export function countByStatus(sessions: readonly SessionMeta[]): StatusCounts {
  const counts = emptyStatusCounts();
  for (const s of sessions) {
    if (s.status in counts) counts[s.status] += 1;
  }
  return counts;
}

// ---------- per-project grouping ----------

/**
 * A dashboard row-group: one project, or the synthetic "unlinked" bucket holding
 * every session with no `projectId` (or one that no longer resolves to a registry
 * entry — those read as unlinked, matching projects FR-18).
 */
export interface OverviewGroup {
  /** null ⇒ the synthetic unlinked bucket. */
  projectId: ProjectId | null;
  name: string;
  /** The project root; null for the unlinked bucket. */
  root: string | null;
  /** false when the project's directory is gone (projects FR-2); always true unlinked. */
  rootExists: boolean;
  /** This group's sessions, most recently active first. */
  sessions: SessionMeta[];
  counts: StatusCounts;
}

/** The unlinked bucket's display name. */
export const UNLINKED_GROUP_NAME = 'unlinked';

/**
 * Build the dashboard's groups.
 *
 * - Projects appear in registry order (the caller passes the already-ordered list
 *   from `orderProjects` / `project_list`), INCLUDING projects that own no session —
 *   a dashboard "of what's happening" must be able to say "nothing here".
 * - The unlinked bucket is appended LAST and only when it is non-empty.
 * - `activeProjectId` non-null scopes the result to that one project (projects
 *   FR-27), so the tab works scoped as well as across everything.
 * - Sessions inside a group are sorted by `lastActivityAt` descending.
 */
export function groupSessionsByProject(
  sessions: readonly SessionMeta[],
  projects: readonly ProjectMeta[],
  activeProjectId: ProjectId | null = null,
): OverviewGroup[] {
  const known = new Set(projects.map((p) => p.id));
  const byProject = new Map<ProjectId, SessionMeta[]>();
  const unlinked: SessionMeta[] = [];

  for (const s of sessions) {
    // A projectId the registry does not know reads as unlinked (projects FR-18).
    if (s.projectId && known.has(s.projectId)) {
      const bucket = byProject.get(s.projectId);
      if (bucket) bucket.push(s);
      else byProject.set(s.projectId, [s]);
    } else {
      unlinked.push(s);
    }
  }

  const byRecency = (a: SessionMeta, b: SessionMeta) => b.lastActivityAt - a.lastActivityAt;
  const groups: OverviewGroup[] = [];

  for (const p of projects) {
    if (activeProjectId !== null && p.id !== activeProjectId) continue;
    const own = (byProject.get(p.id) ?? []).slice().sort(byRecency);
    groups.push({
      projectId: p.id,
      name: p.name,
      root: p.root,
      rootExists: p.rootExists,
      sessions: own,
      counts: countByStatus(own),
    });
  }

  // Scoping to a project deliberately hides the unlinked bucket — those sessions
  // are not in that project, and the board hides them too (projects FR-27).
  if (activeProjectId === null && unlinked.length > 0) {
    const own = unlinked.slice().sort(byRecency);
    groups.push({
      projectId: null,
      name: UNLINKED_GROUP_NAME,
      root: null,
      rootExists: true,
      sessions: own,
      counts: countByStatus(own),
    });
  }

  return groups;
}

// ---------- fleet totals strip ----------

export interface FleetTotals {
  sessions: number;
  /** Groups holding at least one session — "how many projects are actually busy". */
  activeProjects: number;
  counts: StatusCounts;
  /** Sum of every KNOWN, non-zero diff file count. Sessions at `null` contribute 0. */
  changedFiles: number;
  runningAgents: number;
}

/**
 * Aggregate the strip at the top of the dashboard, over exactly the groups being
 * rendered (so it honours the project scope for free).
 */
export function computeFleetTotals(groups: readonly OverviewGroup[], derived: DerivedMap): FleetTotals {
  const counts = emptyStatusCounts();
  let sessions = 0;
  let activeProjects = 0;
  let changedFiles = 0;
  let runningAgents = 0;

  for (const g of groups) {
    if (g.sessions.length > 0) activeProjects += 1;
    sessions += g.sessions.length;
    for (const k of Object.keys(counts) as SessionStatus[]) counts[k] += g.counts[k];
    for (const s of g.sessions) {
      const d = derived.get(s.id);
      if (d) {
        if (d.fileCount != null && d.fileCount > 0) changedFiles += d.fileCount;
        runningAgents += d.runningAgentCount;
      }
    }
  }

  return { sessions, activeProjects, counts, changedFiles, runningAgents };
}

// ---------- needs-attention list ----------

/**
 * Why a session is asking for the user:
 *   'error'       — it failed; `detail` carries the message.
 *   'uncommitted' — it finished its turn (idle/done) and left uncommitted files.
 */
export type AttentionReason = 'error' | 'uncommitted';

export interface AttentionItem {
  session: SessionMeta;
  reason: AttentionReason;
  detail: string;
}

/**
 * The sessions that want the user, most urgent first: every errored session
 * (ordered most-recent-activity first), then every session that is idle or done
 * with a known non-zero diff count. A running session is NEVER listed — it is
 * still working, so there is nothing to act on yet.
 */
export function needsAttention(groups: readonly OverviewGroup[], derived: DerivedMap): AttentionItem[] {
  const errors: AttentionItem[] = [];
  const uncommitted: AttentionItem[] = [];

  for (const g of groups) {
    for (const s of g.sessions) {
      if (s.status === 'error') {
        errors.push({ session: s, reason: 'error', detail: s.errorMessage?.trim() || 'session failed' });
        continue;
      }
      if (s.status === 'running') continue;
      const files = derived.get(s.id)?.fileCount ?? null;
      if (files != null && files > 0) {
        uncommitted.push({
          session: s,
          reason: 'uncommitted',
          detail: `${files} uncommitted ${files === 1 ? 'file' : 'files'}`,
        });
      }
    }
  }

  const byRecency = (a: AttentionItem, b: AttentionItem) => b.session.lastActivityAt - a.session.lastActivityAt;
  return [...errors.sort(byRecency), ...uncommitted.sort(byRecency)];
}

// ---------- activity feed ----------

/**
 * What the feed records. Deliberately coarse — one entry per event a human would
 * call "something happened", not per token or per tool call. `diff.changed` is
 * NOT recorded: the file counts are already on every card, and it fires far too
 * often to read.
 */
export type ActivityKind =
  | 'session.started'
  | 'turn.finished'
  | 'session.done'
  | 'session.error'
  | 'session.removed'
  | 'agent.finished'
  | 'agent.failed';

export interface ActivityEntry {
  /** Unique + monotonically increasing within a run; the React key. */
  id: string;
  at: number; // epoch ms
  kind: ActivityKind;
  sessionId: SessionId;
  /**
   * Captured AT RECORD TIME, not resolved at render: a removed or renamed session
   * must still read correctly in the trail.
   */
  sessionName: string;
  /** Captured at record time, for the project scope filter; absent ⇒ unlinked. */
  projectId?: ProjectId;
  /** Free text: the agent's name, the error message, ''. */
  detail: string;
}

/** The ring buffer's cap. Older entries fall off the end. */
export const MAX_ACTIVITY = 200;

/**
 * Prepend an entry (newest first) and truncate to MAX_ACTIVITY. Pure — returns a
 * new array and never mutates its input.
 */
export function appendActivity(log: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  const next = [entry, ...log];
  return next.length > MAX_ACTIVITY ? next.slice(0, MAX_ACTIVITY) : next;
}

/** Scope the feed to a project (projects FR-27); null ⇒ everything, unchanged. */
export function filterActivityByProject(
  log: readonly ActivityEntry[],
  activeProjectId: ProjectId | null,
): ActivityEntry[] {
  if (activeProjectId === null) return log.slice();
  return log.filter((e) => e.projectId === activeProjectId);
}

/** The human-readable verb for a feed row. */
export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  'session.started': 'started',
  'turn.finished': 'finished a turn',
  'session.done': 'done',
  'session.error': 'errored',
  'session.removed': 'removed',
  'agent.finished': 'agent finished',
  'agent.failed': 'agent failed',
};

/** Feed rows tint like the status they report. 'neutral' renders in --text-faint. */
export type ActivityTone = 'error' | 'success' | 'active' | 'neutral';

export function activityTone(kind: ActivityKind): ActivityTone {
  switch (kind) {
    case 'session.error':
    case 'agent.failed':
      return 'error';
    case 'session.done':
    case 'agent.finished':
      return 'success';
    case 'session.started':
    case 'turn.finished':
      return 'active';
    default:
      return 'neutral';
  }
}

/**
 * Which SessionStatus transitions mint a feed entry. Returns null when the change
 * is not worth recording — notably `→ running`, which happens on every prompt and
 * would drown the feed, and any no-op transition.
 */
export function statusTransitionKind(from: SessionStatus | undefined, to: SessionStatus): ActivityKind | null {
  if (from === to) return null;
  if (to === 'error') return 'session.error';
  if (to === 'done') return 'session.done';
  // Only a turn that was actually RUNNING can "finish" — a fresh session settling
  // into idle at creation is `session.started`, already recorded by session.meta.
  if (to === 'idle' && from === 'running') return 'turn.finished';
  return null;
}
