// Settings / MCP servers — the pure derivations behind the table (Figma 23 · 140:7929).

import { describe, expect, it } from 'vitest';
import type { McpServerInfo, SessionMeta } from '../../../contract/common';
import {
  filterMcpServers,
  mcpCheckedLabel,
  mcpHealthSummary,
  mcpReferenceSessionId,
  mcpScopeCounts,
  mcpStatusView,
} from './mcp-settings';

const s = (name: string, status: McpServerInfo['status'], extra: Partial<McpServerInfo> = {}): McpServerInfo => ({
  name,
  status,
  ...extra,
});

describe('mcpScopeCounts / filterMcpServers', () => {
  const servers = [
    s('a', 'connected', { scope: 'user' }),
    s('b', 'connected', { scope: 'project' }),
    s('c', 'error', { scope: 'project' }),
    s('d', 'connected', { scope: 'local' }),
    s('e', 'connected'),
  ];

  it('counts every scope, and everything under all', () => {
    expect(mcpScopeCounts(servers)).toEqual({ all: 5, project: 2, user: 1, local: 1 });
  });

  it('filters by scope; all keeps every row, in order', () => {
    expect(filterMcpServers(servers, 'all').map((x) => x.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(filterMcpServers(servers, 'project').map((x) => x.name)).toEqual(['b', 'c']);
    expect(filterMcpServers(servers, 'local').map((x) => x.name)).toEqual(['d']);
  });
});

describe('mcpStatusView', () => {
  it('connected reads healthy, with the tool count', () => {
    expect(mcpStatusView(s('a', 'connected', { toolCount: 9 }))).toEqual({ kind: 'done', text: 'Healthy', tone: 'default' });
  });
  it('an error carries its own message, danger-toned', () => {
    expect(mcpStatusView(s('a', 'error', { errorMessage: 'Handshake timed out after 10 s' }))).toEqual({
      kind: 'failed',
      text: 'Handshake timed out after 10 s',
      tone: 'danger',
    });
    expect(mcpStatusView(s('a', 'error')).text).toBe('Failed');
  });
  it('connecting spins; the approval verdicts read as such', () => {
    expect(mcpStatusView(s('a', 'connecting')).kind).toBe('running');
    expect(mcpStatusView(s('a', 'pending'))).toEqual({ kind: 'approval', text: 'Needs approval', tone: 'attention' });
    expect(mcpStatusView(s('a', 'rejected'))).toEqual({ kind: 'idle', text: 'Not approved', tone: 'faint' });
    expect(mcpStatusView(s('a', 'approved'))).toEqual({ kind: 'pending', text: 'Starts next turn', tone: 'default' });
  });
});

describe('mcpHealthSummary', () => {
  it('names only the buckets that are present, healthy first', () => {
    expect(
      mcpHealthSummary([s('a', 'connected'), s('b', 'connected'), s('c', 'error'), s('d', 'pending'), s('e', 'rejected')]),
    ).toEqual({ text: '2 healthy · 1 failing · 1 needs approval · 1 off', failing: true });
  });
  it('is empty for no servers', () => {
    expect(mcpHealthSummary([])).toEqual({ text: '', failing: false });
  });
  it('counts connecting and approved as starting', () => {
    expect(mcpHealthSummary([s('a', 'connecting'), s('b', 'approved')]).text).toBe('2 starting');
  });
});

describe('mcpCheckedLabel', () => {
  it('reads just now under a minute, then minutes, then hours', () => {
    expect(mcpCheckedLabel(null, 1000)).toBe('');
    expect(mcpCheckedLabel(1000, 30_000)).toBe('checked just now');
    expect(mcpCheckedLabel(0, 2 * 60_000 + 5)).toBe('checked 2m ago');
    expect(mcpCheckedLabel(0, 3 * 3_600_000)).toBe('checked 3h ago');
  });
});

describe('mcpReferenceSessionId', () => {
  const meta = (id: string, projectId: string | undefined, lastActivityAt: number) =>
    ({ id, projectId, lastActivityAt }) as unknown as SessionMeta;
  const sessions = [meta('a', 'p1', 10), meta('b', 'p1', 30), meta('c', 'p2', 50), meta('d', undefined, 99)];

  it('prefers the focused session when it belongs to the project', () => {
    expect(mcpReferenceSessionId(sessions, 'p1', 'a')).toBe('a');
  });
  it('else the project session active most recently', () => {
    expect(mcpReferenceSessionId(sessions, 'p1', 'c')).toBe('b');
    expect(mcpReferenceSessionId(sessions, 'p1', null)).toBe('b');
  });
  it('null when the project has no session, or no project is picked', () => {
    expect(mcpReferenceSessionId(sessions, 'p3', 'a')).toBeNull();
    expect(mcpReferenceSessionId(sessions, null, 'a')).toBeNull();
  });
});
