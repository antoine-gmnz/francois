import { getName, getVersion } from '@tauri-apps/api/app';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';
import { DEMO_VERSION } from '../demo/demo';

export interface AppIdentity {
  home: string;
  appName: string;
  appVersion: string;
}

/**
 * Bootstraps the window/app identity: the user's home dir (for path
 * abbreviation), the bundle's app name + version — read from the bundle
 * (tauri.conf.json), never hardcoded, so a release bumps the footer on its
 * own and the dev channel reads "Francois Dev" — and keeps the native window
 * title in sync with the active session, "<session> — <app>" (document-first,
 * so the taskbar and alt-tab show the session, not a constant prefix).
 */
export function useAppIdentity(activeSessionName: string | undefined): AppIdentity {
  const [home, setHome] = useState('');
  useEffect(() => {
    void homeDir()
      .then((h) => setHome(h.replace(/[\\/]$/, '')))
      .catch(() => {});
  }, []);

  const [appName, setAppName] = useState('Francois');
  // Empty until it resolves, so no stale number ever flashes.
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    // The demo build runs off tauri.dev.conf.json, whose bundle name is
    // "Francois Dev" — which would end up in the window caption of every
    // README capture. Keep the real name there. Compile-time flag: this
    // branch is not in a normal build.
    if (__FRANCOIS_DEMO__) {
      setAppName('Francois');
      setAppVersion(DEMO_VERSION);
      return;
    }
    void getName()
      .then(setAppName)
      .catch(() => {});
    void getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void getCurrentWindow()
      .setTitle(activeSessionName ? `${activeSessionName} — ${appName}` : appName)
      .catch(() => {});
  }, [activeSessionName, appName]);

  return { home, appName, appVersion };
}
