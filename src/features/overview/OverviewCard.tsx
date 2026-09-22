// One session card of the OVERVIEW grid — redesign "Graphite & Signal", Figma
// "15 · Overview" (138:6405), "Card / *": the state line (glyph + label + age
// or live elapsed), the name, `project · branch`, a recessed mono "last output"
// block, and a footer of `+41 −12 · 3 files` with the card's one action.
//
// The whole card opens the session. The footer action does the specific thing:
// an approval is answered in place (Allow · Deny, once-only — "always" is a
// trust decision that belongs beside the full tool input in the transcript),
// Review opens the Changes tab, everything else just opens.

import { useState, type MouseEvent } from 'react';
import type { PermissionDecision, SessionMeta } from '../../../contract/common';
import { formatElapsed } from '../../../contract/conversation-view';
import { formatRelativeTime, type SessionDerived } from '../../../contract/fleet-board';
import { permissionsDecide } from '../../lib/api';
import { permissionActions } from '../../lib/permission-actions';
import { requestReplyPending, submitRequestReply } from '../../lib/request-replies';
import type { RosterAsk } from '../../lib/rosterStore';
import { useStore } from '../../lib/store';
import { StateIcon } from '../../ui/StateIcon';
import { askLine } from '../sessions/roster-row';
import {
  askOutput,
  CARD_ACTION,
  CARD_GLYPH,
  CARD_LABEL,
  cardDiffStat,
  cardNote,
  cardOutput,
  cardWhere,
  type CardKind,
} from './overview-cards';

export interface OverviewCardProps {
  session: SessionMeta;
  kind: CardKind;
  derived: SessionDerived | undefined;
  projectName: string | null;
  now: number;
  /** Open the session; `diff` lands on its Changes tab. */
  onOpen: (tab?: 'diff') => void;
}

export function OverviewCard({ session, kind, derived, projectName, now, onOpen }: OverviewCardProps) {
  const since = useStore((s) => s.runningSince.get(session.id));
  const activity = useStore((s) => s.sessionActivity.get(session.id));
  const parked = useStore((s) => (kind === 'approval' ? s.pendingAsk.get(session.id) : undefined));

  const age = kind === 'running' ? formatElapsed(now - (since ?? session.lastActivityAt)) : formatRelativeTime(session.lastActivityAt, now);
  const output = parked ? parkedOutput(parked) : cardOutput(kind, session, activity);
  const stat = cardDiffStat(derived);
  const attention = kind === 'approval' || kind === 'question';

  return (
    <div
      role="button"
      tabIndex={0}
      className={`ov-card ov-card--${kind}${attention ? ' ov-card--attention' : ''}`}
      title={session.cwd}
      onClick={() => onOpen()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen();
      }}
    >
      <div className="ov-card__state">
        <StateIcon kind={CARD_GLYPH[kind]} size={14} />
        <span className="ov-card__label truncate">{CARD_LABEL[kind]}</span>
        <span className="ov-card__age">{age}</span>
      </div>

      <div className="ov-card__name-block">
        <span className="ov-card__name truncate">{session.name}</span>
        <span className="ov-card__where truncate">{cardWhere(projectName, session)}</span>
      </div>

      {output && (
        <div className="ov-card__output" title={output}>
          <span className="truncate">{output}</span>
        </div>
      )}

      <div className="ov-card__footer">
        {stat && (
          <span className="ov-card__stat">
            <span className="ov-card__add">+{stat.added}</span>
            <span className="ov-card__del"> −{stat.deleted}</span>
          </span>
        )}
        <span className="ov-card__note truncate">{cardNote(kind, derived, session.model.label)}</span>
        {kind === 'approval' && parked ? (
          <AskActions session={session} parked={parked} />
        ) : (
          <button
            type="button"
            className="ov-card__action"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              onOpen(kind === 'review' ? 'diff' : undefined);
            }}
          >
            {kind === 'approval' ? 'Open' : CARD_ACTION[kind]}
          </button>
        )}
      </div>
    </div>
  );
}

function parkedOutput(parked: RosterAsk): string {
  const line = askLine(parked.ask);
  return askOutput(parked.ask.toolName, line.lead, line.code);
}

/** Once-only Allow · Deny, the same reply path the roster's approval card uses. */
function AskActions({ session, parked }: { session: SessionMeta; parked: RosterAsk }) {
  const [inFlight, setInFlight] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const writable = requestReplyPending(session, parked.blockId);
  const actions = permissionActions(parked.ask.allowedDecisions).filter(
    (a) => a.decision === 'allowOnce' || a.decision === 'denyOnce',
  );

  const decide = (decision: PermissionDecision) => {
    if (inFlight || !writable) return;
    setInFlight(true);
    setFailed(null);
    void submitRequestReply(
      useStore.getState().sessions.find((s) => s.id === session.id),
      parked.blockId,
      () => permissionsDecide(session.id, parked.blockId, decision, 'local'),
    ).then((res) => {
      setInFlight(false);
      // The card changes kind on `permission.resolved`; a failure must say so here.
      if (!res.ok) setFailed(res.error.message);
    });
  };

  return (
    <span className="ov-card__actions" onClick={(e) => e.stopPropagation()} title={failed ?? undefined}>
      {failed && <span className="ov-card__failed">failed</span>}
      {actions.map((action, i) => (
        <span key={action.decision} className="ov-card__actions-item">
          {i > 0 && <span className="ov-card__sep">·</span>}
          <button
            type="button"
            className="ov-card__action"
            title={action.label}
            disabled={inFlight || !writable}
            onClick={() => decide(action.decision)}
          >
            {action.short}
          </button>
        </span>
      ))}
    </span>
  );
}
