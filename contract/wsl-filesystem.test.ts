import { describe, it, expect } from 'vitest';
import { displayWslCwd, isWslUncPath, wslUncToLinux } from './wsl-filesystem';

describe('isWslUncPath', () => {
  it('recognizes both WSL UNC prefixes', () => {
    expect(isWslUncPath('\\\\wsl$\\Ubuntu\\home\\u\\api')).toBe(true);
    expect(isWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\u')).toBe(true);
  });
  it('is case-insensitive on the prefix and tolerates forward slashes', () => {
    expect(isWslUncPath('\\\\WSL$\\Ubuntu')).toBe(true);
    expect(isWslUncPath('\\\\Wsl.LocalHost\\Debian\\srv')).toBe(true);
    expect(isWslUncPath('//wsl$/Ubuntu/home/u')).toBe(true);
  });
  it('requires a distro segment', () => {
    expect(isWslUncPath('\\\\wsl$\\')).toBe(false);
    expect(isWslUncPath('\\\\wsl$')).toBe(false);
  });
  it('rejects non-WSL paths', () => {
    expect(isWslUncPath('D:\\francois')).toBe(false);
    expect(isWslUncPath('C:\\Users\\u\\wsl$\\trick')).toBe(false);
    expect(isWslUncPath('\\\\server\\share\\repo')).toBe(false);
    expect(isWslUncPath('/mnt/c/Users/u')).toBe(false);
    expect(isWslUncPath('/home/u/api')).toBe(false);
    expect(isWslUncPath('')).toBe(false);
  });
});

describe('wslUncToLinux', () => {
  it('translates a nested path, preserving distro case', () => {
    expect(wslUncToLinux('\\\\wsl$\\Ubuntu\\home\\u\\api')).toEqual({ distro: 'Ubuntu', path: '/home/u/api' });
    expect(wslUncToLinux('\\\\wsl.localhost\\Ubuntu-22.04\\srv\\x')).toEqual({ distro: 'Ubuntu-22.04', path: '/srv/x' });
  });
  it('maps a root-only path to /', () => {
    expect(wslUncToLinux('\\\\wsl$\\Ubuntu')).toEqual({ distro: 'Ubuntu', path: '/' });
    expect(wslUncToLinux('\\\\wsl$\\Ubuntu\\')).toEqual({ distro: 'Ubuntu', path: '/' });
  });
  it('tolerates trailing separators and forward slashes', () => {
    expect(wslUncToLinux('//wsl$/Ubuntu/home/u/')).toEqual({ distro: 'Ubuntu', path: '/home/u' });
  });
  it('returns null for non-WSL paths', () => {
    expect(wslUncToLinux('D:\\francois')).toBeNull();
    expect(wslUncToLinux('\\\\server\\share')).toBeNull();
    expect(wslUncToLinux('/mnt/c/repo')).toBeNull();
  });
});

describe('displayWslCwd', () => {
  it('renders distro:path', () => {
    expect(displayWslCwd('\\\\wsl$\\Ubuntu\\home\\u\\api')).toBe('Ubuntu:/home/u/api');
    expect(displayWslCwd('\\\\wsl.localhost\\Debian\\')).toBe('Debian:/');
  });
  it('returns null for non-WSL paths (caller falls back to ~-abbreviation)', () => {
    expect(displayWslCwd('D:\\francois')).toBeNull();
    expect(displayWslCwd('/home/u')).toBeNull();
  });
});
