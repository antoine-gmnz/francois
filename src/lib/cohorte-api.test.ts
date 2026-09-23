import { expect, it, vi } from 'vitest';
const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({ ok: true, data: null }), listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
import * as api from './api';

it('binds every CohorteCommandMap entry to cohorte_<verb> with the request as `req` (FR-50)', async () => {
  const root = '/code/orbit';
  const run = { root, runId: 'run_abc' };
  const gate = { ...run, approvalId: 'apr_1' };
  const calls: [() => Promise<unknown>, string, object][] = [
    [() => api.cohorteDetect({ startDir: root, force: true }), 'cohorte_detect', { startDir: root, force: true }],
    [() => api.cohorteDoctor({ root }), 'cohorte_doctor', { root }],
    [() => api.cohortePolicy({ root }), 'cohorte_policy', { root }],
    [() => api.cohorteInit({ projectRoot: root }), 'cohorte_init', { projectRoot: root }],
    [() => api.cohorteWatch({ roots: [root], foreground: true }), 'cohorte_watch', { roots: [root], foreground: true }],
    [() => api.cohorteListRuns({ root }), 'cohorte_list_runs', { root }],
    [() => api.cohorteGetRun(run), 'cohorte_get_run', run],
    [() => api.cohorteRunLog({ ...run, limit: 200 }), 'cohorte_run_log', { ...run, limit: 200 }],
    [() => api.cohorteApprove(gate), 'cohorte_approve', gate],
    [() => api.cohorteSendToFix({ ...gate, note: 'n' }), 'cohorte_send_to_fix', { ...gate, note: 'n' }],
    [() => api.cohorteDeny({ ...gate, stopRun: true }), 'cohorte_deny', { ...gate, stopRun: true }],
    [() => api.cohortePause({ ...run, reason: 'lunch' }), 'cohorte_pause', { ...run, reason: 'lunch' }],
    [() => api.cohorteResume(run), 'cohorte_resume', run],
    [() => api.cohorteCancel(run), 'cohorte_cancel', run],
  ];
  for (const [call, cmd, req] of calls) {
    await call();
    expect(invoke).toHaveBeenLastCalledWith(cmd, { req });
  }
});

it('subscribes to francois://cohorte/event and hands over the payload', async () => {
  const cb = vi.fn();
  await api.listenCohorte(cb);
  expect(listen).toHaveBeenCalledWith('francois://cohorte/event', expect.any(Function));
  const handler = listen.mock.calls[0][1] as (e: { payload: unknown }) => void;
  handler({ payload: { type: 'francois.run.removed', projectRoot: '/r', runId: 'run_x' } });
  expect(cb).toHaveBeenCalledWith({ type: 'francois.run.removed', projectRoot: '/r', runId: 'run_x' });
});
