// code-editor-workspace FR-2/FR-3/FR-11/FR-12: the Code view's capture-phase chords.

import { describe, expect, it } from 'vitest';
import { codeChord } from './code-chords';

const ev = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, code = '') => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('codeChord', () => {
  it('reads ⌘ and Ctrl alike', () => {
    expect(codeChord(ev('s', { metaKey: true }))).toBe('save');
    expect(codeChord(ev('w', { ctrlKey: true }))).toBe('close');
    expect(codeChord(ev('p', { metaKey: true }))).toBe('quick-open');
  });

  it('⌘\\ splits, by key or by physical code', () => {
    expect(codeChord(ev('\\', { metaKey: true }))).toBe('split');
    expect(codeChord(ev('<', { ctrlKey: true }, 'Backslash'))).toBe('split');
  });

  it('⌘⇧F searches and ⌘⇧M toggles problems (shift upper-cases the key)', () => {
    expect(codeChord(ev('F', { metaKey: true, shiftKey: true }))).toBe('search');
    expect(codeChord(ev('M', { ctrlKey: true, shiftKey: true }))).toBe('problems');
    expect(codeChord(ev('S', { metaKey: true, shiftKey: true }))).toBeNull();
  });

  it('ignores bare keys and ⌥ chords (Monaco keeps ⌥⌘F)', () => {
    expect(codeChord(ev('s'))).toBeNull();
    expect(codeChord(ev('f', { metaKey: true, altKey: true }))).toBeNull();
    expect(codeChord(ev('f', { metaKey: true }))).toBeNull();
  });
});
