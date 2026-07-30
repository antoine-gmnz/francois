import { describe, it, expect } from 'vitest';
import { worktreeSlug, previewWorktreePath } from './session-worktree';

// ---------- FR-9: worktreeSlug (parity table with src-tauri/src/session/worktree.rs `worktree_slug`) ----------

describe('worktreeSlug', () => {
  it('lowercases and replaces disallowed chars', () => {
    expect(worktreeSlug('feat/Auth Flow')).toBe('feat-auth-flow');
    expect(worktreeSlug('feat/parser')).toBe('feat-parser');
    expect(worktreeSlug('a.b_c-d')).toBe('a.b_c-d');
  });

  it('collapses runs and trims leading/trailing dashes', () => {
    expect(worktreeSlug('feat//weird__name!!')).toBe('feat-weird__name');
    expect(worktreeSlug('--leading-and-trailing--')).toBe('leading-and-trailing');
  });

  it('handles mixed case', () => {
    expect(worktreeSlug('FEAT/Mixed-CASE_Branch')).toBe('feat-mixed-case_branch');
  });

  it('replaces unicode characters (outside [a-z0-9._-]) with a dash', () => {
    expect(worktreeSlug('feat/héllo-wörld')).toBe('feat-h-llo-w-rld');
    // entirely non-ascii collapses to nothing → FR-9 placeholder, never a bare trailing separator
    expect(worktreeSlug('功能/新分支')).toBe('branch');
  });

  it('truncates to 60 chars and trims a trailing dash left by truncation', () => {
    const long = 'a'.repeat(58) + '-!!!'; // 58 a's, then chars that collapse to a single '-'
    const slug = worktreeSlug(long);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('truncates a long all-alnum branch to exactly 60 chars', () => {
    const long = 'b'.repeat(100);
    expect(worktreeSlug(long)).toBe('b'.repeat(60));
  });

  it('leaves an already-clean short slug untouched', () => {
    expect(worktreeSlug('main')).toBe('main');
  });
});

// ---------- FR-9: previewWorktreePath ----------

describe('previewWorktreePath', () => {
  it('builds the sibling path with forward slashes (POSIX repoRoot)', () => {
    expect(previewWorktreePath('/home/u/api', 'feat/parser')).toBe(
      '/home/u/.francois-worktrees/api/feat-parser',
    );
  });

  it('builds the sibling path with backslashes (Windows repoRoot)', () => {
    expect(previewWorktreePath('D:\\repo', 'feat/x')).toBe('D:\\.francois-worktrees\\repo\\feat-x');
  });

  it('strips a trailing separator on repoRoot before splitting', () => {
    expect(previewWorktreePath('/home/u/api/', 'feat/parser')).toBe(
      '/home/u/.francois-worktrees/api/feat-parser',
    );
    expect(previewWorktreePath('D:\\repo\\', 'feat/x')).toBe('D:\\.francois-worktrees\\repo\\feat-x');
  });

  it('slugifies the branch component of the path', () => {
    expect(previewWorktreePath('/home/u/api', 'FEAT/Auth Flow!!')).toBe(
      '/home/u/.francois-worktrees/api/feat-auth-flow',
    );
  });
});
