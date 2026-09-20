// sessions store slice: the app-wide session cache (written by
// sessions-sidebar, read by every pane) plus the sidebar's own
// selection/filter state. Split out of the former monolithic store.ts — see
// store.ts for the composition root.
//
// Cross-slice coupling: `setActiveSessionId` moves agentTabStore's `mainTab`
// off a dynamic tab on a session SWITCH, and `removeSession` drops the removed
// session's tabs (fix-agent-view FR-8/FR-9). The same switch also closes every
// project-scoped extensions log-tail stream (extensions FR-12) — two sessions
// can share a root, so a stream is scoped to the SESSION, not the root, and a
// real change discards it immediately rather than leaving it to FR-43's 10 s
// grace timer (that grace is for the tab going inactive, not the session
// moving on).

import type { StateCreator } from 'zustand';
import type { RuntimeEventEnvelope, SessionId, SessionMeta } from '../../contract/common';
import { dropSessionTabs, mainTabAfterClose } from '../features/agents/agent-tab';
// pi-turn-controls: queue.changed/compaction/retry route to their OWN
// per-session stores (never the fleet cache) — see applyRuntimeEvent below.
import { clearQueueState, setQueueEntries } from '../features/conversation/pi-queue';
import { clearTurnProgress, setCompactionProgress, setRetryProgress } from '../features/conversation/pi-turn-progress';
// pi-models-metrics: model.changed/metrics DO land on the fleet cache — the
// run chip, roster context bar and every other SessionMeta reader need them.
import { modelInfoFromRuntimeDescriptor } from '../features/sessions/runtime-model';
import type { MainTab } from './agentTabStore';
import { closeStreamsForRemovedPanels } from './extensionsStore';
import {
  clampPaneIndex,
  panesWithout,
  persistedLeftPane,
  persistedRightPane,
  persistSplitState,
  layoutRegime,
  type PaneSlot,
} from './layoutStore';
import type { AppState } from './store';

export interface SessionsSlice {
  // session cache (owned/written by sessions-sidebar, read by all)
  sessions: SessionMeta[];
  setSessions: (s: SessionMeta[]) => void;
  upsertSession: (m: SessionMeta) => void;
  patchStatus: (id: SessionId, status: string) => void;
  /**
   * overview FR-28: record a `session.error` message onto the cached SessionMeta.
   * The engine emits session.error and THEN session.status, and never a fresh
   * session.meta — so without this the message is dropped, the activity feed logs
   * an empty detail, and NEEDS ATTENTION falls back to the generic "session
   * failed" for every live failure.
   */
  patchError: (id: SessionId, message: string) => void;
  patchUsage: (id: SessionId, used: number, limit: number) => void;
  /** Applies sanitized, ordered child state only when it belongs to the live connection. */
  applyRuntimeEvent: (event: RuntimeEventEnvelope) => void;
  removeSession: (id: SessionId) => void;

  // sessions-sidebar store slice (§5)
  activeSessionId: SessionId | null;
  setActiveSessionId: (id: SessionId | null) => void;
  /**
   * split-by-4 FR-27: the post-REMOVAL fallback — a plain reassignment.
   * unbound-panes FR-5 deletes FR-27's own de-duplication half (a session may
   * now legitimately sit in more than one pane), so this is now IDENTICAL to
   * `setActiveSessionId` — kept as its own action because callers reach for it
   * by name after a removal (fleet-board's reassignAfterRemoval).
   */
  reassignActiveSessionId: (id: SessionId | null) => void;
  sidebarFilter: string | null;
  setSidebarFilter: (f: string | null) => void;
}

/**
 * The plain session switch — pane 0's ONLY assignment path.
 *
 * unbound-panes FR-5: split-by-4 FR-19's swap-on-reassign is gone. A session
 * already showing in another pane is simply duplicated onto pane 0 rather than
 * swapped out of that pane, exactly like `assignToFocusedPane` (layoutStore.ts).
 *
 * fix-agent-view FR-8 (supersedes agent-tab FR-14): a switch no longer CLOSES
 * anything. Tabs are keyed by session, so the outgoing session keeps its own and
 * gets them back when you return; pane 0 just cannot stay on a tab belonging to
 * the session it is leaving, hence the `mainTabAfterClose` fold — which leaves a
 * built-in `diff`/`shell` tab alone, as before. Re-selecting the session already
 * active stays a pure no-op.
 */
function switchTo(s: AppState, activeSessionId: SessionId | null): Partial<AppState> {
  return s.activeSessionId === activeSessionId
    ? { activeSessionId }
    : { activeSessionId, mainTab: mainTabAfterClose(s.mainTab, null) as MainTab, extStreams: closedProjectStreams(s) };
}

/**
 * extensions FR-12: every PROJECT-scoped log-tail stream dies on a session
 * change — a project-scoped stream's `sessionId` is never null (see
 * `extensionsStore.freshStream`), a fleet panel's always is, so a fleet stream
 * is left running here. Matches ExtensionView's own "fleet takes no session"
 * rule.
 */
function closedProjectStreams(s: AppState): AppState['extStreams'] {
  return closeStreamsForRemovedPanels(s.extStreams, (panelId) => s.extStreams[panelId]?.sessionId !== null);
}

/**
 * split-by-4 FR-27: persist a shortened pane list and re-clamp the focused
 * index. Only the pane LIST changes — pane 0 (`activeSessionId`/`mainTab`) is
 * the caller's business — but dropping to one pane has to unfold the columns
 * the split folded (FR-5).
 */
function compact(s: AppState, extraPanes: PaneSlot[]): Partial<AppState> {
  const focusedPaneIndex = clampPaneIndex(s.focusedPaneIndex, extraPanes.length + 1);
  persistSplitState({ extraPanes, focusedPaneIndex });
  const regime = layoutRegime(extraPanes.length + 1);
  return {
    extraPanes,
    focusedPaneIndex,
    showLeftPane: regime === 'grid' ? false : persistedLeftPane(),
    showRightPane: regime === 'single' ? persistedRightPane() : false,
  };
}

export const createSessionsSlice: StateCreator<AppState, [], [], SessionsSlice> = (set) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
  upsertSession: (m) =>
    set((s) => {
      const i = s.sessions.findIndex((x) => x.id === m.id);
      if (i === -1) return { sessions: [...s.sessions, m] }; // append on create (FR-2)
      // pi-session-durability: a reconnect refused with the SAME recovery
      // state (e.g. a Retry that still finds the native file missing)
      // republishes an otherwise-identical session.meta — bail like every
      // other patch here rather than mint a new array for a no-op update.
      // Both sides are plain JSON off the same wire shape, so value equality
      // is a safe stand-in for a hand-rolled field-by-field comparison.
      if (JSON.stringify(s.sessions[i]) === JSON.stringify(m)) return {};
      const next = s.sessions.slice();
      next[i] = m; // update in place, position preserved
      return { sessions: next };
    }),
  // The three patches bail without minting a new `sessions` array when the
  // patch changes nothing (unknown id, or the value already cached) — the same
  // no-op guard rosterStore/overviewStore carry. Without it every duplicate
  // status/usage event from ANY session invalidated the array reference and
  // re-rendered all whole-array subscribers (App, Sidebar, UsageMeters), which
  // is what made typing lag once several sessions streamed at once. Only the
  // touched entry is replaced, so per-session `find` selectors stay
  // reference-stable for everyone else.
  patchStatus: (id, status) =>
    set((s) => {
      const i = s.sessions.findIndex((x) => x.id === id);
      if (i === -1 || s.sessions[i].status === status) return {};
      const next = s.sessions.slice();
      next[i] = { ...next[i], status: status as SessionMeta['status'] };
      return { sessions: next };
    }),
  patchError: (id, message) =>
    set((s) => {
      const i = s.sessions.findIndex((x) => x.id === id);
      if (i === -1 || s.sessions[i].errorMessage === message) return {};
      const next = s.sessions.slice();
      next[i] = { ...next[i], errorMessage: message };
      return { sessions: next };
    }),
  patchUsage: (id, used, limit) =>
    set((s) => {
      const i = s.sessions.findIndex((x) => x.id === id);
      if (i === -1) return {};
      const cur = s.sessions[i];
      // Identical figures = a duplicate event, not a turn — skip the
      // lastActivityAt stamp too, or the "idle Xh" readout would reset on noise.
      if (cur.contextUsedTokens === used && cur.contextLimitTokens === limit) return {};
      const next = s.sessions.slice();
      next[i] = { ...cur, contextUsedTokens: used, contextLimitTokens: limit, lastActivityAt: Date.now() };
      return { sessions: next };
    }),
  applyRuntimeEvent: (event) =>
    set((s) => {
      // Transcript events belong to the conversation reducer. Bail before
      // mapping so fleet subscribers retain the sessions array reference.
      switch (event.event.kind) {
        case 'message.user':
        case 'assistant.delta':
        case 'assistant.complete':
        case 'tool.update':
        case 'notice':
          return {};
        // pi-turn-controls: these three never touch the `sessions` array — they
        // route to their own per-session stores (./pi-queue, ./pi-turn-progress)
        // so the composer/queue strip re-renders without invalidating the fleet
        // cache for every OTHER subscriber. Same generation guard as the map
        // below: a stale child must never repaint a session that moved on.
        case 'queue.changed':
        case 'compaction':
        case 'retry': {
          const owner = s.sessions.find((session) => session.id === event.sessionId);
          if (!owner || owner.runtimeGeneration !== event.generation) return {};
          if (event.event.kind === 'queue.changed') setQueueEntries(event.sessionId, event.event.entries);
          else if (event.event.kind === 'compaction') setCompactionProgress(event.sessionId, event.event);
          else setRetryProgress(event.sessionId, event.event);
          return {};
        }
        case 'capabilities':
        case 'failure':
        case 'run.state':
        case 'model.changed':
        case 'metrics':
          break;
        default: {
          const unhandled: never = event.event;
          return unhandled;
        }
      }
      return {
        sessions: s.sessions.map((session) => {
          // A fresh session.meta establishes the new generation. An old child is
          // allowed to finish emitting, but it must never repaint the new child.
          if (session.id !== event.sessionId || session.runtimeGeneration !== event.generation) return session;
          switch (event.event.kind) {
          case 'capabilities':
            return { ...session, effectiveCapabilities: event.event.capabilities };
          case 'failure':
            return { ...session, errorMessage: event.event.failure.message };
          // pi-models-metrics FR-5/FR-6: published only AFTER the core read the
          // switch back from the runtime — `model`/`runtimeModel` and `effort`
          // are replaced wholesale with the ACCEPTED values, never guessed at
          // optimistically. Absent `effort` clears any previous level, the same
          // "no effort" state a model with no advertised levels always has.
          case 'model.changed':
            return {
              ...session,
              model: modelInfoFromRuntimeDescriptor(event.event.model, session.accountId),
              runtimeModel: event.event.model.ref,
              effort: event.event.effort,
            };
          // pi-models-metrics FR-7: the runtime's own usage snapshot, stored
          // verbatim — never synthesized from contextUsedTokens/contextLimitTokens.
          case 'metrics':
            return { ...session, metrics: event.event.metrics };
          case 'run.state':
            return {
              ...session,
              status:
                event.event.state === 'failed'
                  ? 'error'
                  : event.event.state === 'idle'
                    ? 'idle'
                    : event.event.state === 'starting'
                      ? 'starting'
                      : 'running',
            };
          // pi-transcript-events: transcript-block kinds are owned by the
          // conversation-view transcript reducer (conversation-blocks.ts), not
          // the session cache — no session field changes here. Listed
          // explicitly (rather than a `default`) so adding a sixth
          // RuntimeEventPayload kind fails typecheck here instead of
          // silently falling through unhandled.
          }
          // The exhaustive guard above makes this unreachable at runtime, but
          // TypeScript does not carry that narrowing into the map callback.
          return session;
        }),
      };
    }),
  removeSession: (id) =>
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      // split-by-4 FR-27: the session is gone from every SESSION pane it sat in
      // (shell panes never match — panesWithout is union-aware) and the grid
      // compacts. (Pane 0's own removal is handled by fleet-board's
      // reassignAfterRemoval below, which reassigns first — pane 1 is never
      // silently promoted into pane 0 by a removal that has a fallback.)
      const extraPanes = panesWithout(s.extraPanes, id);
      // fix-agent-view FR-9: a removed session takes its dynamic tabs with it —
      // nothing else would ever collect them, since the map is keyed by a
      // session id that no longer resolves.
      const agentTabs = dropSessionTabs(s.agentTabs, id);
      // pi-turn-controls: …and its queue ledger + compaction/retry progress —
      // a no-op for every non-Pi session, since neither map ever held an entry.
      clearQueueState(id);
      clearTurnProgress(id);
      if (extraPanes.length === s.extraPanes.length) return { sessions, agentTabs };
      return { sessions, agentTabs, ...compact(s, extraPanes) };
    }),

  activeSessionId: null,
  // The USER's pick of the left pane's session (agent-tab FR-14's tab reset
  // lives in switchTo above). unbound-panes FR-5: a PLAIN assign — no swap, no
  // duplicate check. `reassignActiveSessionId` below is now identical.
  setActiveSessionId: (activeSessionId) => set((s) => switchTo(s, activeSessionId)),
  reassignActiveSessionId: (activeSessionId) => set((s) => switchTo(s, activeSessionId)),
  sidebarFilter: null,
  setSidebarFilter: (sidebarFilter) => set({ sidebarFilter }),
});
