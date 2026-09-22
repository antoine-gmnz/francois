// The roster's project scope chips — redesign "Graphite & Signal", Figma
// "Sidebar / Sessions" 127:28, "Project scope": `All 20 · orbit 5 · docs 1 · +13`.
// "Scope chips cap at 3 + overflow": All, then up to `max` projects, then the
// overflow chip that opens the full project menu. Pure — ScopeChips.tsx renders it.

import type { SessionMeta } from '../../../contract/common';
import { statusNeedsAttention } from '../../../contract/fleet-board';
import type { ProjectId, ProjectMeta } from '../../../contract/projects';

export interface ScopeChip {
  id: ProjectId;
  name: string;
  count: number;
  /** A session in this project is blocked on you (an approval or a question). */
  attention: boolean;
}

export interface ScopeChipsView {
  /** Every session — the All chip's figure. */
  total: number;
  chips: ScopeChip[];
  /** Registered projects NOT shown as a chip (the `+N` figure). */
  overflow: number;
}

/**
 * Projects with sessions, busiest first (ties by name), capped at `max` — with
 * the active project always among them so the selected scope is never hidden
 * behind `+N`. Pinned projects (the scope picker's PINNED tier, in pin order)
 * come before the busiest, sessions or not: a pin is a request to keep it in
 * reach. Any other project with no sessions only shows when it is the active one.
 */
export function scopeChips(
  projects: readonly ProjectMeta[],
  sessions: readonly SessionMeta[],
  activeProjectId: ProjectId | null,
  max: number,
  pinnedIds: readonly ProjectId[] = [],
): ScopeChipsView {
  const all: ScopeChip[] = projects.map((project) => {
    const mine = sessions.filter((s) => s.projectId === project.id);
    return {
      id: project.id,
      name: project.name,
      count: mine.length,
      attention: mine.some((s) => statusNeedsAttention(s.status)),
    };
  });
  const pinned = pinnedIds
    .map((id) => all.find((c) => c.id === id))
    .filter((c): c is ScopeChip => c !== undefined && c.id !== activeProjectId);
  const busiest = all
    .filter((c) => c.count > 0 && c.id !== activeProjectId && !pinnedIds.includes(c.id))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const ranked = [...pinned, ...busiest];
  const active = all.find((c) => c.id === activeProjectId) ?? null;
  const chips = active ? [active, ...ranked.slice(0, Math.max(0, max - 1))] : ranked.slice(0, max);
  return { total: sessions.length, chips, overflow: projects.length - chips.length };
}
