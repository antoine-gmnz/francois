// plugin-system §8 / FR-53..FR-57 — the injection card, rendered inside the
// SESSION transcript by ../conversation/Block (which owns the one per-block
// renderer both the SESSION tab and the agent tab draw with).
//
// The prompt is shown VERBATIM in a scrollable preformatted box: what the card
// displays is exactly what would be sent, which is the entire basis on which a
// user can consent to it. The core already stripped every control character that
// could make those two differ (FR-54).

import { useEffect, useState } from 'react';
import type { PluginInjectionConversationBlock } from '../../../contract/plugin-system';
import { pluginsResolveInjection } from '../../lib/api';
import { useStore } from '../../lib/store';
import {
  INJECTION_INTENT_LINE,
  formatExpiresIn,
  injectionCardClass,
  injectionStateNote,
  queuedNote,
} from './plugins';

const C = {
  faint: 'var(--text-faint)',
  dim: 'var(--text-dim)',
  userBody: 'var(--text-strong)',
  error: 'var(--error)',
};

export default function PluginInjectionCard({
  b,
  sessionId,
}: {
  b: PluginInjectionConversationBlock;
  sessionId: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // §8·E23: the queue position from the resolve call, until the block re-syncs
  // from the transcript carrying its own.
  const [queued, setQueued] = useState<number | undefined>(undefined);
  const pending = b.state === 'pending';

  // §8·E21: the countdown ticks once per second WHILE PENDING. It is not
  // decoration — §7 #29 makes silent expiry a real outcome, and without it the
  // user gets no signal that the decision is time-boxed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pending]);

  const sessionName = useStore((s) => s.sessions.find((x) => x.id === b.request.sessionId)?.name);

  const decide = async (decision: 'approve' | 'deny') => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await pluginsResolveInjection({ sessionId, blockId: b.blockId, decision });
      // §7 #33: a decision for a block that is no longer pending re-syncs from
      // the transcript rather than guessing — the event that resolved it is
      // already on its way.
      if (!res.ok) setError(res.error.message);
      else if (res.data.queued) setQueued(res.data.queuePosition);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the decision could not be sent');
    } finally {
      setBusy(false);
    }
  };

  const note = injectionStateNote(b.state);
  const queuePosition = b.queuePosition ?? queued;
  const queuedLine = queuedNote(queuePosition);

  return (
    // §8·E17: the PURPLE left rail. A permission ask is a stop; a plugin
    // injection is an OUTSIDE VOICE, and the two must never read the same.
    <div className={injectionCardClass(b.state, busy)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 9.5, letterSpacing: '0.08em', color: C.faint }}>PLUGIN</span>
        <span className="picard-chip">{b.request.pluginName}</span>
        {note && (
          <span
            style={{
              fontSize: 9.5,
              color:
                b.state === 'approved'
                  ? 'var(--success)'
                  : b.state === 'denied'
                    ? C.error
                    : C.faint,
            }}
          >
            {note}
          </span>
        )}
      </div>

      {/* §8·E19 — what is actually being asked for, said plainly. */}
      <div style={{ fontSize: 11, color: C.dim, marginTop: 8 }}>{INJECTION_INTENT_LINE}</div>

      {/* §8·E20 — the exact text. This box is the whole point of the card: it is
          never truncated and never collapsed behind a "show more". */}
      <div className="scz picard-prompt">{b.request.prompt}</div>

      {/* §8·E21 — the session by NAME, and the remaining time. */}
      <div style={{ fontSize: 10.5, color: C.faint, marginTop: 6 }}>
        → session {sessionName ?? b.request.sessionId.slice(0, 8)}
        {pending && ` · expires in ${formatExpiresIn(b.request.expiresAt, now)}`}
      </div>

      {/* §8·E23 — an approved prompt that landed behind an in-flight turn. */}
      {queuedLine && <div style={{ fontSize: 10.5, color: C.faint, marginTop: 6 }}>{queuedLine}</div>}

      {error && <div style={{ fontSize: 10, color: C.error, marginTop: 5 }}>{error}</div>}

      {pending && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 14, marginTop: 8 }}>
          <span
            role="button"
            onClick={() => void decide('approve')}
            style={{ fontSize: 11, color: busy ? C.faint : 'var(--success)', cursor: busy ? 'default' : 'pointer' }}
          >
            approve
          </span>
          <span
            role="button"
            onClick={() => void decide('deny')}
            style={{ fontSize: 11, color: busy ? C.faint : C.error, cursor: busy ? 'default' : 'pointer' }}
          >
            deny
          </span>
        </div>
      )}
    </div>
  );
}
