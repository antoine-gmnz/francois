// projects — the pane [1] switcher strip + dropdown (FR-25/FR-26).
// A 26px row pinned under the SESSIONS header, above the fleet board's cards:
// it reads "▾ All projects" or "▾ <name>" and filters the board to one project.
// Selecting a project NEVER touches activeSessionId (FR-28) — the board's own
// effect resets only its keyboard cursor.

import { useEffect, useRef, useState } from 'react';
import { buildSwitcherRows, abbreviateRoot, safeCall, switcherLabel } from './projects';
import { projectList } from '../../lib/api';
import { useStore } from '../../lib/store';

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  muted: 'var(--text-muted)',
  primary: 'var(--text)',
  bright: 'var(--text-bright)',
  error: 'var(--error)',
};

export default function ProjectSwitcher({ home }: { home: string }) {
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProjectId = useStore((s) => s.setActiveProjectId);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const mounted = useRef(true);

  // Never trust a cached registry: read on mount, on every dropdown open, and
  // whenever the modal closes (rootExists is derived per list — FR-2/FR-32).
  const refresh = () => {
    void safeCall(projectList()).then((res) => {
      if (mounted.current && res.ok) setProjects(res.data);
    });
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The modal is the only other writer of the registry; re-read when it closes.
  // This also covers the initial load — its first run fires on mount — so there is
  // deliberately no separate mount fetch (that duplicated every read, ×2 again under
  // StrictMode: four project_list calls per app start).
  useEffect(() => {
    if (!projectsOpen) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsOpen]);

  // Escape / outside click close the dropdown (§8 interactions).
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = projects.find((p) => p.id === activeProjectId) ?? null;
  const rows = buildSwitcherRows(projects, activeProjectId);
  const filtered = active !== null;

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
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
        style={{
          height: 26,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '0 12px',
          // --bg-elevated is all but invisible against --bg-panel in the light
          // theme; --bg-hover is what every other interactive row in pane [1]
          // uses (the remove menu, the dropdown rows) and reads in both themes.
          background: hover ? 'var(--bg-hover)' : 'transparent',
          border: 0,
          borderBottom: '1px solid var(--border)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        {/* The mock's `▾` (U+25BE, the SMALL triangle) carries almost no ink in
            JetBrains Mono — at 8px it reads as a stray period rather than a
            disclosure control. U+25BC at 8px is the same visual weight the mock
            intended, and holds up in both themes. */}
        <span style={{ fontSize: 8, lineHeight: 1, flexShrink: 0, color: filtered ? C.accent : C.muted }}>▼</span>
        <span
          style={{
            fontSize: 11,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            // Unfiltered is a quiet scope line, not a heading: --text would put
            // it at the same weight as the session names right below it.
            color: filtered ? C.accent : hover ? C.bright : C.dim,
          }}
        >
          {switcherLabel(active)}
        </span>
        {/* Mirrors the pane header's own `<count> · [1]` grammar, so the row
            reads as a control that has contents. Hidden while empty. */}
        {projects.length > 0 && (
          <>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: C.faint, flexShrink: 0 }}>{projects.length}</span>
          </>
        )}
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 40,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-2)',
            borderRadius: 5,
            boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
            padding: '4px 0',
            animation: 'dropIn 90ms ease-out',
          }}
        >
          {/* The listbox is ONLY the selectable scopes — the manage action below is
              a sibling, so it is never announced as an option. The scroll cap lives
              here rather than on the panel so that action can't scroll out of reach. */}
          <div
            role="listbox"
            className="scz"
            style={{
              maxHeight: 260,
              // Vertical scroll only — a row must never widen the panel and mint a
              // horizontal scrollbar; long names and roots ellipsize in place.
              overflowY: 'auto',
              overflowX: 'hidden',
            }}
          >
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
              <span style={{ width: 8, flexShrink: 0, fontSize: 9, color: C.accent }}>{r.mark}</span>
              {/* The NAME is the primary information: it takes the slack and is the
                  last thing to be truncated. `minWidth: 0` is what actually lets it
                  ellipsize instead of collapsing — without it a long root next to a
                  `missing` tag squeezed the name to ZERO width and it vanished. */}
              <span
                style={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  fontSize: 11,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  color: r.missing ? C.muted : C.primary,
                }}
              >
                {r.name}
              </span>
              {r.missing && <span style={{ fontSize: 9, color: C.error, flexShrink: 0 }}>missing</span>}
              {/* The root is secondary: it shrinks and ellipsizes first, and is
                  capped so a deep path can never crowd out the name. */}
              <span
                style={{
                  flex: '0 1 auto',
                  minWidth: 0,
                  maxWidth: '52%',
                  fontSize: 10,
                  color: C.faint,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  textAlign: 'right',
                }}
              >
                {abbreviateRoot(r.root, home)}
              </span>
            </Row>
          ))}

          </div>

          {/* Outside the listbox on purpose: it is an ACTION, not one of the
              selectable scopes, so it must not be announced as an option. */}
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0 0' }} />
          <Row
            role="button"
            onClick={() => {
              setOpen(false);
              setProjectsOpen(true);
            }}
          >
            <span style={{ fontSize: 11, color: C.dim }}>Manage projects…</span>
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
    <div
      role={role}
      // Only an `option` carries selection state; hardcoding false here meant the
      // active scope (the one wearing the ✦) was announced as unselected.
      aria-selected={role === 'option' ? !!selected : undefined}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 24,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '0 12px',
        cursor: 'pointer',
        background: hover ? 'var(--bg-hover)' : 'transparent',
      }}
    >
      {children}
    </div>
  );
}
