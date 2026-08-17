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
const fs = require('node:fs');
const path = require('node:path');

const desktop = require('../lib/desktop.js');
const extensions = require('../lib/extensions.js');
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
  francois ext install <name>  install a plugin by name, local path, or git URL
  francois ext list            list installed plugins (works with the app closed)
  francois ext remove <id>     delete an installed plugin
  francois --help              this message

Anything else is forwarded to the app.
`;

const EXT_USAGE = `francois ext — manage plugins in ~/.francois/extensions (filesystem only,
never the app's socket — this works with the app closed).

Usage
  francois ext install <name|path|git-url> [--force]
  francois ext list
  francois ext remove <id> [--yes]

A bare <name> resolves by CONVENTION to the repository
\`github.com/antoine-gmnz/francois-plugin-<name>\`; \`<owner>/<name>\` uses that
owner instead. There is no index and nothing to search — the convention is a
URL shorthand, so any plugin is still installable by its full URL. An existing
local directory of that name always wins, so nothing reaches the network when
a local answer exists.

Installing never enables a plugin — review and enable it in Extensions (⌘K).
`;

/** A single blocking line read off stdin — no dependency, works in a real
 * terminal and under a piped `echo y |` in CI alike. */
function confirmSync(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(4096);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  const answer = buf.toString('utf8', 0, bytesRead).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function runExt(args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(EXT_USAGE);
    return;
  }

  if (sub === 'install') {
    const force = args.includes('--force');
    const source = args.slice(1).find((a) => !a.startsWith('--'));
    if (!source) die('francois ext install <name|path|git-url>');
    let result;
    try {
      result = extensions.installExtension(source, { force });
    } catch (error) {
      die(error.message);
    }
    // The resolved source is printed because a bare name is ambiguous by
    // design: the user must be able to see whether it copied a directory or
    // cloned a repository, without re-deriving the convention in their head.
    // `result.source`/`result.id`/`result.path` are all untrusted (attacker-
    // controlled path/URL text) — sanitize before they ever reach stdout, the
    // same as the `list` path.
    process.stdout.write(
      `francois: installed "${extensions.sanitizeForDisplay(result.id)}" from ${extensions.sanitizeForDisplay(result.source)}\n`
    );
    process.stdout.write(`francois:   at ${extensions.sanitizeForDisplay(result.path)}\n`);
    // FR-15/FR-28: discovery is not authorization — it always arrives inert.
    process.stdout.write('francois: disabled — enable it in Extensions (⌘K)\n');
    return;
  }

  if (sub === 'list') {
    const found = extensions.listExtensions();
    if (found.length === 0) {
      process.stdout.write(`francois: nothing installed yet — see ${extensions.extensionsDir()}\n`);
      return;
    }
    for (const ext of found) {
      const status = !ext.valid ? 'invalid manifest' : ext.enabled ? 'enabled' : 'disabled';
      process.stdout.write(`${ext.id}\t${ext.label}\t${ext.path}\t${status}\n`);
    }
    return;
  }

  if (sub === 'remove') {
    const id = args[1];
    if (!id || id.startsWith('--')) die('francois ext remove <id>');
    let target;
    try {
      target = extensions.resolveExtensionDir(id);
    } catch (error) {
      die(error.message);
    }
    process.stdout.write(`francois: about to delete ${target}\n`);
    if (!args.includes('--yes') && !confirmSync('remove this extension? [y/N] ')) {
      process.stdout.write('francois: cancelled.\n');
      return;
    }
    try {
      extensions.removeExtension(id);
    } catch (error) {
      die(error.message);
    }
    process.stdout.write(`francois: removed "${id}".\n`);
    return;
  }

  die(`unknown "francois ext ${sub}" — see \`francois ext --help\`.`);
}

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

  // extension-install FR-27: filesystem verbs, off the socket — work with the
  // app closed, and never reach the app's dispatch below.
  if (argv[0] === 'ext') {
    runExt(argv.slice(1));
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
