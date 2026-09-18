// session-rename (specs/session-rename.md) — frontend unit tests.
// Covers the pure commit-gate helper (FR-10) and the contract-typed
// `session_rename` invoke wrapper (§5). Both survive session-settings-sheet
// FR-21: the verb, its contract and these tests stay — the dedicated
// RenameSessionModal.tsx they used to back is gone, its NAME field folded into
// SessionSettingsSheet.tsx (session-settings-sheet.md), and the store flag /
// palette command they used to test moved with it — see session-settings.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { SessionRenameRequest } from '../../../contract/session-rename';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { sessionRename } from '../../lib/api';
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
  allowGit: false,
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
