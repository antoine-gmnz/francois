import { requestReplyAvailable, requestReplyPending, submitRequestReply } from '../../lib/request-replies';
// permission-guardrails — approval card renderer for the SESSION transcript,
// drawn to Graphite & Signal: Figma 04 "Permission / Pending", 05 "/ Detail"
// (the raw input disclosed), and the one-line outcomes 06 "Allowed once",
// 07 "Denied", 08 "Always allowed". Classes live in ./permissions.css (no
// motion). All decision logic is pure in ./permission-card and
// ./permission-code (unit-tested); this file is DOM assembly + card-local UI
// state (chosen tier, disclosure, in-flight flag, inline error).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
    PermissionConversationBlock,
    PermissionDecision,
    PermissionTier,
} from '../../../contract/permission-guardrails';
import { permissionsDecide, permissionsRemove } from '../../lib/api';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { useTimedError } from '../../lib/hooks/useTimedError';
import { focusedSessionId } from '../../lib/layoutStore';
import { permissionActions, writesRule } from '../../lib/permission-actions';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { StateIcon } from '../../ui/StateIcon';
import { Tag } from '../../ui/Tag';
import { tabClassName } from '../../ui/Tab';
import CodeSurfaceView from './CodeSurface';
import {
    actionButtonKind,
    actionFace,
    cardClass,
    hasDetail,
    outcomeLabel,
    outcomeStateKind,
    relativeAge,
    rulePreviewScope,
    submitDecision,
    tierControlDimmed,
    tierLabel,
} from './permission-card';
import { askCodeSurface, askTitle } from './permission-code';
import './permissions.css';

const TIERS: PermissionTier[] = ['local', 'global'];

export default function PermissionCard({
  b: block,
  sessionId,
}: {
  b: PermissionConversationBlock;
  sessionId: string;
}) {
  if (block.state !== 'pending') return <PermissionOutcome block={block} sessionId={sessionId} />;
  return <PendingPermission block={block} sessionId={sessionId} />;
}

// ---------- pending (Figma 04 / 05) ----------

function PendingPermission({ block, sessionId }: { block: PermissionConversationBlock; sessionId: string }) {
  // FR-6: local by default — a trust decision made in one repo must not leak.
  const [tier, setTier] = useState<PermissionTier>('local');
  const [inFlight, setInFlight] = useState(false);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<PermissionDecision | null>(null);

  // FR-21: ONE live error timer, cleared on unmount and re-armed rather than
  // stacked on repeat failures.
  const { error, setError, schedule } = useTimedError();

  // FR-21 race check: the failure path must not re-enable a card an event
  // already resolved. Ref, so the async submit sees the CURRENT block state.
  const resolvedRef = useRef(false);
  resolvedRef.current = !requestReplyPending(useStore.getState().sessions.find((s) => s.id === sessionId), block.blockId);

  // §8.2: the transcript carries no timestamp, so the age is measured from the
  // card's first render.
  const askedAt = useRef(Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const now = useElapsedClock(true, 30_000);

  const meta = useStore((s) => s.sessions.find((session) => session.id === sessionId));
  const writable = requestReplyPending(meta, block.blockId);
  const actions = useMemo(() => permissionActions(block.ask.allowedDecisions), [block.ask.allowedDecisions]);
  const offersRules = actions.some((a) => writesRule(a.decision));
  const interactive = writable && !inFlight && actions.length > 0;
  const detail = hasDetail(block.ask, true);
  // The ask never changes while the card lives, so it is parsed once per block.
  const surface = useMemo(() => askCodeSurface(block.ask), [block.ask]);

  const decide = useCallback(
    (decision: PermissionDecision) => {
      if (
        !interactive ||
        !actions.some((a) => a.decision === decision) ||
        !requestReplyAvailable(useStore.getState().sessions.find((s) => s.id === sessionId), block.blockId)
      )
        return;
      void submitDecision({
        decision,
        tier,
        decide: (d, t) =>
          submitRequestReply(useStore.getState().sessions.find((s) => s.id === sessionId), block.blockId, () =>
            permissionsDecide(sessionId, block.blockId, d, t),
          ),
        setInFlight,
        setError,
        isResolved: () => resolvedRef.current,
        schedule,
      });
    },
    [interactive, actions, sessionId, block.blockId, tier, setError, schedule],
  );

  // The keycaps on each button answer from the keyboard. Capture phase +
  // stopPropagation so `1`–`4` never also reach app-shell's pane shortcuts, and
  // only while THIS card's session is focused and the card is on screen (the
  // transcript stays mounted behind DIFF/SHELL). A digit typed into a text
  // field or the terminal is a digit, not an answer.
  useEffect(() => {
    if (!interactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = actions.findIndex((_, i) => String(i + 1) === e.key);
      if (idx === -1) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (el && el.closest('.xterm') !== null) return;
      if (focusedSessionId(useStore.getState()) !== sessionId) return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      e.preventDefault();
      e.stopPropagation();
      decide(actions[idx]!.decision);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [interactive, sessionId, actions, decide]);

  const why = surface.header.blast;

  return (
    <div ref={rootRef} className={cardClass('pending', inFlight)}>
      <div className="pcard__head">
        <StateIcon kind="approval" size={14} />
        <span className="pcard__label">Permission</span>
        {block.ask.toolName !== '' && <Tag>{block.ask.toolName}</Tag>}
        <span className="pcard__gap" />
        <span className="pcard__age">{relativeAge(now - askedAt.current)}</span>
      </div>

      <div className="pcard__title">{askTitle(surface, block.ask.toolName)}</div>

      <CodeSurfaceView surface={surface} open={detail ? open : undefined} onToggle={detail ? () => setOpen((v) => !v) : undefined} />

      {open && <AskDetail block={block} surfaceContext={surface.header.context} />}

      {why !== null && (
        <div className="pcard__why">
          <Icon name="info" size={13} />
          <span>{why}</span>
        </div>
      )}

      {offersRules && block.ask.pattern !== '' && (
        <div className="pcard__rule">
          Always allow adds the rule <code className="pcard__pattern">{block.ask.pattern}</code> {rulePreviewScope(tier)}.
        </div>
      )}

      <div className="pcard__actions">
        {actions.map((a, i) => (
          <Button
            key={a.decision}
            variant={actionButtonKind(a.decision)}
            className="pcard__choice"
            shortcut={String(i + 1)}
            title={a.label}
            disabled={!interactive}
            onClick={() => decide(a.decision)}
            onMouseEnter={interactive ? () => setHovered(a.decision) : undefined}
            onMouseLeave={interactive ? () => setHovered(null) : undefined}
          >
            {actionFace(a.decision)}
          </Button>
        ))}
        {actions.length === 0 && <span className="pcard__hint">No reply choices are available.</span>}
        <span className="pcard__gap" />
        {/* The tier only scopes the two `always` decisions; hovering a `once`
            one dims it so it is clear the choice does not apply (§8.6). */}
        {offersRules && (
          <div
            role="radiogroup"
            aria-label="Rule scope"
            className={'tab-group pcard__scope' + (tierControlDimmed(hovered) ? ' pcard__scope--inert' : '')}
          >
            {TIERS.map((t) => (
              <button
                type="button"
                role="radio"
                aria-checked={t === tier}
                key={t}
                className={tabClassName(t === tier, 'md', 'pcard__tier')}
                disabled={!interactive}
                onClick={() => {
                  if (interactive) setTier(t);
                }}
              >
                <span className="tab__label">{capitalize(tierLabel(t))}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* FR-21: inline, transient, never an alert. */}
      {error !== null && <div className="pcard__error">{error}</div>}
    </div>
  );
}

/** Figma 05 "Arguments": the raw tool input (FR-20), plus the cwd when the surface does not already state it. */
function AskDetail({ block, surfaceContext }: { block: PermissionConversationBlock; surfaceContext: string }) {
  return (
    <>
      {block.ask.inputJson !== '' && <div className="scz pcard__input">{block.ask.inputJson}</div>}
      {block.ask.cwd !== '' && block.ask.cwd !== surfaceContext && <div className="pcard__meta">cwd {block.ask.cwd}</div>}
    </>
  );
}

// ---------- resolved (Figma 06 / 07 / 08) ----------

function PermissionOutcome({ block, sessionId }: { block: PermissionConversationBlock; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [undo, setUndo] = useState<'idle' | 'busy' | 'done'>('idle');
  const { error, setError, schedule } = useTimedError();
  const setPermissionsOpen = useStore((s) => s.setPermissionsOpen);
  const detail = hasDetail(block.ask, false);
  const rule = block.rule;
  const summary = block.ask.summary || block.ask.toolName || 'tool call';

  // Figma 08 "Undo": remove the rule the `always` decision wrote. The decision
  // itself already happened — undo only stops it applying to the NEXT ask.
  const onUndo = async () => {
    if (rule === undefined || undo !== 'idle') return;
    setUndo('busy');
    try {
      const res = await permissionsRemove(sessionId, rule.id);
      if (res.ok) {
        setUndo('done');
        return;
      }
      setError(res.error.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setUndo('idle');
    schedule(() => setError(null), 4000);
  };

  return (
    <div className={`pdone pdone--${block.state}`}>
      <div className="pdone__row">
        <StateIcon kind={outcomeStateKind(block.state)} size={14} />
        <span className="pdone__label">{outcomeLabel(block.state, rule)}</span>
        {rule !== undefined ? (
          <span className="pdone__rule">
            {undo === 'done' ? 'Rule removed from ' : 'Rule added to '}
            {tierLabel(rule.tier)}: <code className="pdone__pattern">{rule.pattern}</code>
          </span>
        ) : detail ? (
          <button type="button" className="pdone__summary" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={summary}>
            {summary}
          </button>
        ) : (
          <span className="pdone__summary" title={summary}>
            {summary}
          </span>
        )}
        {rule !== undefined && undo !== 'done' && (
          <button type="button" className="pdone__action pdone__action--strong" disabled={undo === 'busy'} onClick={() => void onUndo()}>
            Undo
          </button>
        )}
        {rule !== undefined && (
          <button type="button" className="pdone__action" onClick={() => setPermissionsOpen(true)}>
            Edit rules
          </button>
        )}
      </div>
      {open && (
        <div className="pdone__detail">
          <AskDetail block={block} surfaceContext="" />
        </div>
      )}
      {error !== null && <div className="pcard__error">{error}</div>}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
