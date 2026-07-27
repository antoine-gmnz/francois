#!/usr/bin/env node
'use strict';

/**
 * postinstall — fetch this platform's Francois build from its GitHub release and
 * unpack it into vendor/.
 *
 * Why this package exists at all: Windows SmartScreen and macOS Gatekeeper key
 * off the Mark-of-the-Web / com.apple.quarantine attribute that a *browser*
 * attaches at download time. A binary fetched by npm never carries one, so the
 * same unsigned build that gets blocked when downloaded as a .dmg or .exe
 * launches clean from here — no code-signing certificate involved.
 *
 * Dependency-free by necessity: this runs during `npm install`, so nothing but
 * Node's standard library is available.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { VENDOR_DIR, assetKey, readManifest, supportedList } = require('./lib/platform.js');

const DOWNLOAD_BASE = process.env.FRANCOIS_DOWNLOAD_BASE || 'https://github.com';
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;

function log(message) {
  process.stdout.write(`francois: ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\nfrancois: ${message}\n\n`);
  process.exit(1);
}

/**
 * GitHub redirects release downloads to a CDN, so redirects must be followed.
 * http is honoured alongside https only so that a self-hosted
 * FRANCOIS_DOWNLOAD_BASE works; the default base is https.
 */
function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const request = client.get(url, { headers: { 'user-agent': 'francois-npm-installer' } }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft === 0) return reject(new Error('too many redirects'));
        return resolve(download(new URL(headers.location, url).toString(), dest, redirectsLeft - 1));
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} for ${url}`));
      }

      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('error', reject);
      file.on('finish', () => file.close(() => resolve()));
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('download timed out')));
    request.on('error', reject);
  });
}

async function downloadWithRetries(url, dest) {
  for (let attempt = 1; ; attempt++) {
    try {
      await download(url, dest);
      return;
    } catch (error) {
      fs.rmSync(dest, { force: true });
      if (attempt === MAX_ATTEMPTS) throw error;
      log(`download failed (${error.message}) — retrying ${attempt}/${MAX_ATTEMPTS - 1}`);
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

/**
 * .tar.gz everywhere except Windows, which gets a .zip. Windows 10 1803+ ships
 * bsdtar as tar.exe (it reads zip too); Expand-Archive covers anything older.
 */
function extract(archive, dest) {
  if (archive.endsWith('.zip')) {
    try {
      run('tar', ['-xf', archive, '-C', dest]);
    } catch {
      run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`,
      ]);
    }
  } else {
    // System tar on macOS/Linux preserves the bundle's symlinks and exec bits.
    run('tar', ['-xzf', archive, '-C', dest]);
  }
}

async function main() {
  if (process.env.FRANCOIS_SKIP_DOWNLOAD) {
    log('FRANCOIS_SKIP_DOWNLOAD set — skipping the app download.');
    return;
  }

  const key = assetKey();
  if (!key) {
    fail(
      `no prebuilt app for ${process.platform}/${process.arch}.\n` +
        `Published builds: ${supportedList()}.\n` +
        'Build from source instead: https://github.com/antoine-gmnz/francois#build-from-source',
    );
  }

  const manifest = readManifest();
  if (!manifest || !manifest.assets || !manifest.assets[key]) {
    fail(
      'this package has no release manifest, so there is nothing to download.\n' +
        'That means it was not built by CI — install the published package with `npm i -g francois`.',
    );
  }

  const asset = manifest.assets[key];
  const url = `${DOWNLOAD_BASE}/${manifest.repo}/releases/download/${manifest.tag}/${asset.name}`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'francois-install-'));
  const archive = path.join(staging, asset.name);
  // On the exit hook rather than in a finally, so that fail()'s process.exit()
  // — which skips finally blocks — still clears the staging directory.
  process.on('exit', () => fs.rmSync(staging, { recursive: true, force: true }));

  try {
    log(`downloading Francois ${manifest.appVersion} (${key})…`);
    await downloadWithRetries(url, archive);

    const actual = sha256(archive);
    if (actual !== asset.sha256) {
      fail(
        `checksum mismatch for ${asset.name}.\n` +
          `  expected ${asset.sha256}\n  actual   ${actual}\n` +
          (manifest.channel === 'dev'
            ? 'The rolling `dev` release is replaced on every push to main, so an older\n' +
              'dev package points at binaries that no longer exist. Install the current\n' +
              'one: npm i -g francois@dev'
            : 'Refusing to install a binary that does not match the published release.'),
      );
    }

    fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
    extract(archive, VENDOR_DIR);

    if (process.platform === 'darwin') {
      // Belt and braces: npm downloads never carry com.apple.quarantine, but a
      // user-supplied FRANCOIS_DOWNLOAD_BASE or a proxy could. Best-effort.
      spawnSync('xattr', ['-dr', 'com.apple.quarantine', VENDOR_DIR], { stdio: 'ignore' });
    }

    log('installed. Run `francois` to launch it.');
  } catch (error) {
    fail(`install failed: ${error.message}`);
  }
}

main();
