// github-page FR-11 — "Review prune": lists the merged, session-free branches
// with checkboxes, confirms `github_prune`, and reports the outcome per branch
// (a skip carries its reason — e.g. a dirty worktree the core refused to force).

import { useState } from 'react';
import type { BranchInfo, PruneOutcome } from '../../../contract/github-page';
import { githubPrune } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';

export interface PruneModalProps {
  cwd: string;
  branches: BranchInfo[];
  onClose: () => void;
  onPruned: () => void;
}

export function PruneModal({ cwd, branches, onClose, onPruned }: PruneModalProps): JSX.Element {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(branches.map((b) => b.name)));
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<PruneOutcome[] | null>(null);

  const toggle = (name: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  async function confirm(): Promise<void> {
    setBusy(true);
    const res = await githubPrune({ cwd, branches: [...checked] });
    setBusy(false);
    if (res.ok) {
      setOutcomes(res.data);
      if (res.data.every((o) => o.removed)) onPruned();
    }
  }

  return (
    <Modal onClose={onClose} width={460} align="center" closeOnEscape closeOnBackdropClick>
      <ModalHeader>Review prune</ModalHeader>
      <ModalBody>
        {branches.length === 0 && <p className="prune-modal__empty">No merged branches are ready to prune.</p>}
        <ul className="prune-modal__list">
          {branches.map((b) => {
            const outcome = outcomes?.find((o) => o.branch === b.name);
            return (
              <li key={b.name} className="prune-modal__row">
                <label className="prune-modal__label">
                  <input
                    type="checkbox"
                    checked={checked.has(b.name)}
                    disabled={outcomes !== null}
                    onChange={() => toggle(b.name)}
                  />
                  <span className="prune-modal__branch">{b.name}</span>
                  {b.worktree && <span className="prune-modal__wt">{b.worktree.displayPath}</span>}
                </label>
                {outcome && (
                  <span className={outcome.removed ? 'prune-modal__outcome prune-modal__outcome--ok' : 'prune-modal__outcome'}>
                    {outcome.removed ? 'removed' : (outcome.reason ?? 'skipped')}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          {outcomes ? 'Close' : 'Cancel'}
        </Button>
        {!outcomes && (
          <Button variant="danger" disabled={checked.size === 0 || busy} onClick={() => void confirm()}>
            {busy ? 'Pruning…' : `Prune ${checked.size || ''}`.trim()}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
