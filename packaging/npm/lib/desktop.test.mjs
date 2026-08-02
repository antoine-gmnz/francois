import { describe, expect, it, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  ICON_SOURCE,
  appId,
  applicationsDir,
  aumid,
  aumidRegistryKey,
  desktopEntry,
  desktopEntryPath,
  desktopIconPath,
  install,
  remove,
  startMenuShortcut,
  uninstallRegistryKey,
} = require('./desktop.js');

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'francois-desktop-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('appId', () => {
  it('keeps the dev channel from colliding with a stable install', () => {
    expect(appId('stable')).toBe('francois');
    expect(appId('dev')).toBe('francois-dev');
    expect(appId(undefined)).toBe('francois');
  });
});

describe('startMenuShortcut', () => {
  it('lands in the per-user Start Menu, named after the product', () => {
    expect(startMenuShortcut('Francois Dev', 'C:\\Users\\x\\AppData\\Roaming')).toBe(
      path.join('C:\\Users\\x\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Francois Dev.lnk'),
    );
  });

  it('returns null when APPDATA is not set rather than guessing a path', () => {
    expect(startMenuShortcut('Francois', '')).toBeNull();
  });
});

describe('aumid', () => {
  it('matches the tauri identifier of each channel — toasts are sent under it', () => {
    expect(aumid('stable')).toBe('com.francois.desktop');
    expect(aumid(undefined)).toBe('com.francois.desktop');
    expect(aumid('dev')).toBe('com.francois.dev');
  });
});

describe('aumidRegistryKey', () => {
  it('registers per-user under Classes\\AppUserModelId, so no elevation is needed', () => {
    expect(aumidRegistryKey('stable')).toBe(
      'HKCU\\Software\\Classes\\AppUserModelId\\com.francois.desktop',
    );
    expect(aumidRegistryKey('dev')).toMatch(/\\com\.francois\.dev$/);
  });
});

describe('uninstallRegistryKey', () => {
  it('registers per-user, so no elevation is ever needed', () => {
    expect(uninstallRegistryKey('stable')).toBe(
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\francois',
    );
    expect(uninstallRegistryKey('dev')).toMatch(/\\francois-dev$/);
  });
});

describe('freedesktop paths', () => {
  // These paths are only ever built on Linux, but the suite also runs on Windows
  // and macOS — compare with a normalised separator so the assertion stays about
  // the layout rather than the host.
  const posix = (p) => p.split(path.sep).join('/');

  it('writes the entry and icon under the XDG user directories', () => {
    expect(posix(desktopEntryPath('stable', '/home/x'))).toBe(
      '/home/x/.local/share/applications/francois.desktop',
    );
    expect(posix(desktopIconPath('dev', '/home/x'))).toBe(
      '/home/x/.local/share/icons/hicolor/128x128/apps/francois-dev.png',
    );
  });

  it('puts the macOS bundle in the user Applications folder', () => {
    expect(posix(applicationsDir('/Users/x'))).toBe('/Users/x/Applications');
  });
});

describe('desktopEntry', () => {
  const entry = desktopEntry({
    productName: 'Francois',
    exec: '/home/x/.npm-global/lib/node_modules/francois/vendor/francois.AppImage',
    icon: '/home/x/.local/share/icons/hicolor/128x128/apps/francois.png',
  });

  it('declares a non-terminal application', () => {
    expect(entry).toMatch(/^\[Desktop Entry\]$/m);
    expect(entry).toMatch(/^Type=Application$/m);
    expect(entry).toMatch(/^Terminal=false$/m);
    expect(entry).toMatch(/^Name=Francois$/m);
  });

  it('quotes Exec, because npm prefixes routinely contain spaces', () => {
    expect(entry).toMatch(/^Exec="[^"]+" %U$/m);
  });

  it('sets StartupWMClass so the running window groups under the launcher', () => {
    expect(entry).toMatch(/^StartupWMClass=francois$/m);
  });

  it('ends with a trailing newline, as the spec requires', () => {
    expect(entry.endsWith('\n')).toBe(true);
  });
});

describe('the shipped icon', () => {
  it('exists, so the Linux launcher is never icon-less', () => {
    expect(fs.existsSync(ICON_SOURCE)).toBe(true);
  });
});

describe('install', () => {
  it('never throws when the desktop cannot be reached — the CLI must still work', () => {
    const result = install({
      executable: '/nonexistent/Francois.app/Contents/MacOS/francois',
      bundle: '/nonexistent/Francois.app',
      productName: 'Francois',
      channel: 'stable',
      appVersion: '0.9.0',
      platform: 'darwin',
      home: tempDir(),
    });
    expect(result.notes.some((note) => note.includes('still works'))).toBe(true);
  });

  it('relocates the bundle and follows the executable into it', () => {
    const home = tempDir();
    const staging = tempDir();
    const bundle = path.join(staging, 'Francois.app');
    const macos = path.join(bundle, 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(macos, 'francois'), '');

    const result = install({
      executable: path.join(macos, 'francois'),
      bundle,
      productName: 'Francois',
      channel: 'stable',
      appVersion: '0.9.0',
      platform: 'darwin',
      home,
    });

    const moved = path.join(home, 'Applications', 'Francois.app');
    expect(result.bundle).toBe(moved);
    expect(result.executable).toBe(path.join(moved, 'Contents', 'MacOS', 'francois'));
    expect(fs.existsSync(result.executable)).toBe(true);
    expect(fs.existsSync(bundle)).toBe(false);
  });

  it('is idempotent, so `francois shortcut` can be re-run safely', () => {
    const home = tempDir();
    const staging = tempDir();
    const bundle = path.join(staging, 'Francois.app');
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'francois'), 'payload');

    const opts = {
      executable: path.join(bundle, 'Contents', 'MacOS', 'francois'),
      bundle,
      productName: 'Francois',
      channel: 'stable',
      appVersion: '0.9.0',
      platform: 'darwin',
      home,
    };
    const first = install(opts);
    const second = install({ ...opts, executable: first.executable, bundle: first.bundle });

    expect(second.bundle).toBe(first.bundle);
    expect(fs.readFileSync(second.executable, 'utf8')).toBe('payload');
  });

  it('is a no-op on a platform with no integration to do', () => {
    const result = install({ executable: '/x', productName: 'Francois', channel: 'stable', platform: 'freebsd' });
    expect(result).toMatchObject({ executable: '/x', notes: [] });
  });
});

describe('remove', () => {
  it('deletes a bundle that lives in ~/Applications', () => {
    const home = tempDir();
    const bundle = path.join(home, 'Applications', 'Francois.app');
    fs.mkdirSync(bundle, { recursive: true });
    remove({ bundle, channel: 'stable', platform: 'darwin', home });
    expect(fs.existsSync(bundle)).toBe(false);
  });

  it('refuses to delete a bundle outside ~/Applications', () => {
    const home = tempDir();
    const stray = path.join(tempDir(), 'Francois.app');
    fs.mkdirSync(stray, { recursive: true });
    remove({ bundle: stray, channel: 'stable', platform: 'darwin', home });
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('tolerates being called when nothing was registered', () => {
    expect(remove({ channel: 'stable', platform: 'linux', home: tempDir() })).toBe(true);
    expect(remove({ channel: 'stable', platform: 'freebsd', home: tempDir() })).toBe(true);
  });
});
