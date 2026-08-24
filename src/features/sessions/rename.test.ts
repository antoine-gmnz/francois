// session-rename (specs/session-rename.md) — frontend unit tests.
// Covers the pure commit-gate helper the rename modal hangs off (FR-10), the
// contract-typed `session_rename` invoke wrapper (§5), the store flag both entry
// points write (FR-12/FR-14), and the palette command's registration + enablement
// (FR-14). No DOM framework is wired — RenameSessionModal is a thin renderer over
// these.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { SessionRenameRequest } from '../../../contract/session-rename';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { sessionRename } from '../../lib/api';
import { useStore } from '../../lib/store';
import { SESSION_NAME_MAX, canCommitRename } from './rename';

const META: SessionMeta = {
  id: 's1',
  name: 'renamed',
  cwd: '/tmp/p',
  model: { id: 'sonnet', label: 'Sonnet' },
  status: 'idle',
  contextUsedTokens: 0,
  contextLimitTokens: 200000,
  startedAt: 0,
  lastActivityAt: 0,
  permissionMode: 'default',
  permissionModeSince: 0,
  runtime: 'native',
  accountId: 'default',
  agentRuntime: 'claude-code',
  protocol: 'anthropic',
  responseMode: 'default',
};

describe('canCommitRename (FR-10)', () => {
  it('accepts a non-empty trimmed name', () => {
    expect(canCommitRename('api refactor', false)).toBe(true);
  });

  it('rejects an empty or whitespace-only name — Enter is inert, no IPC', () => {
    expect(canCommitRename('', false)).toBe(false);
    expect(canCommitRename('   \t ', false)).toBe(false);
  });

  it('accepts exactly 80 characters and rejects 81 (counted after trimming)', () => {
    expect(SESSION_NAME_MAX).toBe(80);
    expect(canCommitRename('x'.repeat(80), false)).toBe(true);
    expect(canCommitRename(`  ${'x'.repeat(80)}  `, false)).toBe(true);
    expect(canCommitRename('x'.repeat(81), false)).toBe(false);
  });

  it('counts Unicode scalar values, not UTF-16 code units', () => {
    expect(canCommitRename('🙂'.repeat(80), false)).toBe(true);
    expect(canCommitRename('🙂'.repeat(81), false)).toBe(false);
  });

  it('rejects while a call is in flight', () => {
    expect(canCommitRename('ok', true)).toBe(false);
  });
});

describe('sessionRename wrapper (§5)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('invokes session_rename with { sessionId, name } and resolves the Result', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: META });
    const req: SessionRenameRequest = { sessionId: 's1', name: 'renamed' };
    await expect(sessionRename(req)).resolves.toEqual({ ok: true, data: META });
    expect(invokeMock).toHaveBeenCalledWith('session_rename', { sessionId: 's1', name: 'renamed' });
  });

  it('surfaces an ok:false rather than rejecting', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } });
    const res = await sessionRename({ sessionId: 'gone', name: 'x' });
    expect(res.ok).toBe(false);
  });
});

describe('renameSessionId store flag (FR-12/FR-14)', () => {
  it('defaults to null and holds the session being renamed', () => {
    expect(useStore.getState().renameSessionId).toBeNull();
    useStore.getState().setRenameSessionId('s1');
    expect(useStore.getState().renameSessionId).toBe('s1');
    useStore.getState().setRenameSessionId(null);
    expect(useStore.getState().renameSessionId).toBeNull();
  });
});

describe('rename-session palette command (FR-14)', () => {
  async function freshCommands() {
    vi.resetModules();
    const storeMod = await import('../../lib/store');
    const paletteMod = await import('../palette/palette');
    const commandsMod = await import('../palette/paletteCommands');
    commandsMod.registerBuiltinCommands();
    const cmd = paletteMod.paletteCommands().find((c) => c.id === 'rename-session');
    if (!cmd) throw new Error("command 'rename-session' not registered");
    return { useStore: storeMod.useStore, cmd };
  }

  it('is registered with the ✎ glyph and its spec name', async () => {
    const { cmd } = await freshCommands();
    expect(cmd.glyph).toBe('✎');
    expect(cmd.name).toBe('Rename session');
  });

  it('is disabled (⇒ hidden) with no active session', async () => {
    const { cmd } = await freshCommands();
    expect(cmd.enabled?.({ activeSessionId: null, runningAgentCount: 0 })).toBe(false);
    expect(cmd.enabled?.({ activeSessionId: 's1', runningAgentCount: 0 })).toBe(true);
  });

  it('opens the rename modal for the active session and returns void (no SecondaryStep)', async () => {
    const { useStore: store, cmd } = await freshCommands();
    const step = cmd.run({ activeSessionId: 's1', runningAgentCount: 0 });
    expect(step).toBeUndefined();
    expect(store.getState().renameSessionId).toBe('s1');
  });
});
