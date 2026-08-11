// FR-56/FR-57: the Extensions modal, in the AccountsModal idiom (src/ui/Modal).
// It lists EVERY registry entry — including the ones this project does not
// detect, shown as `unavailable here` with the reason, never hidden — each with
// a live toggle, plus a `Re-detect` control in the footer.
//
// The toggle works on an undetected row too: pre-disabling something you have
// not installed yet is legitimate, and FR-7 makes "off" mean nothing spawns.

import { useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { ExtensionId } from '../../../contract/extensions';
import { extensionsDetect, extensionsSetEnabled } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import './extensions.css';

export default function ExtensionsModal({ root, projectName }: { root: string | null; projectName: string | null }) {
  const extensions = useStore((s) => s.extensions);
  const setExtensions = useStore((s) => s.setExtensions);
  const setOpen = useStore((s) => s.setExtensionsOpen);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useMounted();

  const apply = (p: Promise<{ ok: true; data: Parameters<typeof setExtensions>[0] } | { ok: false; error: AppError }>) => {
    setBusy(true);
    void p
      .then((res) => {
        if (!alive.current) return;
        setBusy(false);
        if (res.ok) {
          setError(null);
          setExtensions(res.data);
        } else setError(res.error);
      })
      .catch(() => {
        if (!alive.current) return;
        setBusy(false);
        setError({ code: 'INTERNAL', message: 'Could not reach the core' });
      });
  };

  const toggle = (extensionId: ExtensionId, enabled: boolean) => apply(extensionsSetEnabled({ extensionId, enabled, root }));
  const redetect = () => {
    if (root !== null) apply(extensionsDetect({ root }));
  };

  return (
    <Modal width={520} align="center" closeOnEscape closeOnBackdropClick onClose={() => setOpen(false)}>
      <ModalHeader>EXTENSIONS</ModalHeader>
      <ModalBody>
        {error && <div className="ext-modal__error">{error.message}</div>}
        {extensions.length === 0 && <div className="ext-note">no extensions</div>}
        {extensions.map((e) => (
          <ListRow key={e.id} className={e.detected ? 'ext-modal__row' : 'ext-modal__row ext-modal__row--recessed'}>
            <span className="ext-modal__name">{e.label}</span>
            <span className="ext-modal__state">
              {e.detected
                ? projectName
                  ? `detected in ${projectName}`
                  : 'detected'
                : `unavailable here — ${e.undetectedReason ?? 'not detected'}`}
            </span>
            <span
              className={e.enabled ? 'ext-toggle ext-toggle--on' : 'ext-toggle'}
              onClick={() => !busy && toggle(e.id, !e.enabled)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  if (!busy) toggle(e.id, !e.enabled);
                }
              }}
              role="switch"
              tabIndex={0}
              aria-checked={e.enabled}
              title={e.enabled ? 'turn off' : 'turn on'}
            >
              <span className="ext-toggle__knob" />
            </span>
          </ListRow>
        ))}
      </ModalBody>
      <ModalFooter>
        {/* FR-57: invalidates the active root's cache entry and re-runs every
            predicate. With no session there is no root to re-detect against. */}
        <Button disabled={root === null || busy} onClick={redetect} title="re-run detection for this project">
          Re-detect
        </Button>
        <Button variant="primary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}
