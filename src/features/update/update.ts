// self-update (specs/self-update.md) — everything the chip and the modal do
// that is not markup: the two checks (FR-7 silent at launch, FR-9 on demand),
// the apply (FR-12/FR-16/FR-18), and the pure render derivations
// (FR-8/FR-10/FR-11/FR-12). UpdateChip.tsx and UpdateModal.tsx are thin
// renderers over these so the logic stays coverable by vitest's node env.
//
// Nothing here re-derives what the core already decided: `updateAvailable`,
// `method`, `notesUrl` and `command` come from contract/self-update.ts verbatim
// — the version comparison and the npm-provenance probe are core policy (FR-4,
// FR-5), never reimplemented on this side. The one thing the frontend owns is
// the running-session count, which the core re-checks independently at apply
// time (FR-12).

import type { AppError, SessionMeta } from '../../../contract/common';
import type { UpdateCheck } from '../../../contract/self-update';
import { appApplyUpdate, appCheckUpdate } from '../../lib/api';
import { useStore } from '../../lib/store';

/** Design brief: the line under a button disabled by work in flight. */
export const BLOCKED_NOTE = 'Francois has to quit to update. Finish or stop the running turns first.';
/** Design brief: the line above the copyable command on a non-npm install (FR-11). */
export const MANUAL_NOTE = "This copy wasn't installed through npm, so Francois can't update it in place.";

// ------------------------------------------------------------------ the chip

/** What the status-bar version readout renders (FR-8). */
export interface UpdateChipView {
  /** true → the accent chip that opens the modal; false → today's dim readout. */
  available: boolean;
  /** `↑ 0.16.0` (the NEW version) when available, else the running version. */
  label: string;
  /** The button's accessible name. Empty while idle — that state is a plain,
   *  non-interactive readout with no tooltip, exactly as it renders today. */
  title: string;
}

/**
 * FR-8. `appVersion` is the bundle's own version (useAppIdentity); it is empty
 * until that resolves, which reads as `dev` exactly as it does today. A failed
 * or not-yet-returned check is indistinguishable from "no update" on purpose
 * (FR-7) — this function never sees an error to render.
 */
export function updateChipView(check: UpdateCheck | null, appVersion: string): UpdateChipView {
  if (check?.updateAvailable) {
    return { available: true, label: `↑ ${check.latest}`, title: `Francois ${check.latest} is available` };
  }
  return { available: false, label: appVersion || 'dev', title: '' };
}

// ------------------------------------------------------- the primary action

/** The one action slot at the bottom-right of the modal (design brief §States). */
export type UpdatePrimary =
  | { kind: 'apply'; label: string }
  | { kind: 'busy'; label: string }
  | { kind: 'blocked'; label: string; note: string }
  | { kind: 'manual'; command: string; note: string };

/** FR-12: the count the button names. Derived from the existing sessions slice. */
export function runningSessionCount(sessions: SessionMeta[]): number {
  return sessions.filter((s) => s.status === 'running').length;
}

/**
 * FR-11/FR-12. `manual` wins over everything: no button is ever rendered for a
 * copy Francois cannot update, so running sessions are irrelevant there —
 * nothing is going to quit.
 */
export function updatePrimaryView(check: UpdateCheck, running: number, busy: boolean): UpdatePrimary {
  if (check.method === 'manual') return { kind: 'manual', command: check.command, note: MANUAL_NOTE };
  if (busy) return { kind: 'busy', label: 'Updating…' };
  if (running > 0) {
    return { kind: 'blocked', label: `${running} session${running === 1 ? '' : 's'} running`, note: BLOCKED_NOTE };
  }
  return { kind: 'apply', label: 'Update and restart' };
}

// ----------------------------------------------------------------- the modal

/** FR-10: the offer — version transition, notes, release link, one action. */
export interface UpdateAvailableView {
  kind: 'available';
  current: string;
  latest: string;
  /** null → the `Release notes unavailable` line (FR-3). */
  notes: string | null;
  notesUrl: string;
  primary: UpdatePrimary;
  /** A refused apply, shown without losing the offer (FR-12/FR-18). */
  error: string | null;
}

export type UpdateModalView =
  | { kind: 'failed'; message: string }
  | { kind: 'uptodate'; current: string }
  | UpdateAvailableView;

/** Design brief: the up-to-date state's single line. */
export function upToDateLine(current: string): string {
  return `You're on the latest version (${current})`;
}

/**
 * Which of the modal's three bodies to render. A failed CHECK wins over a stale
 * successful one — after it, neither version is known to be current, so showing
 * the old headline would state something the app can no longer stand behind. An
 * apply failure is the opposite: the check is still good, so the offer stays and
 * the reason rides along.
 */
export function updateModalView(
  check: UpdateCheck | null,
  error: AppError | null,
  running: number,
  busy: boolean,
): UpdateModalView {
  const checkFailed = error?.code === 'UPDATE_CHECK_FAILED';
  if (!check || checkFailed) return { kind: 'failed', message: error?.message ?? 'Could not check for updates' };
  if (!check.updateAvailable) return { kind: 'uptodate', current: check.current };
  return {
    kind: 'available',
    current: check.current,
    latest: check.latest,
    notes: check.notes && check.notes.trim() !== '' ? check.notes : null,
    notesUrl: check.notesUrl,
    primary: updatePrimaryView(check, running, busy),
    error: error ? error.message : null,
  };
}

// --------------------------------------------------------------- the actions

/**
 * FR-7 is "exactly once when the app shell mounts" — module-scoped rather than
 * ref-scoped because React StrictMode mounts the shell twice in dev, and a
 * launch check is an app-run event, not a component event.
 */
let launchChecked = false;

/** Test seam — the flag above is app-scoped state, so each test starts clean. */
export function resetLaunchCheck(): void {
  launchChecked = false;
}

/**
 * FR-7: the launch check. Records a result; reports NOTHING on failure — no
 * chip, no toast, no error surface. A network blip at launch must not shout.
 */
export async function checkUpdateOnLaunch(): Promise<void> {
  if (launchChecked) return;
  launchChecked = true;
  try {
    const res = await appCheckUpdate();
    if (res.ok) useStore.getState().setUpdate(res.data);
  } catch {
    /* the bridge is down — the readout stays exactly as it is (FR-7) */
  }
}

/**
 * FR-9: the palette's `Check for updates`. Always reports back — up-to-date and
 * failed checks included — since this one the user asked for.
 */
export async function checkUpdateManually(): Promise<void> {
  const st = useStore.getState();
  try {
    const res = await appCheckUpdate();
    if (res.ok) {
      st.setUpdate(res.data);
      st.setUpdateError(null);
    } else {
      st.setUpdateError(res.error);
    }
  } catch {
    st.setUpdateError({ code: 'UPDATE_CHECK_FAILED', message: 'Could not reach the core' });
  }
  st.setUpdateModalOpen(true);
}

/**
 * FR-16/FR-18: hand the install to the core and stay busy — a successful ack is
 * followed by the window closing, so there is no success state to fall into. A
 * refusal frees the button again with the reason on screen.
 *
 * The busy flag is also §7's guard against a second call: the first one never
 * clears it, so a double click cannot reach the core.
 */
export async function applyUpdate(): Promise<void> {
  const st = useStore.getState();
  if (st.updateBusy) return;
  const check = st.update;
  // FR-11/FR-18: `applyUpdate` on a manual install resolves UPDATE_APPLY_FAILED
  // in the core — the button that would send it is never rendered, so a call
  // from here would be a bug. Guarded rather than round-tripped.
  if (!check || !check.updateAvailable || check.method !== 'npm') return;

  st.setUpdateError(null);
  st.setUpdateBusy(true);
  try {
    const res = await appApplyUpdate();
    if (res.ok) return; // stays busy: the window is going (FR-16)
    useStore.getState().setUpdateError(res.error);
  } catch {
    useStore.getState().setUpdateError({ code: 'UPDATE_APPLY_FAILED', message: 'Could not reach the core' });
  }
  useStore.getState().setUpdateBusy(false);
}
