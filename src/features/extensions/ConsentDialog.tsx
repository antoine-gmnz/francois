// extension-install FR-16..FR-18 — the consent gate: `src/ui/Modal`, the
// `RemoveAccountConfirm` register (small, centred, two buttons), deliberately
// NOT the session permission card (design brief §"Consent dialog"). Renders
// every distinct argv the manifest declares, verbatim, one per line, mono,
// unwrapped — never truncated, since a hidden flag is the exact thing this
// dialog exists to prevent. `Cancel` takes the default focus: the whole point
// is that inattention leaves the extension off.

import { useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { ExtensionInfo } from '../../../contract/extensions';
import { extensionsConsent, extensionsList } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { Button } from '../../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { STALE_DIALOG_NOTICE, consentRequest, formatArgv, sanitizeForDisplay } from './extensions';

export interface ConsentDialogProps {
  extension: ExtensionInfo;
  /** FR-16: which root the refreshed list should be evaluated against. */
  root: string | null;
  onClose: () => void;
  onApplied: (list: ExtensionInfo[]) => void;
}

export default function ConsentDialog({ extension, root, onClose, onApplied }: ConsentDialogProps): JSX.Element {
  // FR-18: a manifest edited WHILE this dialog is open resolves EXT_CONSENT_STALE
  // rather than closing — the dialog reloads its list in place and shows the
  // new commands, `current` tracks whichever version is on screen.
  const [current, setCurrent] = useState(extension);
  const [staleUnderDialog, setStaleUnderDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const alive = useMounted();

  const confirm = () => {
    setBusy(true);
    setError(null);
    // FR-18: the hash comes off `current` — the version on screen — so the
    // bytes the user read are the bytes the core checks.
    void extensionsConsent(consentRequest(current, root))
      .then((res) => {
        if (!alive.current) return;
        setBusy(false);
        if (res.ok) {
          onApplied(res.data);
          onClose();
          return;
        }
        if (res.error.code === 'EXT_CONSENT_STALE') {
          setStaleUnderDialog(true);
          void extensionsList({ root })
            .then((listRes) => {
              if (!alive.current || !listRes.ok) return;
              onApplied(listRes.data);
              const fresh = listRes.data.find((e) => e.id === current.id);
              if (fresh) setCurrent(fresh);
            })
            .catch(() => {});
          return;
        }
        setError(res.error);
      })
      .catch(() => {
        if (!alive.current) return;
        setBusy(false);
        setError({ code: 'INTERNAL', message: 'Could not reach the core' });
      });
  };

  const stale = staleUnderDialog || current.consent.state === 'stale';

  return (
    <Modal width={440} align="center" closeOnEscape closeOnBackdropClick onClose={onClose}>
      <ModalHeader>{`${current.id} wants to run these commands`}</ModalHeader>
      <ModalBody>
        {stale && <div className="ext-consent__stale">{STALE_DIALOG_NOTICE}</div>}
        <div className="ext-consent__commands">
          {current.source.declaredCommands.map((argv, i) => (
            <div className="ext-consent__command" key={i}>
              {formatArgv(argv)}
            </div>
          ))}
        </div>
        <div className="ext-consent__path">{sanitizeForDisplay(current.source.dir)}</div>
        {error && (
          <div className="ext-consent__error">{sanitizeForDisplay(error.message)}</div>
        )}
      </ModalBody>
      <ModalFooter>
        {/* FR-16's inverted default: Cancel is the safe path and takes the focus. */}
        <Button autoFocus onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={confirm} disabled={busy}>
          Enable
        </Button>
      </ModalFooter>
    </Modal>
  );
}
