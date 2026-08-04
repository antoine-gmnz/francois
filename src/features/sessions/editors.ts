// open-in-vscode (specs/open-in-vscode.md) — FR-10: fetch the detected-editor list
// when a menu opens, memoized in the frontend for the app run behind one shared
// in-flight promise. Mirrors the core's FR-3 cache policy on this side too: a
// successful (non-empty) probe is frozen for the app run; an empty probe is NOT
// cached, so an editor installed after launch is still picked up on a later menu
// open (§7 "Editor installed while Francois runs").

import type { EditorInfo } from '../../../contract/open-in-vscode';
import { sessionEditorList } from '../../lib/api';

let cached: EditorInfo[] | null = null; // non-null only once a non-empty result landed
let inFlight: Promise<EditorInfo[]> | null = null;

/** FR-10: the detected editors, fetched (and memoized) on menu open. Never rejects. */
export function getEditorList(): Promise<EditorInfo[]> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = sessionEditorList()
    .then((res) => (res.ok ? res.data.editors : []))
    .then((editors) => {
      inFlight = null;
      if (editors.length > 0) cached = editors;
      return editors;
    });
  return inFlight;
}

/** Test-only: resets the module-scoped memoization. */
export function resetEditorListCache(): void {
  cached = null;
  inFlight = null;
}
