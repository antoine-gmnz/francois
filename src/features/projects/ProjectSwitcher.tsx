// projects — the title-bar project switcher (titlebar-project-switcher FR-1..FR-11).
// Mounted inside UsageBar's `.titlebar-brand` cluster, this is the app's ONLY
// project control: the label reads the active project's name (or "All
// projects"), the leading dot carries scope state (FR-5), and the `▾` opens
// ProjectMenu — the shared "All projects | <name> | Manage projects…" panel
// (also used to, but no longer — see ProjectMenu's own header for the shared
// history). Selecting a project NEVER touches activeSessionId (FR-28, owned by
// ProjectMenu).

import { useRef, useState } from 'react';
import ProjectMenu from './ProjectMenu';
import { switcherDotTone, switcherLabel, switcherTooltip } from './projects';
import { useProjectRegistrySync } from './useProjectRegistrySync';
import { useStore } from '../../lib/store';
import { useDismiss } from '../../lib/hooks/useDismiss';
import './projects.css';

export default function ProjectSwitcher({ home, sessionCwd }: { home: string; sessionCwd: string | null }) {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const dismissRef = useRef<HTMLDivElement>(null);

  // Keeps the label and the dropdown true after a modal write; the open panel
  // refreshes itself too (ProjectMenu), and UsageBar is always mounted so this
  // IS the app's project-registry load (FR-11).
  useProjectRegistrySync();

  // Escape / outside click close the dropdown (§8 interactions, FR-10).
  useDismiss(dismissRef, {
    onEscape: () => setOpen(false),
    onOutsideClick: () => setOpen(false),
    enabled: open,
  });

  const active = projects.find((p) => p.id === activeProjectId) ?? null;
  const tone = switcherDotTone(active);
  const tooltip = switcherTooltip(active, sessionCwd, home);

  return (
    <div ref={dismissRef} className="titlebar-path-wrap">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={tooltip || undefined}
        className={hover ? 'titlebar-path titlebar-path--hover' : 'titlebar-path'}
      >
        <span className={`titlebar-path-dot titlebar-path-dot--${tone}`} />
        <span className="truncate titlebar-path-text">{switcherLabel(active)}</span>
        <span className="titlebar-path-caret">▾</span>
      </button>

      {open && <ProjectMenu home={home} onClose={() => setOpen(false)} />}
    </div>
  );
}
