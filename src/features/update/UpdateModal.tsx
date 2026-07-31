// self-update FR-10/FR-11/FR-12 — the update modal: everything the user needs
// to decide, in the shell's own modal chrome (src/ui/Modal.tsx, per the design
// brief). Three bodies, chosen by `updateModalView`:
//
//   available  version transition + release notes + View release ↗ + one action
//   uptodate   a single line (manual check only)
//   failed     the check's error + Retry (manual check only)
//
// The release body is THIRD-PARTY TEXT: it is rendered as preformatted mono in
// a <pre>, never as HTML and never as markdown (FR-10).

import { useEffect, useRef, useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { useMounted } from '../../lib/hooks/useMounted';
import { useStore } from '../../lib/store';
import { applyUpdate, checkUpdateManually, runningSessionCount, updateModalView, upToDateLine } from './update';
import './update.css';

const COPIED_MS = 1200;

export default function UpdateModal({ onClose }: { onClose: () => void }): JSX.Element {
  const update = useStore((s) => s.update);
  const error = useStore((s) => s.updateError);
  const busy = useStore((s) => s.updateBusy);
  // FR-12: the count is LIVE — it re-derives while the modal is open, so a turn
  // that finishes under it frees the button with no reopen.
  const running = useStore((s) => runningSessionCount(s.sessions));
  const [copied, setCopied] = useState(false);
  const mounted = useMounted();
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Shared between the `available` view's primary action and the `failed`
  // view's Retry button — the two never render together, so one ref suffices
  // and the mount effect below focuses whichever of them is on screen.
  const actionRef = useRef<HTMLButtonElement | null>(null);
  // §Accessibility: focus lands on the primary action and returns to the chip.
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    returnFocusTo.current = document.activeElement;
    actionRef.current?.focus();
    return () => {
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
      const back = returnFocusTo.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  const view = updateModalView(update, error, running, busy);

  const copyCommand = (command: string) => {
    void navigator.clipboard
      ?.writeText(command)
      .then(() => {
        if (!mounted.current) return;
        setCopied(true);
        if (copyTimeout.current) clearTimeout(copyTimeout.current);
        copyTimeout.current = setTimeout(() => mounted.current && setCopied(false), COPIED_MS);
      })
      .catch(() => {
        /* clipboard denied — the command is on screen to copy by hand */
      });
  };

  const primary = view.kind === 'available' ? view.primary : null;

  return (
    <Modal onClose={onClose} width={560} align="center" closeOnEscape closeOnBackdropClick className="upd-backdrop">
      <ModalHeader>
        <div className="upd-header">
          <span className="upd-header__title">Update</span>
          <button type="button" className="upd-close" onClick={onClose} title="close">
            ✕
          </button>
        </div>
      </ModalHeader>

      <ModalBody>
        {view.kind === 'failed' && (
          <>
            <div className="upd-line upd-line--error">{view.message}</div>
            <button
              type="button"
              ref={actionRef}
              className="upd-ghost"
              onClick={() => void checkUpdateManually()}
            >
              Retry
            </button>
          </>
        )}

        {view.kind === 'uptodate' && (
          <div className="upd-line">
            <span className="upd-ok">✓</span> {upToDateLine(view.current)}
          </div>
        )}

        {view.kind === 'available' && (
          <>
            <div className="upd-headline">
              <span className="upd-headline__from">{view.current}</span>
              <span className="upd-headline__arrow">→</span>
              <span className="upd-headline__to">{view.latest}</span>
            </div>
            {view.notes ? (
              <pre className="scz upd-notes">{view.notes}</pre>
            ) : (
              <div className="upd-notes upd-notes--empty">Release notes unavailable</div>
            )}
            {view.error && <div className="upd-error">{view.error}</div>}
          </>
        )}
      </ModalBody>

      {view.kind === 'available' && primary && (
        <ModalFooter>
          <div className="upd-footer">
            <div className="upd-footer__row">
              {/* opens the release page for v<latest>; `notes` may be absent, the URL never is (FR-3) */}
              <a className="upd-link" href={view.notesUrl} target="_blank" rel="noreferrer" title={view.notesUrl}>
                View release ↗
              </a>
              {primary.kind === 'apply' && (
                <button type="button" ref={actionRef} className="upd-apply" onClick={() => void applyUpdate()}>
                  {primary.label}
                </button>
              )}
              {primary.kind === 'busy' && (
                <button type="button" className="upd-apply upd-apply--busy" disabled>
                  {primary.label}
                </button>
              )}
              {primary.kind === 'blocked' && (
                <button type="button" className="upd-apply upd-apply--blocked" disabled>
                  {primary.label}
                </button>
              )}
            </div>

            {primary.kind === 'blocked' && <div className="upd-note">{primary.note}</div>}

            {/* FR-11: a manual install gets no button at all — the command takes its place. */}
            {primary.kind === 'manual' && (
              <>
                <div className="upd-note">{primary.note}</div>
                <div className="upd-command">
                  <span className="upd-command__text">{primary.command}</span>
                  <button
                    type="button"
                    className={copied ? 'upd-copy upd-copy--copied' : 'upd-copy'}
                    onClick={() => copyCommand(primary.command)}
                  >
                    {copied ? 'COPIED' : 'COPY'}
                  </button>
                </div>
              </>
            )}
          </div>
        </ModalFooter>
      )}
    </Modal>
  );
}
