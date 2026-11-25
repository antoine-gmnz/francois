import { expect, it, vi } from 'vitest';
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
import { sessionContextBreakdown } from './api';

it('asks session_context_breakdown with flat { sessionId, refresh } args', async () => {
  const res = { ok: true, data: { breakdown: null, measuredAt: null, stale: true } };
  invokeMock.mockResolvedValue(res);
  await expect(sessionContextBreakdown('s1', true)).resolves.toEqual(res);
  expect(invokeMock).toHaveBeenCalledWith('session_context_breakdown', { sessionId: 's1', refresh: true });
});

it('defaults refresh to false (reuse a fresh cache)', async () => {
  invokeMock.mockResolvedValue({ ok: true, data: { breakdown: null, measuredAt: null, stale: false } });
  await sessionContextBreakdown('s2');
  expect(invokeMock).toHaveBeenLastCalledWith('session_context_breakdown', { sessionId: 's2', refresh: false });
});
