import { describe, expect, it } from 'vitest';
import { abbreviate } from './path';

describe('abbreviate', () => {
  it('returns "" for an empty cwd', () => {
    expect(abbreviate('', '/home/u')).toBe('');
  });

  it('returns "" for an empty cwd even with an empty home (the Sidebar.tsx edge case)', () => {
    expect(abbreviate('', '')).toBe('');
  });

  it('abbreviates an exact home match to ~', () => {
    expect(abbreviate('/home/u', '/home/u')).toBe('~');
  });

  it('abbreviates a path under home (forward slash)', () => {
    expect(abbreviate('/home/u/projects/api', '/home/u')).toBe('~/projects/api');
  });

  it('abbreviates a path under home (backslash, Windows)', () => {
    expect(abbreviate('C:\\Users\\u\\projects\\api', 'C:\\Users\\u')).toBe('~\\projects\\api');
  });

  it('leaves a path outside home unchanged', () => {
    expect(abbreviate('/var/data', '/home/u')).toBe('/var/data');
  });

  it('does not abbreviate a sibling that merely shares a prefix', () => {
    expect(abbreviate('/home/user2/x', '/home/user')).toBe('/home/user2/x');
  });

  it('leaves cwd unchanged when home is empty (no home resolved yet)', () => {
    expect(abbreviate('/home/u/projects', '')).toBe('/home/u/projects');
  });
});
