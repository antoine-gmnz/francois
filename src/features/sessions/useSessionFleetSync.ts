import { useEffect, useRef, useState } from 'react';
import type { AppError, SessionMeta, SessionStatus } from '../../../contract/common';
import { countRunning, type SessionDerived } from '../../../contract/fleet-board';
import { statusTransitionKind, type ActivityKind } from '../../../contract/overview';
import { diffGetSummary, onDiffEvent, onSessionEvent, sessionList } from '../../lib/api';
import { useStore } from '../../lib/store';
import { clearDraft } from '../conversation/composer-draft';
import { prunePaletteSession } from '../palette/paletteData';
import { useShellStore } from '../shell/shellStore';
import { handleSessionEvent, type SessionEventContext } from './sessionEventHandler';

export interface SessionFleetSync {
  hydrationError: AppError | null;
  /** Re-runs session_list and applies it exactly like the mount hydration (FR-2/6/23). */
  retryHydration: () => void;
  /** Reassign the active session after `id` is gone — nearest remaining, or none (§7). */
  reassignAfterRemoval: (id: string) => void;
  /** Drops `id`'s per-session derived figures and internal bookkeeping (FR-7). */
  dropDerived: (id: string) => void;
}

/**
 * §7 / split-session FR-20: which session takes over the left pane once `id` is
 * removed — the nearest remaining by list position, or null when nothing is
 * left. Pure and exported for tests; the caller feeds the answer to
 * `reassignActiveSessionId`, NEVER to `setActiveSessionId`, whose FR-8 swap
 * branch would fire whenever the answer happens to be the RIGHT pane's session.
 */
export function nextActiveAfterRemoval(list: readonly SessionMeta[], id: string): string | null {
  const idx = list.findIndex((session) => session.id === id);
  const remaining = list.filter((session) => session.id !== id);
  if (remaining.length === 0) return null;
  // Clamped on both ends: an id not in the list (idx === -1) falls back to the
  // first row rather than indexing off the front.
  return remaining[Math.max(0, Math.min(idx, remaining.length - 1))].id;
}

/**
 * Sidebar pane [1]'s ONLY session/diff event subscription (fleet-board
 * FR-2/3/5/6/7): mount hydration via session_list, the live SessionEvent/
 * DiffEvent streams, and the per-session figures NOT on SessionMeta itself —
 * diff file count + running agent count — held in the STORE (OVERVIEW reads
 * the same numbers; a second subscription there would double every seed) and
 * the cross-project activity feed (overview).
 */
export function useSessionFleetSync(): SessionFleetSync {
  const upsertSession = useStore((s) => s.upsertSession);
  const setSessions = useStore((s) => s.setSessions);
  const patchStatus = useStore((s) => s.patchStatus);
  const patchError = useStore((s) => s.patchError);
  const patchUsage = useStore((s) => s.patchUsage);
  const removeSessionFromCache = useStore((s) => s.removeSession);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  // split-session FR-20: the removal fallback takes the RAW reassignment —
  // `setActiveSessionId` would read "the nearest remaining session happens to be
  // the right pane's" as a pane SWAP (FR-8) and smuggle the removed id into
  // `splitSessionId`.
  const reassignActiveSessionId = useStore((s) => s.reassignActiveSessionId);
  const mergeDerived = useStore((s) => s.mergeDerived);
  const dropDerivedFromCache = useStore((s) => s.dropDerived);
  const recordActivity = useStore((s) => s.recordActivity);

  const [hydrationError, setHydrationError] = useState<AppError | null>(null);
  // Backing store for runningAgentCount: sessionId → (agentId → status) (FR-5).
  const agentStatusRef = useRef<Map<string, Map<string, SessionStatus>>>(new Map());
  const seededRef = useRef<Set<string>>(new Set()); // sessions whose diff badge was seeded once (FR-6)
  // overview: ids this run has already accounted for in the activity feed. The
  // session CACHE cannot answer "is this new?" — App's onCreated upserts a
  // modal-created session before its session.meta event lands, and hydration
  // fills the cache with sessions that started long ago. Seeded silently by
  // hydration, written only here.
  const startedRef = useRef<Set<string>>(new Set());

  // overview: one feed entry. The session's name/project are captured HERE, at
  // record time, so a later rename or removal never rewrites history.
  const logActivity = (session: SessionMeta, kind: ActivityKind, detail: string) => {
    recordActivity({
      at: Date.now(),
      kind,
      sessionId: session.id,
      sessionName: session.name,
      projectId: session.projectId,
      detail,
    });
  };

  const updateDerived = (id: string, partial: Partial<SessionDerived>) => mergeDerived(id, partial);

  const dropDerived = (id: string) => {
    agentStatusRef.current.delete(id);
    seededRef.current.delete(id);
    startedRef.current.delete(id);
    dropDerivedFromCache(id);
    // split-session: the rail badges' per-session counts go with it.
    useStore.getState().dropPanelCounts(id);
    // multiple-shells FR-9: purge the session's shell roster/active-id/unread
    // bookkeeping too, mirroring the core's own dispose_session_shells.
    useShellStore.getState().removeSession(id);
    // …and the unsent composer draft, which outlives the view by design.
    clearDraft(id);
  };

  // Best-effort one-shot diff seed, deduped by id so it fires exactly once per
  // session regardless of cache-membership ordering (FR-6). Failure → leaves
  // fileCount null.
  const seedDiff = (id: string) => {
    if (seededRef.current.has(id)) return;
    seededRef.current.add(id);
    void diffGetSummary(id).then((res) => {
      if (res.ok) updateDerived(id, { fileCount: res.data.files.length });
    });
  };

  const reassignAfterRemoval = (id: string) => {
    reassignActiveSessionId(nextActiveAfterRemoval(useStore.getState().sessions, id));
    // split-session FR-20: this only ever runs for the LEFT pane's session, so
    // its removal ends the split — keeping the (already reassigned) left pane.
    // The right pane is never silently promoted into the left slot.
    if (useStore.getState().splitSessionId !== null) useStore.getState().unsplit('left');
  };

  const handleRemovedEvent = (id: string) => {
    const st = useStore.getState();
    if (st.activeSessionId === id) reassignAfterRemoval(id);
    removeSessionFromCache(id);
    dropDerived(id); // FR-7
    prunePaletteSession(id);
  };

  // Apply a successful session_list (mount hydration + retry) identically (FR-2/6/23).
  const applyHydration = (data: SessionMeta[]) => {
    setHydrationError(null);
    setSessions(data);
    // split-session FR-17: a persisted right-pane session that no longer exists
    // is dropped — the app opens single-pane and the record is rewritten clean.
    const persistedSplit = useStore.getState().splitSessionId;
    if (persistedSplit !== null && !data.some((s) => s.id === persistedSplit)) {
      useStore.getState().unsplit('left');
    }
    if (useStore.getState().activeSessionId === null && data[0]) setActiveSessionId(data[0].id);
    for (const session of data) {
      seedDiff(session.id);
      startedRef.current.add(session.id); // restored, not started — no feed entry (overview FR-28)
    }
  };

  const retryHydration = () => {
    void sessionList().then((res) => {
      if (res.ok) applyHydration(res.data);
      else setHydrationError(res.error);
    });
  };

  // Hydration + live event subscription (FR-2/FR-3/FR-5/FR-6/FR-7).
  useEffect(() => {
    let unlistenSession: (() => void) | undefined;
    let unlistenDiff: (() => void) | undefined;
    let cancelled = false;

    const ctx: SessionEventContext = {
      onMeta: (meta) => {
        upsertSession(meta);
        seedDiff(meta.id); // FR-6 — seedDiff dedups, so this fires once even though App upserts first
        // overview: the FIRST meta this run has seen for an id is a new session.
        // Hydration pre-seeds startedRef, so restored sessions stay silent.
        if (!startedRef.current.has(meta.id)) {
          startedRef.current.add(meta.id);
          logActivity(meta, 'session.started', '');
        }
      },
      onStatus: (sessionId, status) => {
        // overview: read the OLD status before patching, so the feed can tell a
        // finished turn from a session that merely settled.
        const prev = useStore.getState().sessions.find((session) => session.id === sessionId);
        patchStatus(sessionId, status);
        const kind = statusTransitionKind(prev?.status, status);
        if (kind && prev) {
          logActivity(prev, kind, kind === 'session.error' ? (prev.errorMessage ?? '') : '');
        }
      },
      onError: (sessionId, message) => {
        // overview FR-28/FR-17: the engine emits session.error and THEN
        // session.status, and never a fresh session.meta — so this is the only
        // place the failure message can be captured, landing before the status
        // event so it is already in the cache when the transition above reads
        // `prev`.
        patchError(sessionId, message);
      },
      onUsage: (sessionId, usedTokens, limitTokens) => {
        patchUsage(sessionId, usedTokens, limitTokens); // keeps the ctx figure live (FR-3)
      },
      onAgentUpdate: (agent) => {
        const owner = useStore.getState().sessions.find((session) => session.id === agent.sessionId);
        if (!owner) return; // drop post-removal (FR-7)
        let m = agentStatusRef.current.get(agent.sessionId);
        if (!m) {
          m = new Map();
          agentStatusRef.current.set(agent.sessionId, m);
        }
        const prevStatus = m.get(agent.id);
        m.set(agent.id, agent.status);
        updateDerived(agent.sessionId, { runningAgentCount: countRunning(m) }); // FR-5
        // overview: an agent SETTLING is feed-worthy; its intermediate updates
        // (every step re-emits) are not — hence the transition guard.
        if (prevStatus !== agent.status) {
          if (agent.status === 'done') logActivity(owner, 'agent.finished', agent.name);
          else if (agent.status === 'error') logActivity(owner, 'agent.failed', agent.name);
        }
      },
      onRemoved: (sessionId) => {
        const gone = useStore.getState().sessions.find((session) => session.id === sessionId);
        if (gone) logActivity(gone, 'session.removed', '');
        handleRemovedEvent(sessionId);
      },
    };

    void onSessionEvent((e) => handleSessionEvent(e, ctx)).then((unsub) => {
      if (cancelled) unsub();
      else unlistenSession = unsub;
    });

    // Per-session diff file count, matched on sessionId for ALL sessions (FR-6).
    void onDiffEvent((e) => {
      if (e.type === 'diff.changed') updateDerived(e.sessionId, { fileCount: e.fileCount });
    }).then((unsub) => {
      if (cancelled) unsub();
      else unlistenDiff = unsub;
    });

    void sessionList().then((res) => {
      if (cancelled) return;
      if (res.ok) applyHydration(res.data);
      else setHydrationError(res.error);
    });

    return () => {
      cancelled = true;
      if (unlistenSession) unlistenSession();
      if (unlistenDiff) unlistenDiff();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { hydrationError, retryHydration, reassignAfterRemoval, dropDerived };
}
