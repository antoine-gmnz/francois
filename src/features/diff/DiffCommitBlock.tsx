import type { RefObject } from 'react';
import type { DiffFileSummary } from '../../../contract/diff-view';
import { DIFF_STATUS } from './diff-status';
import { SUBJECT_LIMIT, buildManifest, staysBehindLine, subjectMeterState } from './diff-commit-form';
import type { DiffDraft } from './diff-state';

export interface DiffCommitBlockProps {
  files: DiffFileSummary[];
  inCommit: Set<string>;
  readCount: number;
  totalFiles: number;
  hiddenChecked: number;

  /** FR-15: viewing a commit replaces this whole block with a return strip. */
  viewingCommit: string | null;
  viewingShortHash: string | null;
  workingTreeChanged: boolean;
  onBackToWorktree: () => void;

  open: boolean;
  onOpenStrip: () => void;
  onCloseForm: () => void;

  draft: DiffDraft;
  onDraftChange: (patch: Partial<DiffDraft>) => void;
  onSetAmend: (amend: boolean) => void;
  headPushed: boolean;

  busy: boolean;
  error: string | null;
  onCommit: () => void;
  subjectInputRef: RefObject<HTMLInputElement>;
}

/** diff-review FR-33..FR-39: the commit block — a 26px closed strip, or the form
 *  across the bottom of the pane (never squeezing into one row). */
export function DiffCommitBlock(props: DiffCommitBlockProps): JSX.Element {
  const {
    files,
    inCommit,
    readCount,
    totalFiles,
    hiddenChecked,
    viewingCommit,
    viewingShortHash,
    workingTreeChanged,
    onBackToWorktree,
    open,
    onOpenStrip,
    onCloseForm,
    draft,
    onDraftChange,
    onSetAmend,
    headPushed,
    busy,
    error,
    onCommit,
    subjectInputRef,
  } = props;

  if (viewingCommit !== null) {
    return (
      <div className="diff-commit-block">
        <div className="diff-commit-strip diff-commit-strip--viewing">
          <span>viewing {viewingShortHash}</span>
          <span className="diff-commit-strip__back" onClick={onBackToWorktree}>
            back to working tree
          </span>
          {workingTreeChanged && <span className="diff-commit-strip__hint">· working tree changed</span>}
        </div>
      </div>
    );
  }

  const checkedCount = inCommit.size;

  if (!open) {
    const disabled = files.length === 0;
    return (
      <div className="diff-commit-block">
        <div className={disabled ? 'diff-commit-strip diff-commit-strip--disabled' : 'diff-commit-strip'} onClick={() => !disabled && onOpenStrip()}>
          <span>
            {checkedCount} of {files.length} in commit
          </span>
          <span className="diff-commit-strip__spacer" />
          {!disabled && <span className="diff-commit-strip__hint">[c] commit</span>}
        </div>
      </div>
    );
  }

  const manifest = buildManifest(files, inCommit);
  const staysBehind = staysBehindLine(files, inCommit);
  const meter = subjectMeterState(draft.subject);
  const subjectTrimmed = draft.subject.trim();
  // FR-36: nothing checked disables the button outright, amend included — the form
  // always names an explicit path list when anything IS checked (readiness gap:
  // the spec's normative core note also allows amend with zero paths to amend the
  // message alone; this frontend never offers that path — see handoff).
  const commitDisabled = busy || subjectTrimmed === '' || checkedCount === 0;

  return (
    <div className="diff-commit-block">
      <div
        className="diff-commit-form"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!commitDisabled) onCommit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCloseForm();
          }
        }}
      >
        <div className="diff-commit-form__header">
          <span className="diff-commit-form__title">COMMIT</span>
          <span>
            {checkedCount} of {files.length} files
          </span>
          <span>
            {readCount} of {totalFiles} read
          </span>
          <span className="diff-commit-form__spacer" />
          <label className="diff-commit-form__amend">
            <input type="checkbox" checked={draft.amend} onChange={(e) => onSetAmend(e.target.checked)} />
            amend last commit
          </label>
          <span className="diff-commit-form__esc" onClick={onCloseForm}>
            esc
          </span>
        </div>

        {draft.amend && headPushed && <div className="diff-commit-form__warn">already pushed — amending needs a force-push</div>}

        <div className="diff-commit-subject-row">
          <span className="diff-commit-subject-row__prompt">›</span>
          <input
            ref={subjectInputRef}
            className="diff-commit-subject-input"
            value={draft.subject}
            placeholder="commit subject…"
            onChange={(e) => onDraftChange({ subject: e.target.value })}
          />
          <span className={meter.warn ? 'diff-commit-subject-row__meter diff-commit-subject-row__meter--warn' : 'diff-commit-subject-row__meter'}>
            {meter.len}/{SUBJECT_LIMIT}
          </span>
        </div>

        <div className="diff-commit-form__body-row">
          <textarea
            className="diff-commit-description"
            value={draft.body}
            placeholder="extended description (optional)…"
            onChange={(e) => onDraftChange({ body: e.target.value })}
          />
          <div className="diff-commit-manifest">
            {manifest.shown.map((f) => {
              const st = DIFF_STATUS[f.status] ?? DIFF_STATUS.modified;
              return (
                <div key={f.path} className="diff-commit-manifest__row" title={f.path}>
                  <span className="diff-commit-manifest__status" style={{ color: st.color }}>
                    {st.ch}
                  </span>
                  <span className="diff-commit-manifest__name truncate">{f.name}</span>
                  {f.additions > 0 && <span className="diff-color-add">+{f.additions}</span>}
                  {f.deletions > 0 && <span className="diff-color-del">−{f.deletions}</span>}
                </div>
              );
            })}
            {manifest.moreCount > 0 && (
              <div className="diff-commit-manifest__more">
                + {manifest.moreCount} more{' '}
                {(manifest.moreAdd > 0 || manifest.moreDel > 0) && (
                  <>
                    (<span className="diff-color-add">+{manifest.moreAdd}</span> <span className="diff-color-del">−{manifest.moreDel}</span>)
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {staysBehind && <div className="diff-commit-form__stays">{staysBehind}</div>}
        {hiddenChecked > 0 && <div className="diff-commit-form__hidden-note">· {hiddenChecked} checked file(s) hidden by the filter — still included</div>}

        <div className="diff-commit-form__buttons">
          {error && <span className="diff-commit-form__error">{error}</span>}
          <span className="diff-commit-form__cancel" onClick={onCloseForm}>
            Cancel
          </span>
          <span className={commitDisabled ? 'diff-commit-form__submit diff-commit-form__submit--disabled' : 'diff-commit-form__submit'} onClick={() => !commitDisabled && onCommit()}>
            Commit {checkedCount} files
            <span className="diff-commit-form__hint">⌘⏎</span>
          </span>
        </div>
      </div>
    </div>
  );
}
