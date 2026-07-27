import { describe, expect, it, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// platform.js is CommonJS on purpose (it runs inside npm's postinstall), so it
// is pulled in through createRequire rather than a bare import.
const require = createRequire(import.meta.url);
const { assetKey, readManifest, resolveExecutable, supportedList } = require('./platform.js');

/** A throwaway vendor/ directory; each test seeds only the layout it asserts on. */
const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'francois-npm-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('assetKey', () => {
  it('maps both Mac architectures to the single universal bundle', () => {
    expect(assetKey('darwin', 'arm64')).toBe('darwin-universal');
    expect(assetKey('darwin', 'x64')).toBe('darwin-universal');
  });

  it('maps 64-bit Windows and Linux to their own assets', () => {
    expect(assetKey('win32', 'x64')).toBe('win32-x64');
    expect(assetKey('linux', 'x64')).toBe('linux-x64');
  });

  it('returns null for platforms with no published build', () => {
    expect(assetKey('linux', 'arm64')).toBeNull();
    expect(assetKey('win32', 'arm64')).toBeNull();
    expect(assetKey('freebsd', 'x64')).toBeNull();
  });
});

describe('supportedList', () => {
  it('names every published asset exactly once', () => {
    expect(supportedList()).toBe('darwin-universal, linux-x64, win32-x64');
  });
});

describe('readManifest', () => {
  it('returns null when CI never wrote one', () => {
    expect(readManifest(path.join(tempDir(), 'manifest.json'))).toBeNull();
  });

  it('returns null on a corrupt manifest rather than throwing mid-install', () => {
    const file = path.join(tempDir(), 'manifest.json');
    fs.writeFileSync(file, '{ not json');
    expect(readManifest(file)).toBeNull();
  });

  it('parses a well-formed manifest', () => {
    const file = path.join(tempDir(), 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ tag: 'v0.9.0', assets: {} }));
    expect(readManifest(file)).toEqual({ tag: 'v0.9.0', assets: {} });
  });
});

describe('resolveExecutable', () => {
  it('returns null when the payload was never unpacked', () => {
    expect(resolveExecutable(path.join(tempDir(), 'vendor'), 'linux')).toBeNull();
  });

  it('finds the Windows executable', () => {
    const vendor = tempDir();
    fs.writeFileSync(path.join(vendor, 'francois.exe'), '');
    expect(resolveExecutable(vendor, 'win32')).toBe(path.join(vendor, 'francois.exe'));
  });

  it('finds the Linux AppImage', () => {
    const vendor = tempDir();
    fs.writeFileSync(path.join(vendor, 'francois.AppImage'), '');
    expect(resolveExecutable(vendor, 'linux')).toBe(path.join(vendor, 'francois.AppImage'));
  });

  it('digs the inner binary out of a macOS bundle whatever the channel named it', () => {
    const vendor = tempDir();
    const macos = path.join(vendor, 'Francois Dev.app', 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(macos, 'francois'), '');
    expect(resolveExecutable(vendor, 'darwin')).toBe(path.join(macos, 'francois'));
  });

  it('returns null for a macOS bundle with no executable inside', () => {
    const vendor = tempDir();
    fs.mkdirSync(path.join(vendor, 'Francois.app', 'Contents', 'MacOS'), { recursive: true });
    expect(resolveExecutable(vendor, 'darwin')).toBeNull();
  });

  it('returns null when the vendor directory holds no bundle at all', () => {
    const vendor = tempDir();
    fs.writeFileSync(path.join(vendor, 'README'), '');
    expect(resolveExecutable(vendor, 'darwin')).toBeNull();
  });

  it('returns null on a platform we do not ship', () => {
    expect(resolveExecutable(tempDir(), 'freebsd')).toBeNull();
  });
});
