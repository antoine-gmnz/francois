// plugin-system §8 / FR-53..FR-57 — the injection card, rendered inside the
// SESSION transcript by ../conversation/Block (which owns the one per-block
// renderer both the SESSION tab and the agent tab draw with).
//
// The prompt is shown VERBATIM in a scrollable preformatted box: what the card
// displays is exactly what would be sent, which is the entire basis on which a
// user can consent to it. The core already stripped every control character that
// could make those two differ (FR-54).

import { useState } from 'react';
import type { PluginInjectionConversationBlock } from '../../../contract/plugin-system';
import { pluginsResolveInjection } from '../../lib/api';

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
  const pending = b.state === 'pending';

  const decide = async (decision: 'approve' | 'deny') => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    const res = await pluginsResolveInjection({ sessionId, blockId: b.blockId, decision });
    // §7 #33: a decision for a block that is no longer pending re-syncs from the
    // transcript rather than guessing — the event that resolved it is already
    // on its way.
    if (!res.ok) setError(res.error.message);
    setBusy(false);
  };

  const label: Record<string, string> = {
    approved: 'approved',
    denied: 'denied',
    expired: 'expired',
  };

  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        borderLeft: '2px solid var(--warn)',
        borderRadius: '0 4px 4px 0',
        padding: '10px 13px',
        // §7 #29: an expired card is dim — it is history, not a choice.
        opacity: b.state === 'expired' ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 10, letterSpacing: '0.12em', color: 'var(--warn)' }}>PLUGIN</span>
        <span
          style={{
            fontSize: 9.5,
            padding: '0 5px',
            border: '1px solid var(--border-2)',
            borderRadius: 3,
            color: C.dim,
          }}
        >
          {b.request.pluginName}
        </span>
        <span style={{ flex: 1 }} />
        {!pending && <span style={{ fontSize: 9.5, color: C.faint }}>{label[b.state] ?? b.state}</span>}
      </div>

      <div
        className="scz"
        style={{
          fontSize: 12,
          color: C.userBody,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          maxHeight: 160,
          overflow: 'auto',
          background: 'var(--bg-deep)',
          border: '1px solid var(--border)',
          borderRadius: 3,
          padding: '7px 9px',
        }}
      >
        {b.request.prompt}
      </div>

      <div style={{ fontSize: 9.5, color: C.faint, marginTop: 6 }}>
        → session {b.request.sessionId.slice(0, 8)}
      </div>

      {error && <div style={{ fontSize: 10, color: C.error, marginTop: 5 }}>{error}</div>}

      {pending && (
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
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
