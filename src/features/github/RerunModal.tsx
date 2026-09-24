// github-ci-logs FR-16 — "Re-run failed" confirm. Calls `github_rerun_failed`
// once per distinct runId; PR-detail-only (not offered in commit detail).

import { useState } from 'react';
import { githubRerunFailed } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import type { RerunTarget } from './ci-logs';
import './pulls.css';

export interface RerunModalProps {
  cwd: string;
  targets: RerunTarget[];
  onClose: () => void;
  onRerun: () => void;
}

export function RerunModal({ cwd, targets, onClose, onRerun }: RerunModalProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = targets.flatMap((t) => t.names);
  const failedJobCount = names.length;

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    for (const target of targets) {
      const res = await githubRerunFailed({ cwd, runId: target.runId });
      if (!res.ok) {
        setBusy(false);
        setError(res.error.message);
        return;
      }
    }
    setBusy(false);
    onRerun();
    onClose();
  }

  return (
    <Modal onClose={onClose} width={420} align="center" closeOnEscape={!busy} closeOnBackdropClick={!busy}>
      <ModalHeader>Re-run failed jobs?</ModalHeader>
      <ModalBody>
        <p className="merge-modal__title">{names.join(', ')}</p>
        <p className="merge-modal__ref">
          {failedJobCount} failed job{failedJobCount === 1 ? '' : 's'}
        </p>
        {error && <p className="merge-modal__error">{error}</p>}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void confirm()}>
          Re-run
        </Button>
      </ModalFooter>
    </Modal>
  );
}
