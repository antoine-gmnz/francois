// Frontend shell UI state (specs/shell-terminal.md §6). A tiny external store
// keyed by sessionId, updated by ONE global listener on francois://shell/event
// (registered once, independent of mount state) so the footer's alive/exit
// state stays correct regardless of what is mounted. Rendering of shell.data
// into xterm.js is handled per-mount by ShellTerminal, not here.

import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { ShellEvent } from '../contract/shell-terminal';

// No session-engine in this build: a single implicit default session.
export const DEFAULT_SESSION_ID = 'default';

export interface ShellUiState {
  alive: boolean;
  exitCode?: number;
  shellName: string;
  cwd: string;
}

const initial: ShellUiState = { alive: false, shellName: '', cwd: '' };

const states = new Map<string, ShellUiState>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setShellState(sessionId: string, patch: Partial<ShellUiState>) {
  const prev = states.get(sessionId) ?? initial;
  states.set(sessionId, { ...prev, ...patch });
  emit();
}

function getState(sessionId: string): ShellUiState {
  return states.get(sessionId) ?? initial;
}

export function useShellState(sessionId: string): ShellUiState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getState(sessionId),
  );
}

let started = false;

/** Register the single global shell-event listener (call once at app start). */
export function initShellEvents() {
  if (started) return;
  started = true;
  void listen<ShellEvent>('francois://shell/event', (e) => {
    const p = e.payload;
    if (p.type === 'shell.exit') {
      setShellState(p.sessionId, { alive: false, exitCode: p.exitCode });
    }
  });
}
