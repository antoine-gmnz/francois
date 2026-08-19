// multi-account FR-31 — the new-session modal's ACCOUNT row, directly after
// MODEL, using the exact select chrome the PROJECT row already uses. Options
// show the label with the email as dim secondary text (a native <option> takes
// no markup, so it is joined with the same ' · ' the sidebar badge's tooltip
// uses).
//
// Renders unconditionally per FR-31 — every account is listed, including a
// single-account install's own Default row.

import type { AccountId } from '../../../contract/common';
import type { Account } from '../../../contract/multi-account';
import { accountFieldOptions, accountNeedsLogin, findAccount } from '../accounts/accounts';
import '../accounts/accounts.css';

export interface AccountFieldProps {
  accounts: Account[];
  accountId: AccountId;
  /** projects FR-24 parity: the value came from the project's snapshot default. */
  fromProject: boolean;
  onChange: (accountId: AccountId) => void;
}

export function AccountField({ accounts, accountId, fromProject, onChange }: AccountFieldProps): JSX.Element | null {
  if (accounts.length === 0) return null;
  const selected = findAccount(accounts, accountId);
  const needsLogin = selected !== null && accountNeedsLogin(selected);
  return (
    <div>
      <label className="new-session-modal__label">ACCOUNT</label>
      {/* The caret is ours, not the platform's — see __field--select. */}
      <div className="new-session-modal__select">
        <select
          className="new-session-modal__field new-session-modal__field--select"
          value={accountId}
          onChange={(e) => onChange(e.target.value)}
        >
          {accountFieldOptions(accounts).map((opt) => (
            // multi-provider-openai FR-22: multi-provider-endpoint FR-14's
            // disabled-with-reason block is deleted — every account, endpoint
            // included, is an ordinary selectable, keyboard-reachable option.
            <option key={opt.value} value={opt.value}>
              {opt.email ? `${opt.label} · ${opt.email}` : opt.label}
              {opt.needsLogin ? ' (needs login)' : ''}
            </option>
          ))}
        </select>
        <span className="new-session-modal__select-caret">▾</span>
      </div>
      {/* FR-22: the turn would fail ACCOUNT_NOT_AUTHENTICATED. Said here, not
          blocked — the fix (Re-login) lives in the Accounts modal, and the
          session itself is still worth creating. */}
      {needsLogin && (
        <div className="new-session-modal__hint new-session-modal__hint--error">
          this account needs to sign in again — its turns will fail until you re-login
        </div>
      )}
      {fromProject && !needsLogin && <div className="new-session-modal__hint">from project defaults</div>}
    </div>
  );
}
