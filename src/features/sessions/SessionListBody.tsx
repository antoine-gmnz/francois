import { useState } from 'react';
import type { AppError, ProjectId, SessionMeta } from '../../../contract/common';
import type { ProjectMeta } from '../../../contract/projects';
import { STATUS_COLOR, STATUS_LABEL, formatRelativeTime, statusPulses, type SessionDerived } from '../../../contract/fleet-board';
import { formatContextTokens } from '../../../contract/conversation-view';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import { abbreviate } from '../../lib/path';
import { BadgePill } from '../../ui/BadgePill';
import { EmptyPane } from '../../ui/EmptyPane';
import { StatusDot } from '../../ui/StatusDot';
import { filteredEmptyLabel } from '../projects/projects';
import './sidebar.css';

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
        visible.map((session, i) => (
          <SessionCard
            key={session.id}
            session={session}
            home={home}
            selected={session.id === activeSessionId}
            cursor={focused && i === rowCursor}
            derived={derived.get(session.id)}
            onClick={() => onSelect(session.id)}
            onContext={(x, y) => onContext(session.id, x, y)}
          />
        ))
      )}
    </div>
  );
}

function ContextFigure({ used, limit }: { used: number; limit: number }) {
  if (limit <= 0) {
    if (used <= 0) return <span className="sidebar-card__faint">—</span>;
    return <span className="sidebar-card__meta">{formatContextTokens(used)}</span>;
  }
  return (
    <>
      <span className="sidebar-card__meta">{formatContextTokens(used)}</span>
      <span className="sidebar-card__faint">/{formatContextTokens(limit)}</span>
    </>
  );
}

function SessionCard({
  session,
  home,
  selected,
  cursor,
  derived,
  onClick,
  onContext,
}: {
  session: SessionMeta;
  home: string;
  selected: boolean;
  cursor: boolean;
  derived: SessionDerived | undefined;
  onClick: () => void;
  onContext: (x: number, y: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const statusColor = STATUS_COLOR[session.status] ?? 'var(--text-dim)';
  const label = STATUS_LABEL[session.status] ?? session.status;
  const fileCount = derived?.fileCount ?? null;
  const agents = derived?.runningAgentCount ?? 0;

  const classNames = ['sidebar-card'];
  if (selected) classNames.push('sidebar-card--selected');
  else if (hover) classNames.push('sidebar-card--hovered');
  if (cursor) classNames.push('sidebar-card--cursor');

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      title={session.status === 'error' ? session.errorMessage : undefined}
      className={classNames.join(' ')}
    >
      {/* Row 1 — header: dot + name + relative time */}
      <div className="sidebar-card__row1">
        <StatusDot color={statusColor} pulsing={statusPulses(session.status)} />
        <span className={selected ? 'sidebar-card__name sidebar-card__name--selected' : 'sidebar-card__name'}>
          {session.name}
        </span>
        <span className="sidebar-card__time">{formatRelativeTime(session.lastActivityAt)}</span>
      </div>

      {/* Row 2 — cwd */}
      <div className="sidebar-card__cwd">{displayWslCwd(session.cwd) ?? abbreviate(session.cwd, home)}</div>

      {/* Row 3 — status line */}
      <div className="sidebar-card__status" style={{ color: statusColor }}>
        {label} · {session.model.label}
      </div>

      {/* Row 4 — meta: context + diff badge + agent count */}
      <div className="sidebar-card__meta-row">
        <span>
          <span className="sidebar-card__faint">ctx </span>
          <ContextFigure used={session.contextUsedTokens} limit={session.contextLimitTokens} />
        </span>
        {fileCount != null && fileCount > 0 && (
          <span className="sidebar-card__files">
            <span className="sidebar-card__faint">≡</span>
            <BadgePill>{fileCount}</BadgePill>
          </span>
        )}
        {agents > 0 && <span className="sidebar-card__agents">⇉ {agents}</span>}
      </div>
    </div>
  );
}
