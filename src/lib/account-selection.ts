import type { AccountId } from '../../contract/common';
import type { Account } from '../../contract/multi-account';

/** The selected account id is always sent verbatim to session creation. */
export function accountIdForSessionCreate(accountId: AccountId): AccountId {
  return accountId;
}

/** The model picker uses the selected account's own label as its heading. */
export function modelPickerProviderHeading(accounts: Account[], accountId: AccountId): string {
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) return '';
  const label = account.label.trim();
  return label !== '' ? label : account.email ?? 'Default';
}
