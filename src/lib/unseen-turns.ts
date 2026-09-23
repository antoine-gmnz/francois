// Finished turns you have not looked at yet: a session whose turn ended while
// you were on another one keeps a mark until you select it. The roster reads
// the mark as a dot on the row.
//
// One detection point: store.ts diffs the `sessions` array on every change and
// folds it through `markFinishedTurns`, so every write path (patchStatus,
// run.state, upsertSession, setSessions) is covered without each one knowing.

import type { SessionId, SessionMeta, SessionStatus } from '../../contract/common';

export type UnseenTurns = Readonly<Record<SessionId, true>>;

const WORKING: ReadonlySet<SessionStatus> = new Set(['starting', 'running', 'awaiting_approval', 'awaiting_input']);

/**
 * The next set of unseen marks after `prev` → `next`. A session is marked when
 * it moved from a working state to `idle` and is not the active one; a session
 * absent from `prev` (hydration, a fresh append) is never marked. Marks whose
 * session left `next` are pruned. Returns `unseen` itself when nothing changed.
 */
export function markFinishedTurns(
  prev: readonly SessionMeta[],
  next: readonly SessionMeta[],
  activeSessionId: SessionId | null,
  unseen: UnseenTurns,
): UnseenTurns {
  const before = new Map(prev.map((s) => [s.id, s.status]));
  const present = new Set<SessionId>();
  let out: Record<SessionId, true> | null = null;
  for (const s of next) {
    present.add(s.id);
    const was = before.get(s.id);
    if (s.status !== 'idle' || was === undefined || !WORKING.has(was) || s.id === activeSessionId || unseen[s.id]) continue;
    out ??= { ...unseen };
    out[s.id] = true;
  }
  for (const id of Object.keys(unseen)) {
    if (present.has(id)) continue;
    out ??= { ...unseen };
    delete out[id];
  }
  return out ?? unseen;
}

/** `unseen` without `id`'s mark — the same reference when it had none. */
export function dropUnseenTurn(unseen: UnseenTurns, id: SessionId | null): UnseenTurns {
  if (id === null || !unseen[id]) return unseen;
  const { [id]: _dropped, ...rest } = unseen;
  void _dropped;
  return rest;
}
