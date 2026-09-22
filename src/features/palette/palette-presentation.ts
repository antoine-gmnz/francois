// The palette's presentation layer — redesign "Graphite & Signal", Figma
// "10 · Command palette" (136:5213). The registry contract (contract/
// command-palette.ts) carries one unicode `glyph` per command and nothing about
// grouping, and the contract is not ours to widen for a visual change — so the
// icon, the section and the keycap each command wears are looked up here, by id.
// A command this table does not know still renders: a generic icon, under
// "Commands".
//
// Pure: PaletteView renders what `paletteSections` returns, and the keyboard
// cursor walks the same flat order the sections list, so what you see and what
// ↑↓ steps through cannot disagree.

import type { IconName } from '../../ui/icons';

export type PaletteSectionId = 'best' | 'session' | 'goto' | 'app' | 'other';

export const PALETTE_SECTION_LABEL: Record<PaletteSectionId, string> = {
  best: 'Best match',
  session: 'Session',
  goto: 'Go to',
  app: 'App',
  other: 'Commands',
};

/** Section order when nothing is typed (and after Best match when something is). */
const SECTION_ORDER: readonly PaletteSectionId[] = ['session', 'goto', 'app', 'other'];

interface CommandLook {
  icon: IconName;
  section: Exclude<PaletteSectionId, 'best'>;
  /** The single-key shortcut that does the same thing outside the palette (appShell.ts). */
  keycap?: string;
}

const LOOK: Record<string, CommandLook> = {
  'new-session': { icon: 'plus', section: 'session', keycap: 'N' },
  'new-session-with-profile': { icon: 'plus', section: 'session' },
  'new-session-worktree': { icon: 'branch', section: 'session' },
  'adopt-cloud-session': { icon: 'cloud', section: 'session' },
  'session-settings': { icon: 'cog', section: 'session' },
  'switch-model': { icon: 'refresh', section: 'session' },
  'attach-mcp-server': { icon: 'plug', section: 'session' },
  'run-skill': { icon: 'spark', section: 'session' },
  'compact-context': { icon: 'layers', section: 'session' },
  'new-agent': { icon: 'agent', section: 'session', keycap: 'A' },
  'kill-agent': { icon: 'stop', section: 'session' },
  'clear-project-attachments': { icon: 'trash', section: 'session' },
  'shell-new': { icon: 'terminal', section: 'session' },
  'open-shell-pane': { icon: 'terminal', section: 'session' },
  'shell-next': { icon: 'arrow-right', section: 'session' },
  'shell-rename': { icon: 'edit', section: 'session' },
  'shell-close': { icon: 'x', section: 'session' },
  'view-overview': { icon: 'activity', section: 'goto', keycap: 'O' },
  'view-diff': { icon: 'branch', section: 'goto', keycap: 'D' },
  'open-agents-panel': { icon: 'agents', section: 'goto', keycap: '3' },
  'open-mcp-panel': { icon: 'plug', section: 'goto', keycap: '4' },
  'open-skills-panel': { icon: 'spark', section: 'goto', keycap: '5' },
  'open-workflows-panel': { icon: 'flow', section: 'goto', keycap: '6' },
  'manage-projects': { icon: 'folder', section: 'goto' },
  'manage-profiles': { icon: 'doc', section: 'goto' },
  'manage-accounts': { icon: 'key', section: 'goto' },
  'manage-permissions': { icon: 'lock', section: 'goto' },
  'manage-extensions': { icon: 'layout-4', section: 'goto' },
  'toggle-sessions-column': { icon: 'panel-left', section: 'app', keycap: '[' },
  'toggle-theme': { icon: 'moon', section: 'app' },
  'add-account': { icon: 'plus', section: 'app' },
  'refresh-usage': { icon: 'refresh', section: 'app' },
  'check-for-updates': { icon: 'arrow-up', section: 'app' },
  'toggle-notify-attention': { icon: 'comment', section: 'app' },
  'toggle-notify-turn-done': { icon: 'comment', section: 'app' },
  'toggle-sound': { icon: 'info', section: 'app' },
};

const FALLBACK: CommandLook = { icon: 'command', section: 'other' };

export function commandLook(id: string): CommandLook {
  return LOOK[id] ?? FALLBACK;
}

/** How many of the top-ranked results sit under "Best match" once a query is typed. */
export const BEST_MATCH_COUNT = 2;

export interface PaletteSection<T> {
  id: PaletteSectionId;
  label: string;
  items: T[];
}

/**
 * Group an already-filtered, already-ranked list into sections.
 *
 * - No query: every command under its own section, sections in a fixed order,
 *   registration order inside each (the ranking IS registration order then).
 * - A query: the top `BEST_MATCH_COUNT` results first under "Best match", the rest
 *   in their sections — rank order kept inside each, so the strongest match of a
 *   section still leads it.
 *
 * Empty sections are dropped.
 */
export function paletteSections<T>(ranked: readonly T[], query: string, idOf: (t: T) => string): PaletteSection<T>[] {
  const best = query.trim() === '' ? [] : ranked.slice(0, BEST_MATCH_COUNT);
  const rest = ranked.slice(best.length);
  const sections: PaletteSection<T>[] = [];
  if (best.length > 0) sections.push({ id: 'best', label: PALETTE_SECTION_LABEL.best, items: best });
  for (const id of SECTION_ORDER) {
    const items = rest.filter((item) => commandLook(idOf(item)).section === id);
    if (items.length > 0) sections.push({ id, label: PALETTE_SECTION_LABEL[id], items });
  }
  return sections;
}

/** The sections' items, top to bottom — the order ↑↓ walks and `selectedIndex` indexes. */
export function flattenSections<T>(sections: readonly PaletteSection<T>[]): T[] {
  return sections.flatMap((s) => s.items);
}
