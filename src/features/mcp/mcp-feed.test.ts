import { describe, expect, it, vi } from 'vitest';
import type { McpServerInfo, Result, SessionEvent } from '../../../contract/common';
import { startMcpFeed } from './mcp-feed';

const server = (status: McpServerInfo['status'], scope?: McpServerInfo['scope']): McpServerInfo => ({ name: 'docs', status, scope });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function harness() {
  let emit!: (event: SessionEvent) => void;
  let subscribed!: (unlisten: () => void) => void;
  let fetched!: (result: Result<McpServerInfo[]>) => void;
  let rows: McpServerInfo[] = [];
  const errors: unknown[] = [];
  const loaded = vi.fn();
  const unlisten = vi.fn();
  const fetch = vi.fn(() => new Promise<Result<McpServerInfo[]>>(resolve => { fetched = resolve; }));
  const stop = startMcpFeed({
    sessionId: 's1',
    subscribe: cb => { emit = cb; return new Promise(resolve => { subscribed = resolve; }); },
    fetch,
    setServers: next => { rows = typeof next === 'function' ? next(rows) : next; },
    onError: error => errors.push(error),
    onLoaded: loaded,
  });
  return { emit: (row: McpServerInfo, sessionId = 's1') => emit({ type: 'mcp.update', sessionId, server: row }), subscribed: () => subscribed(unlisten), fetched: (res: Result<McpServerInfo[]>) => fetched(res), fetch, rows: () => rows, errors, loaded, stop, unlisten };
}

describe('MCP snapshot and live event ordering', () => {
  it('subscribes before fetching and preserves newer events and hydrated scope', async () => {
    const h = harness();
    expect(h.fetch).not.toHaveBeenCalled();
    h.subscribed(); await tick();
    h.emit(server('connected'));
    h.emit(server('error'), 'other');
    h.fetched({ ok: true, data: [server('pending', 'project')] }); await tick();
    expect(h.rows()).toEqual([server('connected', 'project')]);
    h.emit(server('error')); expect(h.rows()).toEqual([server('error', 'project')]);
    expect(h.loaded).toHaveBeenCalledOnce();
  });

  it('preserves structured errors while still accepting later live updates', async () => {
    const h = harness(); h.subscribed(); await tick();
    const error = { code: 'INTERNAL' as const, message: 'Config missing', detail: { path: 'config.toml' } };
    h.emit(server('connected'));
    h.fetched({ ok: false, error }); await tick();
    expect(h.errors).toEqual([error]);
    expect(h.rows()).toEqual([server('connected')]);
    h.emit(server('error')); expect(h.rows()).toEqual([server('error')]);
  });

  it('ignores a snapshot and events after teardown', async () => {
    const h = harness(); h.subscribed(); await tick(); h.stop();
    h.emit(server('connected')); h.fetched({ ok: true, data: [server('pending')] }); await tick();
    expect(h.rows()).toEqual([]); expect(h.loaded).not.toHaveBeenCalled(); expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it('unsubscribes a late subscription without fetching', async () => {
    const h = harness(); h.stop(); h.subscribed(); await tick();
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.unlisten).toHaveBeenCalledOnce();
  });
});
