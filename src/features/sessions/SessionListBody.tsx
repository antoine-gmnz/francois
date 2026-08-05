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
import type { SplitSide } from '../../lib/layoutStore';
import { abbreviate } from '../../lib/path';
import { useStore } from '../../lib/store';
import { BadgePill } from '../../ui/BadgePill';
import { EmptyPane } from '../../ui/EmptyPane';
import { StatusDot } from '../../ui/StatusDot';
import { sessionAccountBadge } from '../accounts/accounts';
import { filteredEmptyLabel } from '../projects/projects';
import { truncateBranchLeft } from './worktree';
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
  visible: SessionMeta[];
  home: string;
  activeSessionId: string | null;
  focused: boolean;
  rowCursor: number;
  derived: ReadonlyMap<string, SessionDerived>;
  onSelect: (id: string) => void;
  onContext: (sessionId: string, x: number, y: number) => void;
  /** split-session FR-15: the RIGHT pane's session — drives the left/right badges. */
  splitSessionId?: string | null;
  focusedSide?: SplitSide;
}

/** FR-15: which pane, if any, is showing this row's session. */
function paneOf(sessionId: string, activeSessionId: string | null, splitSessionId: string | null): SplitSide | null {
  if (splitSessionId === null) return null; // not split — no badges at all
  if (sessionId === splitSessionId) return 'right';
  return sessionId === activeSessionId ? 'left' : null;
}

/** Pane [1]'s scrollable card list, plus its hydration-error / empty states. */
export function SessionListBody({
  hydrationError,
  onRetry,
  sessionCount,
  activeProjectId,
  inProjectCount,
  activeProject,
  visible,
  home,
  activeSessionId,
  focused,
  rowCursor,
  derived,
  onSelect,
  onContext,
  splitSessionId = null,
  focusedSide = 'left',
}: SessionListBodyProps): JSX.Element {
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
      ) : visible.length === 0 ? (
        <EmptyPane className="sidebar-empty">no matches · esc to clear</EmptyPane>
      ) : (
        visible.map((session, i) => {
          // FR-15: both paned rows render the selected treatment; only the
          // FOCUSED side's row carries the accent left rail.
          const pane = paneOf(session.id, activeSessionId, splitSessionId);
          return (
            <SessionCard
              key={session.id}
              session={session}
              home={home}
              selected={pane !== null || session.id === activeSessionId}
              cursor={focused && i === rowCursor}
              derived={derived.get(session.id)}
              pane={pane}
              paneFocused={pane !== null && pane === focusedSide}
              onClick={() => onSelect(session.id)}
              onContext={(x, y) => onContext(session.id, x, y)}
            />
          );
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
  pane,
  paneFocused,
  onClick,
  onContext,
}: {
  session: SessionMeta;
  home: string;
  selected: boolean;
  cursor: boolean;
  derived: SessionDerived | undefined;
  /** split-session FR-15: which split pane shows this session, or null. */
  pane: SplitSide | null;
  paneFocused: boolean;
  onClick: () => void;
  onContext: (x: number, y: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const statusColor = STATUS_COLOR[session.status] ?? 'var(--text-dim)';
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
  // FR-15: the accent left rail marks the FOCUSED side only — one accent per
  // view, and in split it belongs to whichever pane owns the keyboard.
  if (paneFocused) classNames.push('sidebar-card--pane-focus');

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
        {/* split-session FR-15: which pane is showing this session. */}
        {pane && <span className={`sidebar-card__pane sidebar-card__pane--${pane}`}>{pane}</span>}
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
        <div className="sidebar-card__branch" title={session.worktree.branch}>
          <span className="sidebar-card__branch-glyph">⎇</span> {truncateBranchLeft(session.worktree.branch, 20)}
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
