// cohorte-integration — the imperative half: answering a gate (FR-42..FR-44 via
// the core), run controls (FR-46), opening/closing the run view (FR-70), the
// log fetch (FR-69) and the once-per-root policy read (FR-74). Every command
// is the CLI through the core; this module only tracks busy/outcome state and
// words the result (outcome.ts).

import type { CohorteCommandResponse, CohorteGateActionId, CohorteRun } from '../../../contract/cohorte-integration';
import {
  cohorteApprove,
  cohorteCancel,
  cohorteDeny,
  cohorteGetRun,
  cohortePause,
  cohortePolicy,
  cohorteResume,
  cohorteRunLog,
  cohorteSendToFix,
} from '../../lib/api';
import { getDraft } from '../../lib/composer-draft';
import { useCohorteStore, type CohorteBusy } from '../../lib/cohorteStore';
import { useStore, type MainTab } from '../../lib/store';
import { showToast } from '../palette/palette';
import { commandErrorFeedback, hasPendingStep, NOTE_DROPPED_TOAST, OUTCOME_VISIBLE_MS, PENDING_REENABLE_MS } from './outcome';
import { cohorteRunIdFromTab, cohorteTabId } from './tab';

const outcomeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const busyTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(map: Map<string, ReturnType<typeof setTimeout>>, runId: string) {
  const t = map.get(runId);
  if (t) clearTimeout(t);
  map.delete(runId);
}

async function track(run: CohorteRun, busy: CohorteBusy, call: () => Promise<CohorteCommandResponse>): Promise<boolean> {
  const st = useCohorteStore.getState();
  if (st.busy[run.runId]) return false; // FR-63: one command per run at a time
  st.setBusy(run.runId, busy);
  clearTimer(busyTimers, run.runId);
  let res: CohorteCommandResponse;
  try {
    res = await call();
  } catch (e) {
    res = { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } };
  }
  const now = useCohorteStore.getState();
  if (!res.ok) {
    now.setBusy(run.runId, null);
    const fb = commandErrorFeedback(res.error);
    showToast(fb.message, fb.kind);
    if (fb.refresh) void refreshRun(run);
    return false;
  }
  if (res.data.run) now.upsertRun(res.data.run);
  now.setOutcome(run.runId, res.data);
  clearTimer(outcomeTimers, run.runId);
  outcomeTimers.set(
    run.runId,
    setTimeout(() => useCohorteStore.getState().setOutcome(run.runId, null), OUTCOME_VISIBLE_MS),
  );
  if (hasPendingStep(res.data.steps)) {
    // FR-93: the inbox is durable — wait for the next poll (gate.resolved
    // clears busy) or 20 s, whichever first.
    busyTimers.set(
      run.runId,
      setTimeout(() => useCohorteStore.getState().setBusy(run.runId, null), PENDING_REENABLE_MS),
    );
  } else {
    now.setBusy(run.runId, null);
  }
  return true;
}

export async function refreshRun(run: Pick<CohorteRun, 'projectRoot' | 'runId'>): Promise<void> {
  const res = await cohorteGetRun({ root: run.projectRoot, runId: run.runId });
  if (res.ok) useCohorteStore.getState().upsertRun(res.data);
}

/**
 * Answer the run's gate. `sessionId` is the origin session whose composer
 * draft rides along as the fix note (FR-64) — kept in the composer, since
 * Cohorte 3.0 drops notes.
 */
export function answerGate(run: CohorteRun, action: CohorteGateActionId, sessionId?: string | null): Promise<boolean> {
  const gate = run.gate;
  if (!gate || !gate.actions.some((a) => a.id === action)) return Promise.resolve(false);
  const req = { root: run.projectRoot, runId: run.runId, approvalId: gate.request.approvalId };
  if (action === 'approve') return track(run, action, () => cohorteApprove(req));
  if (action === 'fix') {
    const note = sessionId ? getDraft(sessionId).trim() : '';
    if (note) showToast(NOTE_DROPPED_TOAST, 'info');
    return track(run, action, () => cohorteSendToFix(note ? { ...req, note } : req));
  }
  const stopRun = gate.actions.find((a) => a.id === 'deny')?.stopsRun ?? false;
  return track(run, action, () => cohorteDeny({ ...req, stopRun }));
}

export function controlRun(run: CohorteRun, verb: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
  const req = { root: run.projectRoot, runId: run.runId };
  const call = verb === 'pause' ? cohortePause : verb === 'resume' ? cohorteResume : cohorteCancel;
  return track(run, verb, () => call(req));
}

/** FR-70: open the run view, remembering the tab to come back to. */
export function openCohorteRun(runId: string): void {
  const st = useStore.getState();
  if (cohorteRunIdFromTab(st.mainTab) === null) useCohorteStore.getState().setReturnTab(st.mainTab);
  st.setFocusedPane('main');
  st.setMainTab(cohorteTabId(runId));
}

export function closeCohorteRun(): void {
  const back: MainTab = useCohorteStore.getState().returnTab;
  useStore.getState().setMainTab(cohorteRunIdFromTab(back) === null ? back : 'session');
}

/** FR-69: fetch the ring once; live wire events append from then on. */
export async function loadRunLog(run: Pick<CohorteRun, 'projectRoot' | 'runId'>): Promise<void> {
  // R-16: rows that arrive during the fetch are buffered, then merged.
  useCohorteStore.getState().beginLog(run.runId);
  const res = await cohorteRunLog({ root: run.projectRoot, runId: run.runId, limit: 200 });
  useCohorteStore.getState().setLog(run.runId, res.ok ? res.data : []);
}

const policyRequested = new Set<string>();

/** FR-74: `cohorte_policy` once per root. */
export function ensurePolicy(root: string, force = false): void {
  if (policyRequested.has(root) && !force) return;
  policyRequested.add(root);
  void cohortePolicy({ root }).then((res) => {
    if (res.ok) useCohorteStore.getState().setPolicy(root, res.data);
    else policyRequested.delete(root);
  });
}

/** FR-75: copy a CLI line, toast "Copied". */
export function copyCli(text: string): void {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => showToast('Copied', 'success'))
    .catch(() => showToast('Could not copy', 'error'));
}
