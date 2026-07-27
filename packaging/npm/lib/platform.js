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
 * Locate the runnable binary inside an unpacked vendor/ directory. Returns an
 * absolute path, or null when the payload is missing or malformed.
 *
 * The macOS bundle name tracks Tauri's productName and so differs between the
 * stable ("Francois.app") and dev ("Francois Dev.app") channels — hence the
 * glob rather than a hardcoded name. Its inner executable is likewise named by
 * the bundler, so we take whatever is in Contents/MacOS.
 */
function resolveExecutable(vendorDir = VENDOR_DIR, platform = process.platform) {
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
  MANIFEST_PATH,
  PACKAGE_ROOT,
  SUPPORTED,
  VENDOR_DIR,
  assetKey,
  readManifest,
  resolveExecutable,
  supportedList,
};
