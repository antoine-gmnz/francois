import { Fragment, useMemo } from 'react';
import type { SessionId } from '../../contract/common';
import { statusNeedsAttention } from '../../contract/fleet-board';
import { focusedSessionId, paneIndicesOf, railOrder, railPinnedCount } from '../lib/layoutStore';
import { useStore } from '../lib/store';
import { Icon } from '../ui/Icon';
import { StateIcon } from '../ui/StateIcon';
import './session-rail.css';

export interface SessionRailProps {
  /** FR-6: a tile assigns its session to the focused pane. */
  onSelect: (id: SessionId) => void;
}

/**
 * The folded roster — redesign "Graphite & Signal", Figma "Sidebar / Rail"
 * (128:68): a 56px rail with the ivory `+` on top, then one 34px tile per FLEET
 * session (unbound-panes FR-15) carrying its first two characters and its State
 * glyph in the corner. A session blocked on you takes the attention wash; the
 * tiles a pane is showing are pinned to the top (split-by-4 FR-6) and raised,
 * and the FOCUSED pane's carries the edge marker. The panel-left glyph at the
 * foot reopens the full roster — the same thing `[` does.
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
  // 0 ⇒ nothing pinned, or everything is — either way there is no seam to draw.
  const pinnedCount = useMemo(() => railPinnedCount(sessions, paned), [sessions, paned]);

  return (
    <aside className="session-rail">
      <button type="button" className="session-rail__new" title="New session · n" onClick={() => setNewSessionOpen(true)}>
        <Icon name="plus" size={14} />
      </button>
      <span className="session-rail__divider" />
      {ordered.map((session, i) => {
        const panes = panesOf(session.id);
        const project = session.projectId ? projects.find((p) => p.id === session.projectId) : undefined;
        const title = [session.name, project?.name, panes.length > 0 ? `pane ${panes.map((p) => p + 1).join('·')}` : null]
          .filter(Boolean)
          .join(' · ');
        return (
          <Fragment key={session.id}>
            {/* The seam sits BEFORE the first unpinned tile, as its own flex item. */}
            {pinnedCount > 0 && i === pinnedCount && <span className="session-rail__hairline" />}
            <button
              type="button"
              className={[
                'session-rail__tile',
                statusNeedsAttention(session.status) ? 'session-rail__tile--attention' : null,
                panes.length > 0 ? 'session-rail__tile--paned' : null,
                session.id === focusedId ? 'session-rail__tile--focused' : null,
              ]
                .filter(Boolean)
                .join(' ')}
              title={title}
              onClick={() => onSelect(session.id)}
            >
              {session.name.slice(0, 2)}
              <span className="session-rail__badge">
                <StateIcon status={session.status} size={12} />
              </span>
            </button>
          </Fragment>
        );
      })}
      <span className="app-flex-spacer" />
      <button type="button" className="session-rail__expand" title="Expand the sidebar · [" onClick={toggleLeftPane}>
        <Icon name="panel-left" size={14} />
      </button>
    </aside>
  );
}
