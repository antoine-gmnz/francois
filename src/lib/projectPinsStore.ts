// Project pins — the sidebar scope picker's PINNED tier (redesign "Graphite &
// Signal", Figma 134:4687). Window chrome, not project state: cosmetic and
// reversible, so it persists to localStorage like the extension pins, and is
// never written to the project registry.

import { create } from 'zustand';
import type { ProjectId } from '../../contract/projects';

const STORAGE_KEY = 'francois.projectPins';

/** Tolerant parse of the stored pin list: unknown shapes → [], duplicates and blanks dropped. */
export function parseProjectPins(raw: string | null): ProjectId[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ProjectId[] = [];
    for (const v of parsed) if (typeof v === 'string' && v.trim() && !out.includes(v)) out.push(v);
    return out;
  } catch {
    return [];
  }
}

/** Pin appends (pin order is display order); unpin removes. */
export function toggleProjectPin(pins: readonly ProjectId[], id: ProjectId): ProjectId[] {
  return pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
}

function load(): ProjectId[] {
  try {
    return parseProjectPins(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function save(ids: ProjectId[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // storage unavailable (private mode / tests) — the pin still holds for this run
  }
}

interface ProjectPinsState {
  pinnedProjectIds: ProjectId[];
  toggleProjectPin: (id: ProjectId) => void;
}

export const useProjectPins = create<ProjectPinsState>((set) => ({
  pinnedProjectIds: load(),
  toggleProjectPin: (id) =>
    set((s) => {
      const next = toggleProjectPin(s.pinnedProjectIds, id);
      save(next);
      return { pinnedProjectIds: next };
    }),
}));
