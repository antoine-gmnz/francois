// design 12b — "sorted by what wants you". The roster's state-grouped body:
// four headings that are STATES, and three row shapes whose weight matches how
// much the session is asking of you.
//
//   WAITING ON YOU  the whole ask, inline, with its Allow / Deny — you never
//                   have to open the session to unblock it
//   RUNNING         name, live elapsed, what it is doing right now, context
//   IDLE / ARCHIVED name + how long it has been settled, then the branch it is
//                   on with its context, then what its tree is carrying
//
// The settled row is the design's second pass: one line was too little. What it
// shows now is what you need to decide what to DO with a finished session —
// which branch, how much context is left in it, and how much uncommitted work is
// sitting there. What it still does not show is anything identical on every row:
// the cwd, and a model chip that only appears when the session is NOT on its
// project's default. Those live in the row's hover title (rowTitle).
//
// There is no grouping toggle: pane [1] groups by state, full stop.

import { useState } from 'react';
import type { SessionMeta } from '../../../contract/common';
import { formatContextTokens } from '../../../contract/conversation-view';
import { STATUS_COLOR, formatRelativeTime, statusPulses, type SessionDerived } from '../../../contract/fleet-board';
import { permissionsDecide } from '../../lib/api';
import { toneVar } from '../../lib/tone';
import { StatusDot } from '../../ui/StatusDot';
import { sessionAccountBadge } from '../accounts/accounts';
import { projectMarker } from '../projects/projectMarker';
import { useStore } from '../../lib/store';
import type { RosterAsk } from '../../lib/rosterStore';
import { askLine, contextFraction, formatLineCount, rowTitle, workLine } from './roster-row';
import { STATE_STATUS, type RosterStateNode, type SessionState } from './state-groups';
import '../accounts/accounts.css';
import './sidebar.css';

/** What every row shape needs, whatever its state. */
export interface StateRowContext {
  home: string;
  now: number;
  /** fleet-board's per-session figures — the settled row's diff totals. */
  derived: ReadonlyMap<string, SessionDerived>;
  /** Painted-order index of the row the keyboard cursor is on, or -1. */
  cursorIndex: number;
  activeSessionId: string | null;
  /** The repo label for a session — rendered as a marker only when the roster
   *  actually holds more than one project (12b: "project becomes a tag, only
   *  shown when more than one project is open"). */
  projectLabelOf: (session: SessionMeta) => string | null;
  /** The model this session's PROJECT defaults to, or null when it declares
   *  none. A settled row names its model only when the two differ. */
  projectDefaultModelId: (session: SessionMeta) => string | null;
  paneLabelOf: (session: SessionMeta) => { label: string; accent: boolean; focused: boolean } | null;
  onSelect: (id: string) => void;
  onContext: (id: string, x: number, y: number) => void;
}

export interface StateRosterBodyProps extends StateRowContext {
  nodes: readonly RosterStateNode[];
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
}

export function StateRosterBody({ nodes, collapsed, onToggle, ...row }: StateRosterBodyProps): JSX.Element {
  // The keyboard cursor indexes the FLAT painted order (flattenStateGroups), so
  // the walk below reproduces it with a running counter rather than an indexOf
  // per row — the roster re-renders on every session event.
  let flatIndex = -1;

  return (
    <>
      {nodes.map((node) => {
        const isCollapsed = collapsed.has(node.key);
        return (
          <div key={node.key} className="roster-state">
            <StateHeading node={node} collapsed={isCollapsed} onToggle={() => onToggle(node.key)} />
            {!isCollapsed &&
              node.sessions.map((session) => {
                flatIndex += 1;
                return (
                  <StateRow key={session.id} session={session} state={node.state} index={flatIndex} {...row} />
                );
              })}
          </div>
        );
      })}
    </>
  );
}

/** A state heading. The dot IS the group's colour, so no row under it has to
 *  carry a status tag of its own; collapsed, it swaps for a caret (there is
 *  nothing live to show a dot for). */
function StateHeading({
  node,
  collapsed,
  onToggle,
}: {
  node: RosterStateNode;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const status = STATE_STATUS[node.state];
  const color = toneVar(STATUS_COLOR[status]);
  // Only the two groups that are ASKING something tint their label. A settled
  // group is a divider — tinting IDLE green would put four coloured headings on
  // a pane whose whole argument is that one of them should stand out.
  const loud = node.state === 'attention' || node.state === 'running';
  return (
    <div className={`roster-state__head roster-state__head--${node.state}`} onClick={onToggle}>
      {collapsed ? (
        <span className="roster-state__caret">▸</span>
      ) : (
        <StatusDot color={color} size={5} pulsing={statusPulses(status)} />
      )}
      <span className="roster-state__label" style={loud && !collapsed ? { color } : undefined}>
        {node.label}
      </span>
      <span className="roster-state__count">{node.sessions.length}</span>
    </div>
  );
}

function StateRow({ session, state, index, ...ctx }: { session: SessionMeta; state: SessionState; index: number } & StateRowContext) {
  const selected = session.id === ctx.activeSessionId;
  const pane = ctx.paneLabelOf(session);
  const classNames = [`roster-row roster-row--${state}`];
  if (selected || pane) classNames.push('roster-row--selected');
  if (index === ctx.cursorIndex) classNames.push('roster-row--cursor');
  if (pane?.focused) classNames.push('roster-row--pane-focus');

  const tags = <RowTags session={session} pane={pane} projectLabel={ctx.projectLabelOf(session)} />;

  return (
    <div
      className={classNames.join(' ')}
      title={rowTitle(session, ctx.home)}
      onClick={() => ctx.onSelect(session.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        ctx.onContext(session.id, e.clientX, e.clientY);
      }}
    >
      {state === 'attention' ? (
        <AttentionBody session={session} tags={tags} now={ctx.now} />
      ) : state === 'running' ? (
        <RunningBody session={session} tags={tags} now={ctx.now} />
      ) : (
        <QuietBody
          session={session}
          state={state}
          tags={tags}
          now={ctx.now}
          derived={ctx.derived.get(session.id)}
          offDefaultModel={offDefaultModel(session, ctx.projectDefaultModelId(session))}
        />
      )}
    </div>
  );
}

/** The badges a row carries whatever its shape: a non-default account, the
 *  project (only when more than one is open) and which pane holds the session.
 *  Provenance chips (cloud / profile) are deliberately NOT here — 12b's whole
 *  argument is that a row shows what is true of THIS session now; those live in
 *  the session's own header. */
function RowTags({
  session,
  pane,
  projectLabel,
}: {
  session: SessionMeta;
  pane: { label: string; accent: boolean; focused: boolean } | null;
  projectLabel: string | null;
}) {
  const accounts = useStore((s) => s.accounts);
  const accountBadge = sessionAccountBadge(accounts, session);
  if (!accountBadge && !projectLabel && !pane) return null;
  return (
    <>
      {accountBadge && (
        <span className="acc-badge" title={accountBadge.title}>
          {accountBadge.text}
        </span>
      )}
      {projectLabel && (
        <span className="roster-row__marker" title={projectLabel}>
          {projectMarker(projectLabel)}
        </span>
      )}
      {pane && (
        <span className={pane.accent ? 'roster-row__pane roster-row__pane--accent' : 'roster-row__pane'}>
          {pane.label}
        </span>
      )}
    </>
  );
}

/**
 * WAITING ON YOU. A parked approval is answered here, in the roster — the
 * design's central claim, and the reason this row is the only one that grows
 * buttons. A question and an error have nothing to answer inline, so they say
 * what happened and the row itself is the way in.
 */
function AttentionBody({ session, tags, now }: { session: SessionMeta; tags: JSX.Element; now: number }) {
  const parked = useStore((s) => s.pendingAsk.get(session.id));
  return (
    <>
      <div className="roster-row__line">
        <span className="roster-row__name truncate">{session.name}</span>
        {tags}
        <span className="roster-row__age">{formatRelativeTime(session.lastActivityAt, now)}</span>
      </div>
      {session.status === 'awaiting_approval' && parked ? (
        <AskBody sessionId={session.id} parked={parked} />
      ) : (
        <div className="roster-row__says truncate">{attentionNote(session)}</div>
      )}
    </>
  );
}

/** What an attention row says when there is no ask to answer inline. */
function attentionNote(session: SessionMeta): string {
  if (session.status === 'error') return session.errorMessage || 'The turn failed.';
  if (session.status === 'awaiting_input') return 'Asked you a question.';
  return 'Waiting on an approval.';
}

/** The ask, plus its two answers. Once-only decisions: a rule written from a
 *  roster row would be a trust decision made without the tool input in front of
 *  you — "always" stays in the transcript's own card, which shows it. */
function AskBody({ sessionId, parked }: { sessionId: string; parked: RosterAsk }) {
  const [inFlight, setInFlight] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const line = askLine(parked.ask);

  const decide = (decision: 'allowOnce' | 'denyOnce') => {
    if (inFlight) return;
    setInFlight(true);
    setFailed(null);
    void permissionsDecide(sessionId, parked.blockId, decision, 'local').then((res) => {
      setInFlight(false);
      // The card clears itself on `permission.resolved`; a failure has to say so
      // in place, since the row is the only thing on screen that asked.
      if (!res.ok) setFailed(res.error.message);
    });
  };

  return (
    <>
      <div className="roster-row__says truncate" title={parked.ask.summary || parked.ask.toolName}>
        {line.lead} {line.code && <code className="roster-row__code">{line.code}</code>}
      </div>
      {failed && <div className="roster-row__failed truncate">{failed}</div>}
      <div className="roster-row__actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="roster-row__btn roster-row__btn--allow"
          disabled={inFlight}
          onClick={() => decide('allowOnce')}
        >
          Allow
        </button>
        <button
          type="button"
          className="roster-row__btn"
          disabled={inFlight}
          onClick={() => decide('denyOnce')}
        >
          Deny
        </button>
      </div>
    </>
  );
}

/** RUNNING. Live numbers, because they are the only rows whose numbers move:
 *  elapsed since the turn began, what tool is in flight, and the context bar. */
function RunningBody({ session, tags, now }: { session: SessionMeta; tags: JSX.Element; now: number }) {
  const since = useStore((s) => s.runningSince.get(session.id));
  const activity = useStore((s) => s.sessionActivity.get(session.id));
  return (
    <>
      <div className="roster-row__line">
        <span className="roster-row__name truncate">{session.name}</span>
        {tags}
        <span className="roster-row__age roster-row__age--live">
          {formatRelativeTime(since ?? session.lastActivityAt, now)}
        </span>
      </div>
      {activity && (
        <div className="roster-row__activity truncate">
          {activity}
          <span className="roster-row__caret">▌</span>
        </div>
      )}
      <div className="roster-row__ctx">
        <ContextBar session={session} wide />
        <span className="roster-row__figure">
          {session.contextLimitTokens > 0
            ? `${formatContextTokens(session.contextUsedTokens)}/${formatContextTokens(session.contextLimitTokens)}`
            : formatContextTokens(session.contextUsedTokens)}
        </span>
      </div>
    </>
  );
}

/**
 * IDLE / ARCHIVED. Three lines, and every one of them is conditional: the row
 * shrinks back toward one when the session has nothing on that line to say.
 */
function QuietBody({
  session,
  state,
  tags,
  now,
  derived,
  offDefaultModel,
}: {
  session: SessionMeta;
  state: SessionState;
  tags: JSX.Element;
  now: number;
  derived: SessionDerived | undefined;
  offDefaultModel: boolean;
}) {
  const branch = session.worktree?.branch ?? null;
  const work = workLine(derived);
  // "idle 5h" reads as one phrase — how long it has been settled — which is why
  // it repeats the heading's word rather than leaving a bare age to be measured
  // from nothing.
  const settled = state === 'archived' ? 'done' : 'idle';
  const hasDetail = offDefaultModel || branch !== null || session.contextLimitTokens > 0;

  return (
    <>
      <div className="roster-row__line">
        <span className="roster-row__name roster-row__name--quiet truncate">{session.name}</span>
        {tags}
        <span className="roster-row__age">
          {settled} {formatRelativeTime(session.lastActivityAt, now)}
        </span>
      </div>

      {hasDetail && (
        <div className="roster-row__line">
          {/* multi-account's badge rule, applied to the model: shown only when it
              is NOT what the project would have given you, so a chip on a row
              always means "this one is different". */}
          {offDefaultModel && (
            <span className="roster-row__model" title="not the project default model">
              {session.model.label}
            </span>
          )}
          {branch !== null && (
            <span className="roster-row__branch truncate" title={branch}>
              {branch}
            </span>
          )}
          {branch === null && <span className="app-flex-spacer" />}
          <ContextBar session={session} />
          {session.contextLimitTokens > 0 && (
            <span className="roster-row__figure">{formatContextTokens(session.contextUsedTokens)}</span>
          )}
        </div>
      )}

      {work && (
        <div className="roster-row__work">
          <span className="roster-row__add">+{formatLineCount(work.added)}</span>
          <span className="roster-row__del">−{formatLineCount(work.deleted)}</span>
          <span className="roster-row__sep">·</span>
          <span className="truncate">{work.note}</span>
        </div>
      )}
    </>
  );
}

/**
 * Whether this row should name its model. A project that declares no default
 * says nothing about which model is unusual, so nothing is claimed — the model
 * stays in the hover title, where every row carries it anyway.
 */
function offDefaultModel(session: SessionMeta, projectDefaultModelId: string | null): boolean {
  if (projectDefaultModelId === null) return false;
  return session.model.id !== projectDefaultModelId;
}

/** The context bar. Absent — not empty — when there is no window to measure
 *  against, so an unknown limit never paints as a bar sitting at zero. */
function ContextBar({ session, wide = false }: { session: SessionMeta; wide?: boolean }) {
  if (session.contextLimitTokens <= 0) return null;
  return (
    <span className={wide ? 'roster-row__bar roster-row__bar--wide' : 'roster-row__bar'}>
      <span className="roster-row__bar-fill" style={{ width: `${contextFraction(session) * 100}%` }} />
    </span>
  );
}
