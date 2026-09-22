// "Open this file in the DIFF tab" — the one hand-off from outside the DIFF tab
// (the session panel's Changes tree) into its file selection, which is local
// state in useDiffFeed. A request is held until the DIFF tab for that session
// takes it: a DIFF tab that is already mounted hears it live (onDiffFileRequest);
// one that mounts because of the click reads it on its first summary load
// (takePendingDiffFile). Frontend-only — nothing crosses IPC.

export interface DiffFileRequest {
  sessionId: string;
  path: string;
}

let pending: DiffFileRequest | null = null;
const listeners = new Set<(req: DiffFileRequest) => void>();

export function requestDiffFile(sessionId: string, path: string): void {
  pending = { sessionId, path };
  for (const fn of listeners) fn(pending);
}

/** The pending path for `sessionId`, consumed; null when none is waiting for it. */
export function takePendingDiffFile(sessionId: string): string | null {
  if (!pending || pending.sessionId !== sessionId) return null;
  const { path } = pending;
  pending = null;
  return path;
}

export function onDiffFileRequest(fn: (req: DiffFileRequest) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
