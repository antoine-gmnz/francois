// The bundle's own version (tauri.conf.json), never hardcoded — so a release
// bumps every readout on its own. Empty until it resolves, so no stale number
// ever flashes.
//
// A cross-feature hook rather than part of useAppIdentity: the app row states
// the version (self-update FR-8) and so does the SESSION welcome header
// (session-welcome), and neither has any business owning the window title.

import { getVersion } from '@tauri-apps/api/app';
import { useEffect, useState } from 'react';
import { DEMO_VERSION } from '../../demo/demo';

export function useAppVersion(): string {
  // The demo build's number is a compile-time constant, so it is the initial
  // state rather than an effect — this branch is not in a normal build.
  const [appVersion, setAppVersion] = useState(__FRANCOIS_DEMO__ ? DEMO_VERSION : '');
  useEffect(() => {
    if (__FRANCOIS_DEMO__) return;
    void getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);
  return appVersion;
}
