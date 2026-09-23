// cohorte-integration FR-88 / R-16 — "Cohorte: Settings" opens Settings on the
// Cohorte page. With Settings already open, the mounted view listens and
// navigates itself; closed, the request is parked and Settings is opened —
// SettingsView takes the parked request as it resolves its first page.

import { useStore } from '../../lib/store';

type Listener = () => void;
let pending = false;
let listener: Listener | null = null;

function openSettings(): void {
  useStore.getState().setProjectsOpen(true);
}

export function requestCohorteSettings(open: () => void = openSettings): void {
  if (listener) {
    listener();
    return;
  }
  pending = true;
  open();
}

/** SettingsView, while mounted: navigate to Cohorte on every request. */
export function onCohorteSettingsRequest(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/** SettingsView, on open: true once per parked request. */
export function takeCohorteSettingsRequest(): boolean {
  const was = pending;
  pending = false;
  return was;
}
