import { useEffect, useRef, useState } from 'react';
import type { AppError, SessionMeta, SessionStatus } from '../../../contract/common';
import { countRunning, isBusyStatus, type SessionDerived } from '../../../contract/fleet-board';
import { statusTransitionKind, type ActivityKind } from '../../../contract/overview';
import { diffGetSummary, onDiffEvent, sessionList } from '../../lib/api';
import { subscribeSessionEvents } from '../../lib/session-events';
import { useStore } from '../../lib/store';
import { clearDraft } from '../conversation/composer-draft';
import { clearPending, resolvePrompt } from '../conversation/pending-queue';
import { prunePaletteSession } from '../palette/paletteData';
import { useShellStore } from '../shell/shellStore';
import { activityLabel } from './activity';
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
 * transcript-perf FR-12: the pending-queue half of `ctx.onMessageUser` —
 * factored out (rather than the inline `resolvePrompt(sessionId, blockId)`
 * this replaces) so the wiring itself, not just pending-queue's own map ops
 * (pending-queue.test.ts), has a test that does not need to render the hook.
 */
export function drainQueueOnMessageUser(sessionId: string, blockId: string): void {
  resolvePrompt(sessionId, blockId);
}

/**
 * transcript-perf FR-14: the pending-queue half of `ctx.onError` — the hook
 * also calls `patchError` in the same callback; this is only the part that
 * touches the queue.
 */
export function clearQueueOnSessionError(sessionId: string): void {
  clearPending(sessionId);
}

/**
 * transcript-perf FR-14: the pending-queue half of `ctx.onCleared` — the hook
 * also calls `clearRosterSignals` in the same callback; this is only the part
 * that touches the queue.
 */
export function clearQueueOnSessionCleared(sessionId: string): void {
  clearPending(sessionId);
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
  // split-by-4 FR-27: the removal fallback takes the RAW reassignment —
  // `setActiveSessionId` would read "the nearest remaining session happens to be
  // another pane's" as a pane SWAP (FR-19) and smuggle the removed id back into
  // the grid.
  const reassignActiveSessionId = useStore((s) => s.reassignActiveSessionId);
  const mergeDerived = useStore((s) => s.mergeDerived);
  const dropDerivedFromCache = useStore((s) => s.dropDerived);
  const recordActivity = useStore((s) => s.recordActivity);
  // design 12b: the roster's live per-row signals — activity line, turn clock
  // and the parked ask a WAITING row answers inline.
  const setSessionActivity = useStore((s) => s.setSessionActivity);
  const markRunningSince = useStore((s) => s.markRunningSince);
  const setPendingAsk = useStore((s) => s.setPendingAsk);
  const clearRosterSignals = useStore((s) => s.clearRosterSignals);

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
    clearRosterSignals(id); // design 12b: activity line / turn clock / parked ask
    // split-session: the rail badges' per-session counts go with it.
    useStore.getState().dropPanelCounts(id);
    // …and any extension log-tail streams this session owned, so a capped log
    // buffer never sits retained under a panel id that later gets reused.
    useStore.getState().dropSessionExtStreams(id);
    // multiple-shells FR-9: purge the session's shell roster/active-id/unread
    // bookkeeping too, mirroring the core's own dispose_session_shells.
    useShellStore.getState().removeSession(id);
    // …and the unsent composer draft, which outlives the view by design.
    clearDraft(id);
    // transcript-perf FR-15: …and the pending-queue strip, same reason.
    clearPending(id);
  };

  // The full summary — file count AND the line totals design 12b's settled row
  // shows. Failure leaves all three null, which renders as "unknown", not zero.
  const readDiff = (id: string) => {
    void diffGetSummary(id).then((res) => {
      if (res.ok) {
        updateDerived(id, {
          fileCount: res.data.files.length,
          addedLines: res.data.totalAdd,
          deletedLines: res.data.totalDel,
        });
      }
    });
  };

  // Best-effort one-shot diff seed, deduped by id so it fires exactly once per
  // session regardless of cache-membership ordering (FR-6).
  const seedDiff = (id: string) => {
    if (seededRef.current.has(id)) return;
    seededRef.current.add(id);
    readDiff(id);
  };

  // split-by-4 FR-27: this only ever runs for PANE 0's session. The pane keeps
  // its slot with the reassigned session (the grid is not torn down over one
  // removal); `reassignActiveSessionId` drops the duplicate pane if the fallback
  // happened to land on a session another pane was already showing.
  const reassignAfterRemoval = (id: string) => {
    reassignActiveSessionId(nextActiveAfterRemoval(useStore.getState().sessions, id));
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
    // split-by-4 FR-24: a persisted pane whose session no longer exists is
    // dropped and the record rewritten clean; if that empties the list the app
    // opens single-pane. An EMPTY pane is not stale — it is a layout the user
    // chose, and it survives the reload waiting for its session.
    for (const pane of useStore.getState().extraPanes) {
      if (pane.kind === 'session' && pane.sessionId !== null && !data.some((s) => s.id === pane.sessionId)) {
        useStore.getState().removeSession(pane.sessionId);
      }
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
        // design 12b: the RUNNING row's elapsed runs from the moment the turn
        // went busy and keeps running ACROSS a parked approval — the process is
        // still alive and the clock is what says how long it has been waiting.
        // Settling stops it and retires the activity line with it.
        if (isBusyStatus(status)) {
          if (!useStore.getState().runningSince.has(sessionId)) markRunningSince(sessionId, Date.now());
        } else {
          markRunningSince(sessionId, null);
          setSessionActivity(sessionId, null);
          // design 12b: a SETTLED row is the only one that shows +/− line totals,
          // and `diff.changed` carries only a count — so the summary is re-read
          // exactly when the row that needs it appears. Re-reading on every
          // diff.changed instead would run a full git diff per edit per session.
          if (prev && isBusyStatus(prev.status)) readDiff(sessionId);
        }
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
        // transcript-perf FR-14: the core's own s.queue.clear() runs on EVERY
        // errored turn end — transient (USAGE_LIMIT, session lives on) and
        // terminal alike — so this fires on every session.error regardless of
        // code, matching it exactly.
        clearQueueOnSessionError(sessionId);
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
        // fix-agent-view FR-21: the FIRST update for an agent puts its chip in
        // that session's strip on its own — no trip through the AGENTS view to
        // click the card. This map is exactly the "have we seen this agent"
        // record (it is per session and dropped with the session in
        // `dropDerived`), so the tab is offered once and once only: closing the
        // chip, or letting the cap evict it, is final for that agent.
        if (prevStatus === undefined) {
          useStore.getState().trackAgentTab(agent.sessionId, {
            id: agent.id,
            name: agent.name,
            status: agent.status,
          });
        }
        m.set(agent.id, agent.status);
        updateDerived(agent.sessionId, { runningAgentCount: countRunning(m) }); // FR-5
        // overview: an agent SETTLING is feed-worthy; its intermediate updates
        // (every step re-emits) are not — hence the transition guard.
        if (prevStatus !== agent.status) {
          if (agent.status === 'done') logActivity(owner, 'agent.finished', agent.name);
          else if (agent.status === 'error') logActivity(owner, 'agent.failed', agent.name);
        }
      },
      // design 12b: a new turn retires the previous one's activity line and
      // restarts the clock — the status event may not arrive first.
      onTurnStart: (sessionId) => {
        setSessionActivity(sessionId, null);
        markRunningSince(sessionId, Date.now());
      },
      // transcript-perf FR-12: the single, always-listening resolution point
      // for a queued prompt — fires whether or not this session's own SESSION
      // tab happens to be mounted right now.
      onMessageUser: (sessionId, blockId) => drainQueueOnMessageUser(sessionId, blockId),
      onToolStart: (sessionId, tool, summary) => {
        const line = activityLabel(tool, summary);
        setSessionActivity(sessionId, line === '' ? null : line);
      },
      onPermissionAsked: (sessionId, blockId, ask) => {
        setPendingAsk(sessionId, { blockId, ask });
      },
      onPermissionResolved: (sessionId, blockId) => {
        // Only the ask actually on screen: a late resolution for an older block
        // must not clear the row's CURRENT one.
        if (useStore.getState().pendingAsk.get(sessionId)?.blockId === blockId) setPendingAsk(sessionId, null);
      },
      onCleared: (sessionId) => {
        clearRosterSignals(sessionId);
        clearQueueOnSessionCleared(sessionId); // transcript-perf FR-14
      },
      onRemoved: (sessionId) => {
        const gone = useStore.getState().sessions.find((session) => session.id === sessionId);
        if (gone) logActivity(gone, 'session.removed', '');
        handleRemovedEvent(sessionId);
      },
    };

    // transcript-scale FR-21: this is the fleet-wide '*' consumer — every
    // session's own events, through the one router subscription.
    void subscribeSessionEvents('*', (e) => handleSessionEvent(e, ctx)).then((unsub) => {
      if (cancelled) unsub();
      else unlistenSession = unsub;
    });

    // Per-session diff file count, matched on sessionId for ALL sessions (FR-6).
    void onDiffEvent((e) => {
      if (e.type !== 'diff.changed') return;
      updateDerived(e.sessionId, { fileCount: e.fileCount });
      // A settled session whose tree changed under it (a commit from the shell,
      // an external edit) has no status event coming to trigger the re-read, so
      // it happens here. A BUSY one is left alone — its row shows no totals.
      // This re-read is only safe because `diff_get_summary` does NOT broadcast
      // (FR-17 amended): while it did, this line fed its own listener and every
      // idle session spun `git status` + `git diff --numstat` forever — the
      // lag that grew with the number of open sessions. Anything added here
      // that invokes a diff command must stay broadcast-free for the same
      // reason.
      const owner = useStore.getState().sessions.find((x) => x.id === e.sessionId);
      if (owner && !isBusyStatus(owner.status)) readDiff(e.sessionId);
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
