// projects — the pane [1] switcher strip (FR-25/FR-26). A 26px row pinned under
// the SESSIONS header, above the fleet board's cards: it reads "▾ All projects"
// or "▾ <name>" and filters the board to one project. The dropdown itself is
// ProjectMenu (shared with the titlebar project button).
// Selecting a project NEVER touches activeSessionId (FR-28) — the board's own
// effect resets only its keyboard cursor.

import { useRef, useState } from 'react';
import ProjectMenu from './ProjectMenu';
import { switcherLabel } from './projects';
import { useProjectRegistrySync } from './useProjectRegistrySync';
import { useStore } from '../../lib/store';
import { useDismiss } from '../../lib/hooks/useDismiss';
import './projects.css';

export default function ProjectSwitcher({ home }: { home: string }) {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const dismissRef = useRef<HTMLDivElement>(null);

  // Keeps the label and the count true after a modal write; the open dropdown
  // refreshes itself (ProjectMenu).
  useProjectRegistrySync();

  // Escape / outside click close the dropdown (§8 interactions).
  useDismiss(dismissRef, {
    onEscape: () => setOpen(false),
    onOutsideClick: () => setOpen(false),
    enabled: open,
  });

  const active = projects.find((p) => p.id === activeProjectId) ?? null;
  const filtered = active !== null;

  return (
    <div ref={dismissRef} className="pjsw-root">
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

      {open && <ProjectMenu home={home} onClose={() => setOpen(false)} />}
    </div>
  );
}
