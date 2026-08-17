// Redesign turn 8b — the detail pane's two card shapes, once the account list
// gained a provider axis (providers.ts): CredentialCard for a CLI-login
// credential (a config dir, a plan, meters that reset) and ApiKeyRow for an
// API-key credential (a secret, a base URL, no ceiling). Both are thin
// renderers over accounts.ts/providers.ts, matching the rest of the feature —
// see AccountRow.tsx, which they supersede for the modal's new provider-first
// layout.
//
// Actions are TEXT buttons here (design: SET DEFAULT / RENAME / RE-LOGIN /
// REMOVE) rather than AccountRow's icon buttons — the mock reads them as
// sentence-case labels, not iconography, so this pair pulls in no lucide-react
// icons at all.

import { useEffect, useRef } from 'react';
import type { Account } from '../../../contract/multi-account';
import type { UsageSnapshot } from '../../../contract/usage-bar';
import {
  accountDisplayLabel,
  accountMetersView,
  accountSecondaryEmail,
  middleTruncate,
} from './accounts';
import { accountWantsAttention, credentialSessionLine } from './providers';
import './accounts.css';

// ---------------------------------------------------------------- gauges

function Gauges({
  meters,
}: {
  meters: ReturnType<typeof accountMetersView>;
}): JSX.Element | null {
  if (meters.kind === 'meters') {
    return (
      <div className="acc-gauges">
        {meters.chips.map((c, i) => (
          <div key={`${c.label}:${i}`} className="acc-gauge" title={c.title}>
            <div className="acc-gauge-head">
              <span className="truncate acc-gauge-label">{c.label}</span>
              {i === 0 && meters.reset && <span className="acc-gauge-reset">{meters.reset}</span>}
              <span className="acc-gauge-percent">{c.percentText}</span>
            </div>
            <span className="acc-gauge-track">
              <span className="acc-gauge-fill" style={{ width: `${c.fillPercent}%`, background: c.color }} />
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (meters.kind === 'error') {
    return (
      <div className="acc-empty" title={meters.message ?? undefined}>
        usage unavailable
      </div>
    );
  }
  if (meters.kind === 'loading') return <div className="acc-empty">…</div>;
  return null;
}

// ------------------------------------------------------------ CredentialCard

export interface CredentialCardProps {
  account: Account;
  snapshot: UsageSnapshot | undefined;
  now: number;
  /** Names of the sessions bound to this credential (already resolved by the caller). */
  sessionNames: string[];
  cursor: boolean;
  fresh: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraft: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onFocus: () => void;
  onSetDefault: () => void;
  onStartRename: () => void;
  /** Re-login / Sign in. Null ⇒ this row has no login route (the built-in account). */
  loginLabel: string | null;
  onLogin: () => void;
  /** Null ⇒ not removable (the built-in account, FR-8 ACCOUNT_NOT_REMOVABLE). */
  onRemove: (() => void) | null;
}

export function CredentialCard(p: CredentialCardProps): JSX.Element {
  const {
    account,
    snapshot,
    now,
    sessionNames,
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
    loginLabel,
    onLogin,
    onRemove,
  } = p;

  const inputRef = useRef<HTMLInputElement>(null);
  const wantsAttention = accountWantsAttention(account);
  const meters = accountMetersView(snapshot, now);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const classNames = ['acc-cred'];
  if (wantsAttention) classNames.push('acc-cred--alert');
  if (cursor) classNames.push('acc-cred--cursor');
  if (fresh) classNames.push('acc-cred--fresh');

  const footerParts: string[] = [];
  const email = accountSecondaryEmail(account);
  if (email) footerParts.push(email);
  if (account.configDir !== null) footerParts.push('own config dir');
  const sessionsLine = credentialSessionLine(sessionNames);
  if (sessionsLine) footerParts.push(sessionsLine);
  const footer = footerParts.join(' · ');

  const attentionText =
    sessionNames.length > 0
      ? `${sessionNames.length} session${sessionNames.length === 1 ? '' : 's'} paused — this credential needs signing in again.`
      : 'This credential needs signing in again.';

  return (
    <div className={classNames.join(' ')} onMouseEnter={onFocus} onClick={onFocus}>
      <div className="acc-cred-head">
        {renaming ? (
          <input
            ref={inputRef}
            className="acc-rename-input"
            value={renameDraft}
            autoFocus
            onChange={(e) => onRenameDraft(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={(e) => {
              // Swallowed here: the modal's own listener reads Enter as "set
              // default" and Escape as "close" (AccountRow.tsx precedent).
              e.stopPropagation();
              if (e.key === 'Enter') onRenameCommit();
              else if (e.key === 'Escape') onRenameCancel();
            }}
          />
        ) : (
          <span className="truncate acc-cred-name">{accountDisplayLabel(account)}</span>
        )}
        {account.isDefault && <span className="acc-pill">DEFAULT</span>}
        {wantsAttention && <span className="acc-pill acc-pill--alert">NEEDS LOGIN</span>}
        <div className={wantsAttention ? 'acc-cred-actions acc-cred-actions--pinned' : 'acc-cred-actions'}>
          {!account.isDefault && (
            <button
              type="button"
              className="acc-cred-action"
              onClick={(e) => {
                e.stopPropagation();
                onSetDefault();
              }}
            >
              Set default
            </button>
          )}
          <button
            type="button"
            className="acc-cred-action"
            onClick={(e) => {
              e.stopPropagation();
              onStartRename();
            }}
          >
            Rename
          </button>
          {loginLabel !== null && (
            <button
              type="button"
              className="acc-cred-action"
              onClick={(e) => {
                e.stopPropagation();
                onLogin();
              }}
            >
              {loginLabel}
            </button>
          )}
          {onRemove !== null && (
            <button
              type="button"
              className="acc-cred-action acc-cred-action--danger"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <Gauges meters={meters} />

      {wantsAttention && loginLabel !== null && (
        <div className="acc-reroute">
          <span className="acc-reroute-text">{attentionText}</span>
          <button
            type="button"
            className="acc-reroute-action"
            onClick={(e) => {
              e.stopPropagation();
              onLogin();
            }}
          >
            {loginLabel}
          </button>
        </div>
      )}

      {footer && <div className="acc-cred-foot">{footer}</div>}
    </div>
  );
}

// --------------------------------------------------------------- ApiKeyRow

export interface ApiKeyRowProps {
  account: Account;
  cursor: boolean;
  fresh: boolean;
  onFocus: () => void;
  onSetDefault: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

export function ApiKeyRow(p: ApiKeyRowProps): JSX.Element {
  const { account, cursor, fresh, onFocus, onSetDefault, onEdit, onRemove } = p;

  const classNames = ['acc-key'];
  if (cursor) classNames.push('acc-key--cursor');
  if (fresh) classNames.push('acc-key--fresh');

  // Never render key material — only `hasKey` ever crosses the boundary
  // (multi-provider-endpoint FR-3). The dots stand for "a key is stored",
  // nothing more.
  const secret = account.endpoint?.hasKey ? '••••••••' : 'no key';

  const metaParts: string[] = [];
  if (account.endpoint) metaParts.push(middleTruncate(account.endpoint.baseUrl, 44));
  const modelCount = account.endpoint?.modelIds?.length ?? 0;
  // No meters: plan-limit quotas are an Anthropic concept, and an endpoint
  // account has none to show (see AccountRow.tsx's precedent comment).
  if (modelCount > 0) metaParts.push(`${modelCount} model${modelCount === 1 ? '' : 's'}`);
  const meta = metaParts.join(' · ');

  return (
    <div className={classNames.join(' ')} onMouseEnter={onFocus} onClick={onFocus}>
      <div className="acc-key-head">
        <span className="truncate acc-key-name">{accountDisplayLabel(account)}</span>
        {account.isDefault && <span className="acc-pill">DEFAULT</span>}
        <span className="acc-key-secret">{secret}</span>
        <div className="acc-key-actions">
          {!account.isDefault && (
            <button
              type="button"
              className="acc-cred-action"
              onClick={(e) => {
                e.stopPropagation();
                onSetDefault();
              }}
            >
              Set default
            </button>
          )}
          <button
            type="button"
            className="acc-cred-action"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="acc-cred-action acc-cred-action--danger"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            Remove
          </button>
        </div>
      </div>
      {meta && <span className="truncate acc-key-meta">{meta}</span>}
    </div>
  );
}
