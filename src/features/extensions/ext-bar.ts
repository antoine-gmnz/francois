// design 11a ("pinned tabs, menu behind ◈") — the pure half of the extensions
// entry point in the session row.
//
// Two different jobs share one control, and 11a's whole argument is that they must
// not share one WEIGHT: going to an extension's tab is frequent and one click,
// while turning an extension on or off is rare, deliberate, and dangerous enough
// — hooks, MCP servers and skills come with it — that it must never be a stray
// click next to a tab. So the bar carries pinned tabs, and `◈` carries the
// switches; the pin is cosmetic and reversible, the switch is the extension.
//
// The pin lives here rather than in the core because it is a property of THIS
// window's chrome, not of the extension: two machines sharing a manifest should
// not share a decision about how much bar width it deserves.

import type { ExtensionId, ExtensionInfo } from '../../../contract/extensions';
import { sanitizeForDisplay, visibleExtensions } from './extensions';

/**
 * The tile hues, as token names. A tile is an identity mark, not a status — so it
 * never draws from the accent/attention/error families, which in this chrome mean
 * "the live thing", "come here" and "this broke".
 */
export const EXT_TILE_HUES = ['purple', 'teal', 'blue', 'slate', 'clay'] as const;
export type ExtTileHue = (typeof EXT_TILE_HUES)[number];

/**
 * Which extensions earn a tab in the bar, in registry order.
 *
 * `available` is the pre-existing rule and still outranks everything: enabled, and
 * either detected for this root or already opened in this run (FR-8/FR-11/FR-13).
 * 11a adds the pin on top of it — and one exception to the pin, the extension whose
 * tab is currently OPEN. Without that exception, opening a tab from the `◈` menu
 * would leave you on a tab with nothing in the bar pointing at it.
 */
export function barExtensions(
  list: readonly ExtensionInfo[],
  pinned: readonly ExtensionId[],
  sticky: readonly string[],
  activeId: ExtensionId | null,
): ExtensionInfo[] {
  const pins = new Set(pinned);
  return visibleExtensions(list, sticky).filter((e) => pins.has(e.id) || e.id === activeId);
}

/** The `2 on` badge in the `◈` menu header. Counts the switch, not the pin. */
export function enabledCount(list: readonly ExtensionInfo[]): number {
  return list.filter((e) => e.enabled).length;
}

/**
 * `SR`, `DV`, `PD` — one letter per word for a two-word name, the first two for a
 * one-word one. Always two glyphs, and never empty: a manifest that named itself
 * with punctuation still gets a tile rather than a hole in the row.
 */
export function extTileInitials(label: string): string {
  const words = sanitizeForDisplay(label)
    .split(/[\s._-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * A stable hue for an id — same extension, same colour, every launch. Derived from
 * the id rather than the label so renaming an extension does not move its tile
 * colour out from under the muscle memory it just built.
 */
export function extTileHue(id: string): ExtTileHue {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return EXT_TILE_HUES[h % EXT_TILE_HUES.length]!;
}

/** The directory the manifest was loaded from — the mock's `security@anthropic` slot. */
export function extSourceLabel(e: ExtensionInfo): string {
  const dir = e.source?.dir ?? '';
  const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? e.id;
  return sanitizeForDisplay(name);
}

/**
 * The row's second line. A disabled extension says `off` rather than a panel count:
 * the count describes what it WOULD contribute, and reading it next to a dark
 * switch is how you end up believing the tabs are there.
 */
export function extRowDetail(e: ExtensionInfo): string {
  const source = extSourceLabel(e);
  if (!e.enabled) return `${source} · off`;
  const n = e.panels.length;
  if (n === 0) return `${source} · no panels`;
  return `${source} · ${n} panel${n === 1 ? '' : 's'}`;
}

// ---------- the persisted pin set ----------

/**
 * Whatever came out of localStorage, normalised. Anything that is not an array of
 * non-empty strings degrades to "nothing pinned" rather than throwing — a pin set
 * is a preference, and a corrupt one must never be able to stop the chrome from
 * rendering. Duplicates collapse so a hand-edited value cannot draw a tab twice.
 */
export function parsePinnedExtensions(raw: string | null): ExtensionId[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v === 'string' && v.trim() && !out.includes(v)) out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

/** Pin an unpinned id (appending, so the bar order is the order you pinned in) or unpin it. */
export function togglePinned(pinned: readonly ExtensionId[], id: ExtensionId): ExtensionId[] {
  return pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id];
}

/**
 * The number `◈` carries beside its glyph, or null for none.
 *
 * A bare diamond next to the view segment is a mystery: same fill, same 26px, no
 * caret — it reads as a fourth view rather than as the plugin surface. When tabs
 * ARE in the bar they answer "what is behind this"; when none are (nothing pinned,
 * nothing open — the common case for a fresh install) the count answers it instead.
 * Zero installed stays null: `◈ 0` advertises an emptiness the menu already
 * explains, and the glyph still opens to the install path.
 */
export function extGlyphCount(tabsShown: number, installed: number): number | null {
  return tabsShown === 0 && installed > 0 ? installed : null;
}
