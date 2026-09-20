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
//
// The PTY lifecycle itself (subscribe → start → buffer bytes → StrictMode
// double-invoke guard) lives in `useLoginPty`, shared with PiSetupView.

import type { Account } from '../../../contract/multi-account';
import { accountAdd } from '../../lib/api';
import { Button } from '../../ui/Button';
import AccountLoginTerminal from './AccountLoginTerminal';
import { LOGIN_CANCEL_HINT, LOGIN_TITLE, loginErrorMessage } from './accounts';
import { useLoginPty } from './useLoginPty';

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
  const pty = useLoginPty({
    start: () => accountAdd(accountId ? { accountId } : {}),
    onLoginId,
    onDone,
    onFailed: () => {
      /* the failure view below reads pty.error directly */
    },
    startFailedMessage: 'Could not start claude',
  });

  if (pty.error) {
    return (
      <div className="acc-login">
        <div className="acc-login-failure">
          <span className="acc-login-failure-text">{loginErrorMessage(pty.error)}</span>
          <div className="acc-login-failure-actions">
            <Button variant="ghost" onClick={onClose}>
              CLOSE
            </Button>
            <Button variant="primary" onClick={pty.retry}>
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
        {pty.loginId === null ? (
          <div className="acc-login-connecting">starting claude…</div>
        ) : (
          // Mounted only once the id lands: xterm's canvas is opaque, so mounting
          // it earlier would sit on top of the "connecting" message above for the
          // whole life of that state. Any bytes that arrived before the mount are
          // buffered by useLoginPty's byte sink and flushed the instant onReady
          // (registerWriter) fires.
          <AccountLoginTerminal key={pty.attempt} loginId={pty.loginId} onReady={pty.registerWriter} />
        )}
      </div>
      <span className="acc-login-hint">{LOGIN_CANCEL_HINT}</span>
    </div>
  );
}
