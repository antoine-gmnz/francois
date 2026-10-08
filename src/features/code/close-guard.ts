// code-editor FR-13: closing the window with any dirty buffer asks Save all ·
// Discard · Cancel, through Tauri's `onCloseRequested`.
//
// The hook is registered ONLY while a buffer is dirty, and the handler ALWAYS holds
// the close. Going ahead is "drop the hook, then close() again" — never `destroy()`,
// which needs a window permission the app does not grant. With no hook registered
// the window closes exactly as it always has.

import { getCurrentWindow } from '@tauri-apps/api/window';
import { hasTauriRuntime } from '../../lib/platform';
import { allDirtyTabs, useCodeStore } from './codeStore';

export interface CloseRequestWindow {
  onCloseRequested(handler: (e: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
  close(): Promise<void>;
}

export interface CloseGuard {
  /** Register / drop the hook to match whether anything is dirty. */
  sync(hasDirty: boolean): Promise<void>;
  /** Save all or Discard was chosen: let the window close. */
  proceed(): Promise<void>;
}

export function createCloseGuard(win: CloseRequestWindow, ask: () => void): CloseGuard {
  let unlisten: (() => void) | null = null;
  let pending: Promise<void> | null = null;
  const drop = () => {
    unlisten?.();
    unlisten = null;
  };
  const sync = async (hasDirty: boolean) => {
    await pending;
    if (hasDirty && !unlisten) {
      pending = win
        .onCloseRequested((e) => {
          e.preventDefault();
          ask();
        })
        .then((fn) => {
          unlisten = fn;
        });
      await pending;
      pending = null;
    } else if (!hasDirty) {
      drop();
    }
  };
  return {
    sync,
    proceed: async () => {
      await pending;
      drop();
      await win.close();
    },
  };
}

let guard: CloseGuard | null = null;

/** App-wide, once: keeps the hook in step with the Code store's dirty buffers. */
export function initCloseGuard(): void {
  if (guard || !hasTauriRuntime()) return;
  const win = getCurrentWindow();
  guard = createCloseGuard(win, () => useCodeStore.getState().setClosePrompt(true));
  let dirty = false;
  const check = () => {
    const next = allDirtyTabs(useCodeStore.getState()).length > 0;
    if (next === dirty) return;
    dirty = next;
    void guard?.sync(next);
  };
  useCodeStore.subscribe(check);
  check();
}

/** The prompt's Save all / Discard: close the window for real. */
export function proceedWithClose(): void {
  void guard?.proceed();
}
