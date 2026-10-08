import { describe, expect, it } from 'vitest';
import { decideOnChange, detectIndent, indentLabel, minimalChange, staleVersion } from './editor-sync';
import { tab } from './code.testutil';

describe('decideOnChange (FR-12)', () => {
  it('ignores the echo of our own save (same version)', () => {
    expect(decideOnChange(tab('a.ts', { version: 'v2' }), 'v2')).toBe('ignore');
  });
  it('reloads a clean buffer', () => {
    expect(decideOnChange(tab('a.ts', { version: 'v1' }), 'v2')).toBe('reload');
  });
  it('raises the conflict bar on a dirty buffer', () => {
    expect(decideOnChange(tab('a.ts', { dirty: true }), 'v2')).toBe('conflict');
  });
  it('does not re-raise a conflict already open for that disk version', () => {
    expect(decideOnChange(tab('a.ts', { dirty: true, conflict: { version: 'v2' } }), 'v2')).toBe('ignore');
  });
  it('moves an open conflict to the newer disk version', () => {
    expect(decideOnChange(tab('a.ts', { dirty: true, conflict: { version: 'v2' } }), 'v3')).toBe('conflict');
  });
});

describe('minimalChange', () => {
  it('is null for identical text', () => {
    expect(minimalChange('abc', 'abc')).toBeNull();
  });
  it('spans only the differing middle', () => {
    expect(minimalChange('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' });
    expect(minimalChange('one two three', 'one 2 three')).toEqual({ from: 4, to: 7, insert: '2' });
  });
  it('handles a full replacement and a deletion', () => {
    expect(minimalChange('abc', 'xyz')).toEqual({ from: 0, to: 3, insert: 'xyz' });
    expect(minimalChange('abcdef', 'abef')).toEqual({ from: 2, to: 4, insert: '' });
  });
  it('does not let prefix and suffix overlap', () => {
    expect(minimalChange('aa', 'aaa')).toEqual({ from: 2, to: 2, insert: 'a' });
  });
});

describe('detectIndent (FR-10)', () => {
  it('detects tabs', () => {
    expect(detectIndent('a\n\tb\n\t\tc\n\td\n')).toBe('\t');
  });
  it('detects two and four spaces from the dominant step', () => {
    expect(detectIndent('a\n  b\n    c\n  d\n')).toBe('  ');
    expect(detectIndent('a\n    b\n        c\n    d\n')).toBe('    ');
  });
  it('falls back to two spaces when there is no indentation', () => {
    expect(detectIndent('a\nb\n')).toBe('  ');
  });
});

describe('indentLabel (FR-10)', () => {
  it('reads Tabs or Spaces: n', () => {
    expect(indentLabel('\t')).toBe('Tabs');
    expect(indentLabel('    ')).toBe('Spaces: 4');
  });
});

describe('staleVersion (FR-11)', () => {
  it('reads the disk version off an EDITOR_STALE error', () => {
    expect(staleVersion({ code: 'EDITOR_STALE', message: 'x', detail: { version: 'v9' } })).toBe('v9');
  });
  it('is null for any other error or a malformed detail', () => {
    expect(staleVersion({ code: 'INTERNAL', message: 'x', detail: { version: 'v9' } })).toBeNull();
    expect(staleVersion({ code: 'EDITOR_STALE', message: 'x' })).toBeNull();
  });
});
