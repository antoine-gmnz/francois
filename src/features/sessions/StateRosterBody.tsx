// The roster's state-grouped body — design 12b's "sorted by what wants you",
// redrawn to redesign "Graphite & Signal" (Figma "Sidebar / Sessions" 127:28):
// uppercase group labels (NEEDS YOU · RUNNING · IDLE · ARCHIVED) and three row
// shapes whose weight matches how much the session is asking of you.
//
//   NEEDS YOU   a parked approval is an attention CARD: the ask as code, then
//               Allow / Deny / Open — answered from the roster, never opening the
//               session. A question or a failure says what happened instead.
//   RUNNING     name + live elapsed, then what it is doing right now.
//   IDLE / ARCH one line — name + how long it has been settled — plus the
//               uncommitted work line (+184 −52 · 6 files) when there is any.
//
// Every row leads with the Figma State glyph, so the state reads per row as well
// as per heading. What the redesign took off the rows (cwd, branch, model,
// context) lives in the row's hover title (rowTitle) — moved, not lost.

import { useState } from 'react';
import type { PermissionDecision, SessionMeta } from '../../../contract/common';
import { formatRelativeTime, type SessionDerived } from '../../../contract/fleet-board';
import { permissionsDecide } from '../../lib/api';
import { permissionActions, writesRule } from '../../lib/permission-actions';
import { requestReplyPending, submitRequestReply } from '../../lib/request-replies';
import type { RosterAsk } from '../../lib/rosterStore';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { StateIcon } from '../../ui/StateIcon';
import { Tag } from '../../ui/Tag';
import { sessionAccountBadge } from '../accounts/accounts';
import '../accounts/accounts.css';
import type { RosterGroupTier } from './group-tier';
import { askLine, formatLineCount, rowTitle, workLine } from './roster-row';
import './sidebar.css';
import type { RosterStateNode, SessionState } from './state-groups';

/** What every row shape needs, whatever its state. */
export interface StateRowContext {
  home: string;
  now: number;
  /** fleet-board's per-session figures — the settled row's diff totals. */
  derived: ReadonlyMap<string, SessionDerived>;
  /** Painted-order index of the row the keyboard cursor is on, or -1. */
  cursorIndex: number;
  activeSessionId: string | null;
  /** The repo label for a session — rendered as a tag only when the roster
   *  actually holds more than one project (12b). */
  projectLabelOf: (session: SessionMeta) => string | null;
  /** The model this session's PROJECT defaults to, or null when it declares
   *  none. Kept for the hover title's sake; the redesign draws no model chip. */
  projectDefaultModelId: (session: SessionMeta) => string | null;
  paneLabelOf: (session: SessionMeta) => { label: string; accent: boolean; focused: boolean } | null;
  onSelect: (id: string) => void;
  onContext: (id: string, x: number, y: number) => void;
}

export interface StateRosterBodyProps extends StateRowContext {
  nodes: readonly RosterStateNode[];
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** roster-group-tier FR-9/FR-10: independent of `collapsed`, its own slot space. */
  collapsedTiers: ReadonlySet<string>;
  onToggleTier: (key: string) => void;
}

export function StateRosterBody({
  nodes,
  collapsed,
  onToggle,
  collapsedTiers,
  onToggleTier,
  ...row
}: StateRosterBodyProps): JSX.Element {
  // The keyboard cursor indexes the FLAT painted order (flattenStateGroups), so
  // the walk below reproduces it with a running counter rather than an indexOf
  // per row — the roster re-renders on every session event.
  let flatIndex = -1;

  return (
    <>
      {nodes.map((node) => {
        const isCollapsed = collapsed.has(node.key);
        return (
          <div key={node.key} className={`roster-state roster-state--${node.state}`}>
            <StateHeading node={node} collapsed={isCollapsed} onToggle={() => onToggle(node.key)} />
            {!isCollapsed &&
              (node.tiers
                ? node.tiers.map((tier) => {
                    const tierCollapsed = collapsedTiers.has(tier.key);
                    return (
                      <div key={tier.key} className="roster-group">
                        <GroupHeading tier={tier} collapsed={tierCollapsed} onToggle={() => onToggleTier(tier.key)} />
                        {!tierCollapsed &&
                          tier.sessions.map((session) => {
                            flatIndex += 1;
                            return <StateRow key={session.id} session={session} state={node.state} index={flatIndex} {...row} />;
                          })}
                      </div>
                    );
                  })
                : node.sessions.map((session) => {
                    flatIndex += 1;
                    return <StateRow key={session.id} session={session} state={node.state} index={flatIndex} {...row} />;
                  }))}
          </div>
        );
      })}
    </>
  );
}

/** roster-group-tier FR-15/FR-16/FR-19: a thin, neutral row — caret, group
 *  name, count. The state heading above it already owns the colour. */
function GroupHeading({ tier, collapsed, onToggle }: { tier: RosterGroupTier; collapsed: boolean; onToggle: () => void }) {
  return (
    <div className="roster-group__head" role="button" aria-expanded={!collapsed} onClick={onToggle}>
      <span className="roster-state__caret">{collapsed ? '▸' : '▾'}</span>
      <span className="roster-group__label">{tier.label}</span>
      <span className="roster-state__count">{tier.sessions.length}</span>
    </div>
  );
}

/** The group label (Graphite/Label). NEEDS YOU takes the attention text colour;
 *  the others stay faint. Collapsed, it grows a caret so the fold is visible. */
function StateHeading({ node, collapsed, onToggle }: { node: RosterStateNode; collapsed: boolean; onToggle: () => void }) {
  return (
    <div
      className={`roster-state__head roster-state__head--${node.state}`}
      role="button"
      aria-expanded={!collapsed}
      title={collapsed ? 'expand' : 'collapse'}
      onClick={onToggle}
    >
      {collapsed && <span className="roster-state__caret">▸</span>}
      <span className="roster-state__label">{node.label}</span>
      <span className="roster-state__count">{node.sessions.length}</span>
    </div>
  );
}

function StateRow({ session, state, index, ...ctx }: { session: SessionMeta; state: SessionState; index: number } & StateRowContext) {
  const selected = session.id === ctx.activeSessionId;
  const pane = ctx.paneLabelOf(session);
  const parked = useStore((s) => (session.status === 'awaiting_approval' ? s.pendingAsk.get(session.id) : undefined));
  const card = state === 'attention' && parked !== undefined;
  const classNames = [`roster-row roster-row--${state}`];
  if (card) classNames.push('roster-row--card');
  if (state === 'idle' || state === 'archived') classNames.push('roster-row--quiet');
  if (selected || pane) classNames.push('roster-row--selected');
  if (index === ctx.cursorIndex) classNames.push('roster-row--cursor');
  if (pane?.focused) classNames.push('roster-row--pane-focus');

  const tags = <RowTags session={session} pane={pane} projectLabel={ctx.projectLabelOf(session)} />;

  return (
    <div className="roster-row-wrap">
      <div
        className={classNames.join(' ')}
        title={rowTitle(session, ctx.home)}
        onClick={() => ctx.onSelect(session.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          ctx.onContext(session.id, e.clientX, e.clientY);
        }}
      >
        {card ? (
          <AskCard session={session} parked={parked} tags={tags} now={ctx.now} onOpen={() => ctx.onSelect(session.id)} />
        ) : state === 'attention' ? (
          <AttentionBody session={session} tags={tags} now={ctx.now} />
        ) : state === 'running' ? (
          <RunningBody session={session} tags={tags} now={ctx.now} />
        ) : (
          <QuietBody session={session} state={state} tags={tags} now={ctx.now} derived={ctx.derived.get(session.id)} />
        )}
      </div>
    </div>
  );
}

/** The badges a row carries whatever its shape: a non-default account, the
 *  project (only when more than one is open) and which pane holds the session. */
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
        <Tag className="roster-row__project" title={projectLabel}>
          {projectLabel}
        </Tag>
      )}
      {pane && <span className={pane.accent ? 'roster-row__pane roster-row__pane--accent' : 'roster-row__pane'}>{pane.label}</span>}
    </>
  );
}

/** NEEDS YOU without an inline answer: a question or a failure says what happened. */
function AttentionBody({ session, tags, now }: { session: SessionMeta; tags: JSX.Element; now: number }) {
  return (
    <>
      <div className="roster-row__head">
        <StateIcon status={session.status} />
        <span className="roster-row__name truncate">{session.name}</span>
        {tags}
        <span className="app-flex-spacer" />
        <span className="roster-row__age">{formatRelativeTime(session.lastActivityAt, now)}</span>
      </div>
      <div className={session.status === 'error' ? 'roster-row__sub roster-row__sub--danger' : 'roster-row__sub'}>
        {attentionNote(session)}
      </div>
    </>
  );
}

/** What an attention row says when there is no ask to answer inline. */
function attentionNote(session: SessionMeta): string {
  if (session.status === 'error') return session.errorMessage || 'The turn failed.';
  if (session.status === 'awaiting_input') return 'Asked you a question.';
  return 'Waiting on an approval.';
}

/**
 * The approval card. Once-only decisions: a rule written from a roster row would
 * be a trust decision made without the tool input in front of you — "always"
 * stays in the transcript's own card, which shows it. `Open` is the way in.
 */
function AskCard({
  session,
  parked,
  tags,
  now,
  onOpen,
}: {
  session: SessionMeta;
  parked: RosterAsk;
  tags: JSX.Element;
  now: number;
  onOpen: () => void;
}) {
  const [inFlight, setInFlight] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const line = askLine(parked.ask);
  const writable = requestReplyPending(session, parked.blockId);
  const actions = permissionActions(parked.ask.allowedDecisions).filter((a) => !writesRule(a.decision));

  const decide = (decision: PermissionDecision) => {
    if (inFlight || !writable || !actions.some((a) => a.decision === decision)) return;
    setInFlight(true);
    setFailed(null);
    void submitRequestReply(
      useStore.getState().sessions.find((s) => s.id === session.id),
      parked.blockId,
      () => permissionsDecide(session.id, parked.blockId, decision, 'local'),
    ).then((res) => {
      setInFlight(false);
      // The card clears itself on `permission.resolved`; a failure has to say so
      // in place, since the row is the only thing on screen that asked.
      if (!res.ok) setFailed(res.error.message);
    });
  };

  return (
    <>
      <div className="roster-row__head">
        <StateIcon kind="approval" />
        <span className="roster-row__name truncate">{session.name}</span>
        {tags}
        <span className="roster-row__lead truncate">{line.lead.toLowerCase()}</span>
        <span className="roster-row__age">{formatRelativeTime(session.lastActivityAt, now)}</span>
      </div>
      {line.code && (
        <div className="roster-row__command" title={parked.ask.summary || parked.ask.toolName}>
          <code className="truncate">{line.code}</code>
        </div>
      )}
      {failed && <div className="roster-row__failed truncate">{failed}</div>}
      <div className="roster-row__actions" onClick={(e) => e.stopPropagation()}>
        {actions.map((action) => (
          <Button
            key={action.decision}
            size="sm"
            variant={action.allow ? 'attention' : 'secondary'}
            className="roster-row__decide"
            title={action.label}
            disabled={inFlight || !writable}
            onClick={() => decide(action.decision)}
          >
            {action.short}
          </Button>
        ))}
        <Button size="sm" variant="ghost" title="open the session" onClick={onOpen}>
          Open
        </Button>
      </div>
    </>
  );
}

/** RUNNING. Live numbers — the only rows whose numbers move: elapsed since the
 *  turn began, and what it is doing right now. */
function RunningBody({ session, tags, now }: { session: SessionMeta; tags: JSX.Element; now: number }) {
  const since = useStore((s) => s.runningSince.get(session.id));
  const activity = useStore((s) => s.sessionActivity.get(session.id));
  return (
    <>
      <div className="roster-row__head">
        <StateIcon status={session.status} />
        <span className="roster-row__name truncate">{session.name}</span>
        {tags}
        <span className="app-flex-spacer" />
        <span className="roster-row__age roster-row__age--live">{formatRelativeTime(since ?? session.lastActivityAt, now)}</span>
      </div>
      {activity && <div className="roster-row__sub truncate">{activity}</div>}
    </>
  );
}

/** IDLE / ARCHIVED: one line, plus the uncommitted work when there is any. */
function QuietBody({
  session,
  state,
  tags,
  now,
  derived,
}: {
  session: SessionMeta;
  state: SessionState;
  tags: JSX.Element;
  now: number;
  derived: SessionDerived | undefined;
}) {
  const work = workLine(derived);
  return (
    <>
      <div className="roster-row__head">
        <StateIcon status={session.status} />
        <span className="roster-row__name roster-row__name--quiet truncate">{session.name}</span>
        {tags}
        <span className="app-flex-spacer" />
        <span className="roster-row__age" title={state === 'archived' ? 'done' : 'idle'}>
          {formatRelativeTime(session.lastActivityAt, now)}
        </span>
      </div>
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
