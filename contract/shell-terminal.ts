// contract/shell-terminal.ts — the `shell` domain, re-keyed by ShellId (multiple-shells),
// then re-owned by ShellOwner (unbound-panes). Authored from specs/shell-terminal.md §5,
// specs/multiple-shells.md §5 and specs/unbound-panes.md §5, which rewrite this file in
// place each time — the domain keeps its name, but a shell's owner is now a union rather
// than a bare SessionId (live decision, 2026-08-18: a resource that can belong to two kinds
// of parent gets a discriminated union on the entity and every event, never an optional id
// per parent kind). Imports shared vocabulary from common.ts; never redefines it.
//
// Physical Tauri binding (see PIPELINE.md): logical channel
// `francois:shell:<verb>` → Tauri command `shell_<verb>`; the event stream
// `francois:shell:event` → Tauri event `francois://shell/event`. Every command
// RESOLVES a `Result<T>` (never rejects across the bridge).

import type { SessionId, ProjectId, Result } from './common';

/** uuid-v4. A shell belongs to exactly one owner for its whole life (FR-1, unbound-panes FR-6). */
export type ShellId = string;

/** Who a shell belongs to for its whole life. A project-owned shell is rooted at
 *  that project's `root` and has no session (unbound-panes FR-6). */
export type ShellOwner =
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'project'; projectId: ProjectId };

export interface ShellInfo {
  id: ShellId;
  owner: ShellOwner;
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
  owner: ShellOwner;
  /** Omit to attach to the owner's first shell, creating one if none (FR-5). */
  shellId?: ShellId;
}

export interface ShellEnsureData {
  /** The shell actually attached to — echoed because `shellId` may be omitted. */
  shellId: ShellId;
  /** The OWNER's whole strip, in creation order (FR-1) — a project owner's strip is its
   *  own project-owned shells only, never a session's. */
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
  owner: ShellOwner;
}
// invoke('shell_create', req: ShellCreatePayload): Promise<Result<ShellInfo>>
// A `project` owner: cwd is the project's `root` (PROJECT_NOT_FOUND if the id is not in the
// registry; PROJECT_ROOT_MISSING if the root is gone or is not a directory — both checked
// BEFORE spawning). The runtime (native | wsl) resolves from that root exactly as
// `engine.cwd_of` does for a session. SHELL_CAP (6) applies per owner (unbound-panes §5).

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
// `owner` rides along so the frontend can route unread marks (FR-14) without a
// shellId → owner lookup.

export type ShellEvent =
  | { type: 'shell.data'; shellId: ShellId; owner: ShellOwner; data: string }
  | { type: 'shell.exit'; shellId: ShellId; owner: ShellOwner; exitCode: number };

// Re-export the Result envelope for convenience at the call sites.
export type { Result };
