// permission-guardrails — approval card renderer for the SESSION transcript
// (spec §8). Compact by design: a header strip, the call signature, and the
// action row — everything else (raw input, cwd, the rule an "always" would
// write) lives behind the disclosure caret. The classes live in
// ./permissions.css and contain NO @keyframes/animation/transition (the
// file-wide motion rule — state changes are instant swaps). All decision logic
// is pure in ./permission-card (unit-tested); this file is DOM assembly +
// card-local UI state (chosen tier, disclosure, in-flight flag, inline error).

import { useRef, useState } from 'react';
import type {
  PermissionConversationBlock,
  PermissionDecision,
  PermissionTier,
} from '../../../contract/permission-guardrails';
import { permissionsDecide } from '../../lib/api';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { useTimedError } from '../../lib/hooks/useTimedError';
import {
  askSignature,
  cardClass,
  hasDetail,
  PERMISSION_ACTIONS,
  relativeAge,
  ruleSentence,
  stateNote,
  submitDecision,
  tierControlDimmed,
  tierLabel,
  writtenRuleSentence,
} from './permission-card';
import './permissions.css';

const TIERS: PermissionTier[] = ['local', 'global'];

export default function PermissionCard({
  b: block,
  sessionId,
}: {
  b: PermissionConversationBlock;
  sessionId: string;
}) {
  // FR-6: local by default — a trust decision made in one repo must not leak.
  const [tier, setTier] = useState<PermissionTier>('local');
  const [inFlight, setInFlight] = useState(false);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<PermissionDecision | null>(null);

  // FR-21: ONE live error timer, cleared on unmount (session switch, /clear
  // removing the block) and re-armed rather than stacked on repeat failures.
  const { error, setError, schedule } = useTimedError();

  // FR-21 race check: the failure path must not re-enable a card an event
  // already resolved. Ref, so the async submit sees the CURRENT block state.
  const pending = block.state === 'pending';
  const resolvedRef = useRef(!pending);
  resolvedRef.current = !pending;

  // §8.2: the transcript carries no timestamp, so the age is measured from the
  // card's first render and only claimed while the ask is still waiting.
  const askedAt = useRef(Date.now());
  const now = useElapsedClock(pending, 30_000);

  const interactive = pending && !inFlight;
  const note = stateNote(block.state);
  const detail = hasDetail(block.ask, pending);

  const decide = (decision: PermissionDecision) => {
    if (!interactive) return;
    void submitDecision({
      decision,
      tier,
      decide: (d, t) => permissionsDecide(sessionId, block.blockId, d, t),
      setInFlight,
      setError,
      isResolved: () => resolvedRef.current,
      schedule,
    });
  };

  return (
    <div className={cardClass(block.state, inFlight)}>
      <div className="pcard__head">
        <span className="pcard__glyph">◈</span>
        <span className="pcard__label">PERMISSION</span>
        {note && <span className={`pcard__note pcard__note--${block.state}`}>{note}</span>}
        {pending && <span className="pcard__age">{relativeAge(now - askedAt.current)}</span>}
      </div>

      {/* §8.3: the call as it would be typed — `Bash(rm -rf node_modules)`.
          Doubles as the disclosure control when there is detail to reveal. */}
      <button
        type="button"
        className={'pcard__sig' + (detail ? '' : ' pcard__sig--static')}
        onClick={detail ? () => setOpen((v) => !v) : undefined}
        aria-expanded={detail ? open : undefined}
      >
        <span className="pcard__sig-text">{askSignature(block.ask)}</span>
        {detail && <span className="pcard__caret">{open ? '▾' : '▸'}</span>}
      </button>

      {detail && open && (
        <div className="pcard__detail">
          {/* FR-20: the raw input, so nothing is hidden behind the summary. */}
          {block.ask.inputJson !== '' && <div className="scz pcard__input">{block.ask.inputJson}</div>}

          {block.ask.cwd !== '' && <div className="pcard__meta">cwd {block.ask.cwd}</div>}

          {/* FR-20: the rule an "always" decision WOULD write — visible before
              the user commits to it. The tier that scopes it sits in the action
              row, where it stays in view whether or not this is expanded. */}
          {pending && (
            <div className="pcard__rule">
              <span className="pcard__rule-label">writes rule:</span>
              <span className="pcard__rule-text">{ruleSentence(block.ask, tier)}</span>
              <span className="pcard__pattern">{block.ask.pattern}</span>
            </div>
          )}
        </div>
      )}

      {/* FR-22: what an "always" decision actually wrote. Stays out of the
          disclosure — a rule appearing on disk is the one thing worth seeing
          without asking for it. */}
      {block.rule && <div className="pcard__meta">rule written: {writtenRuleSentence(block.rule)}</div>}

      {pending && (
        <div className="pcard__actions">
          <span className={'pcard__tiers' + (tierControlDimmed(hovered) ? ' pcard__tiers--inert' : '')}>
            {TIERS.map((t) => (
              <button
                type="button"
                key={t}
                className={'pcard__tier' + (t === tier ? ' pcard__tier--on' : '')}
                onClick={() => {
                  if (interactive) setTier(t);
                }}
              >
                {tierLabel(t)}
              </button>
            ))}
          </span>

          {PERMISSION_ACTIONS.map((a) => (
            <button
              type="button"
              key={a.decision}
              className={`pcard__btn pcard__btn--${a.variant}`}
              title={a.label}
              onClick={() => decide(a.decision)}
              onMouseEnter={() => setHovered(a.decision)}
              onMouseLeave={() => setHovered(null)}
            >
              {a.short}
            </button>
          ))}
        </div>
      )}

      {/* FR-21: inline, transient, never an alert. */}
      {error !== null && <div className="pcard__error">{error}</div>}
    </div>
  );
}
