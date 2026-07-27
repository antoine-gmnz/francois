#!/usr/bin/env node
'use strict';

/**
 * preuninstall — unregister the desktop integration before npm deletes the
 * package directory.
 *
 * This matters most on macOS, where the .app was moved out to ~/Applications and
 * would otherwise survive `npm uninstall -g francois` as an orphan.
 *
 * npm's uninstall lifecycle does not fire in every situation (a manually deleted
 * global folder, some CI teardowns), so `francois shortcut --remove` exists as
 * the explicit escape hatch. Never fails the uninstall.
 */

const desktop = require('./lib/desktop.js');
const { readInstallRecord } = require('./lib/platform.js');

try {
  const record = readInstallRecord();
  if (record) desktop.remove(record);
} catch {
  // Nothing here is worth blocking an uninstall over.
}
