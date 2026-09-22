// cohorte-integration — the hooks every Cohorte surface reads through: the
// session ↔ run links (FR-30), a session's run, one run by id, and whether a
// directory is a detected Cohorte project.

import { useMemo } from 'react';
import type { CohorteDetection, CohorteRun, CohorteSessionLink } from '../../../contract/cohorte-integration';
import { useCohorteStore } from '../../lib/cohorteStore';
import { IS_WINDOWS } from '../../lib/platform';
import { useStore } from '../../lib/store';
import { cohorteDetect } from '../../lib/api';
import { computeLinks, detectionFor, linkForSession, originSessionId } from './linkage';
import { headerStateChip, type RunChip } from './run-view';

/** Windows and macOS filesystems ignore case (FR-30 rule 2). */
export const CASE_INSENSITIVE_FS = IS_WINDOWS || (typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent));

export function useCohorteLinks(): CohorteSessionLink[] {
  const sessions = useStore((s) => s.sessions);
  const runs = useCohorteStore((s) => s.runs);
  const detections = useCohorteStore((s) => s.detections);
  const explicitLinks = useCohorteStore((s) => s.explicitLinks);
  return useMemo(
    () => computeLinks({ sessions, runs: Object.values(runs), detections, explicitLinks, caseInsensitive: CASE_INSENSITIVE_FS }),
    [sessions, runs, detections, explicitLinks],
  );
}

export interface SessionRun {
  run: CohorteRun | null;
  link: CohorteSessionLink | null;
  /** this session is the run's origin (header chips, inline card, Needs-you) */
  isOrigin: boolean;
}

export function useSessionRun(sessionId: string | null | undefined): SessionRun {
  const links = useCohorteLinks();
  const runs = useCohorteStore((s) => s.runs);
  return useMemo(() => {
    const link = sessionId ? linkForSession(links, sessionId) : null;
    const run = link ? (runs[link.runId] ?? null) : null;
    return { run, link, isOrigin: run !== null && originSessionId(links, run.runId) === sessionId };
  }, [links, runs, sessionId]);
}

export function useRun(runId: string | null): CohorteRun | null {
  return useCohorteStore((s) => (runId ? (s.runs[runId] ?? null) : null));
}

/** Whether `dir` resolves to a `detected` Cohorte project (FR-67 tab visibility). */
export function useCohorteDetected(dir: string | null | undefined): boolean {
  return useCohorteStore((s) => (dir ? detectionFor(s.detections, dir, CASE_INSENSITIVE_FS)?.state === 'detected' : false));
}

/** The non-hook reading of the same, for `visible?(session)`. */
export function isCohorteDetected(dir: string): boolean {
  return detectionFor(useCohorteStore.getState().detections, dir, CASE_INSENSITIVE_FS)?.state === 'detected';
}

/** FR-67: the panel tab shows only with the pref on and a detected project. */
export function cohorteSectionVisible(session: { cwd: string }): boolean {
  return useCohorteStore.getState().prefs.showPanelTab && isCohorteDetected(session.cwd);
}

/** FR-80: detect a project root (cached by the core unless `force`). */
export async function detectProject(root: string, force = false): Promise<CohorteDetection | null> {
  const res = await cohorteDetect({ startDir: root, force });
  if (!res.ok) return null;
  useCohorteStore.getState().setDetection(root, res.data);
  return res.data;
}

export function useProjectDetection(root: string | null): CohorteDetection | null {
  return useCohorteStore((s) => (root ? detectionFor(s.detections, root, CASE_INSENSITIVE_FS) : null));
}

export const GATE_COMPOSER_PLACEHOLDER = 'Answer the gate above, or add context for the fix step…';

/** FR-64: whether the composer should read the gate placeholder. */
export function useSessionGatePending(sessionId: string): boolean {
  const { run, isOrigin } = useSessionRun(sessionId);
  return isOrigin && run?.gate != null;
}

export interface HeaderRunState {
  run: CohorteRun | null;
  /** the state chip, for the origin session only (FR-60) */
  state: (RunChip & { replacesStatus: boolean }) | null;
}

/** FR-60: the session header's run chip + state chip inputs. */
export function useHeaderRun(sessionId: string | null | undefined): HeaderRunState {
  const { run, isOrigin } = useSessionRun(sessionId);
  return { run, state: run && isOrigin ? headerStateChip(run) : null };
}
