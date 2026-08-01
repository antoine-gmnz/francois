// contract/mcp-panel.ts — mcp-panel (pane [4]).
// Authored from specs/mcp-panel.md §5. Imports shared vocabulary from
// common.ts; never redefines it. McpServerDetail extends McpServerInfo.
//
// Physical Tauri binding: `francois:mcp:<verb>` → command `mcp_<verb>`.
// Consumes the mcp.update member of francois://session/event.

import type { SessionId, Result, McpServerInfo } from './common';

// ---------- registry (v1: static curated list from the core) ----------

export interface McpRegistryParam {
  key: string;
  label: string;
  required: boolean;
  secret?: boolean;
}

export interface McpRegistryEntry {
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  commandTemplate?: string;
  urlTemplate?: string;
  params: McpRegistryParam[];
}

// ---------- attach ----------

export interface McpAttachRequest {
  name: string;
  transport: 'stdio' | 'http';
  command?: string; // stdio: template with non-secret {key} substituted, or verbatim custom
  url?: string; // http: same
  secretParams?: Record<string, string>; // secret values → env (stdio) / headers (http)
  registrySource?: string; // registry entry name; omitted for custom
}

// ---------- first-run approval ----------
// Claude Code gates project-scope `.mcp.json` servers behind a consent dialog and
// a never-opened folder behind a trust dialog, storing both answers in its own
// user store (`<claude config>/.claude.json` → projects[cwd]). `claude -p` skips
// those dialogs (the server silently never connects); the interactive
// remote-control host parks on them. These two calls make the same decision from
// the app and write the same keys.

export interface McpApprovalState {
  /** `.mcp.json` servers with no decision on record — what the CLI would ask about. */
  pending: string[];
  /** `.mcp.json` servers already approved (or blanket-approved by settings). */
  approved: string[];
  /** `.mcp.json` servers explicitly refused; the CLI will not start them. */
  rejected: string[];
  /** The folder-trust dialog has not been accepted for this cwd yet. */
  trustRequired: boolean;
  /** `enableAllProjectMcpServers` is on in some settings tier — nothing can be pending. */
  enableAllProjectMcpServers: boolean;
}

/** One click's worth of decisions. Every field is applied in the same write. */
export interface McpDecision {
  approve: string[];
  reject: string[];
  /** Accept the folder-trust dialog (`hasTrustDialogAccepted`). */
  trust: boolean;
}

// ---------- detail (popover) ----------

export interface McpServerDetail extends McpServerInfo {
  transport: 'stdio' | 'http';
  command?: string;
  url?: string;
}

// ---------- IPC ----------
// invoke('mcp_list',      { sessionId })          → Result<McpServerInfo[]>
// invoke('mcp_detail',    { sessionId, name })    → Result<McpServerDetail>
// invoke('mcp_reconnect', { sessionId, name })    → Result<null>
// invoke('mcp_detach',    { sessionId, name })    → Result<null>
// invoke('mcp_registry')                          → Result<McpRegistryEntry[]>
// invoke('mcp_attach',    { sessionId, entry })   → Result<null>
// invoke('mcp_approvals', { sessionId })          → Result<McpApprovalState>
// invoke('mcp_decide',    { sessionId, ...McpDecision }) → Result<McpApprovalState>

export type McpListResponse = Result<McpServerInfo[]>;
export type McpDetailResponse = Result<McpServerDetail>;
export type McpRegistryResponse = Result<McpRegistryEntry[]>;
export type McpApprovalsResponse = Result<McpApprovalState>;

export type { SessionId };
