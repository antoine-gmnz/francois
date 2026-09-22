// Settings / MCP servers (Figma 23 · 140:7929) — the pure derivations behind the
// table: the scope filter and its counts, one row's status cell, the summary line
// above the table, and which session the page reads its servers from.
//
// Why a session at all: the core resolves MCP servers PER SESSION (`mcp_list`
// takes a sessionId — the scopes are resolved against that session's cwd and
// account config dir). A project page therefore reads a live session of that
// project; with none running there is nothing honest to list.

import type { McpScope, McpServerInfo, SessionMeta } from '../../../contract/common';
import type { StateKind } from '../../ui/state-kind';

export type McpScopeFilter = 'all' | McpScope;

export function mcpScopeCounts(servers: McpServerInfo[]): Record<McpScopeFilter, number> {
  const counts: Record<McpScopeFilter, number> = { all: servers.length, project: 0, user: 0, local: 0 };
  for (const server of servers) if (server.scope) counts[server.scope] += 1;
  return counts;
}

export function filterMcpServers(servers: McpServerInfo[], filter: McpScopeFilter): McpServerInfo[] {
  return filter === 'all' ? servers : servers.filter((server) => server.scope === filter);
}

export interface McpStatusView {
  kind: StateKind;
  text: string;
  tone: 'default' | 'danger' | 'attention' | 'faint';
}

/** The STATUS cell: a state glyph and a sentence. */
export function mcpStatusView(server: McpServerInfo): McpStatusView {
  switch (server.status) {
    case 'connected':
      return { kind: 'done', text: 'Healthy', tone: 'default' };
    case 'connecting':
      return { kind: 'running', text: 'Connecting…', tone: 'default' };
    case 'error':
      return { kind: 'failed', text: server.errorMessage ?? 'Failed', tone: 'danger' };
    case 'pending':
      return { kind: 'approval', text: 'Needs approval', tone: 'attention' };
    case 'rejected':
      return { kind: 'idle', text: 'Not approved', tone: 'faint' };
    case 'approved':
      // The CLI only starts `.mcp.json` servers when the next turn spawns.
      return { kind: 'pending', text: 'Starts next turn', tone: 'default' };
  }
}

/** "3 healthy · 1 failing · 1 off" — only the buckets that are present. */
export function mcpHealthSummary(servers: McpServerInfo[]): { text: string; failing: boolean } {
  const count = (pred: (s: McpServerInfo) => boolean) => servers.filter(pred).length;
  const healthy = count((s) => s.status === 'connected');
  const failing = count((s) => s.status === 'error');
  const starting = count((s) => s.status === 'connecting' || s.status === 'approved');
  const pending = count((s) => s.status === 'pending');
  const off = count((s) => s.status === 'rejected');
  const parts = [
    healthy ? `${healthy} healthy` : null,
    failing ? `${failing} failing` : null,
    starting ? `${starting} starting` : null,
    pending ? `${pending} ${pending === 1 ? 'needs' : 'need'} approval` : null,
    off ? `${off} off` : null,
  ].filter(Boolean);
  return { text: parts.join(' · '), failing: failing > 0 };
}

/** When the list was last read from the core. */
export function mcpCheckedLabel(checkedAt: number | null, now: number): string {
  if (checkedAt === null) return '';
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000);
  if (minutes < 1) return 'checked just now';
  if (minutes < 60) return `checked ${minutes}m ago`;
  return `checked ${Math.floor(minutes / 60)}h ago`;
}

/**
 * The session whose servers the page lists: the focused one when it belongs to
 * the project, else the project's most recently active session.
 */
export function mcpReferenceSessionId(
  sessions: Pick<SessionMeta, 'id' | 'projectId' | 'lastActivityAt'>[],
  projectId: string | null,
  focusedId: string | null,
): string | null {
  if (!projectId) return null;
  const inProject = sessions.filter((s) => s.projectId === projectId);
  if (focusedId && inProject.some((s) => s.id === focusedId)) return focusedId;
  let best: (typeof inProject)[number] | null = null;
  for (const s of inProject) if (!best || s.lastActivityAt > best.lastActivityAt) best = s;
  return best?.id ?? null;
}
