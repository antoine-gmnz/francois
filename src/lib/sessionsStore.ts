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
import type { SessionId, SessionMeta } from '../../contract/common';
import { dropSessionTabs, mainTabAfterClose } from '../features/agents/agent-tab';
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
