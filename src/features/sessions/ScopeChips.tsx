// The roster's project scope row — redesign "Graphite & Signal", Figma "Sidebar /
// Sessions" (127:28), "Project scope". It replaces the title-bar project switcher
// as the app's project control: `All` widens to every project (the store's
// switchProject(null) — which also lands OVERVIEW, as before), a project chip
// scopes to it (landing inside it, projects FR-39), and `+N ▾` opens the project
// scope picker (Figma "24 · Sidebar / Project scope picker", 134:4687) — search,
// Pinned / Active now / groups, pins, and "Manage projects…".
//
// Mounted for the app's lifetime (the roster is hidden, never unmounted), so it
// also owns the project-registry load the switcher used to (FR-11).

import { useLayoutEffect, useRef, useState } from 'react';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { useProjectPins } from '../../lib/projectPinsStore';
import { useStore } from '../../lib/store';
import { Icon } from '../../ui/Icon';
import { StateIcon } from '../../ui/StateIcon';
import { useProjectRegistrySync } from '../projects/useProjectRegistrySync';
import { ProjectScopePicker } from './ProjectScopePicker';
import { scopeChips } from './scope-chips';

/** The picker's width (Figma 134:4687), for keeping it inside the window. */
const PICKER_WIDTH = 304;

/** Projects shown as their own chip before the rest fold into `+N`. */
const MAX_PROJECT_CHIPS = 2;

// `home` was the old ProjectMenu's path abbreviation; the picker shows no paths.
export function ScopeChips(_props: { home: string }) {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const switchProject = useStore((s) => s.switchProject);
  const pinned = useProjectPins((s) => s.pinnedProjectIds);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useProjectRegistrySync();
  useDismiss(menuRef, { onEscape: () => setOpen(false), onOutsideClick: () => setOpen(false), enabled: open });

  const view = scopeChips(projects, sessions, activeProjectId, MAX_PROJECT_CHIPS, pinned);

  // The picker opens under the whole chip row, left-aligned to it (it is wider
  // than the trigger), and is kept inside the window.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const r = rowRef.current?.getBoundingClientRect();
      if (r) setPosition({ left: Math.max(8, Math.min(r.left - 8, window.innerWidth - PICKER_WIDTH - 8)), top: r.bottom + 6 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  return (
    <div ref={rowRef} className="scope-chips" role="toolbar" aria-label="project scope">
      <button
        type="button"
        className={activeProjectId === null ? 'scope-chip scope-chip--on' : 'scope-chip'}
        title="All projects"
        onClick={() => switchProject(null)}
      >
        All <span className="scope-chip__count">{view.total}</span>
      </button>
      {view.chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          className={activeProjectId === chip.id ? 'scope-chip scope-chip--on' : 'scope-chip'}
          title={chip.attention ? `${chip.name} — a session needs you` : chip.name}
          onClick={() => switchProject(chip.id)}
        >
          <span className="scope-chip__name truncate">{chip.name}</span>
          {chip.attention && <StateIcon kind="approval" size={10} />}
          <span className="scope-chip__count">{chip.count}</span>
        </button>
      ))}
      {/* Always present: the picker is also where projects are pinned and managed. */}
      {(
        <div ref={menuRef} className="scope-chips__more">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            className={open ? 'scope-chip scope-chip--open' : 'scope-chip'}
            title="All projects · manage projects"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            {view.overflow > 0 ? `+${view.overflow}` : projects.length === 0 ? 'Projects' : null}
            <Icon name="chevron-down" size={9} />
          </button>
          {open && <ProjectScopePicker position={position} onClose={() => setOpen(false)} />}
        </div>
      )}
    </div>
  );
}
