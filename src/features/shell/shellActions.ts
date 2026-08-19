// multiple-shells — the shell-domain actions shared by the strip's mouse
// handlers, the keyboard carve-outs (FR-19/20/21), and the palette commands
// (FR-22). Each wraps one IPC round trip plus the store bookkeeping the
// spec's flows describe (activate the new/neighboring chip, clear its
// unread mark); ShellTerminal/ShellStrip/useShellShortcuts/paletteCommands
// all call into these rather than duplicating the sequencing.

import type { SessionId } from '../../../contract/common';
import type { ShellId } from '../../../contract/shell-terminal';
import { shellCreate, shellDispose, shellRename } from '../../lib/api';
import { showToast } from '../palette/palette';
import { atShellCap, neighborAfterClose, cycleShellId, type ShellShortcut } from './shell';
import { useShellStore } from './shellStore';

/** FR-2/FR-19: creates a shell and activates it (flow 2). No-op at the cap —
 * the strip's disabled `+` is the only feedback, per FR-19. */
export async function newShell(sessionId: SessionId): Promise<void> {
  const store = useShellStore.getState();
  const shells = store.shells[sessionId] ?? [];
  if (atShellCap(shells)) return;
  let res;
  try {
    res = await shellCreate({ kind: 'session', sessionId });
  } catch (e) {
    // IPC-layer rejection (not a domain Result:false) — same treatment as
    // paletteCommands.ts's delegate() catch branch.
    showToast(String(e), 'error');
    return;
  }
  if (!res.ok) {
    // §7: reachable only via a race or the palette (the strip already disables
    // `+` at the cap) — surfaces as a transient toast, no chip.
    showToast(res.error.message, 'error');
    return;
  }
  store.upsertShell(sessionId, res.data);
  store.setActiveShellId(sessionId, res.data.id);
  store.clearUnread(res.data.id);
}

/**
 * FR-8/§7: dispose one shell by id — used by a chip's own `✕`. Only changes
 * the active chip when the CLOSED one was the displayed shell (right
 * neighbor, else left, else the empty state); closing a background chip
 * never disturbs what is on screen.
 */
export async function closeShell(sessionId: SessionId, shellId: ShellId): Promise<void> {
  const store = useShellStore.getState();
  const shells = store.shells[sessionId] ?? [];
  const wasActive = store.activeShellId[sessionId] === shellId;
  const next = wasActive ? neighborAfterClose(shells, shellId) : null;
  await shellDispose(shellId).catch(() => {});
  store.removeShell(sessionId, shellId);
  store.clearUnread(shellId);
  if (!wasActive) return;
  if (next) {
    store.setActiveShellId(sessionId, next);
    store.clearUnread(next);
  } else {
    store.clearActiveShellId(sessionId); // FR-23: empty state
  }
}

/** FR-19/`⌘W`: closes the DISPLAYED shell. No-op with zero shells (§7). */
export function closeDisplayedShell(sessionId: SessionId): void {
  const activeId = useShellStore.getState().activeShellId[sessionId];
  if (!activeId) return;
  void closeShell(sessionId, activeId);
}

/** FR-19: `⌃⇥`/`⌃⇧⇥` — cycle the session's active chip, clearing its unread mark. */
export function cycleShell(sessionId: SessionId, dir: 1 | -1): void {
  const store = useShellStore.getState();
  const shells = store.shells[sessionId] ?? [];
  const next = cycleShellId(shells, store.activeShellId[sessionId] ?? null, dir);
  if (!next) return;
  store.setActiveShellId(sessionId, next);
  store.clearUnread(next);
}

/**
 * FR-4/FR-18: commit an inline rename. The strip always renders the name the
 * core returns (never a local guess), so this only refreshes the store from
 * the response.
 */
export async function renameShell(sessionId: SessionId, shellId: ShellId, name: string): Promise<void> {
  let res;
  try {
    res = await shellRename(shellId, name);
  } catch (e) {
    // IPC-layer rejection (not a domain Result:false) — same treatment as
    // paletteCommands.ts's delegate() catch branch.
    showToast(String(e), 'error');
    return;
  }
  if (res.ok) useShellStore.getState().upsertShell(sessionId, res.data);
  else showToast(res.error.message, 'error');
}

/** FR-20/FR-21: run the action a matched combo maps to. */
export function dispatchShellShortcut(combo: ShellShortcut, sessionId: SessionId): void {
  switch (combo) {
    case 'new':
      void newShell(sessionId);
      break;
    case 'close':
      closeDisplayedShell(sessionId);
      break;
    case 'next':
      cycleShell(sessionId, 1);
      break;
    case 'prev':
      cycleShell(sessionId, -1);
      break;
  }
}

/**
 * FR-22 "Shell: rename": no free-text SecondaryStep exists (contract/command-
 * palette.ts), so this flags the session's displayed shell for the chip to
 * pick up and enter inline-rename mode on its own next render (see
 * shellStore.ts's `renameRequest`). No-op with zero shells.
 */
export function requestActiveShellRename(sessionId: SessionId): void {
  const activeId = useShellStore.getState().activeShellId[sessionId];
  if (activeId) useShellStore.getState().requestRename(activeId);
}
