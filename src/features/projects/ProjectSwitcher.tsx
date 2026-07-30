// projects — the pane [1] switcher strip + dropdown (FR-25/FR-26).
// A 26px row pinned under the SESSIONS header, above the fleet board's cards:
// it reads "▾ All projects" or "▾ <name>" and filters the board to one project.
// Selecting a project NEVER touches activeSessionId (FR-28) — the board's own
// effect resets only its keyboard cursor.

import { useEffect, useRef, useState } from 'react';
import { buildSwitcherRows, abbreviateRoot, safeCall, switcherLabel } from './projects';
import { projectList } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useMounted } from '../../lib/hooks/useMounted';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { ListRow } from '../../ui/ListRow';
import './projects.css';

export default function ProjectSwitcher({ home }: { home: string }) {
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProjectId = useStore((s) => s.setActiveProjectId);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const mounted = useMounted();
  const dismissRef = useRef<HTMLDivElement>(null);

  // Never trust a cached registry: read on mount, on every dropdown open, and
  // whenever the modal closes (rootExists is derived per list — FR-2/FR-32).
  const refresh = () => {
    void safeCall(projectList()).then((res) => {
      if (mounted.current && res.ok) setProjects(res.data);
    });
  };

  // The modal is the only other writer of the registry; re-read when it closes.
  // This also covers the initial load — its first run fires on mount — so there is
  // deliberately no separate mount fetch (that duplicated every read, ×2 again under
  // StrictMode: four project_list calls per app start).
  useEffect(() => {
    if (!projectsOpen) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsOpen]);

  // Escape / outside click close the dropdown (§8 interactions).
  useDismiss(dismissRef, {
    onEscape: () => setOpen(false),
    onOutsideClick: () => setOpen(false),
    enabled: open,
  });

  const active = projects.find((p) => p.id === activeProjectId) ?? null;
  const rows = buildSwitcherRows(projects, activeProjectId);
  const filtered = active !== null;

  return (
    <div ref={dismissRef} className="pjsw-root">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) refresh();
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={hover ? 'pjsw-toggle pjsw-toggle--hover' : 'pjsw-toggle'}
      >
        {/* The mock's `▾` (U+25BE, the SMALL triangle) carries almost no ink in
            JetBrains Mono — at 8px it reads as a stray period rather than a
            disclosure control. U+25BC at 8px is the same visual weight the mock
            intended, and holds up in both themes. */}
        <span className={filtered ? 'pjsw-glyph pjsw-glyph--filtered' : 'pjsw-glyph'}>▼</span>
        <span
          className="truncate pjsw-label"
          style={{ color: filtered ? 'var(--accent)' : hover ? 'var(--text-bright)' : 'var(--text-dim)' }}
        >
          {switcherLabel(active)}
        </span>
        {/* Mirrors the pane header's own `<count> · [1]` grammar, so the row
            reads as a control that has contents. Hidden while empty. */}
        {projects.length > 0 && (
          <>
            <span className="pjsw-spacer" />
            <span className="pjsw-count">{projects.length}</span>
          </>
        )}
      </button>

      {open && (
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
                  setActiveProjectId(r.id);
                  setOpen(false);
                }}
              >
                <span className="pjsw-row-mark">{r.mark}</span>
                {/* The NAME is the primary information: it takes the slack and is
                    the last thing to be truncated. */}
                <span className={`truncate pjsw-row-name${r.missing ? ' pjsw-row-name--missing' : ''}`}>
                  {r.name}
                </span>
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
              setOpen(false);
              setProjectsOpen(true);
            }}
          >
            <span className="pjsw-manage-label">Manage projects…</span>
          </Row>
        </div>
      )}
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
