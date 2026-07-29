#!/usr/bin/env node
'use strict';

/**
 * `francois` — launch the desktop app that install.js unpacked into vendor/.
 *
 * Unrecognised arguments are forwarded to the app binary, so this stays
 * forward-compatible with the read-only CLI companion (specs/cli-companion.md)
 * once that ships.
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const desktop = require('../lib/desktop.js');
const {
  assetKey,
  readInstallRecord,
  readManifest,
  resolveExecutable,
  supportedList,
} = require('../lib/platform.js');

const USAGE = `francois — mission control for your Claude Code fleet

Usage
  francois                     launch the app (returns to the shell immediately)
  francois --attach            launch it in the foreground, keeping its output attached
  francois --version           print the app + package versions
  francois shortcut            re-register the Start Menu / Launchpad / menu entry
  francois shortcut --remove   unregister it
  francois uninstall           unregister the desktop entry, then npm-uninstall this package
  francois --help              this message

Anything else is forwarded to the app.
`;

function die(message) {
  process.stderr.write(`\nfrancois: ${message}\n\n`);
  process.exit(1);
}

/**
 * Tauri renders through the system webview, which on Windows means the WebView2
 * runtime. It ships with Windows 11 and current Windows 10, but a bare machine
 * can be missing it — and the app then fails with nothing useful on screen.
 * A warning only: a false negative here must not block a working launch.
 */
function warnIfWebView2Missing() {
  if (process.platform !== 'win32') return;
  const guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  const roots = [
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${guid}`,
    `HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${guid}`,
  ];
  const found = roots.some(
    (key) => spawnSync('reg', ['query', key, '/v', 'pv'], { stdio: 'ignore' }).status === 0,
  );
  if (!found) {
    process.stderr.write(
      'francois: the Microsoft Edge WebView2 runtime was not found — the window may fail to open.\n' +
        '          Install it from https://developer.microsoft.com/microsoft-edge/webview2/\n',
    );
  }
}

function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    const manifest = readManifest();
    const pkg = require('../package.json');
    process.stdout.write(`francois ${manifest ? manifest.appVersion : 'unknown'} (npm ${pkg.version})\n`);
    return;
  }

  // Re-runnable on demand: a shortcut can be deleted, or the postinstall can have
  // run somewhere the desktop wasn't reachable (SSH, a container, a CI image).
  if (argv[0] === 'shortcut') {
    const record = readInstallRecord();
    if (!record) die('nothing is installed yet — run `npm i -g francois` first.');

    if (argv.includes('--remove')) {
      desktop.remove(record);
      process.stdout.write(`francois: removed the ${record.productName} shortcut.\n`);
      return;
    }

    const { notes } = desktop.install(record);
    for (const note of notes) process.stdout.write(`francois: ${note}\n`);
    return;
  }

  // Current npm (v7+) never runs preuninstall/postuninstall for `npm uninstall
  // -g` — a long-standing, unfixed npm regression — so uninstall.js's preuninstall
  // hook (still useful under yarn/pnpm, which do honor it) cannot be relied on
  // with npm. This is the reliable path: remove the desktop entry (and, on
  // macOS, the ~/Applications bundle) while the install record still exists,
  // THEN hand off to npm — after which the record and this very script are gone.
  if (argv[0] === 'uninstall') {
    const record = readInstallRecord();
    if (record) {
      desktop.remove(record);
      process.stdout.write(`francois: removed the ${record.productName} shortcut.\n`);
    }
    const pkg = require('../package.json');
    process.stdout.write('francois: removing the npm package…\n');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npmCmd, ['uninstall', '-g', pkg.name], { stdio: 'inherit' });
    process.exit(result.status === null ? 1 : result.status);
  }

  const executable = resolveExecutable();
  if (!executable) {
    if (!assetKey()) {
      die(
        `no prebuilt app for ${process.platform}/${process.arch} (published: ${supportedList()}).\n` +
          'Build from source: https://github.com/antoine-gmnz/francois#build-from-source',
      );
    }
    die('the app payload is missing — reinstall with `npm i -g francois`.');
  }

  warnIfWebView2Missing();

  const attach = argv[0] === '--attach';
  const forwarded = attach ? argv.slice(1) : argv;

  if (attach) {
    const result = spawnSync(executable, forwarded, { stdio: 'inherit' });
    process.exit(result.status === null ? 1 : result.status);
  }

  const child = spawn(executable, forwarded, {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.on('error', (error) => die(`could not launch ${path.basename(executable)}: ${error.message}`));
  child.unref();
}

main();
