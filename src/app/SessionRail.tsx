import { ChevronsRight, Plus } from 'lucide-react';
import { Fragment, useMemo } from 'react';
import type { SessionId } from '../../contract/common';
import { STATUS_COLOR, statusPulses } from '../../contract/fleet-board';
import { projectMarker } from '../features/projects/projectMarker';
import { focusedSessionId, paneIndicesOf, railOrder, railPinnedCount } from '../lib/layoutStore';
import { useStore } from '../lib/store';
import { toneVar } from '../lib/tone';

export interface SessionRailProps {
  /** FR-6: a tile assigns its session to the focused pane. */
  onSelect: (id: SessionId) => void;
}

/**
 * split-by-4 FR-6 / design turn 5d — the 46px rail the roster folds to in the
 * grid chrome. One 30px tile per FLEET session (unbound-panes FR-15: the rail
 * is no longer project-scoped) carrying its first two characters, a status dot
 * and its project's neutral marker; the tiles a pane is showing are pinned to
 * the top behind a 1px hairline, and the FOCUSED pane's carries the accent rail.
 *
 * `»` reopens the full roster — the same thing `[` does, so the two agree.
 */
export default function SessionRail({ onSelect }: SessionRailProps) {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const focusedId = useStore((s) => focusedSessionId(s));
  // Subscribed as PRIMITIVES, not as a derived closure: a selector returning a
  // fresh function re-renders this rail on every unrelated store write.
  const activeSessionId = useStore((s) => s.activeSessionId);
  const extraPanes = useStore((s) => s.extraPanes);
  const panesOf = (id: SessionId) => paneIndicesOf({ activeSessionId, mainTab: 'session', extraPanes }, id);
  const toggleLeftPane = useStore((s) => s.toggleLeftPane);
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);

  // unbound-panes FR-15: the WHOLE fleet, paned sessions pinned to the top.
  const paned = useMemo(
    () => sessions.filter((s) => panesOf(s.id).length > 0).map((s) => s.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, activeSessionId, extraPanes],
  );
  const ordered = useMemo(() => railOrder(sessions, paned), [sessions, paned]);
  // design brief: the pinned block is separated from the rest by a 1px hairline.
  // 0 ⇒ nothing pinned, or everything is — either way there is no seam to draw.
  const pinnedCount = useMemo(() => railPinnedCount(sessions, paned), [sessions, paned]);

  return (
    <aside className="session-rail">
      {ordered.map((session, i) => {
        const panes = panesOf(session.id);
        const color = toneVar(STATUS_COLOR[session.status] ?? 'var(--text-dim)');
        const project = session.projectId ? projects.find((p) => p.id === session.projectId) : undefined;
        return (
          <Fragment key={session.id}>
            {/* The seam sits BEFORE the first unpinned tile, as its own flex
                item — never overlaid on a tile. */}
            {pinnedCount > 0 && i === pinnedCount && <span className="session-rail__hairline" />}
            <button
              type="button"
              className={
                [
                  'session-rail__tile',
                  panes.length > 0 ? 'session-rail__tile--paned' : null,
                  session.id === focusedId ? 'session-rail__tile--focused' : null,
                ]
                  .filter(Boolean)
                  .join(' ')
              }
              title={panes.length === 0 ? session.name : `${session.name} · pane ${panes.map((p) => p + 1).join('·')}`}
              onClick={() => onSelect(session.id)}
            >
              {session.name.slice(0, 2)}
              <span
                className={
                  statusPulses(session.status) ? 'session-rail__dot session-rail__dot--live' : 'session-rail__dot'
                }
                style={{ background: color }}
              />
              {/* unbound-panes FR-14: the neutral project marker, never accent. */}
              {project && (
                <span className="session-rail__marker" title={project.name}>
                  {projectMarker(project.name)}
                </span>
              )}
            </button>
          </Fragment>
        );
      })}
      <span className="app-flex-spacer" />
      <button
        type="button"
        className="session-rail__new"
        title="New session · n"
        onClick={() => setNewSessionOpen(true)}
      >
        <Plus size={14} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="session-rail__expand"
        title="Reopen the roster · ["
        onClick={toggleLeftPane}
      >
        <ChevronsRight size={13} strokeWidth={1.75} />
      </button>
    </aside>
  );
}
