'use strict';

/**
 * Platform resolution shared by the postinstall (install.js) and the launcher
 * (bin/francois.js): which release asset this machine needs, and where the
 * unpacked executable ends up.
 *
 * Plain CommonJS with no dependencies — this runs during `npm install`, before
 * anything else is guaranteed to exist.
 */

const fs = require('node:fs');
const path = require('node:path');

/** `${process.platform}:${process.arch}` → release asset key. */
const SUPPORTED = {
  // One universal .app covers both Macs, so both arches map to the same asset.
  'darwin:x64': 'darwin-universal',
  'darwin:arm64': 'darwin-universal',
  'win32:x64': 'win32-x64',
  'linux:x64': 'linux-x64',
};

const PACKAGE_ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join(PACKAGE_ROOT, 'vendor');
const MANIFEST_PATH = path.join(PACKAGE_ROOT, 'manifest.json');
const INSTALL_RECORD = 'install.json';

/** The asset key for a platform/arch pair, or null when unsupported. */
function assetKey(platform = process.platform, arch = process.arch) {
  return SUPPORTED[`${platform}:${arch}`] || null;
}

/** Human-readable list of what we do ship, for the unsupported-platform error. */
function supportedList() {
  return [...new Set(Object.values(SUPPORTED))].sort().join(', ');
}

/**
 * The manifest is written by CI at publish time (it pins the release tag and the
 * per-asset sha256). A package built any other way won't have one.
 */
function readManifest(manifestPath = MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * What the postinstall actually did: where the payload ended up and what it
 * registered with the OS. macOS moves the bundle out to ~/Applications, so this
 * is the only reliable way to find it afterwards.
 */
function readInstallRecord(vendorDir = VENDOR_DIR) {
  try {
    return JSON.parse(fs.readFileSync(path.join(vendorDir, INSTALL_RECORD), 'utf8'));
  } catch {
    return null;
  }
}

function writeInstallRecord(record, vendorDir = VENDOR_DIR) {
  fs.writeFileSync(path.join(vendorDir, INSTALL_RECORD), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Where the app itself lives on Windows: `%LOCALAPPDATA%\francois` (or
 * `francois-dev`), NOT vendor/.
 *
 * npm replaces this package by renaming its directory, and on Windows a rename
 * fails with EBUSY while ANY process holds a handle inside it. A running app's
 * image is such a handle, and so is the working directory of every process it
 * leaves behind — orphaned ConPTY `conhost.exe`s sat in vendor/ and turned every
 * `npm i -g francois` after them into EBUSY. Outside the package, nothing the
 * app does can block npm. null when LOCALAPPDATA is unset.
 */
function windowsAppRoot(channel, localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) return null;
  return path.join(localAppData, channel === 'dev' ? 'francois-dev' : 'francois');
}

const PAYLOAD_PREFIX = 'app-';

/**
 * The directory a version unpacks into. One per version, so a payload some
 * leftover process still pins never blocks installing the next one — it is
 * merely left for a later prune (see prunePayloads). Everywhere but Windows the
 * payload stays in vendor/: nothing there holds a directory against a rename.
 */
function payloadDir({ version, channel, platform = process.platform, localAppData = process.env.LOCALAPPDATA }) {
  if (platform !== 'win32') return VENDOR_DIR;
  const root = windowsAppRoot(channel, localAppData);
  return root ? path.join(root, `${PAYLOAD_PREFIX}${version}`) : VENDOR_DIR;
}

/**
 * Best-effort removal of every payload under `root` except `keep`. A payload
 * still pinned by a live process fails to delete and is simply tried again on
 * the next install. Returns the directories it removed.
 */
function prunePayloads(root, keep) {
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    if (!entry.startsWith(PAYLOAD_PREFIX) || path.resolve(dir) === path.resolve(keep)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Still in use — next install.
    }
  }
  return removed;
}

/**
 * Locate the runnable binary. Prefers what the postinstall recorded; falls back
 * to scanning vendor/ so a payload unpacked by hand still runs.
 *
 * The macOS bundle name tracks Tauri's productName and so differs between the
 * stable ("Francois.app") and dev ("Francois Dev.app") channels — hence the
 * glob rather than a hardcoded name. Its inner executable is likewise named by
 * the bundler, so we take whatever is in Contents/MacOS.
 */
function resolveExecutable(vendorDir = VENDOR_DIR, platform = process.platform) {
  const record = readInstallRecord(vendorDir);
  if (record && record.executable && fs.existsSync(record.executable)) return record.executable;

  if (!fs.existsSync(vendorDir)) return null;

  if (platform === 'win32') {
    const exe = path.join(vendorDir, 'francois.exe');
    return fs.existsSync(exe) ? exe : null;
  }

  if (platform === 'linux') {
    const appimage = path.join(vendorDir, 'francois.AppImage');
    return fs.existsSync(appimage) ? appimage : null;
  }

  if (platform === 'darwin') {
    const bundle = fs
      .readdirSync(vendorDir)
      .filter((entry) => entry.endsWith('.app'))
      .sort()[0];
    if (!bundle) return null;
    const macos = path.join(vendorDir, bundle, 'Contents', 'MacOS');
    if (!fs.existsSync(macos)) return null;
    const binary = fs.readdirSync(macos).sort()[0];
    return binary ? path.join(macos, binary) : null;
  }

  return null;
}

module.exports = {
  INSTALL_RECORD,
  MANIFEST_PATH,
  PACKAGE_ROOT,
  SUPPORTED,
  VENDOR_DIR,
  assetKey,
  payloadDir,
  prunePayloads,
  readInstallRecord,
  readManifest,
  resolveExecutable,
  supportedList,
  windowsAppRoot,
  writeInstallRecord,
};
