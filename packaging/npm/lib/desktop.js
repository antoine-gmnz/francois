'use strict';

/**
 * Desktop integration: make an npm-installed Francois behave like an app you
 * installed, not like a CLI you have to remember the name of.
 *
 * npm delivers the bytes (which is what dodges SmartScreen and Gatekeeper —
 * see install.js) but it only ever puts a command on PATH. Everything the OS
 * needs to show the app in its own launchers is written here, per-user, with no
 * elevation and no signature:
 *
 *   Windows  Start Menu .lnk + an HKCU uninstall entry (Settings > Installed apps)
 *   macOS    the .app lives in ~/Applications, so Spotlight/Launchpad/Dock see it
 *   Linux    a .desktop file + a hicolor icon in ~/.local/share
 *
 * Every step is best-effort: a machine with an unusual shell, a locked-down
 * registry or no desktop environment at all must still end up with a working
 * `francois` command. Failures are reported, never thrown.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ICON_SOURCE = path.join(__dirname, '..', 'assets', 'icon.png');

/**
 * Stable per-channel slug. The dev channel is a separate app with its own data
 * dir, so its shortcuts must not collide with a stable install's.
 */
function appId(channel) {
  return channel === 'dev' ? 'francois-dev' : 'francois';
}

function startMenuShortcut(productName, appData = process.env.APPDATA) {
  if (!appData) return null;
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${productName}.lnk`);
}

function uninstallRegistryKey(channel) {
  return `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId(channel)}`;
}

/**
 * The AppUserModelID toast notifications are sent under. Must equal the tauri
 * `identifier` of the channel's config (tauri.conf.json / tauri.dev.conf.json):
 * tauri-plugin-notification tags every toast from an installed app with that
 * identifier, and Windows silently drops toasts whose AUMID it has never seen.
 */
function aumid(channel) {
  return channel === 'dev' ? 'com.francois.dev' : 'com.francois.desktop';
}

function aumidRegistryKey(channel) {
  return `HKCU\\Software\\Classes\\AppUserModelId\\${aumid(channel)}`;
}

function desktopEntryPath(channel, home = os.homedir()) {
  return path.join(home, '.local', 'share', 'applications', `${appId(channel)}.desktop`);
}

function desktopIconPath(channel, home = os.homedir()) {
  return path.join(home, '.local', 'share', 'icons', 'hicolor', '128x128', 'apps', `${appId(channel)}.png`);
}

function applicationsDir(home = os.homedir()) {
  return path.join(home, 'Applications');
}

/**
 * A freedesktop.org .desktop entry. Exec is quoted because the AppImage sits
 * under npm's global prefix, which on many systems contains spaces.
 * StartupWMClass lets the shell group the running window under this launcher
 * instead of showing a second, icon-less entry.
 */
function desktopEntry({ productName, exec, icon }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${productName}`,
    'Comment=Mission control for your Claude Code fleet',
    `Exec="${exec}" %U`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Development;Utility;',
    'StartupWMClass=francois',
    '',
  ].join('\n');
}

/** Run a command purely for its side effect; never let a missing tool throw. */
function attempt(command, args) {
  try {
    return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// ── Windows ─────────────────────────────────────────────────────────────────

function installWindows({ executable, productName, channel, appVersion, notes }) {
  const shortcut = startMenuShortcut(productName);
  if (!shortcut) {
    notes.push('APPDATA is not set — skipped the Start Menu shortcut.');
    return;
  }

  fs.mkdirSync(path.dirname(shortcut), { recursive: true });
  // WScript.Shell is the only supported way to author a .lnk; there is no
  // Node API for it and no plain-text equivalent of the format.
  const ok = attempt('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    [
      '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + psQuote(shortcut) + ');',
      '$s.TargetPath = ' + psQuote(executable) + ';',
      '$s.WorkingDirectory = ' + psQuote(path.dirname(executable)) + ';',
      "$s.Description = 'Mission control for your Claude Code fleet';",
      '$s.Save()',
    ].join(' '),
  ]);
  notes.push(ok ? `Start Menu: ${productName}` : 'could not create the Start Menu shortcut.');

  // Makes it appear in Settings > Installed apps like any other program. HKCU
  // only, so this never needs elevation.
  const key = uninstallRegistryKey(channel);
  const values = [
    ['DisplayName', 'REG_SZ', productName],
    ['DisplayVersion', 'REG_SZ', appVersion],
    ['Publisher', 'REG_SZ', 'Antoine Gimenez'],
    ['DisplayIcon', 'REG_SZ', executable],
    ['InstallLocation', 'REG_SZ', path.dirname(executable)],
    ['UninstallString', 'REG_SZ', 'cmd.exe /c npm uninstall -g francois'],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
  ];
  const wrote = values.every(([name, type, data]) =>
    attempt('reg', ['add', key, '/v', name, '/t', type, '/d', data, '/f']),
  );
  if (!wrote) notes.push('could not register the uninstall entry.');

  // Registering the AUMID is what lets toast notifications through: a
  // WScript.Shell .lnk cannot carry System.AppUserModel.ID, so use the registry
  // route for unpackaged apps (the same one Chrome uses) instead.
  const toastKey = aumidRegistryKey(channel);
  const registered =
    attempt('reg', ['add', toastKey, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', productName, '/f']) &&
    attempt('reg', ['add', toastKey, '/v', 'IconUri', '/t', 'REG_SZ', '/d', ICON_SOURCE, '/f']);
  if (!registered) notes.push('could not register the notification identity — toasts may not show.');
}

function removeWindows({ productName, channel }) {
  const shortcut = startMenuShortcut(productName);
  if (shortcut) fs.rmSync(shortcut, { force: true });
  attempt('reg', ['delete', uninstallRegistryKey(channel), '/f']);
  attempt('reg', ['delete', aumidRegistryKey(channel), '/f']);
}

/** Single-quoted PowerShell literal — no expansion, '' escapes a quote. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ── macOS ───────────────────────────────────────────────────────────────────

/**
 * Move the bundle into ~/Applications. A .app buried in node_modules is invisible
 * to Spotlight and Launchpad; in ~/Applications it is simply an installed Mac
 * app. Returns the new bundle path.
 */
function installMacos({ bundle, home, notes }) {
  const target = path.join(applicationsDir(home), path.basename(bundle));
  // Already in place — `francois shortcut` re-runs this, and blindly rm'ing the
  // target would delete the very bundle we are about to move.
  if (path.resolve(bundle) !== path.resolve(target)) {
    fs.mkdirSync(applicationsDir(home), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(bundle, target);
  }

  // Nudge LaunchServices so Spotlight sees it now rather than whenever it next
  // rescans. Absent or relocated on some systems, hence best-effort.
  attempt(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', target],
  );
  notes.push(`Applications: ${path.basename(target)}`);
  return target;
}

/** Scoped to ~/Applications so a hand-moved bundle elsewhere is never deleted. */
function removeMacos({ bundle, home }) {
  if (bundle && path.resolve(bundle).startsWith(path.resolve(applicationsDir(home)))) {
    fs.rmSync(bundle, { recursive: true, force: true });
  }
}

// ── Linux ───────────────────────────────────────────────────────────────────

function installLinux({ executable, productName, channel, home, notes }) {
  const icon = desktopIconPath(channel, home);
  const entry = desktopEntryPath(channel, home);
  fs.mkdirSync(path.dirname(icon), { recursive: true });
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(ICON_SOURCE, icon);
  fs.writeFileSync(entry, desktopEntry({ productName, exec: executable, icon }));
  attempt('update-desktop-database', [path.dirname(entry)]);
  notes.push(`Applications menu: ${productName}`);
}

function removeLinux({ channel, home }) {
  const entry = desktopEntryPath(channel, home);
  fs.rmSync(entry, { force: true });
  fs.rmSync(desktopIconPath(channel, home), { force: true });
  attempt('update-desktop-database', [path.dirname(entry)]);
}

// ── entry points ────────────────────────────────────────────────────────────

/**
 * Register the app with the OS. Returns { executable, bundle, notes } — the
 * paths may differ from what went in (macOS relocates the bundle), so the
 * caller must persist what it gets back.
 */
function install({
  executable,
  bundle,
  productName,
  channel,
  appVersion,
  platform = process.platform,
  home = os.homedir(),
}) {
  const notes = [];
  try {
    if (platform === 'win32') {
      installWindows({ executable, productName, channel, appVersion, notes });
    } else if (platform === 'darwin') {
      const moved = installMacos({ bundle, home, notes });
      // The bundle moved, so the executable path inside it moved with it.
      executable = path.join(moved, path.relative(bundle, executable));
      bundle = moved;
    } else if (platform === 'linux') {
      installLinux({ executable, productName, channel, home, notes });
    }
  } catch (error) {
    notes.push(`desktop integration failed (${error.message}) — the \`francois\` command still works.`);
  }
  return { executable, bundle, notes };
}

/** Undo install(). Safe to call when nothing was ever registered. */
function remove({ bundle, productName, channel, platform = process.platform, home = os.homedir() }) {
  try {
    if (platform === 'win32') removeWindows({ productName, channel });
    else if (platform === 'darwin') removeMacos({ bundle, home });
    else if (platform === 'linux') removeLinux({ channel, home });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
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
};
