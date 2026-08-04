// projects — the scope dropdown itself (FR-25/FR-26; re-anchored by
// titlebar-project-switcher FR-9): the "All projects | <name>" rows plus the
// "Manage projects…" action, mounted under ProjectSwitcher — the app's only
// project control.
//
// The parent owns `open` and dismissal (it owns the ref that contains both the
// trigger and this panel); this component owns the registry read, the rows and
// the selection. Selecting a scope LANDS you inside it (FR-39, superseding
// FR-28) — the store's switchProject owns that, this component only names the
// scope that was picked.

import { useEffect, useState } from 'react';
import { buildSwitcherRows, abbreviateRoot, safeCall } from './projects';
import { projectList } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useMounted } from '../../lib/hooks/useMounted';
import { ListRow } from '../../ui/ListRow';
import './projects.css';

export default function ProjectMenu({ home, onClose }: { home: string; onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const switchProject = useStore((s) => s.switchProject);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
  const mounted = useMounted();

  // Never trust a cached registry: the panel is mounted only while open, so this
  // mount-once read IS the "re-read on every open" of FR-2/FR-32 (`rootExists` is
  // derived per list).
  useEffect(() => {
    void safeCall(projectList()).then((res) => {
      if (mounted.current && res.ok) setProjects(res.data);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = buildSwitcherRows(projects, activeProjectId);

  return (
    // stopPropagation: the panel can sit inside a pane that claims focus on click.
    <div onClick={(e) => e.stopPropagation()} className="pjsw-dropdown">
      {/* The listbox is ONLY the selectable scopes — the manage action below is
          a sibling, so it is never announced as an option. The scroll cap lives
          here rather than on the panel so that action can't scroll out of reach. */}
      <div role="listbox" className="scz pjsw-listbox">
        {rows.map((r) => (
          <Row
            key={r.id ?? '__all__'}
            role="option"
            selected={r.selected}
            onClick={() => {
              // Close FIRST: an empty project opens the new-session modal, and
              // the dropdown must not still be layered under it.
              onClose();
              switchProject(r.id);
            }}
          >
            <span className="pjsw-row-mark">{r.mark}</span>
            {/* The NAME is the primary information: it takes the slack and is
                the last thing to be truncated. */}
            <span className={`truncate pjsw-row-name${r.missing ? ' pjsw-row-name--missing' : ''}`}>{r.name}</span>
            {r.missing && <span className="pj-missing-tag">missing</span>}
            {/* The root is secondary: it shrinks and ellipsizes first, and is
                capped so a deep path can never crowd out the name. */}
            <span className="truncate pjsw-row-root">{abbreviateRoot(r.root, home)}</span>
          </Row>
        ))}
      </div>

      {/* Outside the listbox on purpose: it is an ACTION, not one of the
          selectable scopes, so it must not be announced as an option. */}
      <div className="pjsw-divider" />
      <Row
        role="button"
        onClick={() => {
          onClose();
          setProjectsOpen(true);
        }}
      >
        <span className="pjsw-manage-label">Manage projects…</span>
      </Row>
    </div>
  );
}

function Row({
  children,
  onClick,
  role,
  selected,
}: {
  children: React.ReactNode;
  onClick: () => void;
  role: 'option' | 'button';
  selected?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <ListRow
      role={role}
      // Only an `option` carries selection state; hardcoding false here meant the
      // active scope (the one wearing the ✦) was announced as unselected.
      aria-selected={role === 'option' ? !!selected : undefined}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      hovered={hover}
      className="pjsw-row"
    >
      {children}
    </ListRow>
  );
}
