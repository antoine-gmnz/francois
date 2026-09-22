import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../contract/common';
import { sessionMetaLine } from './session-header';

const base = { cwd: '/home/me/code/orbit/api', worktree: undefined } as unknown as SessionMeta;

describe('sessionMetaLine', () => {
  it('reads "<branch>  /  worktree" for a worktree session, with the path in the title', () => {
    const line = sessionMetaLine(base, '/home/me', 'feat/auth-retry');
    expect(line).toEqual({ branch: 'feat/auth-retry', text: 'feat/auth-retry  /  worktree', title: '~/code/orbit/api' });
  });

  it('falls back to the abbreviated cwd when there is no worktree (no branch probe runs)', () => {
    const line = sessionMetaLine(base, '/home/me', null);
    expect(line).toEqual({ branch: null, text: '~/code/orbit/api', title: '~/code/orbit/api' });
  });

  it('shows a WSL path in its distro:linux form (displayWslCwd)', () => {
    const wsl = { cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', worktree: undefined } as unknown as SessionMeta;
    const line = sessionMetaLine(wsl, 'C:\\Users\\me', null);
    expect(line.text).toBe('Ubuntu:/home/me/repo');
  });
});
