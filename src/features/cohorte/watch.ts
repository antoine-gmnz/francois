// cohorte-integration FR-52 — the pure half of the watcher wiring: which Cohorte
// roots this window asks the core to watch.

import type { CohorteDetection } from '../../../contract/cohorte-integration';
import { detectionFor, normalisePath } from './linkage';

/**
 * The declarative watch set: the roots of `detected` detections for the active
 * project's root and every open session cwd in scope. Unique (by normalised
 * path) and sorted, so an unchanged set compares equal as a joined string.
 */
export function watchedRoots(
  detections: Readonly<Record<string, CohorteDetection>>,
  dirs: readonly string[],
  caseInsensitive: boolean,
): string[] {
  const byKey = new Map<string, string>();
  for (const dir of dirs) {
    const d = detectionFor(detections, dir, caseInsensitive);
    if (d?.state === 'detected' && d.root) byKey.set(normalisePath(d.root, caseInsensitive), d.root);
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, root]) => root);
}

/** R-13: the root-membership test the prune and the run filters share. */
export function rootIsWatched(roots: readonly string[], caseInsensitive: boolean): (projectRoot: string) => boolean {
  const set = new Set(roots.map((r) => normalisePath(r, caseInsensitive)));
  return (projectRoot) => set.has(normalisePath(projectRoot, caseInsensitive));
}

/** R-13: only runs under a watched root reach the roster, Needs-you, the links and the palette. */
export function watchedRunList<R extends { projectRoot: string }>(runs: Readonly<Record<string, R>>, roots: readonly string[], caseInsensitive: boolean): R[] {
  const keep = rootIsWatched(roots, caseInsensitive);
  return Object.values(runs).filter((r) => keep(r.projectRoot));
}

/** R-13: how long a root that left the watch set keeps its runs (the core's own linger, FR-15). */
export const ROOT_LINGER_MS = 30_000;
