// Redesign turn 8b — the vault's right pane: ONE provider's credentials in full.
//
// The whole reason the pane exists (designer's note): "room for what a row
// cannot hold — both meters at full width, the session names bound to a
// credential, and the reroute offer at the moment a limit bites. The login
// terminal takes over this pane rather than the whole modal."
//
// Two sections, and each answers the SAME question independently: can this
// provider be authenticated that way here? A provider whose CLI this app does
// not drive (gemini, kimi, qwen-code) keeps its CLI LOGINS section — it just
// says so, rather than hiding the section and implying the provider is
// key-only. The sentences come from providers.ts so all six read alike.
//
// The pane branches on capability (`cliSectionState`/`keySectionState`), never
// on a runtime or a kind — the same trade `runtimeCapabilities()` makes on the
// session side (multi-provider-seam FR-23).

import type { ReactNode } from 'react';
import type { AccountId } from '../../../contract/common';
import type { Account, CliToolStatus } from '../../../contract/multi-account';
import type { UsageSnapshot } from '../../../contract/usage-bar';
import { accountIsEndpoint } from './accounts';
import { CliToolCard, CliToolChip } from './CliToolCard';
import { IDLE_INSTALL, loginBlockedReason, type CliInstallState } from './cliTools';
import { ApiKeyRow, CredentialCard } from './CredentialCard';
import { ProviderTile } from './ProviderTile';
import {
  cliSectionState,
  credentialLoginLabel,
  keySectionState,
  providerIsolationNote,
  type ProviderGroup,
} from './providers';
import './accounts.css';

export interface ProviderDetailProps {
  group: ProviderGroup;
  usageByAccount: Record<AccountId, UsageSnapshot | undefined>;
  sessionNames: Record<AccountId, string[]>;
  now: number;
  cursorId: AccountId | null;
  freshId: AccountId | null;
  renamingId: AccountId | null;
  renameDraft: string;
  /** A login or a form is up — every add affordance is inert until it closes. */
  busy: boolean;
  /**
   * This provider's vendor CLI, or null when it has none / the probe has not
   * answered yet. Passed in rather than looked up here so the pane stays a
   * renderer and one probe result feeds every provider's pane identically.
   */
  cliTool: CliToolStatus | null;
  /** The live `npm i -g` for THIS provider's tool. Idle when nothing is running. */
  cliInstall?: CliInstallState;
  onInstallCli: () => void;
  /** Replaces both sections: the login terminal takes over THIS pane, not the modal. */
  takeover?: ReactNode;
  /** Opens above the sections, pushing them down (the add/edit forms). */
  form?: ReactNode;
  onRenameDraft: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onFocusAccount: (id: AccountId) => void;
  onSetDefault: (account: Account) => void;
  onStartRename: (account: Account) => void;
  onLogin: (account: Account) => void;
  onRemove: (account: Account) => void;
  onEditEndpoint: (account: Account) => void;
  onAddLogin: () => void;
  onAddKey: () => void;
}

export function ProviderDetail({
  group,
  usageByAccount,
  sessionNames,
  now,
  cursorId,
  freshId,
  renamingId,
  renameDraft,
  busy,
  cliTool,
  cliInstall = IDLE_INSTALL,
  onInstallCli,
  takeover,
  form,
  onRenameDraft,
  onRenameCommit,
  onRenameCancel,
  onFocusAccount,
  onSetDefault,
  onStartRename,
  onLogin,
  onRemove,
  onEditEndpoint,
  onAddLogin,
  onAddKey,
}: ProviderDetailProps): JSX.Element {
  const cli = cliSectionState(group.spec);
  const keys = keySectionState(group.spec);
  // "+ Add login" spawns the vendor's CLI. Without it on PATH the only outcome
  // is SPAWN_FAILED, so the button is disabled with the reason rather than left
  // to fail — the same trade the endpoint form makes with an unreachable URL.
  const loginBlocked = loginBlockedReason(group.spec, cliTool);
  // The mock hangs the dot off the provider name too, so the pane says the same
  // thing the rail row said — you never have to look back at the rail to check.
  const dotClass = group.status === 'none' ? null : `acc-dot acc-dot--${group.status}`;

  return (
    <div className="scz acc-detail">
      <div className="acc-detail-head">
        <ProviderTile spec={group.spec} size="lg" />
        <div className="acc-detail-title">
          <span className="truncate acc-detail-name">{group.spec.name}</span>
          <span className="acc-detail-meta">
            {dotClass && <span className={dotClass} aria-hidden="true" />}
            <span className="truncate">{group.meta}</span>
          </span>
        </div>
        <div className="acc-detail-actions">
          {/* The mock's "+ ADD LOGIN" sits in the pane header, and "+ ADD KEY"
              in the API KEYS section head — deliberately not two identical
              buttons side by side. Absent (not disabled) where the provider has
              no CLI at all: the section below already explains why. */}
          {cli.available && (
            <button
              type="button"
              className="acc-ghost-add"
              disabled={busy || loginBlocked !== null}
              onClick={onAddLogin}
              title={loginBlocked ?? `Sign in to ${group.spec.name} with the ${group.spec.cliLogin} CLI`}
            >
              + Add login
            </button>
          )}
        </div>
      </div>

      {takeover ?? (
        <>
          {form}

          <div className="acc-section">
            <div className="acc-section-head">
              <span className="acc-section-eyebrow">CLI logins</span>
              <span className="acc-section-rule" />
              <CliToolChip tool={cliTool} />
            </div>
            <div className="acc-section-body">
              {/* Above BOTH branches, deliberately: a missing CLI is the reason
                  the credentials below cannot be used, and for xAI it is the
                  only actionable thing in a section that otherwise just says
                  "coming soon". */}
              {cliTool && !cliTool.installed && (
                <CliToolCard
                  spec={group.spec}
                  tool={cliTool}
                  state={cliInstall}
                  busy={busy}
                  onInstall={onInstallCli}
                />
              )}
              {!cli.available ? (
                <div className="acc-soon">{cli.comingSoon}</div>
              ) : group.cliAccounts.length === 0 ? (
                <div className="acc-empty">No logins yet.</div>
              ) : (
                group.cliAccounts.map((account) => (
                  <CredentialCard
                    key={account.id}
                    account={account}
                    snapshot={usageByAccount[account.id]}
                    now={now}
                    sessionNames={sessionNames[account.id] ?? []}
                    cursor={account.id === cursorId}
                    fresh={account.id === freshId}
                    renaming={account.id === renamingId}
                    renameDraft={renameDraft}
                    onRenameDraft={onRenameDraft}
                    onRenameCommit={onRenameCommit}
                    onRenameCancel={onRenameCancel}
                    onFocus={() => onFocusAccount(account.id)}
                    onSetDefault={() => onSetDefault(account)}
                    onStartRename={() => onStartRename(account)}
                    loginLabel={credentialLoginLabel(account)}
                    onLogin={() => onLogin(account)}
                    // FR-8: the built-in row is not removable, so it gets no
                    // affordance rather than one that returns an error.
                    onRemove={account.builtIn ? null : () => onRemove(account)}
                  />
                ))
              )}
            </div>
          </div>

          <div className="acc-section">
            <div className="acc-section-head">
              <span className="acc-section-eyebrow">API keys</span>
              <span className="acc-section-rule" />
              {keys.available && (
                <button
                  type="button"
                  className="acc-section-action"
                  disabled={busy}
                  onClick={onAddKey}
                  title={`Register an OpenAI-compatible ${group.spec.name} endpoint`}
                >
                  + Add key
                </button>
              )}
            </div>
            <div className="acc-section-body">
              {!keys.available ? (
                <div className="acc-soon">{keys.comingSoon}</div>
              ) : group.keyAccounts.length === 0 ? (
                <div className="acc-empty">No keys yet.</div>
              ) : (
                group.keyAccounts.map((account) => (
                  <ApiKeyRow
                    key={account.id}
                    account={account}
                    cursor={account.id === cursorId}
                    fresh={account.id === freshId}
                    onFocus={() => onFocusAccount(account.id)}
                    onSetDefault={() => onSetDefault(account)}
                    onEdit={() => (accountIsEndpoint(account) ? onEditEndpoint(account) : onStartRename(account))}
                    onRemove={() => onRemove(account)}
                  />
                ))
              )}
            </div>
          </div>

          {/* FR-36's isolation cost, now stated per provider — the shipped
              sentence said "Claude Code configuration", which stopped being
              true the moment an account could be a Codex login or a key. */}
          <div className="acc-note">{providerIsolationNote(group)}</div>
        </>
      )}
    </div>
  );
}
