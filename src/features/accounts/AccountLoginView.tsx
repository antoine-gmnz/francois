// multi-account — the login view that replaces the modal body while an account
// is being added (FR-11..FR-16). Owns the whole login lifecycle:
//
//   connecting → account:add is in flight; the frame shows `starting claude…`
//   live       → the real `claude` TUI renders in AccountLoginTerminal
//   error      → account.login.failed (or a refused account:add), with the
//                brief's TRY AGAIN / CLOSE pair
//
// `success` is not a state here: FR-13 emits account.login.done and the modal
// returns to the list (which flashes the new row), so this component unmounts.
//
// Cancellation is centralised in the parent's `cancelLogin` — Escape, the
// backdrop, closing the modal and unmounting all take the SAME path, because
// FR-16 requires the PTY killed and the half-written dir deleted every time.

import { useEffect, useRef, useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { Account } from '../../../contract/multi-account';
import { accountAdd, accountLoginCancel } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { Button } from '../../ui/Button';
import AccountLoginTerminal from './AccountLoginTerminal';
import { LOGIN_CANCEL_HINT, LOGIN_TITLE, loginErrorMessage, startLoginFeed } from './accounts';

export interface AccountLoginViewProps {
  /** FR-17: present ⇒ Re-login into an existing row + dir, not a new one. */
  accountId?: string;
  /** FR-13: the identity landed; the parent returns to the list. */
  onDone: (account: Account) => void;
  /** Cancel (Esc / CLOSE) — the parent kills the PTY and deletes the dir. */
  onClose: () => void;
  /** Hands the live loginId up so the parent's cancel path can address it. */
  onLoginId: (loginId: string | null) => void;
}

export default function AccountLoginView({ accountId, onDone, onClose, onLoginId }: AccountLoginViewProps): JSX.Element {
  const [loginId, setLoginId] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  // Bumping this remounts the terminal for TRY AGAIN, so a retry never renders
  // the previous attempt's scrollback behind the new TUI.
  const [attempt, setAttempt] = useState(0);
  const alive = useMounted();
  // The terminal's byte sink. A ref because the event feed below is registered
  // once and must always reach the CURRENT terminal instance.
  const writeRef = useRef<((data: string) => void) | null>(null);
  // Bytes that arrive before the terminal has registered its sink (the feed is
  // mounted first on purpose — FR-11's PTY starts writing immediately).
  const pendingRef = useRef<string[]>([]);
  const loginIdRef = useRef<string | null>(null);

  const write = (data: string) => {
    if (writeRef.current) writeRef.current(data);
    else pendingRef.current.push(data);
  };

  // ONE subscription for the whole view, mounted BEFORE account:add is fired so
  // no byte of the TUI's first frame is lost. It does not filter on the loginId
  // until one exists — at most one login runs at a time (FR-16), so anything
  // arriving before the ack belongs to this attempt.
  useEffect(() => {
    const stop = startLoginFeed({
      onData: (id, data) => {
        if (loginIdRef.current !== null && id !== loginIdRef.current) return;
        write(data);
      },
      onDone: (id, account) => {
        if (loginIdRef.current !== null && id !== loginIdRef.current) return;
        loginIdRef.current = null;
        onLoginId(null); // the core already killed the PTY — nothing to cancel
        onDone(account);
      },
      onFailed: (id, err) => {
        if (loginIdRef.current !== null && id !== loginIdRef.current) return;
        loginIdRef.current = null;
        onLoginId(null); // the core already killed the PTY and deleted the dir
        if (alive.current) {
          setLoginId(null);
          setError(err);
        }
      },
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // FR-11: start (or FR-17 re-run) the login. Runs after the feed above is set
  // up, and again on every TRY AGAIN.
  //
  // At most ONE account:add per attempt. The core allows a single login at a
  // time (FR-16) and refuses the rest with "a login is already in progress", so
  // an effect that fires twice refuses its own second call — which is exactly
  // what React 18's StrictMode double-invoke of mount effects produces in dev.
  // The ref survives that simulated unmount/remount (same component instance),
  // so it is what makes the pair idempotent; a genuine remount gets a fresh ref
  // and correctly starts a new login.
  const startedAttemptRef = useRef<number | null>(null);

  useEffect(() => {
    if (startedAttemptRef.current === attempt) return;
    startedAttemptRef.current = attempt;
    setError(null);
    setLoginId(null);
    void accountAdd(accountId ? { accountId } : {})
      .then((res) => {
        if (!res.ok) {
          if (alive.current) setError(res.error);
          return;
        }
        // The view went away while account:add was in flight. The core still
        // registered a live login, and this is the last reference to its id —
        // dropping it would strand the PTY and hold FR-16's single-login slot
        // for the rest of the run, so cancel it here instead.
        if (!alive.current) {
          void accountLoginCancel({ loginId: res.data.loginId }).catch(() => {});
          return;
        }
        loginIdRef.current = res.data.loginId;
        onLoginId(res.data.loginId);
        setLoginId(res.data.loginId);
      })
      .catch(() => {
        if (alive.current) setError({ code: 'INTERNAL', message: 'Could not start claude' });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  if (error) {
    return (
      <div className="acc-login">
        <div className="acc-login-failure">
          <span className="acc-login-failure-text">{loginErrorMessage(error)}</span>
          <div className="acc-login-failure-actions">
            <Button variant="ghost" onClick={onClose}>
              CLOSE
            </Button>
            <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
              TRY AGAIN
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="acc-login">
      <span className="acc-login-title">{LOGIN_TITLE}</span>
      <div className="acc-login-frame">
        {loginId === null ? (
          <div className="acc-login-connecting">starting claude…</div>
        ) : (
          // Mounted only once the id lands: xterm's canvas is opaque, so mounting
          // it earlier would sit on top of the "connecting" message above for the
          // whole life of that state. Any bytes that arrived before the mount
          // (pendingRef, populated by startLoginFeed which is live from the
          // start) are flushed into the terminal the instant onReady fires.
          <AccountLoginTerminal
            key={attempt}
            loginId={loginId}
            onReady={(w) => {
              writeRef.current = w;
              for (const chunk of pendingRef.current) w(chunk);
              pendingRef.current = [];
            }}
          />
        )}
      </div>
      <span className="acc-login-hint">{LOGIN_CANCEL_HINT}</span>
    </div>
  );
}
