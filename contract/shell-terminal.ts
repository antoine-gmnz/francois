// contract/shell-terminal.ts — shell-terminal (SHELL tab, main pane [2]).
// Authored from specs/shell-terminal.md §5. Imports shared vocabulary from
// common.ts; never redefines it.
//
// Physical Tauri binding (see PIPELINE.md): logical channel
// `francois:shell:<verb>` → Tauri command `shell_<verb>`; the event stream
// `francois:shell:event` → Tauri event `francois://shell/event`. Every command
// RESOLVES a `Result<T>` (never rejects across the bridge).

import type { SessionId, Result } from './common';

// ---------- francois:shell:ensure ----------

export interface ShellEnsurePayload {
  sessionId: SessionId;
}

export interface ShellEnsureData {
  cols: number;
  rows: number;
  /**
   * Raw buffered PTY output (core-side ring buffer, FR-9), oldest-first,
   * to replay verbatim into a freshly (re)mounted xterm.js instance.
   * Empty string on first-ever creation for this session.
   */
  scrollbackReplay: string;
  /**
   * Present only when attaching to an entry whose process has already
   * exited and has not since been restarted (dispose + ensure, FR-17).
   * Drives the same dim-line UI as a live 'shell.exit' event (FR-15).
   */
  exitCode?: number;
  /**
   * Build-time superset of the spec's §5 code block, to realize FR-26 / §6's
   * `ShellUiState`: the footer must show the shell name and cwd that the CORE
   * actually resolved (FR-6/FR-7), and only the core knows them. Additive and
   * safe for every consumer. Flagged for spec reconciliation (§5 vs §6).
   */
  shellName: string;
  cwd: string;
}
// invoke('shell_ensure', req: ShellEnsurePayload): Promise<Result<ShellEnsureData>>

// ---------- francois:shell:write ----------

export interface ShellWritePayload {
  sessionId: SessionId;
  /** Raw bytes to forward to the PTY's stdin, unmodified — includes control bytes, e.g. '\x03', '\x0c'. */
  data: string;
}
// invoke('shell_write', req: ShellWritePayload): Promise<Result<void>>

// ---------- francois:shell:resize ----------

export interface ShellResizePayload {
  sessionId: SessionId;
  cols: number;
  rows: number;
}
// invoke('shell_resize', req: ShellResizePayload): Promise<Result<void>>

// ---------- francois:shell:dispose ----------

export interface ShellDisposePayload {
  sessionId: SessionId;
}
// invoke('shell_dispose', req: ShellDisposePayload): Promise<Result<void>>

// ---------- francois:shell:event (core -> frontend) ----------

export type ShellEvent =
  | { type: 'shell.data'; sessionId: SessionId; data: string }
  | { type: 'shell.exit'; sessionId: SessionId; exitCode: number };

// Re-export the Result envelope for convenience at the call sites.
export type { Result };
