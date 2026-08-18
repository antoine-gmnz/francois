import { useRef } from 'react';
import type { ProjectId } from '../../../contract/common';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { shellPaneEligibleProjects } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';
import './project-picker.css';

export interface ProjectPickerPopoverProps {
  onPick: (projectId: ProjectId) => void;
  onClose: () => void;
}

/**
 * unbound-panes FR-9/design brief — the project picker an "open a shell here"
 * entry point offers. Every registered project with a live root, under its
 * per-owner shell cap (edge case 4); picking one closes the popover.
 */
export default function ProjectPickerPopover({ onPick, onClose }: ProjectPickerPopoverProps) {
  const allProjects = useStore((s) => s.projects);
  const extraPanes = useStore((s) => s.extraPanes);
  // Derived in render, never inside the selector: zustand v5 compares the
  // selector result by reference, and `.filter` hands back a fresh array on
  // every call — which is an infinite re-render, not a stale read.
  const projects = shellPaneEligibleProjects(allProjects, extraPanes);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, { onEscape: onClose, onOutsideClick: onClose });

  return (
    <div ref={ref} className="project-picker" onClick={(e) => e.stopPropagation()}>
      {projects.length === 0 ? (
        <div className="project-picker__empty">no registered projects</div>
      ) : (
        projects.map((p) => (
          <div
            key={p.id}
            className="project-picker__item"
            onClick={() => {
              onPick(p.id);
              onClose();
            }}
          >
            {p.name}
          </div>
        ))
      )}
    </div>
  );
}
