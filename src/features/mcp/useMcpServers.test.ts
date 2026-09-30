import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../../contract/common';

// Exercise the hook's I/O boundary without a DOM renderer. Effects execute
// once; these tests cover the initial read and exposed mutation callback.
const harness = vi.hoisted(() => ({
  meta: null as SessionMeta | null,
  approvals: vi.fn(),
  decide: vi.fn(),
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: (effect: () => unknown) => { effect(); },
  useCallback: (callback: unknown) => callback,
}));
vi.mock('../../lib/hooks/useSessionMeta', () => ({ useSessionMeta: () => harness.meta }));
vi.mock('../../lib/api', () => ({ mcpApprovals: harness.approvals, mcpDecide: harness.decide, mcpList: vi.fn() }));
vi.mock('../../lib/session-events', () => ({ subscribeSessionEvents: vi.fn() }));
import { useApprovals } from './useMcpServers';

beforeEach(() => {
  harness.approvals.mockReset().mockResolvedValue({ ok: true, data: { trustRequired: false, pending: [], rejected: [] } });
  harness.decide.mockReset().mockResolvedValue({ ok: true, data: { trustRequired: false, pending: [], rejected: [] } });
});

it.each([{ agentRuntime: 'codex' } as SessionMeta, null])('never reads or mutates Claude MCP consent for an ineligible session %#', async meta => {
  harness.meta = meta;
  const feed = useApprovals('s1', vi.fn());
  await feed.decide({ approve: ['docs'], reject: [], trust: true });
  expect(feed.approvals).toBeNull();
  expect(feed.deciding).toBe(false);
  expect(feed.decideError).toBeNull();
  expect(harness.approvals).not.toHaveBeenCalled();
  expect(harness.decide).not.toHaveBeenCalled();
});

it('retains read and mutation for an eligible Claude session', async () => {
  harness.meta = { agentRuntime: 'claude-code' } as SessionMeta;
  const onDecided = vi.fn();
  const feed = useApprovals('s1', onDecided);
  const decision = { approve: ['docs'], reject: [], trust: true };
  await feed.decide(decision);
  expect(harness.approvals).toHaveBeenCalledWith('s1');
  expect(harness.decide).toHaveBeenCalledWith('s1', decision);
  expect(onDecided).toHaveBeenCalledOnce();
});
