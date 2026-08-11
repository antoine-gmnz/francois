import { ChevronsRight, Plus } from 'lucide-react';
import { useMemo } from 'react';
import type { SessionId } from '../../contract/common';
import { STATUS_COLOR, statusPulses } from '../../contract/fleet-board';
import { filterSessionsByProject } from '../../contract/projects';
import { focusedSessionId, paneIndexOf } from '../lib/layoutStore';
import { useStore } from '../lib/store';

export interface SessionRailProps {
  /** FR-6: a tile assigns its session to the focused pane. */
  onSelect: (id: SessionId) => void;
}

/**
 * split-by-4 FR-6 / design turn 5d — the 46px rail the roster folds to in the
 * grid chrome. One 30px tile per in-scope session carrying its first two
 * characters and a status dot; the tiles a pane is showing are raised, and the
 * FOCUSED pane's carries the accent left rail (one accent per view).
 *
 * `»` reopens the full roster — the same thing `[` does, so the two agree.
 */
export default function SessionRail({ onSelect }: SessionRailProps) {
  const sessions = useStore((s) => s.sessions);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const focusedId = useStore((s) => focusedSessionId(s));
  // Subscribed as PRIMITIVES, not as a derived closure: a selector returning a
  // fresh function re-renders this rail on every unrelated store write.
  const activeSessionId = useStore((s) => s.activeSessionId);
  const extraPanes = useStore((s) => s.extraPanes);
  const paneOf = (id: SessionId) => paneIndexOf({ activeSessionId, mainTab: 'session', extraPanes }, id);
  const toggleLeftPane = useStore((s) => s.toggleLeftPane);
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);

  const inScope = useMemo(
    () => filterSessionsByProject(sessions, activeProjectId),
    [sessions, activeProjectId],
  );

  return (
    <aside className="session-rail">
      {inScope.map((session) => {
        const pane = paneOf(session.id);
        const color = STATUS_COLOR[session.status] ?? 'var(--text-dim)';
        return (
          <button
            key={session.id}
            type="button"
            className={
              [
                'session-rail__tile',
                pane !== null ? 'session-rail__tile--paned' : null,
                session.id === focusedId ? 'session-rail__tile--focused' : null,
              ]
                .filter(Boolean)
                .join(' ')
            }
            title={pane === null ? session.name : `${session.name} · pane ${pane + 1}`}
            onClick={() => onSelect(session.id)}
          >
            {session.name.slice(0, 2)}
            <span
              className={statusPulses(session.status) ? 'session-rail__dot session-rail__dot--live' : 'session-rail__dot'}
              style={{ background: color }}
            />
          </button>
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
