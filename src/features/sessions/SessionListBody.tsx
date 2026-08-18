import { useState, type CSSProperties } from 'react';
import type { AppError, ProjectId, SessionMeta, SessionStatus } from '../../../contract/common';
import type { ProjectMeta } from '../../../contract/projects';
import {
  STATUS_COLOR,
  STATUS_LABEL,
  formatRelativeTime,
  statusNeedsAttention,
  statusPulses,
  type SessionDerived,
} from '../../../contract/fleet-board';
import { formatContextTokens } from '../../../contract/conversation-view';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import { abbreviate } from '../../lib/path';
import { useStore } from '../../lib/store';
import { toneVar } from '../../lib/tone';
import { BadgePill } from '../../ui/BadgePill';
import { EmptyPane } from '../../ui/EmptyPane';
import { StatusDot } from '../../ui/StatusDot';
import { sessionAccountBadge } from '../accounts/accounts';
import { CloudChip } from '../cloud-sessions/CloudChip';
import { filteredEmptyLabel } from '../projects/projects';
import { ProfileChip } from '../profiles/ProfileChip';
import { isGroupNode, type RosterNode, type RosterProjectNode } from './roster-groups';
import { truncateBranchLeft, worktreeChipLabel } from './worktree';
import '../accounts/accounts.css';
import './sidebar.css';

/**
 * Hover copy for the parked states — the 'approval'/'question' chip says WHICH
 * kind, this says what to do about it. Partial on purpose: every other status
 * either needs no explanation or (error) has its own message.
 */
const ATTENTION_TITLE: Partial<Record<SessionStatus, string>> = {
  awaiting_approval: 'waiting on an approval — open the session to allow or deny',
  awaiting_input: 'waiting on an answer — open the session to reply',
};

export interface SessionListBodyProps {
  hydrationError: AppError | null;
  onRetry: () => void;
  sessionCount: number;
  activeProjectId: ProjectId | null;
  inProjectCount: number;
  activeProject: ProjectMeta | null;
  /**
   * design 7a: the roster's rows, grouped by repo. project-groups FR-11 adds a
   * second, mixed-depth tier above it. `rowCursor` indexes the same sessions
   * FLATTENED in painted order (see flattenGroups) — the walk below reproduces
   * that order with a running counter.
   */
  groups: RosterNode[];
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
  /** A project heading's `+` — scopes a new session to that repo. project-groups
   * FR-25: never offered on a group heading. */
  onNewInGroup: (group: RosterProjectNode) => void;
  home: string;
  activeSessionId: string | null;
  focused: boolean;
  rowCursor: number;
  derived: ReadonlyMap<string, SessionDerived>;
  onSelect: (id: string) => void;
  onContext: (sessionId: string, x: number, y: number) => void;
  /** split-by-4 FR-22: which pane shows a session, or null — drives the badges. */
  paneIndexOf?: (sessionId: string) => number | null;
  /** 1 ⇒ not split, so no badges at all. */
  paneCount?: number;
  focusedPaneIndex?: number;
}

/**
 * FR-22: what a paned row's badge reads. At two panes the positions are the
 * names the user already has for them (turn 5b's `left` / `right`); above that
 * the badge is the pane NUMBER, which is also what `⌘<n>` and the pane header
 * say.
 */
export function paneBadgeLabel(paneIndex: number, paneCount: number): string {
  if (paneCount === 2) return paneIndex === 0 ? 'left' : 'right';
  return String(paneIndex + 1);
}

/** Pane [1]'s scrollable card list, plus its hydration-error / empty states. */
export function SessionListBody({
  hydrationError,
  onRetry,
  sessionCount,
  activeProjectId,
  inProjectCount,
  activeProject,
  groups,
  collapsedGroups,
  onToggleGroup,
  onNewInGroup,
  home,
  activeSessionId,
  focused,
  rowCursor,
  derived,
  onSelect,
  onContext,
  paneIndexOf,
  paneCount = 1,
  focusedPaneIndex = 0,
}: SessionListBodyProps): JSX.Element {
  // `rowCursor` indexes the FLAT painted order, so each card needs to know where
  // it sits in that walk. Tracked as a running counter rather than an indexOf per
  // card — the roster re-renders on every session event.
  let flatIndex = -1;

  // project-groups FR-19..FR-25: a project row, identical whether it sits at the
  // roster's top level or nested one step under a group heading (FR-24: the
  // group heading + this row + its cards is the depth ceiling — three levels).
  const renderProjectNode = (node: RosterProjectNode, nested: boolean) => {
    const collapsed = collapsedGroups.has(node.key);
    return (
      <div key={node.key} className={nested ? 'roster-group roster-group--nested' : 'roster-group'}>
        <div className="roster-group__head" onClick={() => onToggleGroup(node.key)}>
          <span className="roster-group__caret">{collapsed ? '▸' : '▾'}</span>
          <span className="roster-group__label truncate">{node.label}</span>
          <span className="roster-group__count">{node.sessions.length}</span>
          <span className="app-flex-spacer" />
          <span
            className="roster-group__new"
            title={`new session in ${node.label} · n`}
            onClick={(e) => {
              e.stopPropagation();
              onNewInGroup(node);
            }}
          >
            +
          </span>
        </div>
        {!collapsed &&
          node.sessions.map((session) => {
            flatIndex += 1;
            // FR-22: every paned row renders the selected treatment; only
            // the FOCUSED pane's row carries the accent left rail.
            const pane = paneCount > 1 && paneIndexOf ? paneIndexOf(session.id) : null;
            return (
              <SessionCard
                key={session.id}
                session={session}
                home={home}
                selected={pane !== null || session.id === activeSessionId}
                cursor={focused && flatIndex === rowCursor}
                derived={derived.get(session.id)}
                paneLabel={pane === null ? null : paneBadgeLabel(pane, paneCount)}
                paneAccent={pane !== null && pane > 0}
                paneFocused={pane !== null && pane === focusedPaneIndex}
                nested={nested}
                onClick={() => onSelect(session.id)}
                onContext={(x, y) => onContext(session.id, x, y)}
              />
            );
          })}
      </div>
    );
  };

  return (
    <div className="scz sidebar-list">
      {hydrationError ? (
        <div className="sidebar-error">
          failed to load sessions
          <div onClick={onRetry} className="sidebar-error__retry">
            retry
          </div>
        </div>
      ) : sessionCount === 0 ? (
        <EmptyPane className="sidebar-empty">no sessions yet · press n</EmptyPane>
      ) : activeProjectId !== null && inProjectCount === 0 ? (
        // projects FR-29: a project is active and owns no session — distinct
        // from the global "no sessions yet" state.
        //
        // Keyed on the ID, not on the resolved object: `projects` is empty until
        // the switcher's project_list lands (and stays empty forever if it
        // fails), so keying on `activeProject` showed the '/'-filter message
        // "no matches · esc to clear" on first paint with no filter typed.
        // filteredEmptyLabel degrades to a generic line for a null project.
        <EmptyPane className="sidebar-empty">
          {filteredEmptyLabel(activeProject)}
          <div className="sidebar-empty__hint">press n to start one</div>
        </EmptyPane>
      ) : groups.length === 0 ? (
        <EmptyPane className="sidebar-empty">no matches · esc to clear</EmptyPane>
      ) : (
        // design 7a: grouped by repo. project-groups FR-11: a second, mixed-depth
        // tier sits above it — a group node holds only project nodes, never
        // another group (FR-11 "groups never nest"). A row with a single session
        // still gets a heading — the roster's shape must not change as sessions
        // come and go.
        groups.map((node) => {
          if (isGroupNode(node)) {
            const collapsed = collapsedGroups.has(node.key);
            return (
              <div key={node.key} className="roster-group">
                {/* project-groups FR-23: a thin heading — no card surface, no
                    status dot, no acid. FR-25: no `+` at this tier. */}
                <div className="roster-group__head roster-group__head--group" onClick={() => onToggleGroup(node.key)}>
                  <span className="roster-group__caret">{collapsed ? '▸' : '▾'}</span>
                  <span className="roster-group__label roster-group__label--group truncate">{node.label}</span>
                  <span className="roster-group__count">{node.sessionCount}</span>
                </div>
                {!collapsed && node.projects.map((project) => renderProjectNode(project, true))}
              </div>
            );
          }
          return renderProjectNode(node, false);
        })
      )}
    </div>
  );
}

function ContextFigure({ used, limit }: { used: number; limit: number }) {
  if (limit <= 0) {
    if (used <= 0) return <span className="sidebar-card__faint">—</span>;
    return <span className="sidebar-card__meta">{formatContextTokens(used)}</span>;
  }
  // One element, not a fragment: this sits in a `gap`-spaced flex row, so two
  // siblings would have the gap wedged between the figure and its denominator.
  return (
    <span className="sidebar-card__meta">
      {formatContextTokens(used)}
      <span className="sidebar-card__faint">/{formatContextTokens(limit)}</span>
    </span>
  );
}

function SessionCard({
  session,
  home,
  selected,
  cursor,
  derived,
  paneLabel,
  paneAccent,
  paneFocused,
  nested,
  onClick,
  onContext,
}: {
  session: SessionMeta;
  home: string;
  selected: boolean;
  cursor: boolean;
  derived: SessionDerived | undefined;
  /** split-by-4 FR-22: the badge text (`left`/`right`/`1`…`4`), or null. */
  paneLabel: string | null;
  /** Accent treatment — every pane past pane 0, whose badge stays neutral. */
  paneAccent: boolean;
  paneFocused: boolean;
  /** project-groups FR-24: one further indent step under a nested project row. */
  nested: boolean;
  onClick: () => void;
  onContext: (x: number, y: number) => void;
}) {
  const [hover, setHover] = useState(false);
  // toneVar: the contract's STATUS_COLOR is the DARK palette (lib/tone.ts) — the
  // card's dot, tag and attention rail all hang off this one value.
  const statusColor = toneVar(STATUS_COLOR[session.status] ?? 'var(--text-dim)');
  const label = STATUS_LABEL[session.status] ?? session.status;
  const fileCount = derived?.fileCount ?? null;
  const agents = derived?.runningAgentCount ?? 0;
  // multi-account FR-32: nothing at all on the isDefault account, so the badge
  // always reads as "not the usual account".
  const accounts = useStore((s) => s.accounts);
  const accountBadge = sessionAccountBadge(accounts, session);

  // A parked session gets a left edge in its status colour: the dot is 6px and
  // easy to miss when the sidebar holds a dozen cards, and "which one is waiting
  // on me?" is the question this pane exists to answer.
  const attention = statusNeedsAttention(session.status);

  const classNames = ['sidebar-card'];
  if (selected) classNames.push('sidebar-card--selected');
  else if (hover) classNames.push('sidebar-card--hovered');
  if (cursor) classNames.push('sidebar-card--cursor');
  if (attention) classNames.push('sidebar-card--attention');
  // FR-22: the accent left rail marks the FOCUSED pane only — one accent per
  // view, and in split it belongs to whichever pane owns the keyboard.
  if (paneFocused) classNames.push('sidebar-card--pane-focus');
  // project-groups FR-24: one further indent step than the project row it sits under.
  if (nested) classNames.push('sidebar-card--nested');

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      title={session.status === 'error' ? session.errorMessage : (ATTENTION_TITLE[session.status] ?? undefined)}
      className={classNames.join(' ')}
      style={attention ? ({ '--card-attn': statusColor } as CSSProperties) : undefined}
    >
      {/* Row 1 — name, with the status dot + label right-aligned beside it */}
      <div className="sidebar-card__row1">
        <span className={selected ? 'sidebar-card__name sidebar-card__name--selected truncate' : 'sidebar-card__name truncate'}>
          {session.name}
        </span>
        {accountBadge && (
          <span className="acc-badge" title={accountBadge.title}>
            {accountBadge.text}
          </span>
        )}
        {/* cloud-sessions FR-16: where this session came FROM. Neutral, never
            accent — provenance is a fact, not a live state. */}
        {session.cloud && <CloudChip cloud={session.cloud} size="sm" />}
        {/* session-profiles FR-22: NEUTRAL here — the acid accent is reserved
            for the focused session's own welcome header (one accent per view). */}
        {session.profile && <ProfileChip profile={session.profile} size="sm" />}
        {/* split-by-4 FR-22: which pane is showing this session. */}
        {paneLabel && (
          <span className={paneAccent ? 'sidebar-card__pane sidebar-card__pane--accent' : 'sidebar-card__pane'}>
            {paneLabel}
          </span>
        )}
        <span className="sidebar-card__status" style={{ color: statusColor }}>
          <StatusDot color={statusColor} size={6} pulsing={statusPulses(session.status)} />
          {label}
        </span>
      </div>

      {/* Row 2 — cwd */}
      <div className="sidebar-card__cwd">{displayWslCwd(session.cwd) ?? abbreviate(session.cwd, home)}</div>

      {/* Row 3 — one meta line: model chip · token-usage bar · context · age
          (design-refresh FR-6 / the mock's card footer) */}
      <div className="sidebar-card__meta-row">
        <span className="sidebar-card__model">{session.model.label}</span>
        {session.contextLimitTokens > 0 ? (
          <span className="sidebar-card__bar-track">
            <span
              className="sidebar-card__bar-fill"
              style={{ width: `${Math.min(100, (session.contextUsedTokens / session.contextLimitTokens) * 100)}%` }}
            />
          </span>
        ) : (
          <span className="sidebar-card__spacer" />
        )}
        <ContextFigure used={session.contextUsedTokens} limit={session.contextLimitTokens} />
        <span className="sidebar-card__faint">{formatRelativeTime(session.lastActivityAt)}</span>
      </div>

      {/* session-worktree FR-13: branch glyph + name, on its own line so it never
          squeezes the meta row's usage bar. */}
      {session.worktree && (
        <div className="sidebar-card__branch" title={worktreeChipLabel(session.worktree)}>
          <span className="sidebar-card__branch-glyph">⎇</span> {truncateBranchLeft(worktreeChipLabel(session.worktree), 20)}
        </div>
      )}

      {/* Row 4 — only when there is something to say: running subagents and the
          uncommitted-file count (both from fleet-board's derived figures). */}
      {(agents > 0 || (fileCount != null && fileCount > 0)) && (
        <div className="sidebar-card__meta-row">
          {agents > 0 && (
            <span className="sidebar-card__agents">
              ⇉ {agents} {agents === 1 ? 'agent' : 'agents'}
            </span>
          )}
          {fileCount != null && fileCount > 0 && (
            <span className="sidebar-card__files">
              <span className="sidebar-card__faint">≡</span>
              <BadgePill>{fileCount}</BadgePill>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
