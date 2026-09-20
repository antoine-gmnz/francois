// pi-provider-auth — one Pi account's card. Reuses the CLI-login credential
// card's visual vocabulary (`.acc-cred*`, `.acc-pill`) rather than inventing a
// third card shape — a Pi account IS a durable, everyday credential the same
// way a Claude/Codex/Grok login is, it just carries a different set of facts
// (a directory + trust + inherited-env, instead of a plan quota).

import type { Account, PiProviderAuthObservation } from '../../../contract/multi-account';
import {
  piActionBlockedReason,
  piEnvironmentLabel,
  piInheritLabel,
  piObservationCheckedAtLabel,
  piObservationLabel,
  piObservationTone,
  piObservationsSummary,
  piTrustActionLabel,
  piTrustLabel,
  PI_LOGOUT_HINT,
} from './pi';
import { credentialSessionLine } from './providers';
import './accounts.css';

export interface PiAccountCardProps {
  account: Account;
  sessionNames: string[];
  renaming: boolean;
  renameDraft: string;
  onRenameDraft: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onStartRename: () => void;
  onSetDefault: () => void;
  observations: PiProviderAuthObservation[];
  refreshing: boolean;
  onRefresh: () => void;
  trustBusy: boolean;
  onToggleTrust: () => void;
  onSetup: () => void;
  onRemove: () => void;
}

export function PiAccountCard(p: PiAccountCardProps): JSX.Element {
  const pi = p.account.pi;
  const trusted = pi?.trusted ?? false;
  // Setup and Refresh both round-trip through the core's Pi PTY/probe
  // machinery, which refuses either untrusted — one shared reason gates both
  // buttons identically instead of Refresh discovering the refusal live.
  const blocked = piActionBlockedReason(pi);

  const footerParts: string[] = [];
  if (p.account.configDir) footerParts.push(p.account.configDir);
  if (pi) footerParts.push(piInheritLabel(pi.inheritEnvironmentCredentials));
  const sessionsLine = credentialSessionLine(p.sessionNames);
  if (sessionsLine) footerParts.push(sessionsLine);

  return (
    <div className="acc-cred">
      <div className="acc-cred-head">
        {p.renaming ? (
          <input
            className="acc-rename-input"
            value={p.renameDraft}
            autoFocus
            onChange={(e) => p.onRenameDraft(e.target.value)}
            onBlur={p.onRenameCommit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') p.onRenameCommit();
              else if (e.key === 'Escape') p.onRenameCancel();
            }}
          />
        ) : (
          <span className="truncate acc-cred-name">{p.account.label.trim() || 'Pi'}</span>
        )}
        <span className="acc-pill">PI</span>
        <span className={trusted ? 'acc-pill' : 'acc-pill acc-pill--attn'}>{piTrustLabel(trusted).toUpperCase()}</span>
        {p.account.isDefault && <span className="acc-pill">DEFAULT</span>}
        <div className="acc-cred-actions acc-cred-actions--pinned">
          {!p.account.isDefault && (
            <button type="button" className="acc-cred-action" onClick={p.onSetDefault}>
              Set default
            </button>
          )}
          <button type="button" className="acc-cred-action" onClick={p.onStartRename}>
            Rename
          </button>
          <button
            type="button"
            className="acc-cred-action"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={p.onSetup}
          >
            {trusted ? PI_LOGOUT_HINT : 'Open Pi setup'}
          </button>
          {pi && (
            <button type="button" className="acc-cred-action" disabled={p.trustBusy} onClick={p.onToggleTrust}>
              {piTrustActionLabel(trusted)}
            </button>
          )}
          <button
            type="button"
            className="acc-cred-action"
            disabled={p.refreshing || blocked !== null}
            title={blocked ?? undefined}
            onClick={p.onRefresh}
          >
            {p.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="acc-cred-action acc-cred-action--danger" onClick={p.onRemove}>
            Remove
          </button>
        </div>
      </div>

      {pi && <div className="acc-cli-card-note">{piEnvironmentLabel(pi)}</div>}

      <div className="acc-pi-observations">
        {piObservationsSummary(p.observations)}
        {p.observations.length > 0 && (
          <span className="acc-pi-observations-list">
            {p.observations.map((o) => (
              <span key={o.providerId} className={`acc-endpoint-result--${piObservationTone(o)}`}>
                {o.providerId}: {piObservationLabel(o)} · {piObservationCheckedAtLabel(o)}
              </span>
            ))}
          </span>
        )}
      </div>

      {footerParts.length > 0 && <div className="acc-cred-foot">{footerParts.join(' · ')}</div>}
    </div>
  );
}
