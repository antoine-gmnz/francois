import { beforeEach, expect, it, vi } from 'vitest';
import type { CohorteGate } from '../../../contract/cohorte-integration';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
import { initializationSummary, resolvePreparation } from './preparation';
beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue({ ok: true, data: { run: null } }); });

it('routes project questions and exact approvals without fabricating a run', async () => {
  const question = { request: { approvalId: 'question-123', kind: 'question' }, actions: [] } as unknown as CohorteGate;
  await resolvePreparation('/repo', question, { answer: 'Use PostgreSQL' });
  expect(mocks.invoke).toHaveBeenCalledWith('cohorte_v3_answer', { req: { root: '/repo', runId: '', approvalId: 'question-123', answer: 'Use PostgreSQL' } });
  const approval = { request: { approvalId: 'profile-123', kind: 'project-profile-review' }, actions: [{ id: 'approve' }] } as unknown as CohorteGate;
  await resolvePreparation('/repo', approval, { action: 'approve' });
  expect(mocks.invoke).toHaveBeenCalledWith('cohorte_v3_approve', { req: { root: '/repo', runId: '', approvalId: 'profile-123' } });
});

it('refuses unoffered decisions and non-question answers without I/O', async () => {
  const gate = { request: { approvalId: 'profile', kind: 'project-profile-review' }, actions: [] } as unknown as CohorteGate;
  expect((await resolvePreparation('/repo', gate, { action: 'approve' })).ok).toBe(false);
  expect((await resolvePreparation('/repo', gate, { answer: 'yes' })).ok).toBe(false);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('shows only supported profile analysis facts and tolerates absent data', () => {
  expect(initializationSummary(undefined)).toEqual([]);
  expect(initializationSummary({ surfaces: [{ id: 'frontend', paths: ['src'], role_profile: 'React', checks: [{ id: 'test' }] }, { unexpected: true }] })).toEqual(['frontend · src · React · 1 check']);
});
