// pi-provider-auth — the Pi accounts list beneath the vendor-provider vault
// (see providers.ts's `providerIdForAccount` for why Pi never joins that
// rail). Sits alongside the existing pi-runtime-distribution install-health
// card (PiSetupCard) in the same fixed `.acc-pi-section`, visible no matter
// which vendor provider the rail above is pointed at.
//
// Purely a renderer: every mutation, the setup PTY takeover and the
// rename/confirm state it shares with the rest of the modal are lifted into
// AccountsModal, exactly like codexForm/grokForm — so Esc and the modal's
// busy flag see it too.

import type { ReactNode } from 'react';
import type { AccountId } from '../../../contract/common';
import type { Account, PiProviderAuthObservation } from '../../../contract/multi-account';
import { PiAccountCard } from './PiAccountCard';
import './accounts.css';

export interface PiAccountsSectionProps {
  accounts: Account[]; // every kind==='pi' account, in registry order
  sessionNames: Record<AccountId, string[]>;
  busy: boolean;
  onAdd: () => void;
  /** Present ⇒ the add form is open above the list. */
  form?: ReactNode;
  /** Present ⇒ a setup PTY has taken over the whole section. */
  takeover?: ReactNode;
  renamingId: string | null;
  renameDraft: string;
  onRenameDraft: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onStartRename: (account: Account) => void;
  onSetDefault: (account: Account) => void;
  observations: Record<AccountId, PiProviderAuthObservation[]>;
  refreshing: Record<AccountId, boolean>;
  onRefresh: (account: Account) => void;
  trustBusy: Record<AccountId, boolean>;
  onToggleTrust: (account: Account) => void;
  onSetup: (account: Account) => void;
  onRemove: (account: Account) => void;
}

export function PiAccountsSection(p: PiAccountsSectionProps): JSX.Element {
  return (
    <div className="acc-section">
      <div className="acc-section-head">
        <span className="acc-section-eyebrow">Pi accounts</span>
        <span className="acc-section-rule" />
        <button type="button" className="acc-section-action" disabled={p.busy} onClick={p.onAdd}>
          + Add Pi account
        </button>
      </div>
      <div className="acc-section-body">
        {p.takeover ?? (
          <>
            {p.form}
            {p.accounts.length === 0 ? (
              <div className="acc-empty">
                No Pi accounts yet — add one to reference an existing PI_CODING_AGENT_DIR.
              </div>
            ) : (
              p.accounts.map((account) => (
                <PiAccountCard
                  key={account.id}
                  account={account}
                  sessionNames={p.sessionNames[account.id] ?? []}
                  renaming={account.id === p.renamingId}
                  renameDraft={p.renameDraft}
                  onRenameDraft={p.onRenameDraft}
                  onRenameCommit={p.onRenameCommit}
                  onRenameCancel={p.onRenameCancel}
                  onStartRename={() => p.onStartRename(account)}
                  onSetDefault={() => p.onSetDefault(account)}
                  observations={p.observations[account.id] ?? []}
                  refreshing={p.refreshing[account.id] ?? false}
                  onRefresh={() => p.onRefresh(account)}
                  trustBusy={p.trustBusy[account.id] ?? false}
                  onToggleTrust={() => p.onToggleTrust(account)}
                  onSetup={() => p.onSetup(account)}
                  onRemove={() => p.onRemove(account)}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
