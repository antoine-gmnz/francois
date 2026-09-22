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
