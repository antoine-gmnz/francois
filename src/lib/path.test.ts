import { describe, expect, it } from 'vitest';
import { abbreviate, basename, inRoot, joinRoot, normPath, pathKey, relativeTo } from './path';

describe('basename', () => {
  it('takes the last segment of a POSIX path', () => {
    expect(basename('/home/u/shots/a.png')).toBe('a.png');
  });

  it('takes the last segment of a Windows path', () => {
    expect(basename('C:\\repo\\docs\\report.pdf')).toBe('report.pdf');
  });

  it('ignores a trailing separator (a dropped folder)', () => {
    expect(basename('/home/u/src/')).toBe('src');
  });

  it('returns a bare name unchanged', () => {
    expect(basename('a.png')).toBe('a.png');
  });

  it('returns "" for an empty path', () => {
    expect(basename('')).toBe('');
  });
});

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

// code-editor-agents FR-2: the frontend twin of the core's path normaliser. The
// core's helper (editor_files.rootDir, file.touched.path) must match these vectors.

describe('normPath (code-editor-agents FR-2)', () => {
  it.each([
    ['C:\\Users\\me\\repo', 'C:/Users/me/repo'],
    ['c:\\Users\\me\\repo\\', 'C:/Users/me/repo'],
    ['d:/work/', 'D:/work'],
    ['C:\\', 'C:'],
    ['e:/Repo/Src', 'E:/Repo/Src'],
    ['\\\\wsl.localhost\\Ubuntu\\home\\u\\api', '//wsl.localhost/Ubuntu/home/u/api'],
    ['/home/me/repo/', '/home/me/repo'],
    ['/home/me/repo//', '/home/me/repo'],
    ['/', '/'],
    ['\\\\wsl$\\Ubuntu\\home\\me', '//wsl$/Ubuntu/home/me'],
    ['', ''],
  ])('%s → %s', (input, out) => {
    expect(normPath(input)).toBe(out);
  });
});

describe('pathKey / inRoot / relativeTo (FR-2)', () => {
  it('compares drive-letter paths case-insensitively, POSIX paths case-sensitively', () => {
    expect(pathKey('C:/Repo/Src/A.ts')).toBe(pathKey('c:\\repo\\src\\a.ts'));
    expect(pathKey('/home/A')).not.toBe(pathKey('/home/a'));
  });

  it('is in a root when it starts with rootDir + "/"', () => {
    expect(inRoot('/r/src/a.ts', '/r')).toBe(true);
    expect(inRoot('/rr/a.ts', '/r')).toBe(false);
    expect(inRoot('/r', '/r')).toBe(false);
    expect(inRoot('C:/Repo/a.ts', 'c:/repo')).toBe(true);
    expect(inRoot('/R/a.ts', '/r')).toBe(false);
  });

  it('relativises inside the root and returns null outside it', () => {
    expect(relativeTo('/r/src/a.ts', '/r')).toBe('src/a.ts');
    expect(relativeTo('C:/Repo/src/a.ts', 'c:\\repo\\')).toBe('src/a.ts');
    expect(relativeTo('/elsewhere/a.ts', '/r')).toBeNull();
  });
});

describe('joinRoot', () => {
  it('joins under a root, a drive root and the filesystem root', () => {
    expect(joinRoot('/r', 'a.ts')).toBe('/r/a.ts');
    expect(joinRoot('C:', 'a.ts')).toBe('C:/a.ts');
    expect(joinRoot('/', 'a.ts')).toBe('/a.ts');
  });
});
