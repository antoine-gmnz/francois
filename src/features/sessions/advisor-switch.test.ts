// advisor-switch — the contract-typed invoke wrapper (francois:session:switchAdvisor).
// The popover's pure half (advisorRows / advisorAvailable) is covered in
// run-settings.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { SessionSwitchAdvisorInput } from '../../../contract/session-engine';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { sessionSwitchAdvisor } from '../../lib/api';

const META = { id: 's1', agentRuntime: 'claude-code', advisorModel: 'opus' } as SessionMeta;

beforeEach(() => invokeMock.mockReset());

describe('sessionSwitchAdvisor', () => {
  it('invokes session_switch_advisor with the contract payload', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: META });
    const res = await sessionSwitchAdvisor('s1', 'opus');
    const payload: SessionSwitchAdvisorInput = { sessionId: 's1', advisorModel: 'opus' };
    expect(invokeMock).toHaveBeenCalledWith('session_switch_advisor', payload);
    expect(res).toEqual({ ok: true, data: META });
  });

  it('sends null to clear the override and inherit the account setting', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { ...META, advisorModel: undefined } });
    await sessionSwitchAdvisor('s1', null);
    expect(invokeMock).toHaveBeenCalledWith('session_switch_advisor', { sessionId: 's1', advisorModel: null });
  });

  it('resolves a domain failure rather than rejecting', async () => {
    const failure = { ok: false, error: { code: 'RUNTIME_UNSUPPORTED', message: 'Claude Code only' } };
    invokeMock.mockResolvedValue(failure);
    await expect(sessionSwitchAdvisor('s1', 'off')).resolves.toEqual(failure);
  });
});
