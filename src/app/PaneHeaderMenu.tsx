import { MoreHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ProjectId } from '../../contract/common';
import ProjectPickerPopover from '../features/projects/ProjectPickerPopover';
import { useDismiss } from '../lib/hooks/useDismiss';
import { paneCount, shellPaneEligibleProjects } from '../lib/layoutStore';
import { useStore } from '../lib/store';
import { paneMenuEntries, type PaneMenuEntry } from './appShell';

export interface PaneHeaderMenuProps {
  index: number;
  /** Which shape of pane this header belongs to — `convert` is absent on a shell. */
  kind: 'session' | 'shell';
  /** unbound-panes FR-9: turn THIS pane into a shell pane rooted at `projectId`. */
  onConvertToShell?: (projectId: ProjectId) => void;
}

/**
 * unbound-panes FR-9 / design brief flow 4 — the pane header's `⋯` hover menu:
 * *Convert to shell…* and *Open a shell pane beside…*, both routing through the
 * same project picker (skipped when exactly one project is registered, as
 * everywhere else).
 *
 * Renders NOTHING when `paneMenuEntries` comes back empty — a `⋯` that opens
 * onto an empty menu is worse than no `⋯` at all. That covers "no registered
 * project" and, on pane 0 of a full grid, "neither entry applies".
 */
export default function PaneHeaderMenu({ index, kind, onConvertToShell }: PaneHeaderMenuProps) {
  const panes = useStore((s) => paneCount(s));
  const allProjects = useStore((s) => s.projects);
  const extraPanes = useStore((s) => s.extraPanes);
  // Derived in render, never inside the selector: zustand v5 compares the
  // selector result by reference, and `.filter` hands back a fresh array on
  // every call — which is an infinite re-render, not a stale read.
  const projects = shellPaneEligibleProjects(allProjects, extraPanes);
  const openShellPane = useStore((s) => s.openShellPane);
  const [open, setOpen] = useState(false);
  // Which entry the picker that is currently up will answer for; null ⇒ no picker.
  const [picking, setPicking] = useState<PaneMenuEntry['id'] | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  useDismiss(ref, {
    onEscape: () => {
      setOpen(false);
      setPicking(null);
    },
    onOutsideClick: () => {
      setOpen(false);
      setPicking(null);
    },
    enabled: open,
  });

  const entries = paneMenuEntries(index, kind, panes, projects.length);
  if (entries.length === 0) return null;

  const dispatch = (id: PaneMenuEntry['id'], projectId: ProjectId) => {
    if (id === 'convert-to-shell') onConvertToShell?.(projectId);
    else openShellPane(projectId);
    setOpen(false);
    setPicking(null);
  };

  const choose = (id: PaneMenuEntry['id']) => {
    // One registered project is a question with one answer — skip the picker.
    if (projects.length === 1) dispatch(id, projects[0].id);
    else setPicking(id);
  };

  return (
    // stopPropagation throughout: the pane's own click handler would otherwise
    // re-focus this pane after the action has already moved focus elsewhere.
    <span ref={ref} className="split-pane__menu" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="split-pane__promote split-pane__menu-btn"
        title="Pane actions"
        onClick={() => {
          setOpen((o) => !o);
          setPicking(null);
        }}
      >
        <MoreHorizontal size={12} strokeWidth={1.75} />
      </button>
      {open &&
        (picking !== null ? (
          <ProjectPickerPopover onPick={(projectId) => dispatch(picking, projectId)} onClose={() => setPicking(null)} />
        ) : (
          <div className="split-pane__menu-list">
            {entries.map((entry) => (
              <button key={entry.id} type="button" className="split-pane__menu-item" onClick={() => choose(entry.id)}>
                {entry.label}
              </button>
            ))}
          </div>
        ))}
    </span>
  );
}
