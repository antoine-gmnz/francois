// The icon set is the Figma "Components / Icons" frame (125:2) exported verbatim
// into src/assets/icons/. Every name the Icon primitive accepts — and every
// state glyph StateIcon draws — must resolve to a file; a missing one renders as
// an empty box.
import { describe, expect, it } from 'vitest';
import { iconAssetUrl, ICON_NAMES } from './icons';
import { STATE_KINDS } from './state-kind';

describe('icon set', () => {
  it('every icon name resolves to an exported svg', () => {
    for (const name of ICON_NAMES) expect(iconAssetUrl(name), name).toMatch(/\.svg/);
  });

  it('every state kind resolves to its state-<kind> svg', () => {
    for (const kind of STATE_KINDS) expect(iconAssetUrl(`state-${kind}`), kind).toMatch(/state-.*\.svg/);
  });

  it('an unknown file resolves to nothing rather than throwing', () => {
    expect(iconAssetUrl('does-not-exist')).toBe('');
  });

  it('names are unique', () => {
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });
});
