// multi-account FR-34..FR-36 — the Accounts modal, dressed as redesign 4a:
// a centred panel over the dimmed shell, a titled header with a count pill and
// the add affordance, a list of account CARDS, and a footer carrying both the
// isolation note and the keyboard model (see accounts.css). Four states:
//
//   list           the registry, one AccountRow each + [+ ADD ACCOUNT]
//   login          AccountLoginView replaces the body while a login runs
//   rename         the label becomes an inline input on its row
//   remove-confirm the compact confirm dialog above the list
//
// It does NOT re-read the registry itself: FR-7 makes every mutation emit
// account.list with the full list, and App.tsx's feed writes that into the
// store — so the store IS the modal's source of truth, and a change made
// anywhere (including by the core, e.g. FR-23's authFailedAt) shows up here
// with no extra read. The mutations still resolve the fresh list; that is used
// only to keep the cursor honest across a removal.
//
// Keyboard (§3): ↑/↓ move · Enter set default · r rename · Del remove ·
// a add · Esc close (or cancel the login / the confirm).

import { useEffect, useRef, useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { Account } from '../../../contract/multi-account';
import { accountLoginCancel, accountRemove, accountRename, accountSetDefault } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { useStore } from '../../lib/store';
import { seedAccountUsage } from '../usage/usage';
import { AccountRow } from './AccountRow';
import AccountLoginView from './AccountLoginView';
import { RemoveAccountConfirm } from './RemoveAccountConfirm';
import {
  ACCOUNTS_ISOLATION_NOTE,
  ACCOUNTS_KEY_HINTS,
  accountSessionCounts,
  clampCursor,
  moveCursor,
} from './accounts';
import './accounts.css';

/** Which login this is: a brand-new account, or FR-17's re-login into a row. */
type LoginTarget = { accountId?: string } | null;

export default function AccountsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const accounts = useStore((s) => s.accounts);
  const setAccounts = useStore((s) => s.setAccounts);
  const sessions = useStore((s) => s.sessions);
  const usageByAccount = useStore((s) => s.usageByAccount);
  const setAccountUsage = useStore((s) => s.setAccountUsage);
  const autoAdd = useStore((s) => s.accountsAutoAdd);
  const setAutoAdd = useStore((s) => s.setAccountsAutoAdd);

  const [cursor, setCursor] = useState(0);
  const [login, setLogin] = useState<LoginTarget>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const alive = useMounted();
  // The live login's id, so cancel can address it from anywhere — including the
  // unmount cleanup, which must fire even when the modal is torn down by a
  // parent re-render rather than by a user action (FR-16).
  const loginIdRef = useRef<string | null>(null);
  // Guards commitRename against the delayed native `blur` a cancel triggers:
  // unmounting the (still-focused) rename <input> fires `blur` synchronously,
  // which React dispatches to the onBlur={commitRename} closure captured on
  // the PREVIOUS render — i.e. the one from before renamingId was cleared —
  // so without this flag that stale closure would silently re-commit the very
  // edit Escape just cancelled. Flipped true the instant either commitRename
  // or cancelRename actually runs, and reset only when a fresh rename starts;
  // this also makes a legitimate Enter-commit's own trailing blur a no-op
  // instead of firing accountRename twice.
  const renameHandledRef = useRef(false);

  const selected = accounts[clampCursor(cursor, accounts.length)] ?? null;
  const confirming = confirmId ? (accounts.find((a) => a.id === confirmId) ?? null) : null;
  const sessionCounts = accountSessionCounts(accounts, sessions);

  // Redesign 4a hangs a reset countdown off every account bar. Same granularity
  // rule the usage bar follows: one text tick a minute, not motion — the
  // countdown's finest unit IS the minute, so a faster clock buys nothing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // FR-34: each row shows its OWN meters, so every listed account needs a seed.
  // Cheap and idempotent — app_get_usage never probes (usage-bar FR-22), and a
  // seed for an account the live channel already covered is dropped.
  useEffect(() => {
    const stops = accounts
      .filter((a) => usageByAccount[a.id] === undefined)
      .map((a) => seedAccountUsage(a.id, setAccountUsage));
    return () => stops.forEach((stop) => stop());
    // Keyed on the ids alone: re-running on every snapshot write would restart
    // the seeds the writes are the result of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.map((a) => a.id).join(','), setAccountUsage]);

  // FR-16: whatever ends the login — Esc, CLOSE, the modal unmounting — kills
  // the PTY and deletes the half-written dir through this ONE path.
  const cancelLogin = () => {
    const id = loginIdRef.current;
    loginIdRef.current = null;
    if (id) void accountLoginCancel({ loginId: id }).catch(() => {});
  };

  useEffect(() => cancelLogin, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The palette's "Add account" opens the modal straight into the login view.
  // One-shot: cleared here so re-opening the modal normally lands on the list.
  useEffect(() => {
    if (!autoAdd) return;
    setAutoAdd(false);
    setLogin({});
  }, [autoAdd, setAutoAdd]);

  const closeLogin = () => {
    cancelLogin();
    setLogin(null);
  };

  const startRename = (account: Account) => {
    renameHandledRef.current = false;
    setRenameDraft(account.label);
    setRenamingId(account.id);
  };

  // FR-5 / design brief: Esc cancels without persisting. Marks the attempt as
  // handled BEFORE clearing renamingId, so the stale onBlur={commitRename}
  // closure the ensuing unmount fires sees renameHandledRef.current already
  // true and no-ops instead of committing the discarded draft (see the ref's
  // own comment above).
  const cancelRename = () => {
    renameHandledRef.current = true;
    setRenamingId(null);
  };

  // A rejected promise here means the Tauri bridge itself failed (not a domain
  // Result — those always resolve ok:false and are handled inline above). Same
  // guard AccountLoginView's accountAdd(...).catch(...) uses, so no mutation can
  // become an unhandled rejection.
  const onIpcRejected = () => {
    if (alive.current) setError({ code: 'INTERNAL', message: 'Could not reach the core' });
  };

  const commitRename = () => {
    if (renameHandledRef.current) return; // already cancelled, or already committed once
    renameHandledRef.current = true;
    const id = renamingId;
    setRenamingId(null);
    const target = accounts.find((a) => a.id === id);
    const label = renameDraft.trim();
    // FR-5: non-empty after trimming, and a no-op edit is not worth a round-trip.
    if (!id || !target || label === '' || label === target.label) return;
    void accountRename(id, label)
      .then((res) => {
        if (!alive.current) return;
        if (res.ok) {
          setError(null);
          setAccounts(res.data);
        } else setError(res.error);
      })
      .catch(onIpcRejected);
  };

  const setDefault = (account: Account) => {
    if (account.isDefault) return;
    void accountSetDefault(account.id)
      .then((res) => {
        if (!alive.current) return;
        if (res.ok) {
          setError(null);
          setAccounts(res.data);
        } else setError(res.error);
      })
      .catch(onIpcRejected);
  };

  const doRemove = (account: Account) => {
    setConfirmId(null);
    void accountRemove(account.id)
      .then((res) => {
        if (!alive.current) return;
        if (!res.ok) {
          setError(res.error); // e.g. ACCOUNT_NOT_REMOVABLE on the built-in (FR-8)
          return;
        }
        setError(null);
        setAccounts(res.data.accounts);
        setCursor((c) => clampCursor(c, res.data.accounts.length));
        // FR-9's repointed sessions arrive as session.meta events on the session
        // stream, which pane [1] already owns — nothing to apply here.
      })
      .catch(onIpcRejected);
  };

  // §3 Keyboard. Capture phase, like every other modal in the shell, so the
  // app-wide single-letter globals never see these keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (login) closeLogin();
        else if (renamingId) cancelRename();
        else if (confirmId) setConfirmId(null);
        else onClose();
        return;
      }
      // Everything below is list-state only: while the login TUI is up every
      // other key belongs to it, and while renaming they belong to the input.
      if (login || renamingId) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setCursor((c) => moveCursor(c, e.key === 'ArrowDown' ? 1 : -1, accounts.length));
        return;
      }
      if (confirmId) {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const account = accounts.find((a) => a.id === confirmId);
          if (account) doRemove(account);
        }
        return;
      }
      if (e.key === 'Enter' && selected) {
        e.preventDefault();
        e.stopPropagation();
        setDefault(selected);
      } else if ((e.key === 'r' || e.key === 'R') && selected) {
        e.preventDefault();
        e.stopPropagation();
        startRename(selected);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !selected.builtIn) {
        e.preventDefault();
        e.stopPropagation();
        setConfirmId(selected.id);
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        e.stopPropagation();
        setLogin({});
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // Re-attaches only when the state the handler branches on actually
    // changes — not on every render (e.g. each keystroke of a rename draft),
    // like the effects above. The closures it calls (closeLogin, doRemove,
    // setDefault, startRename, onClose) read only refs/setters/these same
    // deps, so a version captured at that point stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login, renamingId, confirmId, selected, accounts, onClose]);

  return (
    <div
      className="acc-backdrop"
      onClick={() => {
        if (login) closeLogin();
        else onClose();
      }}
    >
      <div className="acc-panel" onClick={(e) => e.stopPropagation()}>
        <div className="acc-header">
          <span className="acc-title">Accounts</span>
          {/* The count pill redesign 4a puts beside every panel title — it also
              answers "did the new one land?" without counting rows. */}
          <span className="acc-count">{accounts.length}</span>
          <span className="acc-header-spacer" />
          <button
            type="button"
            className="acc-add"
            disabled={login !== null}
            onClick={() => setLogin({})}
            title="Add an Anthropic account by signing in here"
          >
            <span className="acc-add-plus" aria-hidden="true">
              +
            </span>
            Add account
          </button>
        </div>

        {login ? (
          <AccountLoginView
            accountId={login.accountId}
            onLoginId={(id) => {
              loginIdRef.current = id;
            }}
            onClose={closeLogin}
            onDone={(account) => {
              loginIdRef.current = null;
              if (!alive.current) return;
              setLogin(null);
              setError(null);
              // The registry itself arrives as the account.list that FR-13
              // emits right after; all this does is point the cursor at the new
              // row and flash it (design brief: success).
              setFreshId(account.id);
              window.setTimeout(() => alive.current && setFreshId(null), 1200);
            }}
          />
        ) : (
          <>
            {error && <div className="acc-error">{error.message}</div>}
            {confirming && (
              <RemoveAccountConfirm
                account={confirming}
                sessions={sessions}
                onCancel={() => setConfirmId(null)}
                onConfirm={() => doRemove(confirming)}
              />
            )}
            <div className="scz acc-body">
              {accounts.map((account, i) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  snapshot={usageByAccount[account.id]}
                  sessionCount={sessionCounts[account.id] ?? 0}
                  now={now}
                  cursor={i === clampCursor(cursor, accounts.length)}
                  fresh={account.id === freshId}
                  renaming={renamingId === account.id}
                  renameDraft={renameDraft}
                  onRenameDraft={setRenameDraft}
                  onRenameCommit={commitRename}
                  onRenameCancel={cancelRename}
                  onFocus={() => setCursor(i)}
                  onSetDefault={() => setDefault(account)}
                  onStartRename={() => startRename(account)}
                  onRelogin={() => setLogin({ accountId: account.id })}
                  onRemove={() => setConfirmId(account.id)}
                />
              ))}
            </div>
            {/* FR-36 — the isolation cost, stated once, in prose — over the
                keyboard model this modal has always had and never named. */}
            <div className="acc-footer">
              <span className="acc-footer-note">{ACCOUNTS_ISOLATION_NOTE}</span>
              <div className="acc-hints">
                {ACCOUNTS_KEY_HINTS.map((h) => (
                  <span key={h.key} className="acc-hint">
                    <span className="acc-hint-key">{h.key}</span>
                    {h.label}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
