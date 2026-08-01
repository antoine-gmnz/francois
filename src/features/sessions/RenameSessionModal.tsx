// session-rename FR-8..FR-11 — the smallest modal in the app: one field, one
// decision. Built on src/ui/Modal + the creation form's own NameField, so the
// input is literally the creation input.

import { useEffect, useRef, useState } from 'react';
import type { AppError } from '../../../contract/common';
import { sessionRename } from '../../lib/api';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { NameField } from './NameField';
import { canCommitRename } from './rename';
import './new-session-modal.css';
import './rename-session-modal.css';

export interface RenameSessionModalProps {
  sessionId: string;
  /** The session's current name — prefills the input (FR-9). */
  currentName: string;
  onClose: () => void;
}

export default function RenameSessionModal({ sessionId, currentName, onClose }: RenameSessionModalProps): JSX.Element {
  const [name, setName] = useState(currentName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards a setState after the modal closed mid-flight (the commit resolves
  // after unmount when the user cancels while the call is out).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // FR-9: focused AND fully selected, so the first keystroke replaces the old name.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const canCommit = canCommitRename(name, submitting);

  const commit = () => {
    if (!canCommit) return;
    setSubmitting(true);
    setError(null);
    // FR-11: on ok:true the store is NOT written here — the session.meta event is
    // the single update path (FR-13).
    void sessionRename({ sessionId, name })
      .then((res) => {
        if (!alive.current) return;
        setSubmitting(false);
        if (res.ok) onClose();
        else setError(res.error);
      })
      .catch(() => {
        if (!alive.current) return;
        setSubmitting(false);
        setError({ code: 'INTERNAL', message: 'Could not reach the core' });
      });
  };

  // FR-10: Enter commits (when enabled), Escape cancels. Capture phase like every
  // other modal in the shell, so the app-wide single-letter globals never see
  // these keys — and Modal is told closeOnEscape={false} to avoid double-handling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        e.preventDefault();
        commit();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <Modal onClose={onClose} width={380} align="center" closeOnEscape={false} closeOnBackdropClick={true}>
      <ModalHeader>
        <span className="rename-session-modal__title">RENAME SESSION</span>
      </ModalHeader>

      <ModalBody>
        <NameField name={name} onChange={setName} inputRef={inputRef} />
        {/* FR-11 / design §2 state "error": the core's message, verbatim. */}
        {error && <div className="form-error rename-session-modal__error">{error.message}</div>}
      </ModalBody>

      <ModalFooter>
        <div className="rename-session-modal__actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={commit} disabled={!canCommit}>
            Rename
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
