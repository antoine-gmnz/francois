// cohorte-integration FR-88 — "Cohorte: Settings" opens Settings on the Cohorte
// page. Settings opens on General when the projects flag rises, so the request
// is parked here and taken by SettingsView as it resolves its page.

import { useStore } from '../../lib/store';

let pending = false;

export function requestCohorteSettings(): void {
  pending = true;
  const st = useStore.getState();
  if (st.projectsOpen) st.setProjectsOpen(false);
  st.setProjectsOpen(true);
}

/** SettingsView: true once per request. */
export function takeCohorteSettingsRequest(): boolean {
  const was = pending;
  pending = false;
  return was;
}
