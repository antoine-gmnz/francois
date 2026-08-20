import { describe, expect, it } from 'vitest';
import { WORKTREE_REF, diffUiReducer, initDiffUiState, type DiffUiState } from './diff-state';

describe('syncFiles (FR-1 seeding / §7 path enter/leave)', () => {
  it('seeds every newly-appearing path as checked, unread', () => {
    const s0 = initDiffUiState();
    const s1 = diffUiReducer(s0, { type: 'syncFiles', paths: ['a.ts', 'b.ts'] });
    expect(s1.inCommit).toEqual(new Set(['a.ts', 'b.ts']));
    expect(s1.knownPaths).toEqual(new Set(['a.ts', 'b.ts']));
  });

  it('is a no-op (same reference) when the path set is unchanged', () => {
    const s1 = diffUiReducer(initDiffUiState(), { type: 'syncFiles', paths: ['a.ts'] });
    const s2 = diffUiReducer(s1, { type: 'syncFiles', paths: ['a.ts'] });
    expect(s2).toBe(s1);
  });

  it('drops a path that left the summary from inCommit, collapsed and read (committed/reverted/stashed)', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'syncFiles', paths: ['a.ts', 'b.ts'] });
    s = diffUiReducer(s, { type: 'toggleCollapse', path: 'a.ts' });
    s = diffUiReducer(s, { type: 'markRead', paths: ['a.ts'], ref: WORKTREE_REF });
    s = diffUiReducer(s, { type: 'syncFiles', paths: ['b.ts'] }); // a.ts left
    expect(s.inCommit.has('a.ts')).toBe(false);
    expect(s.collapsed.has('a.ts')).toBe(false);
    expect(s.read.get(WORKTREE_REF)?.has('a.ts')).toBe(false);
    expect(s.knownPaths).toEqual(new Set(['b.ts']));
  });

  it('re-appending a previously-read path (left then re-entered) resets it unread', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'syncFiles', paths: ['a.ts'] });
    s = diffUiReducer(s, { type: 'markRead', paths: ['a.ts'], ref: WORKTREE_REF });
    s = diffUiReducer(s, { type: 'syncFiles', paths: [] }); // left
    s = diffUiReducer(s, { type: 'syncFiles', paths: ['a.ts'] }); // re-entered
    expect(s.read.get(WORKTREE_REF)?.has('a.ts')).toBe(false);
    expect(s.inCommit.has('a.ts')).toBe(true); // re-seeded checked
  });
});

describe('inCommit writes (FR-7/FR-20 — one set, two affordances)', () => {
  it('toggleInCommit flips a single path both ways', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'syncFiles', paths: ['a.ts'] });
    s = diffUiReducer(s, { type: 'toggleInCommit', path: 'a.ts' });
    expect(s.inCommit.has('a.ts')).toBe(false);
    s = diffUiReducer(s, { type: 'toggleInCommit', path: 'a.ts' });
    expect(s.inCommit.has('a.ts')).toBe(true);
  });

  it('setInCommit writes every path in the list to the same value — the directory checkbox write', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'syncFiles', paths: ['a.ts', 'b.ts', 'c.ts'] });
    s = diffUiReducer(s, { type: 'setInCommit', paths: ['a.ts', 'b.ts'], checked: false });
    expect(s.inCommit).toEqual(new Set(['c.ts']));
    s = diffUiReducer(s, { type: 'setInCommit', paths: ['a.ts', 'b.ts'], checked: true });
    expect(s.inCommit).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']));
  });
});

describe('read state (FR-28/FR-29/FR-31)', () => {
  it('markRead is one-way and additive', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'markRead', paths: ['a.ts'], ref: WORKTREE_REF });
    expect(s.read.get(WORKTREE_REF)).toEqual(new Set(['a.ts']));
    s = diffUiReducer(s, { type: 'markRead', paths: ['b.ts'], ref: WORKTREE_REF });
    expect(s.read.get(WORKTREE_REF)).toEqual(new Set(['a.ts', 'b.ts']));
  });

  it('markRead is a no-op (same reference) when every path is already read', () => {
    const s1 = diffUiReducer(initDiffUiState(), { type: 'markRead', paths: ['a.ts'], ref: WORKTREE_REF });
    const s2 = diffUiReducer(s1, { type: 'markRead', paths: ['a.ts'], ref: WORKTREE_REF });
    expect(s2).toBe(s1);
  });

  it('toggleRead flips read both ways (manual override, FR-29)', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'toggleRead', path: 'a.ts', ref: WORKTREE_REF });
    expect(s.read.get(WORKTREE_REF)?.has('a.ts')).toBe(true);
    s = diffUiReducer(s, { type: 'toggleRead', path: 'a.ts', ref: WORKTREE_REF });
    expect(s.read.get(WORKTREE_REF)?.has('a.ts')).toBe(false);
  });

  it('read is scoped per ref — the working tree and a viewed commit keep separate sets', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'markRead', paths: ['a.ts'], ref: WORKTREE_REF });
    s = diffUiReducer(s, { type: 'markRead', paths: ['a.ts'], ref: 'abc123' });
    expect(s.read.get(WORKTREE_REF)).toEqual(new Set(['a.ts']));
    expect(s.read.get('abc123')).toEqual(new Set(['a.ts']));
  });
});

describe('collapse (FR-3/FR-21/FR-23/FR-30 — read never auto-collapses)', () => {
  it('toggleCollapse flips a file both ways, independent of read', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'toggleCollapse', path: 'a.ts' });
    expect(s.collapsed.has('a.ts')).toBe(true);
    s = diffUiReducer(s, { type: 'markRead', paths: ['a.ts'], ref: WORKTREE_REF });
    expect(s.collapsed.has('a.ts')).toBe(true); // unaffected by becoming read
    s = diffUiReducer(s, { type: 'toggleCollapse', path: 'a.ts' });
    expect(s.collapsed.has('a.ts')).toBe(false);
  });

  it('collapseRead (FR-3) is a one-shot batch of the currently-read files', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'markRead', paths: ['a.ts', 'b.ts'], ref: WORKTREE_REF });
    s = diffUiReducer(s, { type: 'collapseRead', ref: WORKTREE_REF });
    expect(s.collapsed).toEqual(new Set(['a.ts', 'b.ts']));
  });

  it('collapseRead does not retroactively collapse a file read afterward (not a mode)', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'markRead', paths: ['a.ts'], ref: WORKTREE_REF });
    s = diffUiReducer(s, { type: 'collapseRead', ref: WORKTREE_REF });
    s = diffUiReducer(s, { type: 'markRead', paths: ['b.ts'], ref: WORKTREE_REF });
    expect(s.collapsed.has('b.ts')).toBe(false);
  });

  it('ensureCollapsed (FR-23 big-file guard) is idempotent and additive', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'ensureCollapsed', paths: ['big.ts'] });
    expect(s.collapsed.has('big.ts')).toBe(true);
    const s2 = diffUiReducer(s, { type: 'ensureCollapsed', paths: ['big.ts'] });
    expect(s2).toBe(s); // no-op once already collapsed — never re-forces after a manual expand
  });
});

describe('commit view (FR-15/FR-39 §7)', () => {
  it('viewCommit sets the ref and clears any stale workingTreeChanged flag', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'flagWorkingTreeChanged' });
    s = diffUiReducer(s, { type: 'viewCommit', hash: 'abc123' });
    expect(s.viewingCommit).toBe('abc123');
    expect(s.workingTreeChanged).toBe(false);
  });

  it('flagWorkingTreeChanged sets the flag once; backToWorktree clears it and the ref', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'viewCommit', hash: 'abc123' });
    s = diffUiReducer(s, { type: 'flagWorkingTreeChanged' });
    expect(s.workingTreeChanged).toBe(true);
    s = diffUiReducer(s, { type: 'backToWorktree' });
    expect(s.viewingCommit).toBeNull();
    expect(s.workingTreeChanged).toBe(false);
  });
});

describe('draft / amend (FR-35..FR-39)', () => {
  it('setDraft merges a patch', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'setDraft', patch: { subject: 'fix bug' } });
    expect(s.draft).toEqual({ subject: 'fix bug', body: '', amend: false });
  });

  it('setAmend pre-fills subject/body only the first time, when both are empty', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'setAmend', amend: true, headSubject: 'HEAD subject', headBody: 'HEAD body' });
    expect(s.draft).toEqual({ subject: 'HEAD subject', body: 'HEAD body', amend: true });
  });

  it('setAmend does not overwrite text the user already typed', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'setDraft', patch: { subject: 'my own subject' } });
    s = diffUiReducer(s, { type: 'setAmend', amend: true, headSubject: 'HEAD subject', headBody: 'HEAD body' });
    expect(s.draft.subject).toBe('my own subject');
    expect(s.draft.amend).toBe(true);
  });

  it('unticking amend never clears what was typed (including a pre-filled value)', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'setAmend', amend: true, headSubject: 'HEAD subject', headBody: 'HEAD body' });
    s = diffUiReducer(s, { type: 'setAmend', amend: false, headSubject: 'HEAD subject', headBody: 'HEAD body' });
    expect(s.draft).toEqual({ subject: 'HEAD subject', body: 'HEAD body', amend: false });
  });
});

describe('commit form open/close + success (FR-33/FR-34/FR-37)', () => {
  it('openCommit / closeCommit toggle commitOpen', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'openCommit' });
    expect(s.commitOpen).toBe(true);
    s = diffUiReducer(s, { type: 'closeCommit' });
    expect(s.commitOpen).toBe(false);
  });

  it('closeCommit keeps the draft (Esc keeps the draft, FR-34)', () => {
    let s: DiffUiState = diffUiReducer(initDiffUiState(), { type: 'setDraft', patch: { subject: 'wip' } });
    s = diffUiReducer(s, { type: 'openCommit' });
    s = diffUiReducer(s, { type: 'closeCommit' });
    expect(s.draft.subject).toBe('wip');
  });

  it('commitSucceeded clears the draft, closes the form, and drops read state for the committed paths', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'markRead', paths: ['a.ts', 'b.ts'], ref: WORKTREE_REF });
    s = diffUiReducer(s, { type: 'setDraft', patch: { subject: 'fix bug' } });
    s = diffUiReducer(s, { type: 'openCommit' });
    s = diffUiReducer(s, { type: 'commitSucceeded', paths: ['a.ts'] });
    expect(s.read.get(WORKTREE_REF)).toEqual(new Set(['b.ts']));
    expect(s.draft).toEqual({ subject: '', body: '', amend: false });
    expect(s.commitOpen).toBe(false);
  });
});

describe('rail mode / filter / fold / cursor', () => {
  it('setRailMode / setFilter / setCursor are no-ops (same reference) when unchanged', () => {
    const s0 = initDiffUiState();
    expect(diffUiReducer(s0, { type: 'setRailMode', mode: 'tree' })).toBe(s0);
    expect(diffUiReducer(s0, { type: 'setFilter', value: '' })).toBe(s0);
    expect(diffUiReducer(s0, { type: 'setCursor', key: null })).toBe(s0);
  });

  it('toggleFold flips a folder key both ways', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'toggleFold', key: 'src' });
    expect(s.folded.has('src')).toBe(true);
    s = diffUiReducer(s, { type: 'toggleFold', key: 'src' });
    expect(s.folded.has('src')).toBe(false);
  });

  it('toggleCommitsExpanded flips the expander', () => {
    let s = diffUiReducer(initDiffUiState(), { type: 'toggleCommitsExpanded' });
    expect(s.commitsExpanded).toBe(true);
    s = diffUiReducer(s, { type: 'toggleCommitsExpanded' });
    expect(s.commitsExpanded).toBe(false);
  });
});
