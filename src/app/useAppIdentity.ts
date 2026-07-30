import { getName, getVersion } from '@tauri-apps/api/app';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';

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
