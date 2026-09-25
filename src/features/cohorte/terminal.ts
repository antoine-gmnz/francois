// cohorte-actions FR-20/FR-21 — guided/plumbing verbs run in a real session
// shell tab: create it (reusing shellActions.newShell's own IPC + bookkeeping
// shape, not duplicated), name it, switch the main pane to SHELL, then type
// the line (executed or not).

import type { SessionId } from '../../../contract/common';
import { shellCreate, shellRename, shellWrite } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useShellStore } from '../../lib/shellStore';
import { showToast } from '../../lib/toast';

/** The verb `cohorte <verb> …` names the shell tab after ("cohorte brainstorm"). */
export function terminalShellName(line: string): string {
  const verb = line.trim().split(/\s+/)[1] ?? '';
  return verb ? `cohorte ${verb}` : 'cohorte';
}

export interface OpenCohorteTerminalOptions {
  /** true: send `line + \r` (runs it). false: type it, never press Enter (FR-21). */
  execute: boolean;
}

/**
 * FR-20 — creates a session shell, names it, focuses the main pane on SHELL,
 * then writes `line`. Returns false (toasting the error) on any failure —
 * §7 "Terminal creation fails → toast with the error; nothing else changes."
 */
export async function openCohorteTerminal(sessionId: SessionId, line: string, { execute }: OpenCohorteTerminalOptions): Promise<boolean> {
  let res;
  try {
    res = await shellCreate({ kind: 'session', sessionId });
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), 'error');
    return false;
  }
  if (!res.ok) {
    showToast(res.error.message, 'error');
    return false;
  }
  const shell = res.data;
  const store = useShellStore.getState();
  store.upsertShell(sessionId, shell);
  store.setActiveShellId(sessionId, shell.id);
  store.clearUnread(shell.id);

  void shellRename(shell.id, terminalShellName(line)).then((renamed) => {
    if (renamed.ok) useShellStore.getState().upsertShell(sessionId, renamed.data);
  });

  const app = useStore.getState();
  app.setFocusedPane('main');
  app.setMainTab('shell');

  await shellWrite(shell.id, execute ? `${line}\r` : line);
  return true;
}

/** FR-21 — Patch/Fleet/Audit/Retro: typed, never executed, plus a toast. */
export function openPlumbingTerminal(sessionId: SessionId, verb: 'patch' | 'fleet' | 'audit' | 'retro', line: string): void {
  void openCohorteTerminal(sessionId, line, { execute: false }).then((ok) => {
    if (ok) showToast(`Complete the arguments, then press Enter — cohorte ${verb} --help lists them`, 'info');
  });
}
