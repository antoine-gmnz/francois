// pi-provider-auth FR-3 — the Pi setup takeover: reuses the exact login-PTY
// infrastructure AccountLoginView already drives (useLoginPty,
// AccountLoginTerminal), pointed at `account_pi_setup` instead of
// `account_add`.
//
// Deliberately NOT the same OUTCOME as AccountLoginView's state machine: that
// view treats `account.login.done` as SUCCESS and returns to the list. FR-3 is
// explicit that closing Pi's setup NEVER implies auth succeeded — there is no
// new identity for Pi setup to report, only Pi's own native `/login` running
// in the frame — so `done` and `failed` both just mean "the PTY session
// ended", identical to the user closing it by hand. Close is therefore always
// available once the terminal is live, not gated behind an error state.

import { accountPiSetup } from '../../lib/api';
import { Button } from '../../ui/Button';
import AccountLoginTerminal from './AccountLoginTerminal';
import { piErrorMessage } from './pi';
import { useLoginPty } from './useLoginPty';

export interface PiSetupViewProps {
  accountId: string;
  /** Cancel (Esc / CLOSE) — the parent kills the PTY, same as every other login. */
  onClose: () => void;
  /** Hands the live loginId up so the parent's cancel path can address it. */
  onLoginId: (loginId: string | null) => void;
}

export default function PiSetupView({ accountId, onClose, onLoginId }: PiSetupViewProps): JSX.Element {
  const pty = useLoginPty({
    start: () => accountPiSetup({ accountId }),
    onLoginId,
    // FR-3: the PTY ended on its own. Not a success signal — treated exactly
    // like a manual close, so the caller returns to the list with no error.
    onDone: () => onClose(),
    onFailed: () => {
      /* the failure view below reads pty.error directly */
    },
    startFailedMessage: 'Could not start Pi',
  });

  if (pty.error) {
    return (
      <div className="acc-login">
        <div className="acc-login-failure">
          <span className="acc-login-failure-text">{piErrorMessage(pty.error)}</span>
          <div className="acc-login-failure-actions">
            <Button variant="ghost" onClick={onClose}>
              CLOSE
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="acc-login">
      <span className="acc-login-title">PI SETUP — run /login or configure keys, then close</span>
      <div className="acc-login-frame">
        {pty.loginId === null ? (
          <div className="acc-login-connecting">starting pi…</div>
        ) : (
          <AccountLoginTerminal loginId={pty.loginId} onReady={pty.registerWriter} />
        )}
      </div>
      <span className="acc-login-hint">Esc to close · Refresh afterwards to see the new auth state</span>
    </div>
  );
}
