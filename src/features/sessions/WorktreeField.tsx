// WorktreeField — session-worktree §8 screen 1: the "Isolate in worktree" group
// of the New Session modal (FR-1..FR-5, FR-9). Absent entirely on a non-repo cwd
// (FR-1) — no gap, no disabled control. All state and decision logic lives in
// useWorktreeGroup / worktree.ts; this file is layout only.

import { Chip } from '../../ui/Chip';
import type { UseWorktreeGroupResult } from './useWorktreeGroup';

export interface WorktreeFieldProps {
  worktree: UseWorktreeGroupResult;
  onOpenRecovery: () => void;
}

export function WorktreeField({ worktree, onOpenRecovery }: WorktreeFieldProps): JSX.Element | null {
  const {
    probe,
    worktreeEnabled,
    setWorktreeEnabled,
    branch,
    setBranch,
    baseRef,
    setBaseRef,
    branchValid,
    worktreePreview,
    recoveryPath,
    recovering,
    canOpenRecovery,
  } = worktree;

  if (!probe?.isRepo) return null;

  return (
    <div>
      <label className="new-session-modal__label">WORKTREE</label>
      <div className="new-session-modal__chip-row">
        <Chip selected={worktreeEnabled} onClick={() => setWorktreeEnabled((v) => !v)}>
          {worktreeEnabled ? '✓ ' : ''}Isolate in worktree
        </Chip>
      </div>
      <div className="new-session-modal__hint new-session-modal__hint--below-chips">runs this session in its own git worktree</div>

      {worktreeEnabled && (
        <div className="worktree-field">
          <div>
            <label className="new-session-modal__label">BRANCH</label>
            <input
              className="new-session-modal__field worktree-field__mono"
              value={branch}
              placeholder="feat/my-change"
              onChange={(e) => setBranch(e.target.value)}
            />
          </div>
          <div>
            <label className="new-session-modal__label">BASE REF</label>
            {/* FR-3: an existing branch is checked out as-is, so its base ref is
                not a choice the form can offer. */}
            <input
              className={
                probe.branchExists
                  ? 'new-session-modal__field worktree-field__mono worktree-field__mono--disabled'
                  : 'new-session-modal__field worktree-field__mono'
              }
              value={baseRef}
              disabled={!!probe.branchExists}
              placeholder="main"
              onChange={(e) => setBaseRef(e.target.value)}
            />
          </div>
          {/* FR-9 path preview. design brief §"Narrow window": middle-/left-truncates
              (direction: rtl) rather than losing its meaningful tail to a trailing
              ellipsis — same intent as truncateBranchLeft's FR-13 chip. */}
          {worktreePreview && (
            <div className="worktree-field__preview" title={worktreePreview}>
              {worktreePreview}
            </div>
          )}

          {/* inline notice slot (FR-4/FR-5/FR-3) */}
          {recoveryPath ? (
            <div className="worktree-field__recovery">
              <span>
                <code>{branch.trim()}</code> is already checked out at <code title={recoveryPath}>{recoveryPath}</code>
              </span>
              <span
                onClick={() => canOpenRecovery && onOpenRecovery()}
                className={canOpenRecovery ? 'worktree-field__recovery-action' : 'worktree-field__recovery-action worktree-field__recovery-action--disabled'}
              >
                {recovering ? 'opening…' : 'Open a session there instead'}
              </span>
            </div>
          ) : probe.branchExists ? (
            <div className="new-session-modal__hint">existing branch — will be checked out</div>
          ) : (
            branch.trim() !== '' && !branchValid && <div className="new-session-modal__hint new-session-modal__hint--error">invalid branch name</div>
          )}
        </div>
      )}
    </div>
  );
}
