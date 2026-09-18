// multiple-shells §6: the frontend shell store — grown from one ShellUiState
// per session to the whole per-session roster + active chip + unread marks. A
// standalone zustand store (not folded into the composed `useStore`, exactly
// like command-palette's own local stores) since nothing outside this feature
// reads it directly — every other surface only ever sees the SHELL tab.
//
// The single global francois://shell/event listener (initShellEvents, called
// once from App's mount effect) keeps `alive`/`exitCode` and the unread marks
// current regardless of what is mounted; per-mount xterm rendering (writing
// bytes, the exited dim line) stays in ShellTerminal.

import { create } from 'zustand';
import type { SessionId } from '../../../contract/common';
import type { ShellId, ShellInfo } from '../../../contract/shell-terminal';
import { onShellEvent } from '../../lib/api';
import { isShellVisible } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';

export interface ShellStoreState {
  /** Core order (FR-1), refreshed by every `shell_ensure` response. */
  shells: Record<SessionId, ShellInfo[]>;
  /** FR-15: the chip the user left on, remembered per session for the app's lifetime. */
  activeShellId: Record<SessionId, ShellId>;
  /** FR-14: shells that emitted output (or exited) while not displayed. */
  unread: Record<ShellId, true>;
  /**
   * command-palette "Shell: rename" (FR-22): SecondaryStep has no free-text
   * input, so the command flags the session's displayed shell here and the
   * chip enters inline-rename mode (§8) the instant it next renders, then
   * clears the flag. See the frontend handoff for this assumption.
   */
  renameRequest: ShellId | null;

  setShells: (sessionId: SessionId, shells: ShellInfo[]) => void;
  upsertShell: (sessionId: SessionId, shell: ShellInfo) => void;
  removeShell: (sessionId: SessionId, shellId: ShellId) => void;
  /** Merges alive/exitCode onto an existing entry in place — position and name untouched (FR-17). */
  setShellStatus: (sessionId: SessionId, shellId: ShellId, alive: boolean, exitCode?: number) => void;
  setActiveShellId: (sessionId: SessionId, shellId: ShellId) => void;
  clearActiveShellId: (sessionId: SessionId) => void;
  /** FR-14: emits only on the false → true transition. */
  markUnread: (shellId: ShellId) => void;
  clearUnread: (shellId: ShellId) => void;
  requestRename: (shellId: ShellId) => void;
  clearRenameRequest: () => void;
  /**
   * FR-9: purges every trace of a removed session's shells — `shells[sessionId]`,
   * `activeShellId[sessionId]`, and any `unread` entries for those shellIds.
   * Mirrors the core's own `dispose_session_shells`; called from the session-
   * removal path (session.removed → useSessionFleetSync's dropDerived).
   */
  removeSession: (sessionId: SessionId) => void;
}

export const useShellStore = create<ShellStoreState>((set, get) => ({
  shells: {},
  activeShellId: {},
  unread: {},
  renameRequest: null,

  setShells: (sessionId, shells) => set((s) => ({ shells: { ...s.shells, [sessionId]: shells } })),

  upsertShell: (sessionId, shell) =>
    set((s) => {
      const list = s.shells[sessionId] ?? [];
      const i = list.findIndex((x) => x.id === shell.id);
      const next = i >= 0 ? list.map((x, idx) => (idx === i ? shell : x)) : [...list, shell];
      return { shells: { ...s.shells, [sessionId]: next } };
    }),

  removeShell: (sessionId, shellId) =>
    set((s) => {
      const list = s.shells[sessionId];
      if (!list) return {};
      return { shells: { ...s.shells, [sessionId]: list.filter((x) => x.id !== shellId) } };
    }),

  setShellStatus: (sessionId, shellId, alive, exitCode) =>
    set((s) => {
      const list = s.shells[sessionId];
      if (!list) return {};
      const i = list.findIndex((x) => x.id === shellId);
      if (i < 0) return {};
      const next = list.slice();
      next[i] = { ...next[i], alive, exitCode };
      return { shells: { ...s.shells, [sessionId]: next } };
    }),

  setActiveShellId: (sessionId, shellId) =>
    set((s) => ({ activeShellId: { ...s.activeShellId, [sessionId]: shellId } })),

  clearActiveShellId: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.activeShellId)) return {};
      const next = { ...s.activeShellId };
      delete next[sessionId];
      return { activeShellId: next };
    }),

  // Bail BEFORE calling set on the no-op path: initShellEvents calls this for
  // EVERY shell.data chunk of every non-displayed shell (up to ~125/s for a
  // noisy hidden shell), and `set` notifies every subscriber even when the
  // returned patch is `{}` — the hot path must never reach it once already true.
  markUnread: (shellId) => {
    if (get().unread[shellId]) return;
    set((s) => ({ unread: { ...s.unread, [shellId]: true } }));
  },

  clearUnread: (shellId) =>
    set((s) => {
      if (!s.unread[shellId]) return {};
      const next = { ...s.unread };
      delete next[shellId];
      return { unread: next };
    }),

  requestRename: (shellId) => set({ renameRequest: shellId }),
  clearRenameRequest: () => set({ renameRequest: null }),

  removeSession: (sessionId) =>
    set((s) => {
      const list = s.shells[sessionId];
      if (!list) return {};
      const shellIds = new Set(list.map((x) => x.id));

      const shells = { ...s.shells };
      delete shells[sessionId];

      const activeShellId = { ...s.activeShellId };
      delete activeShellId[sessionId];

      let unread = s.unread;
      for (const id of shellIds) {
        if (unread[id]) {
          if (unread === s.unread) unread = { ...s.unread };
          delete unread[id];
        }
      }

      return { shells, activeShellId, unread };
    }),
}));

// ---------- selectors ----------

const EMPTY_SHELLS: ShellInfo[] = [];

export function useShellsFor(sessionId: SessionId | null): ShellInfo[] {
  return useShellStore((s) => (sessionId ? (s.shells[sessionId] ?? EMPTY_SHELLS) : EMPTY_SHELLS));
}

export function useActiveShellId(sessionId: SessionId | null): ShellId | null {
  return useShellStore((s) => (sessionId ? (s.activeShellId[sessionId] ?? null) : null));
}

export function useShellUnread(shellId: ShellId | null): boolean {
  return useShellStore((s) => (shellId ? (s.unread[shellId] ?? false) : false));
}

// ---------- global event listener ----------

/**
 * FR-14: a shell is "displayed" only while its session's SHELL tab is on screen
 * AND it is that session's active chip.
 *
 * split-session FR-18: "on screen" is `isShellVisible`, which tests BOTH panes —
 * a shell in the RIGHT pane is as displayed as one in the left, so its output
 * must not raise an unread mark. Outside split the predicate is the old
 * `mainTab === 'shell' && activeSessionId === sessionId` pair exactly.
 */
function isDisplayedShell(sessionId: SessionId, shellId: ShellId): boolean {
  if (!isShellVisible(useStore.getState(), sessionId)) return false;
  return useShellStore.getState().activeShellId[sessionId] === shellId;
}

let started = false;

/** Register the single global shell-event listener (call once at app start). */
export function initShellEvents(): void {
  if (started) return;
  started = true;
  void onShellEvent((e) => {
    // unbound-panes FR-6: this store only ever tracks SESSION-owned shells — a
    // project-owned shell pane manages its own single PTY directly and never
    // touches the multi-shell strip/unread bookkeeping.
    if (e.owner.kind !== 'session') return;
    const sessionId = e.owner.sessionId;
    const store = useShellStore.getState();
    if (e.type === 'shell.data') {
      if (!isDisplayedShell(sessionId, e.shellId)) store.markUnread(e.shellId);
      return;
    }
    // shell.exit
    store.setShellStatus(sessionId, e.shellId, false, e.exitCode);
    if (!isDisplayedShell(sessionId, e.shellId)) store.markUnread(e.shellId);
  });
}
