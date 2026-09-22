// cohorte-integration FR-52 — mounted once in App. Detects the active project's
// root (forced on every project switch, frame 28) and each new session cwd
// (cached), then tells the core the whole watch set — declaratively, debounced
// 500 ms — with whether the window is in the foreground. A root watched for
// the first time is hydrated with `cohorte_list_runs`.

import { useEffect, useMemo, useRef } from 'react';
import { cohorteDetect, cohorteListRuns, cohorteWatch } from '../../lib/api';
import { useCohorteStore } from '../../lib/cohorteStore';
import { useStore } from '../../lib/store';
import { noteRunsSeen } from './cohorteFeed';
import { CASE_INSENSITIVE_FS } from './useCohorte';
import { watchedRoots } from './watch';

const DEBOUNCE_MS = 500;

function foreground(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
}

function detect(startDir: string, force: boolean) {
  void cohorteDetect({ startDir, force }).then((res) => {
    if (res.ok) useCohorteStore.getState().setDetection(startDir, res.data);
  });
}

export function useCohorteWatch(): void {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const detections = useCohorteStore((s) => s.detections);
  const projectRoot = projects.find((p) => p.id === activeProjectId)?.root ?? null;

  const cwds = useMemo(
    () => [...new Set(sessions.filter((s) => activeProjectId === null || s.projectId === activeProjectId).map((s) => s.cwd))],
    [sessions, activeProjectId],
  );

  // Forced on every project switch.
  useEffect(() => {
    if (projectRoot) detect(projectRoot, true);
  }, [projectRoot]);

  // Each new session cwd, once, unforced (the core caches 30 s).
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const cwd of cwds) {
      if (asked.current.has(cwd)) continue;
      asked.current.add(cwd);
      detect(cwd, false);
    }
  }, [cwds]);

  const roots = useMemo(
    () => watchedRoots(detections, projectRoot ? [projectRoot, ...cwds] : cwds, CASE_INSENSITIVE_FS),
    [detections, projectRoot, cwds],
  );
  const key = roots.join('\n');

  const hydrated = useRef(new Set<string>());
  useEffect(() => {
    const send = () => {
      void cohorteWatch({ roots, foreground: foreground() });
      for (const root of roots) {
        if (hydrated.current.has(root)) continue;
        hydrated.current.add(root);
        void cohorteListRuns({ root }).then((res) => {
          if (!res.ok) {
            hydrated.current.delete(root);
            return;
          }
          noteRunsSeen(res.data);
          useCohorteStore.getState().hydrateRuns(res.data);
        });
      }
    };
    const timer = setTimeout(send, DEBOUNCE_MS);
    // Foreground flips re-declare the same set with the new cadence flag.
    const onFocus = () => void cohorteWatch({ roots, foreground: foreground() });
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
    // `key` stands for `roots` — an equal set must not re-declare.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
