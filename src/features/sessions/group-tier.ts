// roster-group-tier: the innermost tier inside every state band of the pane [1]
// roster — sessions clustered by their project's hand-assigned GROUP (`ODO`,
// `Perso`, `elsewhere`). Paint only: the grouping data (`ProjectGroup`,
// `ProjectMeta.groupId`) already crosses the boundary via project-groups; this
// module just resolves it per session and buckets it per band, mirroring the
// shape of state-groups.ts (a node list, a flatten contribution, its own
// collapse record).
//
// design 12b regrouped the roster by STATE and deleted the tier that painted
// groups — this feature restores it, nested inside every state band rather
// than replacing it.

import type { SessionMeta } from '../../../contract/common';
import type { ProjectGroup, ProjectMeta } from '../../../contract/projects';
import type { RosterStateNode } from './state-groups';

/** FR-2. `group:<groupId>` | `group:none`. */
export const UNGROUPED_TIER_KEY = 'group:none';
/** Matches roster-groups.ts's UNGROUPED_LABEL — the same word for the same idea. */
export const UNGROUPED_TIER_LABEL = 'elsewhere';

/**
 * FR-1: total over any session. A miss at ANY hop — no projectId, project not
 * (yet) in the registry, no groupId, or a groupId naming a group the registry
 * no longer has — resolves to the ungrouped tier. Never throws, never
 * `undefined`.
 */
export function tierOf(
  session: SessionMeta,
  projects: readonly ProjectMeta[],
  groups: readonly ProjectGroup[],
): { key: string; label: string } {
  if (session.projectId !== undefined) {
    const project = projects.find((p) => p.id === session.projectId);
    if (project?.groupId !== undefined) {
      const group = groups.find((g) => g.id === project.groupId);
      if (group) return { key: `group:${group.id}`, label: group.name };
    }
  }
  return { key: UNGROUPED_TIER_KEY, label: UNGROUPED_TIER_LABEL };
}

export interface RosterGroupTier {
  /** FR-9. `gtier:<stateKey>:<groupKey>` — the collapse slot. */
  key: string;
  /** FR-2. `group:<groupId>` | `group:none`. */
  groupKey: string;
  label: string;
  sessions: SessionMeta[];
}

/**
 * FR-3 ordering: group name, case-insensitive ascending, ties broken by
 * groupKey ascending; `group:none` is always last regardless of name.
 */
function sortTiers(tiers: readonly RosterGroupTier[]): RosterGroupTier[] {
  return [...tiers].sort((a, b) => {
    if (a.groupKey === UNGROUPED_TIER_KEY) return b.groupKey === UNGROUPED_TIER_KEY ? 0 : 1;
    if (b.groupKey === UNGROUPED_TIER_KEY) return -1;
    const an = a.label.toLowerCase();
    const bn = b.label.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0;
  });
}

/**
 * FR-3/FR-4/FR-6/FR-7. Buckets `node.sessions` by tier (FR-5: sessions keep
 * their incoming order inside a tier — no second sort). Returns `null` when
 * the band resolves to a single tier — including a single group AND a single
 * "everyone ungrouped" tier (FR-7, no exception) — so the caller paints
 * `node.sessions` flat instead.
 */
export function groupTiersOf(
  node: RosterStateNode,
  projects: readonly ProjectMeta[],
  groups: readonly ProjectGroup[],
): RosterGroupTier[] | null {
  const byGroupKey = new Map<string, RosterGroupTier>();
  for (const session of node.sessions) {
    const { key: groupKey, label } = tierOf(session, projects, groups);
    let tier = byGroupKey.get(groupKey);
    if (!tier) {
      tier = { key: `gtier:${node.key}:${groupKey}`, groupKey, label, sessions: [] };
      byGroupKey.set(groupKey, tier);
    }
    tier.sessions.push(session);
  }
  if (byGroupKey.size <= 1) return null;
  return sortTiers([...byGroupKey.values()]);
}

/** Attaches FR-7-aware tiers to each band, for both the painter and the flatten. */
export function withGroupTiers(
  nodes: readonly RosterStateNode[],
  projects: readonly ProjectMeta[],
  groups: readonly ProjectGroup[],
): RosterStateNode[] {
  return nodes.map((node) => ({ ...node, tiers: groupTiersOf(node, projects, groups) }));
}

// ---------- collapse record (localStorage, its own key space — FR-10/FR-11) ----------

export const COLLAPSED_TIERS_KEY = 'francois.collapsedRosterGroupTiers';

/** Pure, exported for tests: default is EXPANDED — the record is a plain set
 *  of collapsed slots, absence means expanded, malformed input degrades to
 *  empty (FR-10/FR-11). */
export function parseCollapsedTiers(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

export function loadCollapsedTiers(): Set<string> {
  try {
    return parseCollapsedTiers(localStorage.getItem(COLLAPSED_TIERS_KEY));
  } catch {
    return new Set();
  }
}

export function persistCollapsedTiers(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_TIERS_KEY, JSON.stringify([...keys]));
  } catch {
    /* ignore — FR-11: reads and writes never throw out of the module */
  }
}
