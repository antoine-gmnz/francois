// response-mode (specs/response-mode.md) — the frontend's own half.
//
// Everything the panel and the New Session modal render comes off
// RESPONSE_MODE_OPTIONS (FR-13); the only thing they send is the enum, over the
// one contract-typed wrapper below (FR-2). The DIRECTIVE text is core-owned and
// never crosses the boundary (FR-6) — that is asserted here as an absence, because
// a table that grew a `directive` key is exactly how it would start crossing.
//
// No DOM framework is wired: RunChip / NewSessionModal are thin renderers over
// run-chip.ts's helpers, covered in run-chip.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseMode, SessionMeta } from '../../../contract/common';
import { RESPONSE_MODE_OPTIONS } from '../../../contract/response-mode';
import type { SessionSwitchResponseModeInput } from '../../../contract/response-mode';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { sessionSwitchResponseMode } from '../../lib/api';

const META: SessionMeta = {
  id: 's1',
  name: 'context count bugfix',
  cwd: '/repo',
  model: { id: 'sonnet', label: 'Sonnet' },
  status: 'running',
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
  responseMode: 'concise',
  allowGit: false,
};

beforeEach(() => invokeMock.mockReset());

describe('RESPONSE_MODE_OPTIONS (FR-13)', () => {
  it('covers the whole union, in display order, once each', () => {
    expect(RESPONSE_MODE_OPTIONS.map((o) => o.mode)).toEqual<ResponseMode[]>([
      'default',
      'concise',
      'explanatory',
      'learning',
    ]);
  });

  it('gives every mode a label, a short and a hint — no row renders blank', () => {
    for (const opt of RESPONSE_MODE_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.short.length).toBeGreaterThan(0);
      expect(opt.hint.length).toBeGreaterThan(0);
    }
  });

  it('carries no directive text — the instruction is core-owned (FR-6)', () => {
    for (const opt of RESPONSE_MODE_OPTIONS) {
      expect(Object.keys(opt).sort()).toEqual(['hint', 'label', 'mode', 'short']);
    }
  });
});

describe('sessionSwitchResponseMode (FR-2)', () => {
  it('invokes session_switch_response_mode with the contract payload', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: META });
    const res = await sessionSwitchResponseMode('s1', 'concise');
    const payload: SessionSwitchResponseModeInput = { sessionId: 's1', mode: 'concise' };
    expect(invokeMock).toHaveBeenCalledWith('session_switch_response_mode', payload);
    expect(res).toEqual({ ok: true, data: META });
  });

  it('sends the enum verbatim, including a return to default (FR-11)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { ...META, responseMode: 'default' } });
    await sessionSwitchResponseMode('s1', 'default');
    expect(invokeMock).toHaveBeenCalledWith('session_switch_response_mode', { sessionId: 's1', mode: 'default' });
  });

  it('resolves a domain failure rather than rejecting (FR-3/FR-18)', async () => {
    invokeMock.mockResolvedValue({
      ok: false,
      error: { code: 'SESSION_NOT_RUNNING', message: 'This session has finished.' },
    });
    const res = await sessionSwitchResponseMode('s1', 'learning');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('SESSION_NOT_RUNNING');
  });
});
