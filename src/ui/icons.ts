// The Graphite icon set — the Figma "Components / Icons" frame (125:2), exported
// verbatim into src/assets/icons/<name>.svg (the seven session-state glyphs as
// state-<kind>.svg). Rendered by <Icon name="…" /> / <StateIcon /> as a CSS mask
// (icons.css), so a glyph always takes `currentColor` and follows the theme;
// never recolour one with a prop. To add an icon: export it from Figma into
// src/assets/icons/ and add its name here (icons.test.ts checks the file exists).
// Prefer this set over lucide-react for anything the design draws; lucide stays
// for glyphs the set does not cover.

export const ICON_NAMES = [
  'activity',
  'agent',
  'agents',
  'arrow-right',
  'arrow-up',
  'attach',
  'back',
  'branch',
  'check',
  'chevron-down',
  'chevron-right',
  'clock',
  'cloud',
  'cog',
  'command',
  'comment',
  'doc',
  'dots',
  'edit',
  'external',
  'file',
  'flow',
  'folder',
  'info',
  'key',
  'layers',
  'layout-1',
  'layout-2',
  'layout-4',
  'lock',
  'maximize',
  'moon',
  'panel-left',
  'panel-right',
  'pin',
  'plan',
  'plug',
  'plus',
  'refresh',
  'remote',
  'search',
  'spark',
  'stop',
  'sun',
  'terminal',
  'trash',
  'warn',
  'x',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** Every exported asset's URL, by file name (`search.svg` → `/assets/search-<hash>.svg`). */
const URLS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../assets/icons/*.svg', { query: '?url', import: 'default', eager: true })).map(
    ([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url],
  ),
);

/** The asset URL for an icon or a `state-<kind>` glyph; '' if the file is missing. */
export function iconAssetUrl(file: string): string {
  return URLS[`${file}.svg`] ?? '';
}
