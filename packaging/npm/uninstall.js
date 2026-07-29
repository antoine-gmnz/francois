#!/usr/bin/env node
'use strict';

/**
 * preuninstall — unregister the desktop integration before the package
 * directory is deleted.
 *
 * This matters most on macOS, where the .app was moved out to ~/Applications and
 * would otherwise survive an uninstall as an orphan.
 *
 * Current npm (v7+) never actually runs this — a long-standing, unfixed
 * regression where `npm uninstall -g` skips preuninstall/postuninstall
 * entirely — so `francois uninstall` (bin/francois.js) is the command that
 * reliably does this cleanup with npm. This script still earns its keep under
 * package managers that do honor the hook (yarn, pnpm). Never fails the
 * uninstall either way.
 */

const desktop = require('./lib/desktop.js');
const { readInstallRecord } = require('./lib/platform.js');

try {
  const record = readInstallRecord();
  if (record) desktop.remove(record);
} catch {
  // Nothing here is worth blocking an uninstall over.
}
