// multi-account FR-34 — one Accounts-modal row:
//   avatar · label / email · DEFAULT or NEEDS LOGIN pill · usage meters · actions
//
// Actions are revealed on hover/focus (design brief) EXCEPT on a row that needs
// re-login, where RE-LOGIN is pinned visible — that row is asking for something,
// and an affordance you have to discover by hovering is not asking.
// The built-in `Default` row shows no REMOVE (FR-8: ACCOUNT_NOT_REMOVABLE).

import { useEffect, useRef } from 'react';
import type { Account } from '../../../contract/multi-account';
import type { UsageSnapshot } from '../../../contract/usage-bar';
import {
  accountAvatarHue,
  accountAvatarLetter,
  accountDisplayLabel,
  accountMetersView,
  accountNeedsLogin,
  accountSecondaryEmail,
} from './accounts';

function MeterChip({ label, percentText, fillPercent, color, title }: ReturnType<typeof accountMetersView>['chips'][number]) {
  return (
    <span title={title} className="usage-chip">
      <span className="usage-chip-label">{label}</span>
      <span className="usage-track">
        <span className="usage-fill" style={{ width: `${fillPercent}%`, background: color }} />
      </span>
      <span className="usage-percent">{percentText}</span>
    </span>
  );
}

export interface AccountRowProps {
  account: Account;
  snapshot: UsageSnapshot | undefined;
  cursor: boolean;
  /** Just minted by a login — briefly rail-flashed in --success (design brief). */
  fresh: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraft: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onFocus: () => void;
  onSetDefault: () => void;
  onStartRename: () => void;
  onRelogin: () => void;
  onRemove: () => void;
}

export function AccountRow({
  account,
  snapshot,
  cursor,
  fresh,
  renaming,
  renameDraft,
  onRenameDraft,
  onRenameCommit,
  onRenameCancel,
  onFocus,
  onSetDefault,
  onStartRename,
  onRelogin,
  onRemove,
}: AccountRowProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const needsLogin = accountNeedsLogin(account);
  const email = accountSecondaryEmail(account);
  const meters = accountMetersView(snapshot);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const classNames = ['acc-row'];
  if (cursor) classNames.push('acc-row--cursor');
  if (fresh) classNames.push('acc-row--fresh');

  return (
    <div className={classNames.join(' ')} onMouseEnter={onFocus} onClick={onFocus}>
      <span className="acc-avatar" style={{ background: accountAvatarHue(account) }}>
        {accountAvatarLetter(account)}
      </span>

      <div className="acc-identity">
        <div className="acc-identity-top">
          {renaming ? (
            <input
              ref={inputRef}
              className="acc-rename-input"
              value={renameDraft}
              autoFocus
              onChange={(e) => onRenameDraft(e.target.value)}
              onBlur={onRenameCommit}
              onKeyDown={(e) => {
                // Both keys are swallowed here: the modal's own listener reads
                // Enter as "set default" and Escape as "close".
                e.stopPropagation();
                if (e.key === 'Enter') onRenameCommit();
                else if (e.key === 'Escape') onRenameCancel();
              }}
            />
          ) : (
            <span className="truncate acc-label">{accountDisplayLabel(account)}</span>
          )}
          {account.isDefault && <span className="acc-pill">DEFAULT</span>}
          {needsLogin && <span className="acc-pill acc-pill--alert">NEEDS LOGIN</span>}
        </div>
        {email && !renaming && <span className="truncate acc-email">{email}</span>}
      </div>

      <div className="acc-meters">
        {meters.kind === 'meters' && meters.chips.map((c, i) => <MeterChip key={`${c.label}:${i}`} {...c} />)}
        {meters.kind === 'none' && <span className="acc-meters-placeholder">—</span>}
        {meters.kind === 'loading' && <span className="acc-meters-placeholder">…</span>}
        {meters.kind === 'error' && (
          <span title={meters.message ?? undefined} className="acc-meters-error">
            usage unavailable
          </span>
        )}
      </div>

      {/* §Responsive: below ~560px of panel width these collapse to icon-only
          (accounts.css); the `title` attribute is what carries the label then. */}
      <div className={needsLogin ? 'acc-actions acc-actions--pinned' : 'acc-actions'}>
        {!account.isDefault && (
          <button type="button" className="acc-action" title="Set default" onClick={onSetDefault}>
            <span className="acc-action-icon" aria-hidden="true">
              ★
            </span>
            <span className="acc-action-label">SET DEFAULT</span>
          </button>
        )}
        <button type="button" className="acc-action" title="Rename" onClick={onStartRename}>
          <span className="acc-action-icon" aria-hidden="true">
            ✎
          </span>
          <span className="acc-action-label">RENAME</span>
        </button>
        {/* FR-17: Re-login is account:add reusing this row + dir. The built-in
            account has no config dir of its own, so it has nothing to re-log
            into — `claude` owns ~/.claude directly. */}
        {!account.builtIn && (
          <button type="button" className="acc-action" title="Re-login" onClick={onRelogin}>
            <span className="acc-action-icon" aria-hidden="true">
              ↻
            </span>
            <span className="acc-action-label">RE-LOGIN</span>
          </button>
        )}
        {!account.builtIn && (
          <button type="button" className="acc-action acc-action--danger" title="Remove" onClick={onRemove}>
            <span className="acc-action-icon" aria-hidden="true">
              ✕
            </span>
            <span className="acc-action-label">REMOVE</span>
          </button>
        )}
      </div>
    </div>
  );
}
