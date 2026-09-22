// The sidebar's project scope picker — the pure half. Redesign "Graphite &
// Signal", Figma "24 · Sidebar / Project scope picker" (134:4687; light frame
// 142:17085). Opened from the scope chips' `+N ▾`: a search field, then the
// projects in four tiers — PINNED (your pins, in pin order), ACTIVE NOW (a session
// is running or blocked on you), one tier per project group, and the rest —
// each row a state glyph, the name, its session count and a pin toggle.
// ProjectScopePicker.tsx renders it.
//
// Pins are window chrome, like the extension pins: cosmetic, reversible, kept
// in localStorage (src/lib/projectPinsStore.ts) — never written to the registry.

import type { SessionId, SessionMeta, SessionStatus } from '../../../contract/common';
import type { ProjectGroup, ProjectId, ProjectMeta } from '../../../contract/projects';

export type ScopeRowState = 'approval' | 'question' | 'running';

/** A row's session, for the "sessions in this project" flyout (name + glyph only). */
export interface ScopeRowSession {
  id: SessionId;
  name: string;
  status: SessionStatus;
}

export interface ScopeRow {
  id: ProjectId;
  name: string;
  /** Sessions in this project (any state). */
  count: number;
  /** The most urgent live state among its sessions, or null when all are settled. */
  state: ScopeRowState | null;
  /** The project's root is gone (ProjectMeta.rootExists false). */
  missing: boolean;
  pinned: boolean;
  /** Blocked-on-you/running first, then name — the order the flyout lists them in. */
  sessions: ScopeRowSession[];
}

export interface ScopeTier {
  key: string;
  label: string;
  rows: ScopeRow[];
}

export interface ScopePickerView {
  tiers: ScopeTier[];
  /** Rows cut by the row cap (the "N more · type to search" figure). 0 while searching. */
  hidden: number;
  /** Every registered project — the search field's `16 projects`. */
  total: number;
}

/** Rows shown before the rest fold into "N more · type to search". */
export const SCOPE_ROW_LIMIT = 10;

const LIVE: Partial<Record<SessionStatus, ScopeRowState>> = {
  awaiting_approval: 'approval',
  awaiting_input: 'question',
  running: 'running',
  starting: 'running',
};
/** Blocked on you outranks running: the glyph shows what most needs you. */
const STATE_RANK: Record<ScopeRowState, number> = { approval: 3, question: 2, running: 1 };

function liveState(sessions: readonly SessionMeta[]): ScopeRowState | null {
  let best: ScopeRowState | null = null;
  for (const s of sessions) {
    const state = LIVE[s.status];
    if (state && (!best || STATE_RANK[state] > STATE_RANK[best])) best = state;
  }
  return best;
}

/** Blocked-on-you/running first (ranked like `liveState`), then name — the
 *  flyout's own order, independent of the row's aggregate `state`. */
function orderRowSessions(sessions: readonly SessionMeta[]): ScopeRowSession[] {
  return sessions
    .slice()
    .sort((a, b) => {
      const rank = (s: SessionMeta) => (LIVE[s.status] ? STATE_RANK[LIVE[s.status]!] : 0);
      return rank(b) - rank(a) || a.name.localeCompare(b.name);
    })
    .map((s) => ({ id: s.id, name: s.name, status: s.status }));
}

const stateRank = (row: ScopeRow) => (row.state ? STATE_RANK[row.state] : 0);
const byCountThenName = (a: ScopeRow, b: ScopeRow) => b.count - a.count || a.name.localeCompare(b.name);

/** Case-insensitive substring match on the name; an empty query matches everything. */
export function matchesScopeQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || name.toLowerCase().includes(q);
}

export function projectScopeView(
  projects: readonly ProjectMeta[],
  groups: readonly ProjectGroup[],
  sessions: readonly SessionMeta[],
  pinnedIds: readonly ProjectId[],
  query: string,
  limit = SCOPE_ROW_LIMIT,
): ScopePickerView {
  const rows = projects
    .filter((p) => matchesScopeQuery(p.name, query))
    .map((p): ScopeRow => {
      const mine = sessions.filter((s) => s.projectId === p.id);
      return {
        id: p.id,
        name: p.name,
        count: mine.length,
        state: liveState(mine),
        missing: !p.rootExists,
        pinned: pinnedIds.includes(p.id),
        sessions: orderRowSessions(mine),
      };
    });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const placed = new Set<ProjectId>();
  const take = (list: ScopeRow[]) => {
    list.forEach((r) => placed.add(r.id));
    return list;
  };

  const tiers: ScopeTier[] = [];
  const pinned = take(pinnedIds.map((id) => byId.get(id)).filter((r): r is ScopeRow => r !== undefined));
  tiers.push({ key: 'pinned', label: 'Pinned', rows: pinned });

  const active = take(rows.filter((r) => !placed.has(r.id) && r.state !== null).sort((a, b) => stateRank(b) - stateRank(a) || byCountThenName(a, b)));
  tiers.push({ key: 'active', label: 'Active now', rows: active });

  const groupOf = new Map(projects.map((p) => [p.id, p.groupId]));
  for (const g of groups) {
    const members = take(rows.filter((r) => !placed.has(r.id) && groupOf.get(r.id) === g.id).sort(byCountThenName));
    tiers.push({ key: `group:${g.id}`, label: g.name, rows: members });
  }
  const rest = take(rows.filter((r) => !placed.has(r.id)).sort(byCountThenName));
  tiers.push({ key: 'rest', label: groups.length > 0 ? 'Other projects' : 'Projects', rows: rest });

  const nonEmpty = tiers.filter((t) => t.rows.length > 0);
  if (query.trim() !== '') return { tiers: nonEmpty, hidden: 0, total: projects.length };

  let budget = limit;
  let hidden = 0;
  const capped: ScopeTier[] = [];
  for (const tier of nonEmpty) {
    const shown = tier.rows.slice(0, Math.max(0, budget));
    hidden += tier.rows.length - shown.length;
    budget -= shown.length;
    if (shown.length > 0) capped.push({ ...tier, rows: shown });
  }
  return { tiers: capped, hidden, total: projects.length };
}

/** The rows top to bottom — the order ↑↓ walks. */
export function flattenScopeTiers(view: ScopePickerView): ScopeRow[] {
  return view.tiers.flatMap((t) => t.rows);
}

/**
 * Where a project row's session flyout sits: opens to the row's right, flipping to
 * its left when there is no room; its top tracks the row but is clamped inside the
 * window so a row near the bottom of the list doesn't run the flyout off-screen.
 */
export function scopeFlyoutPlacement(
  row: { left: number; right: number; top: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  gap = 4,
): { left: number; top: number } {
  const openRight = row.right + gap + size.width <= viewport.width;
  const left = openRight ? row.right + gap : Math.max(8, row.left - gap - size.width);
  const top = Math.min(Math.max(8, row.top), Math.max(8, viewport.height - size.height - 8));
  return { left, top };
}
