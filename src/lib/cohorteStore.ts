// cohorte-integration FR-51/FR-53 — the frontend's reading of every Cohorte
// root this window watches. A standalone zustand store (like
// notificationsStore): the core owns the projection, this store only mirrors
// what the event stream and the hydrating reads hand it.
//
//   detections   per start dir (a project root or a session cwd)
//   runs         per runId — `francois.run.updated` REPLACES, never merges
//   logs         per runId, only once "Tail logs" fetched that run's ring
//   busy / lastOutcome   the command in flight and how the last one ended
//   explicitLinks        FR-30 rule 1, recorded by the transcript tool rows
//   prefs                the four Settings switches, in localStorage (FR-53)
//
// `applyCohorteEvent` is the pure reducer; `apply` wraps it.

import { create } from 'zustand';
import { COHORTE_PREF_DEFAULTS, COHORTE_PREF_KEYS, type CohorteCommandOutcome, type CohorteDetection, type CohorteEvent, type CohorteGateActionId, type CohorteLogEntry, type CohortePolicySummary, type CohortePrefs, type CohorteRun } from '../../contract/cohorte-integration';
import { type CohorteApprovalDecision } from '../../contract/cohorte-events';
import type { ErrorCode, SessionId } from '../../contract/common';
import type { MainTab } from './agentTabStore';
import { appendLog, logEntryFromEvent } from './cohorte-log';

export type CohorteBusy = CohorteGateActionId | 'pause' | 'resume' | 'cancel';

export interface CohorteWatchHealth {
  healthy: boolean;
  error?: { code: ErrorCode; message: string };
  nextPollInMs: number;
}

export interface CohorteResolution {
  approvalId: string;
  decision: CohorteApprovalDecision | 'unknown';
  actor?: string;
  /** when this window saw it (epoch ms) */
  at: number;
  /** R-15: the resolution answers a command this window issued (busy or outcome pending) */
  byThisWindow: boolean;
}

/** Everything the reducer reads and writes — the store minus its actions. */
export interface CohorteData {
  detections: Record<string, CohorteDetection>;
  /** why the last detection for a start dir failed; cleared when one lands. */
  detectErrors: Record<string, string>;
  runs: Record<string, CohorteRun>;
  logs: Record<string, CohorteLogEntry[]>;
  busy: Record<string, CohorteBusy | null>;
  lastOutcome: Record<string, CohorteCommandOutcome>;
  explicitLinks: Record<SessionId, string[]>;
  prefs: CohortePrefs;
  /** FR-70: where the run view's Back returns to. */
  returnTab: MainTab;
  /** FR-19/FR-101: per-root watcher health, from `francois.watch.status`. */
  watchHealth: Record<string, CohorteWatchHealth>;
  /** FR-74: `cohorte_policy`, fetched once per root. */
  policies: Record<string, CohortePolicySummary>;
  /** the last gate resolution per run — who answered it (§5.1 approval.resolved). */
  resolutions: Record<string, CohorteResolution>;
  /** FR-69 / R-16: per session, the run whose activity log its Cohorte tab shows. */
  panelLog: Record<SessionId, string>;
  /** R-16: wire rows that arrived while a run's log fetch was in flight. */
  logBuffers: Record<string, CohorteLogEntry[]>;
  /** R-16: the `cli` hint of a run's latest `auth.required` (`cohorte auth login …`). */
  authCli: Record<string, string>;
  /** R-13: the Cohorte roots this window currently asks the core to watch. */
  watchedRoots: string[];
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * FR-51 — one event folded into the store. Wire members only ever add a log
 * row (and only to a log that was fetched); the run projection itself comes
 * from the derived `francois.run.updated`, which replaces the whole run.
 */
export function applyCohorteEvent(s: CohorteData, e: CohorteEvent, now: number = Date.now()): Partial<CohorteData> {
  switch (e.type) {
    case 'francois.detection.changed':
      return { detections: { ...s.detections, [e.detection.startDir]: e.detection } };
    case 'francois.run.updated':
      return { runs: { ...s.runs, [e.run.runId]: e.run } };
    case 'francois.run.removed':
      return {
        runs: without(s.runs, e.runId),
        logs: without(s.logs, e.runId),
        busy: without(s.busy, e.runId),
        lastOutcome: without(s.lastOutcome, e.runId),
        logBuffers: without(s.logBuffers, e.runId),
        authCli: without(s.authCli, e.runId),
      };
    case 'francois.gate.opened': {
      const current = s.runs[e.gate.runId];
      if (!current) return {};
      return { runs: { ...s.runs, [current.runId]: { ...current, gate: e.gate, view: 'gate' } } };
    }
    case 'francois.gate.resolved': {
      const current = s.runs[e.runId];
      const byThisWindow = s.busy[e.runId] != null || s.lastOutcome[e.runId] !== undefined;
      const resolution: CohorteResolution = { approvalId: e.approvalId, decision: e.decision, actor: e.actor, at: now, byThisWindow };
      const patch: Partial<CohorteData> = {
        resolutions: { ...s.resolutions, [e.runId]: resolution },
        busy: without(s.busy, e.runId),
        // R-16: the step lines stay "for 8 s or until the gate resolves" (FR-65).
        lastOutcome: without(s.lastOutcome, e.runId),
      };
      if (current?.gate?.request.approvalId === e.approvalId) {
        patch.runs = { ...s.runs, [e.runId]: { ...current, gate: null } };
      }
      return patch;
    }
    case 'francois.watch.status':
      return {
        watchHealth: {
          ...s.watchHealth,
          [e.projectRoot]: { healthy: e.healthy, error: e.error, nextPollInMs: e.nextPollInMs },
        },
      };
    case 'pipeline.started':
    case 'pipeline.completed':
    case 'pipeline.failed':
    case 'run.state.changed':
    case 'run.paused':
    case 'run.resumed':
    case 'run.cancelled':
    case 'run.host.attached':
    case 'run.host.detached':
    case 'phase.started':
    case 'phase.completed':
    case 'check.started':
    case 'check.completed':
    case 'error':
    case 'checkpoint.created':
    case 'agent.declared':
    case 'agent.spawned':
    case 'agent.started':
    case 'agent.state.changed':
    case 'agent.completed':
    case 'agent.failed':
    case 'agent.turn.started':
    case 'agent.turn.completed':
    case 'agent.message.started':
    case 'agent.message.delta':
    case 'agent.message.completed':
    case 'agent.message.accepted':
    case 'runtime.warning':
    case 'model.requested':
    case 'model.responded':
    case 'context.built':
    case 'escalation.applied':
    case 'tool.requested':
    case 'tool.denied':
    case 'tool.rejected':
    case 'tool.started':
    case 'tool.progress':
    case 'tool.completed':
    case 'file.read':
    case 'file.written':
    case 'file.changed':
    case 'review.started':
    case 'review.finding':
    case 'review.completed':
    case 'review.approved':
    case 'approval.requested':
    case 'approval.resolved':
    case 'budget.updated':
    case 'budget.exceeded':
    case 'quota.updated':
    case 'auth.required':
    case 'retry.scheduled':
    case 'command.accepted':
    case 'command.completed':
    case 'command.rejected':
    case 'git.worktree.created':
    case 'git.worktree.provisioned':
    case 'git.worktree.quarantined':
    case 'git.worktree.removed':
    case 'git.commit.created':
    case 'git.merge.completed':
    case 'git.merge.conflicted':
    case 'repo.change.detected':
    case 'lock.acquired':
    case 'lock.released':
    case 'lock.stolen':
    case 'snapshot':
    case 'heartbeat':
    case 'unknown': {
      // §5.1: every wire member is one log row — appended only to a log the
      // user opened (the ring is fetched lazily, FR-69), or buffered while
      // that fetch is in flight (R-16).
      const patch: Partial<CohorteData> = {};
      if (e.type === 'auth.required') patch.authCli = { ...s.authCli, [e.runId]: e.payload.cli };
      const buffer = s.logBuffers[e.runId];
      if (buffer) {
        patch.logBuffers = { ...s.logBuffers, [e.runId]: [...buffer, logEntryFromEvent(e)] };
        return patch;
      }
      const log = s.logs[e.runId];
      if (!log) return patch;
      const next = appendLog(log, logEntryFromEvent(e));
      if (next !== log) patch.logs = { ...s.logs, [e.runId]: next };
      return patch;
    }
    default: {
      // Exhaustive: a member added to the contract fails to compile here. At
      // runtime a type the build does not know is ignored, never merged.
      const unreachable: never = e;
      void unreachable;
      return {};
    }
  }
}

/**
 * R-16 — the fetched ring, then every row that arrived while the fetch was in
 * flight (deduped by `(sequence, sub)` in `appendLog`). Clears the buffer.
 */
export function mergeFetchedLog(s: CohorteData, runId: string, entries: CohorteLogEntry[]): Partial<CohorteData> {
  let log = entries;
  for (const row of s.logBuffers[runId] ?? []) log = appendLog(log, row);
  return { logs: { ...s.logs, [runId]: log }, logBuffers: without(s.logBuffers, runId) };
}

/** R-13 — keep only the runs whose root is still watched (after the linger). */
export function pruneRunsTo(s: CohorteData, keep: (projectRoot: string) => boolean): Partial<CohorteData> {
  const gone = Object.values(s.runs).filter((r) => !keep(r.projectRoot)).map((r) => r.runId);
  if (gone.length === 0) return {};
  const drop = <T>(rec: Record<string, T>): Record<string, T> => {
    let next = rec;
    for (const id of gone) next = without(next, id);
    return next;
  };
  return {
    runs: drop(s.runs),
    logs: drop(s.logs),
    busy: drop(s.busy),
    lastOutcome: drop(s.lastOutcome),
    logBuffers: drop(s.logBuffers),
    authCli: drop(s.authCli),
    resolutions: drop(s.resolutions),
  };
}

// ---------- prefs (FR-53) ----------

type PrefStorage = Pick<Storage, 'getItem'>;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Absent, malformed or unreadable → the default for that switch. */
export function loadCohortePrefs(from: PrefStorage | null = storage()): CohortePrefs {
  const prefs = { ...COHORTE_PREF_DEFAULTS };
  for (const key of Object.keys(COHORTE_PREF_KEYS) as (keyof CohortePrefs)[]) {
    let raw: string | null = null;
    try {
      raw = from?.getItem(COHORTE_PREF_KEYS[key]) ?? null;
    } catch {
      raw = null;
    }
    if (raw === '1') prefs[key] = true;
    else if (raw === '0') prefs[key] = false;
  }
  return prefs;
}

export function persistCohortePref(key: keyof CohortePrefs, on: boolean, to: Pick<Storage, 'setItem'> | null = storage()): void {
  try {
    to?.setItem(COHORTE_PREF_KEYS[key], on ? '1' : '0');
  } catch {
    /* ignore — the in-memory switch still works for this run */
  }
}

// ---------- the store ----------

export interface CohorteState extends CohorteData {
  apply: (e: CohorteEvent) => void;
  /** `key` is the start dir the caller asked about; the detection's own is stored too. */
  setDetection: (key: string, detection: CohorteDetection) => void;
  setDetectError: (key: string, message: string | null) => void;
  /** FR-52: `cohorte_list_runs` after a root is first watched. */
  hydrateRuns: (runs: readonly CohorteRun[]) => void;
  upsertRun: (run: CohorteRun) => void;
  setLog: (runId: string, entries: CohorteLogEntry[]) => void;
  setBusy: (runId: string, busy: CohorteBusy | null) => void;
  setOutcome: (runId: string, outcome: CohorteCommandOutcome | null) => void;
  /** FR-30 rule 1: the session's transcript launched a run and printed `runRef` (full id or its first 10 chars). */
  recordLaunch: (sessionId: SessionId, runRef: string) => void;
  setPref: (key: keyof CohortePrefs, on: boolean) => void;
  setReturnTab: (tab: MainTab) => void;
  setPolicy: (root: string, policy: CohortePolicySummary) => void;
  /** R-16: which run's log a session's Cohorte tab shows (null = the run view). */
  setPanelLog: (sessionId: SessionId, runId: string | null) => void;
  /** R-16: a log fetch started — wire rows buffer until `setLog`. */
  beginLog: (runId: string) => void;
  /** R-13: the declared watch set (set as soon as it is computed). */
  setWatchedRoots: (roots: string[]) => void;
  /** R-13: drop every run (and its log, busy, outcome) whose root `keep` rejects. */
  pruneRuns: (keep: (projectRoot: string) => boolean) => void;
}

export function initialCohorteData(): CohorteData {
  return {
    detections: {},
    detectErrors: {},
    runs: {},
    logs: {},
    busy: {},
    lastOutcome: {},
    explicitLinks: {},
    prefs: loadCohortePrefs(),
    returnTab: 'session',
    watchHealth: {},
    policies: {},
    resolutions: {},
    panelLog: {},
    logBuffers: {},
    authCli: {},
    watchedRoots: [],
  };
}

export const useCohorteStore = create<CohorteState>((set) => ({
  ...initialCohorteData(),
  apply: (e) => set((s) => applyCohorteEvent(s, e)),
  setDetection: (key, detection) =>
    set((s) => {
      const detectErrors = { ...s.detectErrors };
      delete detectErrors[key];
      delete detectErrors[detection.startDir];
      return { detections: { ...s.detections, [key]: detection, [detection.startDir]: detection }, detectErrors };
    }),
  setDetectError: (key, message) =>
    set((s) => {
      const detectErrors = { ...s.detectErrors };
      if (message) detectErrors[key] = message;
      else delete detectErrors[key];
      return { detectErrors };
    }),
  hydrateRuns: (runs) =>
    set((s) => {
      const next = { ...s.runs };
      for (const r of runs) next[r.runId] = r;
      return { runs: next };
    }),
  upsertRun: (run) => set((s) => ({ runs: { ...s.runs, [run.runId]: run } })),
  setLog: (runId, entries) => set((s) => mergeFetchedLog(s, runId, entries)),
  setBusy: (runId, busy) => set((s) => ({ busy: busy === null ? without(s.busy, runId) : { ...s.busy, [runId]: busy } })),
  setOutcome: (runId, outcome) =>
    set((s) => ({ lastOutcome: outcome === null ? without(s.lastOutcome, runId) : { ...s.lastOutcome, [runId]: outcome } })),
  recordLaunch: (sessionId, runRef) =>
    set((s) => {
      const known = s.explicitLinks[sessionId] ?? [];
      if (known.includes(runRef)) return {};
      return { explicitLinks: { ...s.explicitLinks, [sessionId]: [...known, runRef] } };
    }),
  setPref: (key, on) => {
    persistCohortePref(key, on);
    set((s) => ({ prefs: { ...s.prefs, [key]: on } }));
  },
  setReturnTab: (returnTab) => set({ returnTab }),
  setPolicy: (root, policy) => set((s) => ({ policies: { ...s.policies, [root]: policy } })),
  setPanelLog: (sessionId, runId) =>
    set((s) => ({ panelLog: runId === null ? without(s.panelLog, sessionId) : { ...s.panelLog, [sessionId]: runId } })),
  beginLog: (runId) => set((s) => (s.logBuffers[runId] ? {} : { logBuffers: { ...s.logBuffers, [runId]: [] } })),
  setWatchedRoots: (watchedRoots) => set({ watchedRoots }),
  pruneRuns: (keep) => set((s) => pruneRunsTo(s, keep)),
}));
