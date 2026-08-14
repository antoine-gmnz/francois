// multi-account FR-34 — one Accounts-modal row, drawn as the card redesign 4a
// gives every account:
//
//   ┌ tinted initial tile · label + DEFAULT/NEEDS LOGIN pill · row actions ┐
//   └ email · N sessions ─── meter bars ─── resets in 4h 9m               ┘
//
// Two lines, not one: the mock hangs each account's quota under its name rather
// than beside it, which is what lets the bars be wide enough to read and leaves
// the top line for identity alone.
//
// Actions are revealed on hover/focus (design brief) EXCEPT on a row that needs
// re-login, where they are pinned visible — that row is asking for something,
// and an affordance you have to discover by hovering is not asking.
// The built-in `Default` row shows no REMOVE (FR-8: ACCOUNT_NOT_REMOVABLE).
//
// Icons are lucide-react and inherit `currentColor`, so the tone lives in
// accounts.css and no icon here names a colour.

import { useEffect, useRef, type CSSProperties } from 'react';
import { Pencil, RotateCw, Star, X } from 'lucide-react';
import type { Account } from '../../../contract/multi-account';
import type { UsageSnapshot } from '../../../contract/usage-bar';
import {
  accountAvatarHue,
  accountAvatarLetter,
  accountDisplayLabel,
  accountIsEndpoint,
  accountMetaLine,
  accountMetersView,
  accountNeedsLogin,
  endpointBaseUrlLine,
  endpointRowNote,
} from './accounts';

// One size and one weight for every icon in the row — 13px reads level with the
// 13px label, and 1.75 matches the hairline weight of the app's rules.
const ICON = { size: 13, strokeWidth: 1.75 } as const;

function Meter({ label, percentText, fillPercent, color, title }: ReturnType<typeof accountMetersView>['chips'][number]) {
  return (
    <span title={title} className="acc-meter">
      <span className="truncate acc-meter-label">{label}</span>
      <span className="acc-meter-track">
        <span className="acc-meter-fill" style={{ width: `${fillPercent}%`, background: color }} />
      </span>
      <span className="acc-meter-percent">{percentText}</span>
    </span>
  );
}

export interface AccountRowProps {
  account: Account;
  snapshot: UsageSnapshot | undefined;
  /** How many sessions this account carries — the row's `N sessions` half. */
  sessionCount: number;
  /** Epoch ms, ticked once a minute by the modal, for the reset countdown. */
  now: number;
  cursor: boolean;
  /** Just minted by a login — briefly ring-flashed in --accent (design brief). */
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
  /** multi-provider-endpoint FR-13: the pencil affordance on an endpoint row opens
   * the full form instead of the inline label-only rename. */
  onEditEndpoint: () => void;
}

export function AccountRow({
  account,
  snapshot,
  sessionCount,
  now,
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
  onEditEndpoint,
}: AccountRowProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const needsLogin = accountNeedsLogin(account);
  const isEndpoint = accountIsEndpoint(account);
  // Design brief §1: an endpoint row's second line is its base URL (dim,
  // middle-truncated, `no key` when keyless) instead of email/session count.
  const meta = isEndpoint ? endpointBaseUrlLine(account) : accountMetaLine(account, sessionCount);
  const note = endpointRowNote(account);
  const meters = accountMetersView(snapshot, now);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const classNames = ['acc-row'];
  if (cursor) classNames.push('acc-row--cursor');
  if (fresh) classNames.push('acc-row--fresh');
  if (needsLogin) classNames.push('acc-row--alert');

  return (
    <div className={classNames.join(' ')} onMouseEnter={onFocus} onClick={onFocus}>
      <div className="acc-row-main">
        {/* The hue is per-account state, so it rides in as a custom property and
            accounts.css derives the tile's fill, edge and glyph tone from it —
            one runtime value instead of three inline colours. */}
        <span className="acc-avatar" style={{ '--acc-hue': accountAvatarHue(account) } as CSSProperties}>
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
            {/* multi-provider-endpoint design brief §1: neutral, no fill — provider
                is metadata, not identity. OAuth rows get no chip at all. */}
            {isEndpoint && <span className="acc-kind-chip">endpoint</span>}
            {account.isDefault && <span className="acc-pill">DEFAULT</span>}
            {needsLogin && <span className="acc-pill acc-pill--alert">NEEDS LOGIN</span>}
          </div>
          {meta && !renaming && <span className="truncate acc-meta">{meta}</span>}
          {/* multi-provider-endpoint FR-14 / design brief §1: dim, one line,
              removed the moment multi-provider-openai lands. */}
          {note && !renaming && <span className="acc-endpoint-note">{note}</span>}
        </div>

        {/* Icon-only, with the label on `title`/`aria-label`: the mock's rows
            carry no button chrome at all, and the modal footer now names every
            one of these actions with its keyboard equivalent. */}
        <div className={needsLogin ? 'acc-actions acc-actions--pinned' : 'acc-actions'}>
          {!account.isDefault && (
            <button type="button" className="acc-action" title="Set default" aria-label="Set default" onClick={onSetDefault}>
              <Star {...ICON} />
            </button>
          )}
          {/* multi-provider-endpoint design brief §1: an endpoint row's pencil opens
              the full form (label/base URL/key/models), not the label-only rename. */}
          <button
            type="button"
            className="acc-action"
            title={isEndpoint ? 'Edit' : 'Rename'}
            aria-label={isEndpoint ? 'Edit' : 'Rename'}
            onClick={isEndpoint ? onEditEndpoint : onStartRename}
          >
            <Pencil {...ICON} />
          </button>
          {/* FR-17: Re-login is account:add reusing this row + dir. The built-in
              account has no config dir of its own, so it has nothing to re-log
              into — `claude` owns ~/.claude directly. An endpoint account has no
              interactive login at all (design brief §1: replaced by Edit above). */}
          {!account.builtIn && !isEndpoint && (
            <button type="button" className="acc-action" title="Re-login" aria-label="Re-login" onClick={onRelogin}>
              <RotateCw {...ICON} />
            </button>
          )}
          {!account.builtIn && (
            <button
              type="button"
              className="acc-action acc-action--danger"
              title="Remove"
              aria-label="Remove"
              onClick={onRemove}
            >
              <X {...ICON} />
            </button>
          )}
        </div>
      </div>

      {/* §Responsive: the quota line is what the row drops first when it runs
          out of width (accounts.css) — identity and actions always survive.
          multi-provider-endpoint: plan-limit meters are an Anthropic concept
          (usage-bar, explicitly out of scope here) — an endpoint account has
          none to show, so the row simply ends after its note instead of
          reading `—`/`usage unavailable` about a meter that was never real. */}
      {!isEndpoint && (
        <div className="acc-quota">
          {meters.kind === 'meters' && (
            <>
              {meters.chips.map((c, i) => (
                <Meter key={`${c.label}:${i}`} {...c} />
              ))}
              {meters.reset && <span className="acc-reset">{meters.reset}</span>}
              {meters.message && (
                <span title={meters.message} className="acc-quota-stale">
                  stale
                </span>
              )}
            </>
          )}
          {meters.kind === 'none' && <span className="acc-quota-placeholder">—</span>}
          {meters.kind === 'loading' && <span className="acc-quota-placeholder">…</span>}
          {meters.kind === 'error' && (
            <span title={meters.message ?? undefined} className="acc-quota-error">
              usage unavailable
            </span>
          )}
        </div>
      )}
    </div>
  );
}
