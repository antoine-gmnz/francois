// permission-guardrails — approval card renderer for the SESSION transcript
// (spec §8), under design 9b. Compact by design: a legend row, the CODE SURFACE
// (what is being approved, set as code rather than stated as prose), and the
// action row — everything else (raw input, cwd, the rule an "always" would
// write) lives behind the disclosure caret. The classes live in
// ./permissions.css and contain NO @keyframes/animation/transition (the
// file-wide motion rule — state changes are instant swaps). All decision logic
// is pure in ./permission-card (unit-tested); this file is DOM assembly +
// card-local UI state (chosen tier, disclosure, in-flight flag, inline error).

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PermissionConversationBlock,
  PermissionDecision,
  PermissionTier,
} from '../../../contract/permission-guardrails';
import { permissionsDecide } from '../../lib/api';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { useTimedError } from '../../lib/hooks/useTimedError';
import { focusedSessionId } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';
import { askCodeSurface, cardLegend } from './permission-code';
import CodeSurfaceView from './CodeSurface';
import {
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
  // Whether this card is actually ON SCREEN — see the keydown guard below.
  const rootRef = useRef<HTMLDivElement>(null);
  const now = useElapsedClock(pending, 30_000);

  const interactive = pending && !inFlight;
  const note = stateNote(block.state);
  const detail = hasDetail(block.ask, pending);
  // 9b: the ask, parsed into the surface that sets it — a tokenized command, a
  // request line or a real diff. Pure and cheap, but the ask never changes
  // while the card lives, so it is derived once per block rather than per key.
  const surface = useMemo(() => askCodeSurface(block.ask), [block.ask]);

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

  // design 7a: the numbered rows are answerable from the keyboard, exactly as
  // the mock's composer promises. Capture phase + stopPropagation so `1`–`4`
  // never also reach app-shell's pane shortcuts, and only while THIS card's
  // session is the focused one — two mounted panes must not both claim a digit.
  // Same standing-down rule as every other single-letter global: a digit typed
  // into a text field or the terminal is a digit, not an answer.
  useEffect(() => {
    if (!interactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = PERMISSION_ACTIONS.findIndex((_, i) => String(i + 1) === e.key);
      if (idx === -1) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (el && el.closest('.xterm') !== null) return;
      if (focusedSessionId(useStore.getState()) !== sessionId) return;
      // …and only while this card is DISPLAYED. The main pane now HOLDS a
      // session's transcript mounted behind DIFF, SHELL and the panel tabs
      // (SessionViewHost), so the session test above no longer implies the card
      // is on screen — without this, `1`–`4` typed on the DIFF tab (where they
      // mean "focus the roster" / "open a panel") would answer an approval the
      // user cannot even see. `offsetParent === null` is the same
      // "hidden by an ancestor" test ShellTerminal's ResizeObserver uses.
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      e.preventDefault();
      e.stopPropagation();
      decide(PERMISSION_ACTIONS[idx].decision);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // `decide` closes over the CURRENT tier/interactive, so it belongs in the deps.
  }, [interactive, sessionId, tier]);

  return (
    <div ref={rootRef} className={cardClass(block.state, inFlight)}>
      {/* 9b: the legend names WHAT KIND of ask this is, then a rule carries the
          eye to the waiting clock at the right edge. */}
      <div className="pcard__head">
        <span className="pcard__label">{cardLegend(surface)}</span>
        {note && <span className={`pcard__note pcard__note--${block.state}`}>{note}</span>}
        <span className="pcard__head-rule" />
        {/* relativeAge already reads "5m ago" / "just now" — no "waiting" prefix,
            which would double the tense the mock's `waiting 4m` states once. */}
        {pending && <span className="pcard__age">{relativeAge(now - askedAt.current)}</span>}
      </div>

      {/* §8.3 / 9b: what is being approved, set as code. Its header strip
          doubles as the disclosure control when there is detail to reveal. */}
      <CodeSurfaceView
        surface={surface}
        open={detail ? open : undefined}
        onToggle={detail ? () => setOpen((v) => !v) : undefined}
      />

      {detail && open && (
        <div className="pcard__detail">
          {/* FR-20: the raw input, so nothing is hidden behind the summary. */}
          {block.ask.inputJson !== '' && <div className="scz pcard__input">{block.ask.inputJson}</div>}

          {/* 9b: skipped when the surface header already states it — a command
              ask puts the cwd there, and repeating it inside the disclosure
              makes the reader check whether the two say different things. */}
          {block.ask.cwd !== '' && block.ask.cwd !== surface.header.context && (
            <div className="pcard__meta">cwd {block.ask.cwd}</div>
          )}

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
        <>
          {/* design 7a: the decisions are NUMBERED LINES, not a button row — the
              terminal grammar the mock uses, and the shape that lets the keyboard
              answer without hunting for a target. Order is unchanged, so the
              number of each decision is stable across every ask. */}
          <div className="pcard__choices">
            {PERMISSION_ACTIONS.map((a, i) => (
              <div
                key={a.decision}
                className={i === 0 ? 'pcard__choice pcard__choice--lead' : 'pcard__choice'}
                title={a.label}
                onClick={() => decide(a.decision)}
                onMouseEnter={() => setHovered(a.decision)}
                onMouseLeave={() => setHovered(null)}
              >
                <span className={`pcard__choice-key pcard__choice-key--${a.variant}`}>{i + 1}</span>
                <span className="pcard__choice-label">{a.label}</span>
              </div>
            ))}
          </div>

          {/* The tier only scopes the two `*Always` lines, so it sits under them
              rather than beside a specific one (§8.6/8.7). */}
          <div className="pcard__actions">
            <span className={'pcard__tiers' + (tierControlDimmed(hovered) ? ' pcard__tiers--inert' : '')}>
              <span className="pcard__tiers-label">always applies to</span>
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
            <span className="pcard__hint">press 1–{PERMISSION_ACTIONS.length}, or click a line</span>
          </div>
        </>
      )}

      {/* FR-21: inline, transient, never an alert. */}
      {error !== null && <div className="pcard__error">{error}</div>}
    </div>
  );
}
