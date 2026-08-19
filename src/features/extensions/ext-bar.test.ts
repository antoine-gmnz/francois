// design 11a — "pinned tabs, menu behind ◈". The pure half: which extensions earn
// a tab in the bar, what each row's tile and sub-line say, and how the pin set
// survives a restart.

import { describe, expect, it } from 'vitest';
import type { ExtensionInfo } from '../../../contract/extensions';
import {
  EXT_TILE_HUES,
  barExtensions,
  enabledCount,
  extRowDetail,
  extSourceLabel,
  extTileHue,
  extTileInitials,
  parsePinnedExtensions,
  togglePinned,
} from './ext-bar';

function ext(over: Partial<ExtensionInfo> & { id: string }): ExtensionInfo {
  return {
    label: over.id,
    enabled: true,
    consent: { state: 'granted' },
    detected: true,
    undetectedReason: null,
    minVersionLabel: null,
    source: { dir: `/home/me/.francois/extensions/${over.id}`, manifestSha256: 'x', declaredCommands: [] },
    predicate: { kind: 'pathExists', path: '.' },
    panels: [],
    manifestError: null,
    ...over,
  };
}

describe('barExtensions', () => {
  const list = [
    ext({ id: 'security-review', label: 'Security review' }),
    ext({ id: 'dataviz', label: 'Dataviz' }),
    ext({ id: 'pdf-tools', label: 'PDF tools', enabled: false }),
    ext({ id: 'trace', label: 'Trace viewer', detected: false }),
  ];

  it('gives a tab only to pinned extensions, in registry order', () => {
    expect(barExtensions(list, ['dataviz', 'security-review'], [], null).map((e) => e.id)).toEqual([
      'security-review',
      'dataviz',
    ]);
  });

  it('never gives a tab to a disabled extension, pinned or not', () => {
    // "The tab cannot exist without the extension, so one switch removes both."
    expect(barExtensions(list, ['pdf-tools'], [], null)).toEqual([]);
  });

  it('never gives a tab to an undetected extension unless a tab is already sticky', () => {
    expect(barExtensions(list, ['trace'], [], null)).toEqual([]);
    expect(barExtensions(list, ['trace'], ['trace'], null).map((e) => e.id)).toEqual(['trace']);
  });

  it('always shows the OPEN extension, pinned or not — you cannot lose your place', () => {
    expect(barExtensions(list, [], [], 'dataviz').map((e) => e.id)).toEqual(['dataviz']);
    expect(barExtensions(list, ['security-review'], [], 'dataviz').map((e) => e.id)).toEqual([
      'security-review',
      'dataviz',
    ]);
  });

  it('does not resurrect a disabled extension just because its tab was open', () => {
    expect(barExtensions(list, [], [], 'pdf-tools')).toEqual([]);
  });

  it('lists an extension once even when it is both pinned and open', () => {
    expect(barExtensions(list, ['dataviz'], [], 'dataviz').map((e) => e.id)).toEqual(['dataviz']);
  });
});

describe('the tile', () => {
  it('takes one letter from each of the first two words', () => {
    expect(extTileInitials('Security review')).toBe('SR');
    expect(extTileInitials('PDF tools')).toBe('PT');
  });

  it('takes the first two letters of a single word', () => {
    expect(extTileInitials('Dataviz')).toBe('DA');
  });

  it('never renders empty, whatever the manifest called itself', () => {
    expect(extTileInitials('')).toBe('??');
    expect(extTileInitials('   ')).toBe('??');
    expect(extTileInitials('x')).toBe('X');
  });

  it('picks a hue from the id, so a tile keeps its colour across restarts', () => {
    expect(extTileHue('security-review')).toBe(extTileHue('security-review'));
    expect(EXT_TILE_HUES).toContain(extTileHue('security-review'));
    expect(EXT_TILE_HUES).toContain(extTileHue(''));
  });
});

describe('the menu row copy', () => {
  it('names the source directory, not the absolute path', () => {
    expect(extSourceLabel(ext({ id: 'security-review' }))).toBe('security-review');
  });

  it('counts the tabs an enabled extension contributes', () => {
    const e = ext({ id: 'sr', label: 'Security review', panels: [{ id: 'sr:a' }, { id: 'sr:b' }] as never });
    expect(extRowDetail(e)).toBe('sr · 2 panels');
  });

  it('says `off` instead of a count for a disabled extension', () => {
    expect(extRowDetail(ext({ id: 'pdf', enabled: false, panels: [{ id: 'pdf:a' }] as never }))).toBe('pdf · off');
  });

  it('says so when an enabled extension contributes nothing to look at', () => {
    expect(extRowDetail(ext({ id: 'sr' }))).toBe('sr · no panels');
  });

  it('counts what the ◈ header badge shows', () => {
    expect(enabledCount([ext({ id: 'a' }), ext({ id: 'b' }), ext({ id: 'c', enabled: false })])).toBe(2);
  });
});

describe('the pin set', () => {
  it('round-trips through the persisted form', () => {
    expect(parsePinnedExtensions(JSON.stringify(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('degrades to nothing pinned for anything malformed', () => {
    expect(parsePinnedExtensions(null)).toEqual([]);
    expect(parsePinnedExtensions('')).toEqual([]);
    expect(parsePinnedExtensions('{')).toEqual([]);
    expect(parsePinnedExtensions('{"a":1}')).toEqual([]);
    expect(parsePinnedExtensions(JSON.stringify(['a', 3, null, 'b']))).toEqual(['a', 'b']);
    expect(parsePinnedExtensions(JSON.stringify(['a', 'a']))).toEqual(['a']);
  });

  it('toggles a single id without disturbing the rest', () => {
    expect(togglePinned(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(togglePinned(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(togglePinned([], 'a')).toEqual(['a']);
  });
});
