// extensions store slice (specs/extensions.md §6): the registry as the frontend
// sees it, the Extensions modal flag, which extension tabs are open, and the
// live `log-tail` streams. Split per domain like every other slice — see
// store.ts for the composition root.
//
// Why the streams live HERE and not inside the tab's component: FR-43 gives a
// stream a 10 s grace period after its tab stops being active, and leaving the
// tab unmounts the view (MainPaneBody renders only the active branch). A buffer
// owned by the component would therefore be destroyed by the very transition
// the grace period exists to survive. The cursor state of a paginated table has
// no such rule (FR-34 discards it on exactly those transitions), so that one
// stays in the section component.
//
// Cross-slice coupling: `setExtensions`/`closeExtTab` write agentTabStore's
// `mainTab` — FR-8 requires a disabled extension's tab to close in the same
// turn as the toggle write, and that tab is a `MainTab` value.

import type { StateCreator } from 'zustand';
import type { AppError } from '../../contract/common';
import type { ExtensionId, ExtensionInfo, PanelId, StreamId } from '../../contract/extensions';
import { EMPTY_LOG, appendLogLines, extIdFromTab, extTabId, type LogBuffer } from '../features/extensions/extensions';
import { extensionsCloseStream } from './api';
import type { AppState, MainTab } from './store';

/** One panel's live (or just-ended) `log-tail` stream. */
export interface ExtStreamState {
  /** Core-minted; null while the open call is in flight or after the end (FR-44). */
  streamId: StreamId | null;
  /** FR-38: the row-selected value this stream was opened for. */
  token: string | null;
  /** The root it was opened against, so a session change can tell it apart. */
  root: string | null;
  /**
   * FR-12: the session it was opened against, null for a fleet panel. Two
   * sessions can share a root, so `root` alone cannot tell a session change
   * apart from a no-op — this is what actually drives the re-scope.
   */
  sessionId: string | null;
  log: LogBuffer;
  /** FR-45: the process source's exit code, rendered BELOW the retained buffer. */
  exitCode: number | null;
  error: AppError | null;
  starting: boolean;
}

function freshStream(root: string | null, sessionId: string | null, token: string | null): ExtStreamState {
  return { streamId: null, token, root, sessionId, log: EMPTY_LOG, exitCode: null, error: null, starting: true };
}

export interface ExtensionsSlice {
  /** The list `extensions_list` last resolved, for the root it was queried with. */
  extensions: ExtensionInfo[];
  setExtensions: (list: ExtensionInfo[]) => void;

  /** FR-56: the Extensions modal (⌘K + titlebar). */
  extensionsOpen: boolean;
  setExtensionsOpen: (open: boolean) => void;

  /**
   * FR-13: extensions whose tab has been opened in this app run. A sticky tab
   * survives a session change into a root that no longer detects it; it is
   * dropped by an explicit close (FR-16) and by a toggle-off (FR-8).
   */
  extStickyIds: ExtensionId[];
  openExtTab: (extensionId: ExtensionId) => void;
  closeExtTab: (extensionId: ExtensionId) => void;

  /** FR-42: at most one live stream per panel, keyed by panel id. */
  extStreams: Record<PanelId, ExtStreamState>;
  startExtStream: (panelId: PanelId, root: string | null, sessionId: string | null, token: string | null) => void;
  attachExtStream: (panelId: PanelId, streamId: StreamId) => void;
  appendExtStream: (streamId: StreamId, lines: string[]) => void;
  endExtStream: (streamId: StreamId, exitCode: number | null) => void;
  failExtStream: (streamId: StreamId, error: AppError) => void;
  /** The open call itself refused — there is no streamId to address it by. */
  failExtStreamPanel: (panelId: PanelId, error: AppError) => void;
  dropExtStream: (panelId: PanelId) => void;
}

/** The panel a streamId currently belongs to, or null — FR-44's ownership check. */
function panelOfStream(streams: Record<PanelId, ExtStreamState>, streamId: StreamId): PanelId | null {
  for (const [panelId, s] of Object.entries(streams)) if (s.streamId === streamId) return panelId;
  return null;
}

function withoutPanels(streams: Record<PanelId, ExtStreamState>, keep: (panelId: PanelId) => boolean) {
  const next: Record<PanelId, ExtStreamState> = {};
  for (const [panelId, s] of Object.entries(streams)) if (keep(panelId)) next[panelId] = s;
  return next;
}

/**
 * FR-16/FR-8/FR-12: every panel matched by `remove` has its live stream closed
 * on the core BEFORE its entry is dropped from the map — otherwise the
 * streamId is gone the instant `LogTailSection` unmounts and its grace-timer's
 * ownership check (`now.streamId === streamId`) can never fire. Exported for
 * sessionsStore's `setActiveSessionId`, which uses this to discard every
 * project-scoped stream immediately on a real session change (FR-12) instead
 * of leaving it to FR-43's 10 s grace timer, which exists for the tab going
 * inactive, not for the session moving on.
 */
export function closeStreamsForRemovedPanels(
  streams: Record<PanelId, ExtStreamState>,
  remove: (panelId: PanelId) => boolean,
): Record<PanelId, ExtStreamState> {
  for (const [panelId, s] of Object.entries(streams)) {
    if (remove(panelId) && s.streamId !== null) void extensionsCloseStream({ streamId: s.streamId }).catch(() => {});
  }
  return withoutPanels(streams, (panelId) => !remove(panelId));
}

export const createExtensionsSlice: StateCreator<AppState, [], [], ExtensionsSlice> = (set) => ({
  extensions: [],
  setExtensions: (list) =>
    set((s) => {
      // FR-8: off means off, in the same turn as the write — the tab closes, its
      // sticky mark goes, and every stream it owned is dropped.
      const disabled = new Set<string>(list.filter((e) => !e.enabled).map((e) => e.id));
      if (disabled.size === 0) return { extensions: list };
      const activeExt = extIdFromTab(s.mainTab);
      return {
        extensions: list,
        extStickyIds: s.extStickyIds.filter((id) => !disabled.has(id)),
        extStreams: closeStreamsForRemovedPanels(s.extStreams, (panelId) => disabled.has(panelId.split(':')[0])),
        mainTab: activeExt !== null && disabled.has(activeExt) ? ('session' as MainTab) : s.mainTab,
      };
    }),

  extensionsOpen: false,
  setExtensionsOpen: (extensionsOpen) => set({ extensionsOpen }),

  extStickyIds: [],
  openExtTab: (extensionId) =>
    set((s) => ({
      extStickyIds: s.extStickyIds.includes(extensionId) ? s.extStickyIds : [...s.extStickyIds, extensionId],
      mainTab: extTabId(extensionId) as MainTab,
    })),
  // FR-16: closing kills every stream the tab owned and drops its cursors (the
  // sections unmount with the tab). It does NOT touch the toggle — the tab is
  // offered again on the next strip render whenever the root still detects it.
  closeExtTab: (extensionId) =>
    set((s) => ({
      extStickyIds: s.extStickyIds.filter((id) => id !== extensionId),
      extStreams: closeStreamsForRemovedPanels(s.extStreams, (panelId) => panelId.split(':')[0] === extensionId),
      mainTab: s.mainTab === extTabId(extensionId) ? ('session' as MainTab) : s.mainTab,
    })),

  extStreams: {},
  // FR-42: opening a stream for a panel that already has one replaces it — a
  // different target is the same operation, and the buffer restarts empty.
  startExtStream: (panelId, root, sessionId, token) =>
    set((s) => ({ extStreams: { ...s.extStreams, [panelId]: freshStream(root, sessionId, token) } })),
  attachExtStream: (panelId, streamId) =>
    set((s) => {
      const prev = s.extStreams[panelId];
      if (!prev) return {};
      return { extStreams: { ...s.extStreams, [panelId]: { ...prev, streamId, starting: false } } };
    }),
  // FR-44: a chunk whose streamId no panel currently owns is dropped, so a late
  // chunk from a killed stream can never append to a new one.
  appendExtStream: (streamId, lines) =>
    set((s) => {
      const panelId = panelOfStream(s.extStreams, streamId);
      if (panelId === null) return {};
      const prev = s.extStreams[panelId];
      return { extStreams: { ...s.extStreams, [panelId]: { ...prev, log: appendLogLines(prev.log, lines) } } };
    }),
  // FR-45: the buffer is RETAINED — the lines already read are what the user
  // wanted; the exit renders below them.
  endExtStream: (streamId, exitCode) =>
    set((s) => {
      const panelId = panelOfStream(s.extStreams, streamId);
      if (panelId === null) return {};
      const prev = s.extStreams[panelId];
      return { extStreams: { ...s.extStreams, [panelId]: { ...prev, streamId: null, starting: false, exitCode } } };
    }),
  failExtStream: (streamId, error) =>
    set((s) => {
      const panelId = panelOfStream(s.extStreams, streamId);
      if (panelId === null) return {};
      const prev = s.extStreams[panelId];
      return { extStreams: { ...s.extStreams, [panelId]: { ...prev, streamId: null, starting: false, error } } };
    }),
  failExtStreamPanel: (panelId, error) =>
    set((s) => {
      const prev = s.extStreams[panelId];
      if (!prev) return {};
      return { extStreams: { ...s.extStreams, [panelId]: { ...prev, streamId: null, starting: false, error } } };
    }),
  dropExtStream: (panelId) => set((s) => ({ extStreams: withoutPanels(s.extStreams, (id) => id !== panelId) })),
});
