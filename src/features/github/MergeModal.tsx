// github-page FR-5a — "Merge pull request": the one irreversible action on the
// page, so it sits behind a confirm naming the method and the target branch.
// Refusals (branch protection, a head that moved) come back as gh's own error,
// shown inline; a failed branch delete never undoes the reported merge.

import { useState } from 'react';
import type { MergeMethod, MergeOutcome, PullDetail } from '../../../contract/github-page';
import { githubMergePull } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { defaultMergeMethod, mergeMethodLabel, mergeOutcomeNote } from './pulls';
import './pulls.css';

export interface MergeModalProps {
  cwd: string;
  pull: Pick<PullDetail, 'number' | 'title' | 'head' | 'base' | 'mergeMethods' | 'crossRepository'>;
  onClose: () => void;
  onMerged: () => void;
}

export function MergeModal({ cwd, pull, onClose, onMerged }: MergeModalProps): JSX.Element {
  const [method, setMethod] = useState<MergeMethod>(() => defaultMergeMethod(pull.mergeMethods));
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<MergeOutcome | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await githubMergePull({ cwd, number: pull.number, method, deleteBranch });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    onMerged();
    const note = mergeOutcomeNote(res.data, pull.head, deleteBranch);
    if (note) setOutcome(res.data);
    else onClose();
  }

  const note = outcome ? mergeOutcomeNote(outcome, pull.head, deleteBranch) : null;

  return (
    <Modal onClose={onClose} width={460} align="center" closeOnEscape={!busy} closeOnBackdropClick={!busy}>
      <ModalHeader>Merge pull request</ModalHeader>
      <ModalBody>
        <p className="merge-modal__target">
          #{pull.number} <span className="merge-modal__ref">{pull.head}</span>
          <span className="merge-modal__arrow"> → </span>
          <span className="merge-modal__ref">{pull.base}</span>
        </p>
        <p className="merge-modal__title">{pull.title}</p>
        {note ? (
          <p className={outcome?.branchDeleted ? 'merge-modal__note merge-modal__note--ok' : 'merge-modal__note'}>{note}</p>
        ) : (
          <>
            <div className="merge-modal__methods" role="radiogroup" aria-label="Merge method">
              {pull.mergeMethods.map((m) => (
                <label key={m} className="merge-modal__method">
                  <input
                    type="radio"
                    name="merge-method"
                    checked={method === m}
                    disabled={busy}
                    onChange={() => setMethod(m)}
                  />
                  {mergeMethodLabel(m)}
                </label>
              ))}
            </div>
            {!pull.crossRepository && (
              <label className="merge-modal__delete">
                <input
                  type="checkbox"
                  checked={deleteBranch}
                  disabled={busy}
                  onChange={() => setDeleteBranch((v) => !v)}
                />
                Delete <span className="merge-modal__ref">{pull.head}</span> on GitHub
              </label>
            )}
            {error && <p className="merge-modal__error">{error}</p>}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        {note ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
              {busy ? 'Merging…' : mergeMethodLabel(method)}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
