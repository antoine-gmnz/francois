// cohorte-actions FR-20/FR-21 — guided/plumbing verbs run in a real session
// shell tab: create it (reusing shellActions.newShell's own IPC + bookkeeping
// shape, not duplicated), name it, switch the main pane to SHELL, then type
// the line (executed or not).

import type { SessionId } from '../../../contract/common';
import { shellCreate, shellRename, shellWrite } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useShellStore } from '../../lib/shellStore';
import { showToast } from '../../lib/toast';
import { useCohorteStore } from '../../lib/cohorteStore';
import { detectionFor } from './linkage';
import { CASE_INSENSITIVE_FS } from './useCohorte';
import { canOpenShellPane, paneCount, paneIndicesOf } from '../../lib/layoutStore';

/** The verb `cohorte <verb> …` names the shell tab after ("cohorte brainstorm"). */
export function terminalShellName(line: string): string {
  const verb = line.trim().split(/\s+/)[1] ?? '';
  return verb ? `cohorte ${verb}` : 'cohorte';
}

export interface OpenCohorteTerminalOptions {
  /** true: send `line + \r` (runs it). false: type it, never press Enter (FR-21). */
  execute: boolean;
  /** Structured arguments preserve arbitrary question answers across shells. */
  argv?: string[];
  root?: string;
}

type TerminalContext = { root?: string; cliExecutable?: string; cliDataDir?: string };

/** A shell literal, including command substitutions and quote characters. */
function quoteShell(value: string, powershell: boolean): string {
  return `'${powershell ? value.replace(/'/g, "''") : value.replace(/'/g, "'\\''")}'`;
}

export function cohorteTerminalLine(line: string, context: TerminalContext, shellName: string, argv?: string[]): string {
  const powershell = /(?:powershell|pwsh)/i.test(shellName);
  if (!argv && !context.root && !context.cliExecutable && !context.cliDataDir) return line;
  const executable = context.cliExecutable ?? 'cohorte';
  const command = `${powershell ? '& ' : ''}${quoteShell(executable, powershell)}`;
  const data = context.cliDataDir ? ` --data-dir ${quoteShell(context.cliDataDir, powershell)}` : '';
  const args = argv ? argv.map(arg => quoteShell(arg, powershell)).join(' ') : line.replace(/^cohorte\s*/, '');
  const invocation = `${command}${data} ${args}`;
  if (!context.root) return invocation;
  const root = quoteShell(context.root, powershell);
  return powershell ? `Set-Location -LiteralPath ${root}; if ($?) { ${invocation} }` : `cd -- ${root} && ${invocation}`;
}

/**
 * FR-20 — creates a session shell, names it, focuses the main pane on SHELL,
 * then writes `line`. Returns false (toasting the error) on any failure —
 * §7 "Terminal creation fails → toast with the error; nothing else changes."
 */
export async function openCohorteTerminal(sessionId: SessionId | null, line: string, { execute, argv, root }: OpenCohorteTerminalOptions): Promise<boolean> {
  const initial = useStore.getState();
  const project = sessionId === null ? initial.projects.find(candidate => candidate.root === root && candidate.rootExists) : null;
  if (sessionId === null && (!project || !canOpenShellPane(paneCount(initial), 1))) {
    showToast(project ? 'Close a pane to open the Cohorte terminal.' : 'Register this project to open its Cohorte terminal.', 'error');
    return false;
  }
  let res;
  try {
    res = await shellCreate(sessionId !== null ? { kind: 'session', sessionId } : { kind: 'project', projectId: project!.id }, { runtime: 'native' });
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), 'error');
    return false;
  }
  if (!res.ok) {
    showToast(res.error.message, 'error');
    return false;
  }
  const shell = res.data;
  if (sessionId !== null) {
    const store = useShellStore.getState();
    store.upsertShell(sessionId, shell);
    store.setActiveShellId(sessionId, shell.id);
    store.clearUnread(shell.id);
  }

  void shellRename(shell.id, terminalShellName(line)).then((renamed) => {
    if (renamed.ok && sessionId !== null) useShellStore.getState().upsertShell(sessionId, renamed.data);
  }).catch(() => {});

  const app = useStore.getState();
  app.setFocusedPane('main');
  if (sessionId !== null) {
    const panes = paneIndicesOf(app, sessionId);
    const paneIndex = panes.includes(app.focusedPaneIndex) ? app.focusedPaneIndex : (panes[0] ?? 0);
    if (panes.length === 0) app.setActiveSessionId(sessionId);
    app.setPaneTab(paneIndex, 'shell');
    app.setFocusedPaneIndex(paneIndex);
  }
  else {
    app.openShellPane(project!.id);
    const opened = useStore.getState();
    opened.setPaneShellId(opened.focusedPaneIndex, shell.id);
  }

  const session = app.sessions.find(meta => meta.id === sessionId);
  const detections = useCohorteStore.getState().detections;
  const detection = detectionFor(detections, root ?? session?.cwd ?? '', CASE_INSENSITIVE_FS)
    ?? Object.values(detections).find(candidate => candidate.root === root);
  const terminalLine = cohorteTerminalLine(line, { ...detection, root: root ?? detection?.root }, shell.shellName, argv);
  try {
    const written = await shellWrite(shell.id, execute ? `${terminalLine}\r` : terminalLine);
    if (!written.ok) { showToast(written.error.message, 'error'); return false; }
    return true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
    return false;
  }
}

/** FR-21 — Patch/Fleet/Audit/Retro: typed, never executed, plus a toast. */
export function openPlumbingTerminal(sessionId: SessionId, verb: 'patch' | 'fleet' | 'audit' | 'retro', line: string): void {
  void openCohorteTerminal(sessionId, line, { execute: false }).then((ok) => {
    if (ok) showToast(`Complete the arguments, then press Enter — cohorte ${verb} --help lists them`, 'info');
  });
}
