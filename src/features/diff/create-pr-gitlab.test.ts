import { beforeEach, expect, it, vi } from 'vitest';
import { createRequestPrompt, requestCreatePr } from './create-pr';
import { githubRepoInfo } from '../../lib/api';
import { sendPrompt } from '../../lib/send-prompt';
import { useStore } from '../../lib/store';
import type { SessionMeta } from '../../../contract/common';

vi.mock('../../lib/api', () => ({ githubRepoInfo: vi.fn() }));
vi.mock('../../lib/send-prompt', () => ({ sendPrompt: vi.fn().mockResolvedValue(true) }));

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ sessions: [{ id: 'session', cwd: '/gitlab-worktree' } as SessionMeta] });
});
it('builds an MR prompt using glab and asks for an existing MR update and URL', () => {
  const prompt = createRequestPrompt('gitlab');
  expect(prompt).toContain('glab mr create');
  expect(prompt).toContain('MR URL');
  expect(prompt).toContain('update it instead');
  expect(prompt).not.toContain('gh pr create');
});
it('resolves the session repository before sending instead of assuming active project provider', async () => {
  vi.mocked(githubRepoInfo).mockResolvedValue({ ok: true, data: { provider: 'gitlab' } as never });
  await expect(requestCreatePr('session')).resolves.toBe(true);
  expect(githubRepoInfo).toHaveBeenCalledWith('/gitlab-worktree');
  expect(sendPrompt).toHaveBeenCalledWith('session', expect.stringContaining('glab mr create'));
});
it('does not ask an agent to create a GitHub PR for an unknown remote or failed detection', async () => {
  vi.mocked(githubRepoInfo).mockResolvedValue({ ok: true, data: { provider: 'unknown' } as never });
  await expect(requestCreatePr('session')).resolves.toBe(false);
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('retains GitHub behavior when the optional provider is absent', async () => {
  vi.mocked(githubRepoInfo).mockResolvedValue({ ok: true, data: {} as never });
  await expect(requestCreatePr('session')).resolves.toBe(true);
  expect(sendPrompt).toHaveBeenCalledWith('session', expect.stringContaining('gh pr create'));
});
it('does not send when repository detection fails', async () => {
  vi.mocked(githubRepoInfo).mockResolvedValue({ ok: false, error: { code: 'GH_UNAVAILABLE', message: 'Unavailable' } });
  await expect(requestCreatePr('session')).resolves.toBe(false);
  expect(sendPrompt).not.toHaveBeenCalled();
});
