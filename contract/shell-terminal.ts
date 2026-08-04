// contract/shell-terminal.ts — the `shell` domain, re-keyed by ShellId (multiple-shells).
// Authored from specs/shell-terminal.md §5 and specs/multiple-shells.md §5, which rewrites
// this file in place — the domain keeps its name, but every channel now addresses a
// ShellId rather than a SessionId. Imports shared vocabulary from common.ts; never
// redefines it.
//
// Physical Tauri binding (see PIPELINE.md): logical channel
// `francois:shell:<verb>` → Tauri command `shell_<verb>`; the event stream
// `francois:shell:event` → Tauri event `francois://shell/event`. Every command
// RESOLVES a `Result<T>` (never rejects across the bridge).

import type { SessionId, Result } from './common';

/** uuid-v4. A shell belongs to exactly one session for its whole life (FR-1). */
export type ShellId = string;

export interface ShellInfo {
  id: ShellId;
  sessionId: SessionId;
  /** Display label: auto `<shellName> <n>` (FR-3) or the custom name (FR-4). */
  name: string;
  /** Resolved executable basename, e.g. 'zsh', 'pwsh' (shell-terminal FR-6). */
  shellName: string;
  cwd: string;
  alive: boolean;
  /** Set once `alive === false`; cleared by a restart (FR-7). */
  exitCode?: number;
}

// ---------- francois:shell:ensure ----------

export interface ShellEnsurePayload {
  sessionId: SessionId;
  /** Omit to attach to the session's first shell, creating one if none (FR-5). */
  shellId?: ShellId;
}

export interface ShellEnsureData {
  /** The shell actually attached to — echoed because `shellId` may be omitted. */
  shellId: ShellId;
  /** The session's whole strip, in creation order (FR-1). */
  shells: ShellInfo[];
  cols: number;
  rows: number;
  /** Raw ring-buffer replay for `shellId`, oldest-first; '' on a fresh spawn. */
  scrollbackReplay: string;
  /** Present when the attached shell has already exited (drives FR-17). */
  exitCode?: number;
}
// invoke('shell_ensure', req: ShellEnsurePayload): Promise<Result<ShellEnsureData>>

// ---------- francois:shell:create ----------

export interface ShellCreatePayload {
  sessionId: SessionId;
}
// invoke('shell_create', req: ShellCreatePayload): Promise<Result<ShellInfo>>

// ---------- francois:shell:restart ----------

export interface ShellRestartPayload {
  shellId: ShellId;
}
/** The entry's last known size — the restarted PTY comes up at it (FR-7). */
export interface ShellRestartData {
  cols: number;
  rows: number;
}
// invoke('shell_restart', req: ShellRestartPayload): Promise<Result<ShellRestartData>>

// ---------- francois:shell:rename ----------

export interface ShellRenamePayload {
  shellId: ShellId;
  /** Trimmed, truncated to 40 chars; empty resets to the auto name (FR-4). */
  name: string;
}
// invoke('shell_rename', req: ShellRenamePayload): Promise<Result<ShellInfo>>

// ---------- francois:shell:dispose ----------

export interface ShellDisposePayload {
  shellId: ShellId;
}
// invoke('shell_dispose', req: ShellDisposePayload): Promise<Result<void>>

// ---------- francois:shell:write ----------

export interface ShellWritePayload {
  shellId: ShellId;
  /** Raw bytes to forward to the PTY's stdin, unmodified — includes control bytes, e.g. '\x03', '\x0c'. */
  data: string;
}
// invoke('shell_write', req: ShellWritePayload): Promise<Result<void>>

// ---------- francois:shell:resize ----------

export interface ShellResizePayload {
  shellId: ShellId;
  cols: number;
  rows: number;
}
// invoke('shell_resize', req: ShellResizePayload): Promise<Result<void>>

// ---------- francois:shell:event (core -> frontend) ----------
// `sessionId` rides along so the frontend can route unread marks (FR-14)
// without a shellId → session lookup.

export type ShellEvent =
  | { type: 'shell.data'; shellId: ShellId; sessionId: SessionId; data: string }
  | { type: 'shell.exit'; shellId: ShellId; sessionId: SessionId; exitCode: number };

// Re-export the Result envelope for convenience at the call sites.
export type { Result };
