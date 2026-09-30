import { beforeEach, expect, it, vi } from 'vitest';
import type { CohorteRun } from '../../../contract/cohorte-integration';
const harness = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('./terminal', () => ({ openCohorteTerminal: harness.open }));
import { shipRun } from './actions';

beforeEach(() => { harness.open.mockReset().mockResolvedValue(true); });

const run = { runId: 'run-123', projectRoot: '/repo', gate: null, view: 'waiting' } as CohorteRun;

it('launches a separate live ship command only for an explicitly approved candidate', async () => {
  expect(await shipRun(run, 'session-1')).toBe(false);
  expect(harness.open).not.toHaveBeenCalled();
  expect(await shipRun({ ...run, shipReady: true }, 'session-1')).toBe(true);
  expect(harness.open).toHaveBeenCalledWith('session-1', 'cohorte ship run-123 --live', { execute: true, root: '/repo', argv: ['ship', 'run-123', '--live'] });
});

it('does not ship before a pending gate is answered or after completion', async () => {
  expect(await shipRun({ ...run, shipReady: true, gate: {} as CohorteRun['gate'] }, 'session-1')).toBe(false);
  expect(await shipRun({ ...run, shipReady: true, view: 'completed' }, 'session-1')).toBe(false);
  expect(harness.open).not.toHaveBeenCalled();
});
