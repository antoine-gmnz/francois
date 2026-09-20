// pi-session-durability §8 — the SESSION tab's Pi recovery banner:
// missing/corrupt/incompatible/account-missing refuse resume with ONE cause
// plus Retry / Create new session (FR-3/FR-7). ConversationView only mounts
// this for a Pi session whose `recovery` is one of those four states — `ready`
// and `disconnected` render nothing (the next send re-attaches transparently),
// and Claude's own ResumeFailBanner is untouched and unrelated.
//
// Neither action touches the composer's draft (./composer-draft.ts) — a
// half-typed prompt survives a Retry, a failed Retry, or a Create-new-session
// exactly as it survives switching tabs, since nothing here calls session_send
// or clears that per-session map.

import { useState } from 'react';
import type { Result, RuntimeRecovery, SessionId, SessionMeta } from '../../../contract/common';
import { sessionNewFrom, sessionReconnect } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { useTimedError } from '../../lib/hooks/useTimedError';
import { Button } from '../../ui/Button';
import { recoveryCauseText, submitRecoveryAction } from './pi-recovery';

export default function PiRecoveryBanner({ sessionId, recovery }: { sessionId: SessionId; recovery: RuntimeRecovery }) {
  const [busy, setBusy] = useState(false);
  const { error, setError, schedule } = useTimedError();
  const mountedRef = useMounted();

  const run = (action: () => Promise<Result<SessionMeta>>) => {
    if (busy) return;
    void submitRecoveryAction({
      action,
      setBusy: (v) => {
        if (mountedRef.current) setBusy(v);
      },
      setError: (m) => {
        if (mountedRef.current) setError(m);
      },
      schedule,
    });
  };

  return (
    <div className="pi-recovery-banner" role="status">
      <span className="pi-recovery-banner__text">{recoveryCauseText(recovery)}</span>
      <div className="pi-recovery-banner__actions">
        <Button variant="primary" disabled={busy} onClick={() => run(() => sessionReconnect(sessionId))}>
          Retry
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => run(() => sessionNewFrom(sessionId))}>
          Create new session
        </Button>
      </div>
      {error !== null && <span className="pi-recovery-banner__error">{error}</span>}
    </div>
  );
}
