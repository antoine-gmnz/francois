// session-worktree (specs/session-worktree.md) — pure logic covering FR-2, FR-3,
// FR-14, FR-15, FR-18/19 and the palette FR-16 preset handoff. Node env, no DOM:
// localStorage is stubbed exactly like projects.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError, SessionMeta, SessionWorktree } from '../../../contract/common';
import type { WorktreeProbeData, WorktreeStatusData } from '../../../contract/session-worktree';
import { WORKTREE_NOTICE_STORAGE_KEY } from '../../../contract/session-worktree';
import {
  basenameOf,
  canOpenWorktreeRecovery,
  consumeWorktreePreset,
  defaultWorktreeBranch,
  dismissWorktreeNotice,
  isValidBranchName,
  isWorktreeNoticeDismissed,
  liveWorktreeProbe,
  requestWorktreePreset,
  siblingWorktreeSummaryLine,
  submitErrorBanner,
  truncateBranchLeft,
  worktreeBranchInUsePath,
  worktreeCreateBlocked,
  worktreeFetchWarningLine,
  worktreeRemovalBlockReason,
} from './worktree';
import type { WorktreeGateState, WorktreeProbeState, WorktreeRecoveryGateState } from './worktree';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    name: 'francois',
    cwd: '/repo',
    model: { id: 'm', label: 'Model' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    runtime: 'native',
    accountId: 'default',
    ...over,
  };
}

function wt(over: Partial<SessionWorktree> = {}): SessionWorktree {
  return {
    branch: 'feat/x',
    baseRef: 'main',
    path: '/repo/../.francois-worktrees/repo/feat-x',
    sourceRepoRoot: '/repo',
    createdBranch: true,
    fetched: true,
    ...over,
  };
}

describe('basenameOf', () => {
  it('handles both separators and trailing slashes', () => {
    expect(basenameOf('/a/b/c')).toBe('c');
    expect(basenameOf('C:\\a\\b\\c')).toBe('c');
    expect(basenameOf('/a/b/')).toBe('b');
  });
});

describe('defaultWorktreeBranch (FR-2)', () => {
  it('slugs the session name', () => {
    expect(defaultWorktreeBranch('My Session!', '/repo')).toBe('feat/my-session');
  });
  it('falls back to basename(cwd) when the name is empty after trim', () => {
    expect(defaultWorktreeBranch('   ', '/home/u/francois')).toBe('feat/francois');
  });
  it('collapses non-alnum runs and trims edges', () => {
    expect(defaultWorktreeBranch('  --Auth Fix--  ', '/repo')).toBe('feat/auth-fix');
  });
});

describe('isValidBranchName (FR-3 convenience check)', () => {
  it.each([
    ['feat/auth', true],
    ['feat/Auth-Fix_2', true],
    ['', false],
    ['   ', false],
    ['@', false],
    ['/feat/auth', false],
    ['feat/auth/', false],
    ['-feat', false],
    ['feat..auth', false],
    ['feat@{up}', false],
    ['feat auth', false],
    ['feat~auth', false],
    ['feat^auth', false],
    ['feat:auth', false],
    ['feat.lock', false],
    ['feat.', false],
    ['feat//auth', false],
    ['feat/.hidden', false],
  ])('%s -> %s', (branch, valid) => {
    expect(isValidBranchName(branch)).toBe(valid);
  });
});

describe('worktreeCreateBlocked (FR-1/FR-3 probe staleness gate)', () => {
  function gate(over: Partial<WorktreeGateState> = {}): WorktreeGateState {
    return {
      worktreeEnabled: true,
      probeIsRepo: true,
      probing: false,
      probeErrored: false,
      branch: 'feat/x',
      branchValid: true,
      recoveryPath: null,
      ...over,
    };
  }

  it('is never blocked when the worktree checkbox is off, regardless of probe state', () => {
    expect(worktreeCreateBlocked(gate({ worktreeEnabled: false, probeIsRepo: null, probing: true, probeErrored: true }))).toBe(
      false,
    );
  });

  it('is unblocked on a settled, successful, in-repo probe with a valid branch', () => {
    expect(worktreeCreateBlocked(gate())).toBe(false);
  });

  it('blocks while a probe is still in flight, even if the last known probe was a repo', () => {
    expect(worktreeCreateBlocked(gate({ probing: true }))).toBe(true);
  });

  it('blocks after a probe request errors, even with a sticky isRepo:true from before', () => {
    expect(worktreeCreateBlocked(gate({ probeErrored: true }))).toBe(true);
  });

  it('does NOT silently unblock (i.e. degrade into a plain create) on error or pending — it always blocks', () => {
    // This is the regression this gate exists to prevent: previously a failed
    // probe nulled `isRepo` and the create gate fell through as unblocked.
    expect(worktreeCreateBlocked(gate({ probeErrored: true, probeIsRepo: null }))).toBe(true);
    expect(worktreeCreateBlocked(gate({ probing: true, probeIsRepo: null }))).toBe(true);
  });

  it('stays blocked while the probe result is still unknown (pending/never resolved)', () => {
    expect(worktreeCreateBlocked(gate({ probeIsRepo: null }))).toBe(true);
  });

  it('unblocks (allows a plain, non-worktree create) once the probe confirms the cwd is not a repo', () => {
    expect(worktreeCreateBlocked(gate({ probeIsRepo: false }))).toBe(false);
  });

  it('blocks on a recovery path (branch already checked out elsewhere)', () => {
    expect(worktreeCreateBlocked(gate({ recoveryPath: '/other/checkout' }))).toBe(true);
  });

  it('blocks on an empty or invalid branch', () => {
    expect(worktreeCreateBlocked(gate({ branch: '' }))).toBe(true);
    expect(worktreeCreateBlocked(gate({ branch: '   ' }))).toBe(true);
    expect(worktreeCreateBlocked(gate({ branchValid: false }))).toBe(true);
  });
});

describe('canOpenWorktreeRecovery (FR-5 recovery-offer gate, probe-staleness)', () => {
  function gate(over: Partial<WorktreeRecoveryGateState> = {}): WorktreeRecoveryGateState {
    return {
      name: 'my session',
      modelId: 'm',
      projectRootMissing: false,
      submitting: false,
      recovering: false,
      probing: false,
      probeErrored: false,
      ...over,
    };
  }

  it('is open when every field settles clean', () => {
    expect(canOpenWorktreeRecovery(gate())).toBe(true);
  });

  it('blocks while a probe is still in flight for the current branch — regression: a branch', () => {
    // edit re-probes (worktree.ts liveWorktreeProbe only invalidates on cwd, not
    // branch) so the amber card can still show the PREVIOUS branch's
    // branchCheckedOutAt while the field holds a different value; this must not
    // stay clickable during that debounce + round-trip window.
    expect(canOpenWorktreeRecovery(gate({ probing: true }))).toBe(false);
  });

  it('blocks when the last probe for the current branch errored', () => {
    expect(canOpenWorktreeRecovery(gate({ probeErrored: true }))).toBe(false);
  });

  it('blocks on the same non-worktree guards as canCreate', () => {
    expect(canOpenWorktreeRecovery(gate({ name: '' }))).toBe(false);
    expect(canOpenWorktreeRecovery(gate({ name: '   ' }))).toBe(false);
    expect(canOpenWorktreeRecovery(gate({ modelId: '' }))).toBe(false);
    expect(canOpenWorktreeRecovery(gate({ projectRootMissing: true }))).toBe(false);
    expect(canOpenWorktreeRecovery(gate({ submitting: true }))).toBe(false);
  });

  it('blocks its own re-entrancy guard', () => {
    expect(canOpenWorktreeRecovery(gate({ recovering: true }))).toBe(false);
  });
});

describe('worktreeRemovalBlockReason (FR-18/FR-19)', () => {
  const base: WorktreeStatusData = { dirty: false, dirtyCount: 0, unpushed: false, unpushedCount: 0, upstream: null };

  it('is null when clean and pushed', () => {
    expect(worktreeRemovalBlockReason(base)).toBeNull();
  });
  it('reports dirty count, singular vs plural', () => {
    expect(worktreeRemovalBlockReason({ ...base, dirty: true, dirtyCount: 1 })).toBe('1 uncommitted file');
    expect(worktreeRemovalBlockReason({ ...base, dirty: true, dirtyCount: 3 })).toBe('3 uncommitted files');
  });
  it('reports unpushed count against the upstream name', () => {
    expect(
      worktreeRemovalBlockReason({ ...base, unpushed: true, unpushedCount: 2, upstream: 'origin/feat/x' }),
    ).toBe('2 commits not on origin/feat/x');
  });
  it('falls back to a generic upstream label when there is none', () => {
    expect(worktreeRemovalBlockReason({ ...base, unpushed: true, unpushedCount: 1, upstream: null })).toBe(
      '1 commit not on its upstream',
    );
  });
  it('joins both reasons when both apply', () => {
    expect(
      worktreeRemovalBlockReason({ dirty: true, dirtyCount: 3, unpushed: true, unpushedCount: 2, upstream: 'origin/feat/x' }),
    ).toBe('3 uncommitted files · 2 commits not on origin/feat/x');
  });

  // contract §WorktreeStatusData / spec §5: `unpushed: true` + `unpushedCount: 0`
  // is the "push status could not be determined" sentinel, NOT a literal zero.
  it('renders the push-status-unknown sentinel instead of "0 commits"', () => {
    const reason = worktreeRemovalBlockReason({ ...base, unpushed: true, unpushedCount: 0, upstream: null });
    expect(reason).toBe('push status unknown — no upstream configured');
    expect(reason).not.toContain('0 commit');
  });

  it('still says "push status unknown" for the sentinel when an upstream name is present', () => {
    expect(worktreeRemovalBlockReason({ ...base, unpushed: true, unpushedCount: 0, upstream: 'origin/feat/x' })).toBe(
      'push status unknown',
    );
  });

  it('joins the dirty reason with the sentinel', () => {
    expect(worktreeRemovalBlockReason({ dirty: true, dirtyCount: 1, unpushed: true, unpushedCount: 0, upstream: null })).toBe(
      '1 uncommitted file · push status unknown — no upstream configured',
    );
  });
});

describe('liveWorktreeProbe (FR-1 — a probe belongs to the cwd it was requested for)', () => {
  const data: WorktreeProbeData = {
    isRepo: true,
    repoRoot: '/repo-a',
    defaultBranch: 'main',
    currentBranch: 'main',
    remote: 'origin',
    branchExists: true,
    branchCheckedOutAt: '/elsewhere',
    worktreePath: '/x/.francois-worktrees/repo-a/feat-x',
  };
  const state: WorktreeProbeState = { cwd: '/repo-a', data, errored: false };

  it('is empty with no probe at all', () => {
    expect(liveWorktreeProbe(null, '/repo-a')).toEqual({ data: null, errored: false });
  });

  it('returns the data for the cwd it was requested for, ignoring surrounding whitespace', () => {
    expect(liveWorktreeProbe(state, '/repo-a')).toEqual({ data, errored: false });
    expect(liveWorktreeProbe(state, '  /repo-a  ')).toEqual({ data, errored: false });
  });

  it('keeps the sticky error flag for the matching cwd (a blip never nulls the data)', () => {
    expect(liveWorktreeProbe({ ...state, errored: true }, '/repo-a')).toEqual({ data, errored: true });
  });

  it('goes stale IMMEDIATELY on a cwd change — repo A details never render for repo B', () => {
    expect(liveWorktreeProbe(state, '/repo-b')).toEqual({ data: null, errored: false });
    expect(liveWorktreeProbe({ ...state, errored: true }, '/repo-b')).toEqual({ data: null, errored: false });
  });

  it('goes stale when the cwd is cleared', () => {
    expect(liveWorktreeProbe(state, '')).toEqual({ data: null, errored: false });
    expect(liveWorktreeProbe(state, '   ')).toEqual({ data: null, errored: false });
  });

  it('feeds worktreeCreateBlocked an unknown (blocking) isRepo across a cwd change', () => {
    const live = liveWorktreeProbe(state, '/repo-b');
    expect(
      worktreeCreateBlocked({
        worktreeEnabled: true,
        probeIsRepo: live.data?.isRepo ?? null,
        probing: false,
        probeErrored: live.errored,
        branch: 'feat/x',
        branchValid: true,
        recoveryPath: live.data?.branchCheckedOutAt ?? null,
      }),
    ).toBe(true);
  });
});

describe('worktreeFetchWarningLine (FR-14)', () => {
  it('is null when fetched', () => {
    expect(worktreeFetchWarningLine(wt({ fetched: true }))).toBeNull();
  });
  it('is null when there is no remote (no fetchError)', () => {
    expect(worktreeFetchWarningLine(wt({ fetched: false }))).toBeNull();
  });
  it('names the base ref when the fetch failed', () => {
    expect(worktreeFetchWarningLine(wt({ fetched: false, fetchError: 'timed out', baseRef: 'main' }))).toBe(
      'could not fetch — forked from local `main`',
    );
  });
});

describe('worktree notice dismissal (FR-14, localStorage)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('is not dismissed with no storage at all', () => {
    expect(isWorktreeNoticeDismissed('s1')).toBe(false);
  });

  it('round-trips a dismissal under the contract key', () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    expect(isWorktreeNoticeDismissed('s1')).toBe(false);
    dismissWorktreeNotice('s1');
    expect(isWorktreeNoticeDismissed('s1')).toBe(true);
    expect(JSON.parse(store.getItem(WORKTREE_NOTICE_STORAGE_KEY) as string)).toEqual(['s1']);
  });

  it('never returns for that session, and is per-session', () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    dismissWorktreeNotice('s1');
    dismissWorktreeNotice('s1'); // idempotent
    dismissWorktreeNotice('s2');
    expect(isWorktreeNoticeDismissed('s1')).toBe(true);
    expect(isWorktreeNoticeDismissed('s2')).toBe(true);
    expect(isWorktreeNoticeDismissed('s3')).toBe(false);
  });
});

describe('siblingWorktreeSummaryLine (FR-15)', () => {
  it('is null when the session itself is a worktree session', () => {
    const main = session({ id: 'main', cwd: '/repo', worktree: wt() });
    expect(siblingWorktreeSummaryLine(main, [main], true)).toBeNull();
  });

  it('is null when there are no siblings', () => {
    const main = session({ id: 'main', cwd: '/repo' });
    expect(siblingWorktreeSummaryLine(main, [main], true)).toBeNull();
  });

  it('lists siblings by branch, count first, singular vs plural', () => {
    const main = session({ id: 'main', cwd: '/repo' });
    const a = session({ id: 'a', cwd: '/x/feat-a', worktree: wt({ branch: 'feat/auth', sourceRepoRoot: '/repo' }) });
    expect(siblingWorktreeSummaryLine(main, [main, a], true)).toBe('1 worktree session · feat/auth');
    const b = session({ id: 'b', cwd: '/x/feat-b', worktree: wt({ branch: 'feat/parser', sourceRepoRoot: '/repo' }) });
    expect(siblingWorktreeSummaryLine(main, [main, a, b], true)).toBe('2 worktree sessions · feat/auth, feat/parser');
  });
});

describe('truncateBranchLeft (FR-13)', () => {
  it('leaves short names untouched', () => {
    expect(truncateBranchLeft('feat/auth', 26)).toBe('feat/auth');
  });
  it('left-truncates long names with an ellipsis', () => {
    const long = 'feat/a-very-long-branch-name-indeed';
    const out = truncateBranchLeft(long, 16);
    expect(out.length).toBe(16);
    expect(out.startsWith('…')).toBe(true);
    expect(long.endsWith(out.slice(1))).toBe(true);
  });
});

describe('worktreeBranchInUsePath (§7 race: branch checked out between probe and create)', () => {
  it('extracts the path from a WORKTREE_BRANCH_IN_USE error', () => {
    const err: AppError = { code: 'WORKTREE_BRANCH_IN_USE', message: 'in use', detail: { path: '/other/checkout' } };
    expect(worktreeBranchInUsePath(err)).toBe('/other/checkout');
  });

  it('is null for any other error code', () => {
    const err: AppError = { code: 'GIT_ERROR', message: 'oops', detail: { path: '/other/checkout' } };
    expect(worktreeBranchInUsePath(err)).toBeNull();
  });

  it('is null when detail is missing or malformed', () => {
    expect(worktreeBranchInUsePath({ code: 'WORKTREE_BRANCH_IN_USE', message: 'in use' })).toBeNull();
    expect(worktreeBranchInUsePath({ code: 'WORKTREE_BRANCH_IN_USE', message: 'in use', detail: {} })).toBeNull();
    expect(
      worktreeBranchInUsePath({ code: 'WORKTREE_BRANCH_IN_USE', message: 'in use', detail: { path: 42 } }),
    ).toBeNull();
  });
});

describe('submitErrorBanner (§7 race: recovery offer instead of a dead-end error)', () => {
  it('suppresses the red banner when the error carries a recovery path', () => {
    // The form transitions to the SAME amber recovery offer FR-5's probe drives,
    // so stacking the raw WORKTREE_BRANCH_IN_USE message on top of it would
    // contradict §7 ("the form transitions to the same recovery offer").
    const err: AppError = { code: 'WORKTREE_BRANCH_IN_USE', message: 'in use', detail: { path: '/other/checkout' } };
    expect(submitErrorBanner(err)).toBeNull();
    // …and it agrees with the helper that derives the offer, by construction.
    expect(worktreeBranchInUsePath(err)).toBe('/other/checkout');
  });

  it('still surfaces WORKTREE_BRANCH_IN_USE when no path came with it (no offer to fall back on)', () => {
    const err: AppError = { code: 'WORKTREE_BRANCH_IN_USE', message: 'in use' };
    expect(submitErrorBanner(err)).toBe(err);
  });

  it('passes every other error through unchanged', () => {
    const err: AppError = { code: 'WORKTREE_CREATE_FAILED', message: 'git said no' };
    expect(submitErrorBanner(err)).toBe(err);
    const other: AppError = { code: 'PROJECT_ROOT_MISSING', message: 'gone' };
    expect(submitErrorBanner(other)).toBe(other);
  });
});

describe('command-palette worktree preset (FR-16)', () => {
  it('is one-shot: set then consumed exactly once', () => {
    expect(consumeWorktreePreset()).toBe(false);
    requestWorktreePreset();
    expect(consumeWorktreePreset()).toBe(true);
    expect(consumeWorktreePreset()).toBe(false);
  });
});
