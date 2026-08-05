// split-session FR-9/FR-10 — the titlebar's layout control: `▯` single and
// `▯▯` split, a two-button segmented pill after the quota cluster. This and the
// sidebar context menu's "Open in right pane" are the feature's ONLY two entry
// points (palette/keyboard/drag entries are explicit non-goals).

import { useMemo } from 'react';
import { Columns2, Square } from 'lucide-react';
import { filterSessionsByProject } from '../../../contract/projects';
import { splitCandidate } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';

const ICON = { size: 12, strokeWidth: 1.75 } as const;

export default function LayoutToggle(): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const splitSessionId = useStore((s) => s.splitSessionId);
  const openInRightPane = useStore((s) => s.openInRightPane);
  const setFocusedSide = useStore((s) => s.setFocusedSide);
  const unsplit = useStore((s) => s.unsplit);

  const split = splitSessionId !== null;

  const inScope = useMemo(() => filterSessionsByProject(sessions, activeProjectId), [sessions, activeProjectId]);
  // FR-9: at All-projects scope there is no "in scope" to split within — the
  // main pane belongs to OVERVIEW there (FR-14).
  const candidate = activeProjectId === null ? null : splitCandidate(inScope, activeSessionId);
  const disabled = !split && candidate === null;
  const splitTitle = split
    ? 'Split view'
    : disabled
      ? activeProjectId === null
        ? 'Split needs a project in scope — pick one first'
        : 'Split needs a second session in this project'
      : 'Split view';

  const openSplit = () => {
    if (split || !candidate) return;
    openInRightPane(candidate.id);
    // §3 flow 1: `▯▯` opens the other session on the right but leaves the LEFT
    // pane focused — you were mid-thought in it. (The context menu, which names
    // a session on purpose, focuses the right instead — FR-11.)
    setFocusedSide('left');
  };

  return (
    <>
      <span className="titlebar-divider" />
      <div className="layout-toggle">
        <button
          type="button"
          className={split ? 'layout-toggle__btn' : 'layout-toggle__btn layout-toggle__btn--on'}
          aria-pressed={!split}
          title="Single pane"
          onClick={() => unsplit()}
        >
          <Square {...ICON} />
        </button>
        <button
          type="button"
          className={
            split
              ? 'layout-toggle__btn layout-toggle__btn--on'
              : disabled
                ? 'layout-toggle__btn layout-toggle__btn--disabled'
                : 'layout-toggle__btn'
          }
          aria-pressed={split}
          aria-disabled={disabled}
          title={splitTitle}
          onClick={openSplit}
        >
          <Columns2 {...ICON} />
        </button>
      </div>
    </>
  );
}
