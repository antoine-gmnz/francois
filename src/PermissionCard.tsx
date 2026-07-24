// permission-guardrails — approval card renderer for the SESSION transcript
// (spec §8). Inherits the question-card visual language; the classes live in
// src/styles.css and contain NO @keyframes/animation/transition (the file-wide
// motion rule — state changes are instant swaps). All decision logic is pure in
// ./permission-card (unit-tested); this file is DOM assembly + card-local UI
// state (chosen tier, in-flight flag, inline error).

import { useEffect, useRef, useState } from 'react';
import type {
  PermissionConversationBlock,
  PermissionDecision,
  PermissionTier,
} from '../contract/permission-guardrails';
import { permissionsDecide } from './api';
import {
  cardClass,
  PERMISSION_ACTIONS,
  ruleSentence,
  stateNote,
  submitDecision,
  tierControlDimmed,
  tierLabel,
  writtenRuleSentence,
} from './permission-card';

const TIERS: PermissionTier[] = ['local', 'global'];

export default function PermissionCard({ b, sessionId }: { b: PermissionConversationBlock; sessionId: string }) {
  // FR-6: local by default — a trust decision made in one repo must not leak.
  const [tier, setTier] = useState<PermissionTier>('local');
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<PermissionDecision | null>(null);

  // FR-21 race check: the failure path must not re-enable a card an event
  // already resolved. Ref, so the async submit sees the CURRENT block state.
  const resolvedRef = useRef(b.state !== 'pending');
  resolvedRef.current = b.state !== 'pending';

  // FR-21: ONE live error timer. Repeated failures used to stack overlapping 4 s
  // timeouts, so timer #1 cleared message #2 early; and nothing cleaned them up
  // on unmount (session switch, /clear removing the block).
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearErrorTimer = () => {
    if (errorTimer.current !== null) clearTimeout(errorTimer.current);
    errorTimer.current = null;
  };
  useEffect(() => clearErrorTimer, []);

  const interactive = b.state === 'pending' && !inFlight;
  const note = stateNote(b.state);

  const decide = (decision: PermissionDecision) => {
    if (!interactive) return;
    void submitDecision({
      decision,
      tier,
      decide: (d, t) => permissionsDecide(sessionId, b.blockId, d, t),
      setInFlight,
      setError,
      isResolved: () => resolvedRef.current,
      schedule: (fn, ms) => {
        clearErrorTimer();
        errorTimer.current = setTimeout(fn, ms);
      },
    });
  };

  return (
    <div className={cardClass(b.state, inFlight)}>
      <div className="pcard-head">
        <span className="pcard-label">PERMISSION</span>
        <span className="pcard-chip">{b.ask.toolName || 'tool'}</span>
        {note && <span className={`pcard-note pcard-note-${b.state}`}>{note}</span>}
      </div>

      {/* FR-20: the one-line "what" — omitted when the tool exposes none. */}
      {b.ask.summary !== '' && <div className="pcard-summary">{b.ask.summary}</div>}

      {/* FR-20: the raw input, so nothing is hidden behind the summary. */}
      {b.ask.inputJson !== '' && <div className="scz pcard-input">{b.ask.inputJson}</div>}

      {b.ask.cwd !== '' && <div className="pcard-meta">cwd {b.ask.cwd}</div>}

      {/* FR-22: what an "always" decision actually wrote. */}
      {b.rule && <div className="pcard-meta">rule written: {writtenRuleSentence(b.rule)}</div>}

      {b.state === 'pending' && (
        <>
          {/* FR-20: the rule an "always" decision WOULD write, with its tier
              control — visible before the user commits to it. */}
          <div className="pcard-rule">
            <span className="pcard-rule-label">writes rule:</span>
            <span className="pcard-rule-text">{ruleSentence(b.ask, tier)}</span>
            <span className="pcard-pattern">{b.ask.pattern}</span>
            <span className={'pcard-tiers' + (tierControlDimmed(hovered) ? ' pcard-tiers-inert' : '')}>
              {TIERS.map((t) => (
                <span
                  key={t}
                  className={'pcard-tier' + (t === tier ? ' pcard-tier-on' : '')}
                  onClick={() => {
                    if (interactive) setTier(t);
                  }}
                >
                  {tierLabel(t)}
                </span>
              ))}
            </span>
          </div>

          <div className="pcard-actions">
            {PERMISSION_ACTIONS.map((a) => (
              <span
                key={a.decision}
                className={'pcard-action ' + (a.allow ? 'pcard-allow' : 'pcard-deny')}
                onClick={() => decide(a.decision)}
                onMouseEnter={() => setHovered(a.decision)}
                onMouseLeave={() => setHovered(null)}
              >
                {a.label}
              </span>
            ))}
          </div>
        </>
      )}

      {/* FR-21: inline, transient, never an alert. */}
      {error !== null && <div className="pcard-error">{error}</div>}
    </div>
  );
}
