// cohorte-integration FR-51/FR-87 — the ONE app-wide subscription to
// francois://cohorte/event: every member goes through the store's reducer, and
// `francois.gate.opened` may raise a desktop notification.

import type { CohorteGate, CohorteRun } from '../../../contract/cohorte-integration';
import { listenCohorte } from '../../lib/api';
import { useCohorteStore } from '../../lib/cohorteStore';
import { visibleSessionIds } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';
import { isWindowFocused, notifyDesktop } from '../notifications/notifications';
import { gateNotificationBody } from './gate-view';
import { computeLinks, originSessionId } from './linkage';
import { shouldNotifyGate } from './notify';
import { rejectionToast } from './outcome';
import { showToast } from '../../lib/toast';
import { CASE_INSENSITIVE_FS } from './useCohorte';
import { watchedRunList } from './watch';

const firstSeen = new Map<string, number>();
const notified = new Set<string>();
let initialized = false;

/** Record when this window first saw each run (FR-87's backfill rule). */
export function noteRunsSeen(runs: readonly Pick<CohorteRun, 'runId'>[], at = Date.now()): void {
  for (const r of runs) if (!firstSeen.has(r.runId)) firstSeen.set(r.runId, at);
}

function originOf(runId: string): string | null {
  const c = useCohorteStore.getState();
  const links = computeLinks({
    sessions: useStore.getState().sessions,
    runs: watchedRunList(c.runs, c.watchedRoots, CASE_INSENSITIVE_FS),
    detections: c.detections,
    explicitLinks: c.explicitLinks,
    caseInsensitive: CASE_INSENSITIVE_FS,
  });
  return originSessionId(links, runId);
}

function onGateOpened(gate: CohorteGate): void {
  const c = useCohorteStore.getState();
  const run = c.runs[gate.runId];
  noteRunsSeen([{ runId: gate.runId }]);
  const origin = originOf(gate.runId);
  const st = useStore.getState();
  const fire = shouldNotifyGate({
    prefOn: c.prefs.notifyOnGate,
    alreadyNotified: notified.has(gate.request.approvalId),
    firstSeenAt: firstSeen.get(gate.runId) ?? Date.now(),
    requestedAt: gate.requestedAt,
    windowFocused: isWindowFocused(),
    originVisible: origin !== null && visibleSessionIds(st).includes(origin) && st.mainTab === 'session',
  });
  if (!fire) return;
  notified.add(gate.request.approvalId);
  void notifyDesktop(gateNotificationBody(run ?? { specId: '', title: gate.runId }, gate), origin ?? undefined);
}

/** Called once from App's mount effect. Idempotent. */
export function initCohorteFeed(): void {
  if (initialized) return;
  initialized = true;
  void listenCohorte((e) => {
    if (e.type === 'francois.run.updated') noteRunsSeen([e.run]);
    useCohorteStore.getState().apply(e);
    if (e.type === 'francois.gate.opened') onGateOpened(e.gate);
    if (e.type === 'command.rejected') {
      const message = rejectionToast(e);
      if (message) showToast(message, 'error');
    }
  });
}
