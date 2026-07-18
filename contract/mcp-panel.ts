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

export type McpListResponse = Result<McpServerInfo[]>;
export type McpDetailResponse = Result<McpServerDetail>;
export type McpRegistryResponse = Result<McpRegistryEntry[]>;

export type { SessionId };
