// multi-account FR-35 — the remove confirmation: a compact dialog inside the
// modal (not a second modal), naming the sessions that will fall back to
// Default (FR-9) and stating that the credentials on disk are deleted (FR-8).
//
// pi-provider-auth: takes the view rather than computing it from an account,
// so PiAccountsSection can reuse this same banner with `piRemoveConfirmView`'s
// FR-8-accurate copy (Pi's removal neither reassigns nor deletes credentials)
// instead of the legacy `removeConfirmView` text, which would misdescribe both.

import type { RemoveConfirmView } from './accounts';
import { Button } from '../../ui/Button';

export function RemoveAccountConfirm({
  view,
  onCancel,
  onConfirm,
}: {
  view: RemoveConfirmView;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <div className="acc-confirm">
      <span className="acc-confirm-title">{view.title}</span>
      <span className="acc-confirm-line">{view.credentialsLine}</span>
      {view.sessionsLine && <span className="acc-confirm-line">{view.sessionsLine}</span>}
      {view.names.length > 0 && (
        <div className="acc-confirm-names">
          {view.names.map((name, i) => (
            <span key={`${name}:${i}`} className="acc-confirm-name">
              {name}
            </span>
          ))}
          {view.moreLabel && <span className="acc-confirm-more">{view.moreLabel}</span>}
        </div>
      )}
      {/* Filled-danger for the destructive half, ghost for the way out — the
          redesign's own primary/secondary pairing, recoloured for a removal.
          The tone lives in accounts.css; nothing here names a colour. */}
      <div className="acc-confirm-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" className="acc-confirm-remove" onClick={onConfirm}>
          Remove
        </Button>
      </div>
    </div>
  );
}
