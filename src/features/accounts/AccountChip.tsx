// multi-account FR-33 — the status-bar account chip: the selected session's
// account (label, or the email when the label IS the email — accountDisplayLabel
// collapses the two). Clicking it opens the Accounts modal.
//
// Renders unconditionally per FR-33 — it names whichever account resolves,
// including a single-account install's own Default row (before hydration,
// or with no accounts at all, there is nothing to name yet, so it renders
// nothing).

import { useWindowWidth } from '../../lib/hooks/useWindowWidth';
import { focusedSessionId } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';
import {
  accountDisplayLabel,
  accountNeedsLogin,
  findAccount,
  statusChipLabel,
  statusChipMaxChars,
  usageAccountId,
} from './accounts';
import './accounts.css';

export function AccountChip(): JSX.Element | null {
  const accounts = useStore((s) => s.accounts);
  const sessions = useStore((s) => s.sessions);
  // split-session FR-7: the chip names the FOCUSED session's account — equal to
  // activeSessionId whenever the app is not split.
  const activeSessionId = useStore((s) => focusedSessionId(s));
  const setAccountsOpen = useStore((s) => s.setAccountsOpen);
  const windowWidth = useWindowWidth();

  if (accounts.length === 0) return null;

  const accountId = usageAccountId(accounts, sessions, activeSessionId);
  const account = findAccount(accounts, accountId);
  if (!account) return null;

  const label = accountDisplayLabel(account);
  const needsLogin = accountNeedsLogin(account);
  const classNames = ['acc-chip'];
  if (needsLogin) classNames.push('acc-chip--alert');
  else if (account.isDefault) classNames.push('acc-chip--default');

  return (
    <button
      type="button"
      className={classNames.join(' ')}
      onClick={() => setAccountsOpen(true)}
      title={needsLogin ? `${label} — needs re-login · manage accounts` : `${label} · manage accounts`}
    >
      <span className="acc-chip-glyph">◈</span>
      <span className="acc-chip-label">{statusChipLabel(label, statusChipMaxChars(windowWidth))}</span>
      {/* NEEDS LOGIN is conveyed by TEXT as well as colour (§Accessibility) —
          same principle as .acc-pill--alert on the row. */}
      {needsLogin && <span className="acc-chip-alert">!</span>}
    </button>
  );
}
