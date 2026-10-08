// Flow 4: ⌘W (or a tab's ×) on a dirty tab asks Save · Discard · Cancel.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { useCodeStore } from './codeStore';
import './code.css';

export function CloseTabPrompt({ rootKey, path, onDone }: { rootKey: string; path: string; onDone: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const close = () => {
    void useCodeStore.getState().closeTab(rootKey, path);
    onDone();
  };
  const save = async () => {
    setBusy(true);
    const res = await useCodeStore.getState().save(rootKey, path);
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    close();
  };
  return (
    <Modal onClose={onDone} width={400} align="center" closeOnEscape>
      <ModalHeader>
        <span className="code-prompt__title">Save changes to {name}?</span>
      </ModalHeader>
      <ModalBody>
        <p className="code-prompt__text">Your changes are lost if you don't save them.</p>
        {error && <p className="code-prompt__error">{error}</p>}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" onClick={close}>
          Discard
        </Button>
        <Button variant="primary" size="sm" busy={busy} onClick={() => void save()}>
          Save
        </Button>
      </ModalFooter>
    </Modal>
  );
}
