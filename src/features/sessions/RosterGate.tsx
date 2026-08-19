// The roster's scroll container and its four "there is nothing to paint" states.
// Extracted from SessionListBody at design 12b: the pane now has TWO bodies
// (grouped by state, grouped by repo) and exactly one set of hydration/empty
// states, which belong to neither of them.

import type { ReactNode } from 'react';
import type { AppError, ProjectId } from '../../../contract/common';
import type { ProjectMeta } from '../../../contract/projects';
import { EmptyPane } from '../../ui/EmptyPane';
import { filteredEmptyLabel } from '../projects/projects';
import './sidebar.css';

export interface RosterGateProps {
  hydrationError: AppError | null;
  onRetry: () => void;
  /** Sessions in the cache, before any filtering. */
  sessionCount: number;
  activeProjectId: ProjectId | null;
  /** Sessions in the active project's scope, before the '/' filter. */
  inProjectCount: number;
  activeProject: ProjectMeta | null;
  /** Rows the body would actually paint — 0 with a filter typed means "no matches". */
  visibleCount: number;
  children: ReactNode;
}

export function RosterGate({
  hydrationError,
  onRetry,
  sessionCount,
  activeProjectId,
  inProjectCount,
  activeProject,
  visibleCount,
  children,
}: RosterGateProps): JSX.Element {
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
      ) : visibleCount === 0 ? (
        <EmptyPane className="sidebar-empty">no matches · esc to clear</EmptyPane>
      ) : (
        children
      )}
    </div>
  );
}
