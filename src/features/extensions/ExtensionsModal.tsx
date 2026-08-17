// FR-56/FR-57, amended by extension-install §8 — the Extensions modal, in the
// AccountsModal idiom (src/ui/Modal). It lists EVERY registry entry —
// including the ones this project does not detect, and including an invalid
// manifest — never hidden (design brief: "a row must never be hidden").
//
// The trailing control is the whole consent state machine (extension-install
// FR-15..FR-20): `granted` gets the live toggle from before; `never`/`stale`
// get a `Review & enable` / `Review again` button that opens ConsentDialog
// instead of flipping the toggle directly — enabling is never a single click.

import { useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { ExtensionId, ExtensionInfo } from '../../../contract/extensions';
import { extensionsDetect, extensionsSetEnabled } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { EmptyPane } from '../../ui/EmptyPane';
import { ListRow } from '../../ui/ListRow';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import ConsentDialog from './ConsentDialog';
import {
  EMPTY_DIR_LABEL,
  EMPTY_STATE_COPY,
  REVIEW_AGAIN_COPY,
  REVIEW_ENABLE_COPY,
  STALE_ROW_NOTICE,
  consentControlKind,
  manifestErrorCause,
  manifestErrorPath,
  sanitizeForDisplay,
  truncatePathLeft,
} from './extensions';
import './extensions.css';

export default function ExtensionsModal({ root, projectName }: { root: string | null; projectName: string | null }) {
  const extensions = useStore((s) => s.extensions);
  const setExtensions = useStore((s) => s.setExtensions);
  const setOpen = useStore((s) => s.setExtensionsOpen);
  const consentDialogId = useStore((s) => s.extConsentDialogId);
  const openConsentDialog = useStore((s) => s.openExtConsentDialog);
  const closeConsentDialog = useStore((s) => s.closeExtConsentDialog);
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

  const consentTarget = consentDialogId ? (extensions.find((e) => e.id === consentDialogId) ?? null) : null;

  return (
    <Modal width={520} align="center" closeOnEscape closeOnBackdropClick onClose={() => setOpen(false)}>
      <ModalHeader>EXTENSIONS</ModalHeader>
      <ModalBody>
        {error && <div className="ext-modal__error">{sanitizeForDisplay(error.message)}</div>}
        {extensions.length === 0 ? (
          <EmptyPane className="ext-modal__empty">
            <span className="ext-modal__empty-path">{EMPTY_DIR_LABEL}</span>
            <span>{EMPTY_STATE_COPY}</span>
          </EmptyPane>
        ) : (
          extensions.map((e) => (
            <ExtensionRow
              key={e.id}
              extension={e}
              projectName={projectName}
              busy={busy}
              onToggle={(enabled) => toggle(e.id, enabled)}
              onReview={() => openConsentDialog(e.id)}
            />
          ))
        )}
      </ModalBody>
      <ModalFooter>
        {/* FR-13: invalidates the active root's cache entry, re-scans the
            manifest directory and re-runs every predicate. With no session
            there is no root to re-detect against. */}
        <Button disabled={root === null || busy} onClick={redetect} title="re-run detection for this project">
          Re-detect
        </Button>
        <Button variant="primary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </ModalFooter>

      {consentTarget && (
        <ConsentDialog
          extension={consentTarget}
          root={root}
          onClose={closeConsentDialog}
          onApplied={(list) => {
            setError(null);
            setExtensions(list);
          }}
        />
      )}
    </Modal>
  );
}

function ExtensionRow({
  extension: e,
  projectName,
  busy,
  onToggle,
  onReview,
}: {
  extension: ExtensionInfo;
  projectName: string | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onReview: () => void;
}) {
  const hasError = e.manifestError !== null;
  const control = consentControlKind(e.consent);
  const manifestPath = e.manifestError ? manifestErrorPath(e.manifestError) : null;

  return (
    <ListRow className={hasError ? 'ext-modal__row ext-modal__row--recessed' : 'ext-modal__row'}>
      <div className="ext-modal__main">
        <div className="ext-modal__idline">
          <span className="ext-modal__id">{sanitizeForDisplay(e.id)}</span>
          <span className="ext-modal__name">{sanitizeForDisplay(e.label)}</span>
        </div>
        <span className="ext-modal__path" title={sanitizeForDisplay(e.source.dir)}>
          {truncatePathLeft(e.source.dir, 56)}
        </span>
        {hasError ? (
          <div className="ext-modal__manifest-error">
            <span className="ext-modal__manifest-cause">{manifestErrorCause(e.manifestError!)}</span>
            {manifestPath && <span className="ext-modal__manifest-path">{manifestPath}</span>}
          </div>
        ) : (
          <span className={e.enabled && e.detected ? 'ext-modal__state ext-modal__state--ready' : 'ext-modal__state'}>
            {e.detected
              ? projectName
                ? `detected in ${projectName}`
                : 'detected'
              : `unavailable here — ${sanitizeForDisplay(e.undetectedReason ?? 'not detected')}`}
          </span>
        )}
        {!hasError && control === 'review-again' && <span className="ext-modal__stale-notice">{STALE_ROW_NOTICE}</span>}
      </div>
      <span className="ext-modal__control">
        {!hasError && control === 'toggle' && (
          <span
            className={e.enabled ? 'ext-toggle ext-toggle--on' : 'ext-toggle'}
            onClick={() => !busy && onToggle(!e.enabled)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                if (!busy) onToggle(!e.enabled);
              }
            }}
            role="switch"
            tabIndex={0}
            aria-checked={e.enabled}
            title={e.enabled ? 'turn off' : 'turn on'}
          >
            <span className="ext-toggle__knob" />
          </span>
        )}
        {!hasError && control !== 'toggle' && (
          <Button variant="ghost" className="ext-modal__review" disabled={busy} onClick={onReview}>
            {control === 'review-again' ? REVIEW_AGAIN_COPY : REVIEW_ENABLE_COPY}
          </Button>
        )}
      </span>
    </ListRow>
  );
}
