import { expect, it, vi } from 'vitest';
import { githubGetJob, githubGetStepLog } from '../../lib/api';
import { fixFailingChecksMessage } from './actions';
import type { CheckJob, StepLog } from '../../../contract/github-page';

vi.mock('../../lib/api', () => ({ githubGetJob: vi.fn(), githubGetStepLog: vi.fn() }));

it('includes GitLab whole-job trace errors in a fix session using synthetic step 1', async () => {
  vi.mocked(githubGetJob).mockResolvedValue({ ok: true, data: {
    name: 'lint', completed: true, state: 'failed', steps: [{ number: 1, name: 'Job log', state: 'failed' }],
  } as CheckJob });
  vi.mocked(githubGetStepLog).mockResolvedValue({ ok: true, data: {
    jobId: 42, stepNumber: 1, lines: [{ n: 1, kind: 'error', text: 'lint: unexpected token' }], totalLines: 1, droppedLines: 0, firstErrorLine: 1,
  } as StepLog });
  const message = await fixFailingChecksMessage('/repo', 'Fix failing checks on MR #3.', [{ name: 'lint', state: 'failed', jobId: 42 }]);
  expect(githubGetStepLog).toHaveBeenCalledWith({ cwd: '/repo', jobId: 42, stepNumber: 1 });
  expect(message).toContain('lint › Job log');
  expect(message).toContain('lint: unexpected token');
});
