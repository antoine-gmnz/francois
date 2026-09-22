// The sidebar's project scope picker — redesign "Graphite & Signal", Figma
// "24 · Sidebar / Project scope picker" (134:4687; light 142:17085). Opened from
// the scope chips' `+N ▾`; it replaces the flat ProjectMenu that chip opened
// before. A search field (focused on open), the projects in tiers — Pinned ·
// Active now · each project group · the rest — capped with "N more · type to
// search", and "Manage projects…" in the footer. Selecting a project scopes the
// roster to it (the store's switchProject, which also lands you inside it);
// "All projects" stays the `All` chip beside the trigger.
//
// The parent (ScopeChips) owns `open` and outside-click / Escape dismissal —
// it owns the ref that contains both the trigger and this panel.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { SessionId } from '../../../contract/common';
import { projectList } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { useProjectPins } from '../../lib/projectPinsStore';
import { useStore } from '../../lib/store';
import { Icon } from '../../ui/Icon';
import { StateIcon } from '../../ui/StateIcon';
import { safeCall } from '../projects/projects';
import { flattenScopeTiers, projectScopeView, scopeFlyoutPlacement, type ScopeRow } from './project-scope';
import './project-scope.css';

/** The sessions flyout's fixed width; its height is derived from its row count. */
const FLYOUT_WIDTH = 220;
const FLYOUT_ROW_HEIGHT = 28;
const FLYOUT_MAX_VISIBLE_ROWS = 8;
const FLYOUT_PADDING = 8;
/** A brief hover grace period, so crossing the gap to the flyout doesn't close it. */
const FLYOUT_CLOSE_DELAY_MS = 150;

export function ProjectScopePicker({ onClose, position }: { onClose: () => void; position: { left: number; top: number } | null }) {
  const projects = useStore((s) => s.projects);
  const groups = useStore((s) => s.groups);
  const sessions = useStore((s) => s.sessions);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setProjects = useStore((s) => s.setProjects);
  const setGroups = useStore((s) => s.setGroups);
  const switchProject = useStore((s) => s.switchProject);
  const setActiveProjectId = useStore((s) => s.setActiveProjectId);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const mainTab = useStore((s) => s.mainTab);
  const setMainTab = useStore((s) => s.setMainTab);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
  const pinned = useProjectPins((s) => s.pinnedProjectIds);
  const togglePin = useProjectPins((s) => s.toggleProjectPin);
  const mounted = useMounted();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [flyoutRowId, setFlyoutRowId] = useState<string | null>(null);
  const [flyoutPosition, setFlyoutPosition] = useState<{ left: number; top: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const flyoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Never trust a cached registry: the panel mounts only while open, so this
  // mount-once read is the "re-read on every open" the old menu did (projects
  // FR-2/FR-32), groups included (project-groups FR-11).
  useEffect(() => {
    void safeCall(projectList()).then((res) => {
      if (!mounted.current || !res.ok) return;
      setProjects(res.data.projects);
      setGroups(res.data.groups);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const view = projectScopeView(projects, groups, sessions, pinned, query);
  const rows = flattenScopeTiers(view);
  const at = rows.length === 0 ? -1 : Math.min(cursor, rows.length - 1);

  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.project-scope__row--cursor')?.scrollIntoView?.({ block: 'nearest' });
  }, [at]);

  // The flyout timer outlives any single render (it fires from a setTimeout), so
  // it must be cleared on unmount too, not just on the next hover.
  useEffect(() => () => {
    if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current);
  }, []);

  const cancelFlyoutClose = () => {
    if (flyoutCloseTimer.current) {
      clearTimeout(flyoutCloseTimer.current);
      flyoutCloseTimer.current = null;
    }
  };
  const scheduleFlyoutClose = () => {
    cancelFlyoutClose();
    flyoutCloseTimer.current = setTimeout(() => setFlyoutRowId(null), FLYOUT_CLOSE_DELAY_MS);
  };
  const openFlyout = (row: ScopeRow, target: HTMLElement) => {
    if (row.sessions.length === 0) return;
    cancelFlyoutClose();
    const r = target.getBoundingClientRect();
    const height = Math.min(row.sessions.length, FLYOUT_MAX_VISIBLE_ROWS) * FLYOUT_ROW_HEIGHT + FLYOUT_PADDING;
    setFlyoutPosition(scopeFlyoutPlacement(r, { width: window.innerWidth, height: window.innerHeight }, { width: FLYOUT_WIDTH, height }));
    setFlyoutRowId(row.id);
  };

  const pick = (row: ScopeRow) => {
    // Close FIRST: an empty project opens the new-task dialog, and this panel
    // must not still be layered under it.
    onClose();
    switchProject(row.id);
  };

  const pickSession = (row: ScopeRow, sessionId: SessionId) => {
    onClose();
    if (row.id !== activeProjectId) setActiveProjectId(row.id);
    setActiveSessionId(sessionId);
    if (mainTab === 'overview') setMainTab('session');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor((at + step + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[at];
      if (row) pick(row);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Project scope"
      className="project-scope"
      style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div className="project-scope__search-wrap">
        <label className="project-scope__search">
          <Icon name="search" size={12} className="project-scope__search-icon" />
          <input
            ref={inputRef}
            className="project-scope__input"
            value={query}
            placeholder="Find a project…"
            aria-label="Find a project"
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
          />
          <span className="project-scope__total">
            {view.total} project{view.total === 1 ? '' : 's'}
          </span>
        </label>
      </div>

      <div ref={listRef} role="listbox" aria-label="Projects" className="scz project-scope__list">
        {rows.length === 0 && <div className="project-scope__empty">{projects.length === 0 ? 'No projects yet' : 'No matching projects'}</div>}
        {view.tiers.map((tier) => (
          <div key={tier.key} role="group" aria-label={tier.label}>
            <div className="project-scope__tier">{tier.label}</div>
            {tier.rows.map((row) => {
              const i = rows.indexOf(row);
              const cls = ['project-scope__row'];
              if (i === at) cls.push('project-scope__row--cursor');
              if (row.id === activeProjectId) cls.push('project-scope__row--current');
              return (
                <div
                  key={row.id}
                  role="option"
                  aria-selected={row.id === activeProjectId}
                  aria-haspopup={row.sessions.length > 0 ? 'menu' : undefined}
                  className={cls.join(' ')}
                  onMouseEnter={(e: ReactMouseEvent<HTMLDivElement>) => {
                    setCursor(i);
                    openFlyout(row, e.currentTarget);
                  }}
                  onMouseLeave={scheduleFlyoutClose}
                  onClick={() => pick(row)}
                >
                  <span className="project-scope__state">{row.state && <StateIcon kind={row.state} size={12} />}</span>
                  <span className="project-scope__name truncate">{row.name}</span>
                  {row.missing && <span className="project-scope__tag">missing</span>}
                  <span className="project-scope__count">{row.count}</span>
                  {row.sessions.length > 0 && <span className="project-scope__disclosure">›</span>}
                  <button
                    type="button"
                    className={row.pinned ? 'project-scope__pin project-scope__pin--on' : 'project-scope__pin'}
                    title={row.pinned ? `Unpin ${row.name}` : `Pin ${row.name}`}
                    aria-pressed={row.pinned}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(row.id);
                    }}
                  >
                    <Icon name="pin" size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {view.hidden > 0 && <div className="project-scope__more">{view.hidden} more · type to search</div>}
      </div>

      {flyoutRowId &&
        flyoutPosition &&
        (() => {
          const row = rows.find((r) => r.id === flyoutRowId);
          if (!row || row.sessions.length === 0) return null;
          return (
            <div
              role="menu"
              aria-label={`${row.name} sessions`}
              className="project-scope__flyout"
              style={{ left: flyoutPosition.left, top: flyoutPosition.top, width: FLYOUT_WIDTH }}
              onMouseEnter={cancelFlyoutClose}
              onMouseLeave={scheduleFlyoutClose}
            >
              {row.sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  className="project-scope__flyout-item"
                  onClick={() => pickSession(row, s.id)}
                >
                  <StateIcon status={s.status} size={12} />
                  <span className="project-scope__flyout-name truncate">{s.name}</span>
                </button>
              ))}
            </div>
          );
        })()}

      <div className="project-scope__footer">
        <button
          type="button"
          className="project-scope__manage"
          onClick={() => {
            onClose();
            setProjectsOpen(true);
          }}
        >
          Manage projects…
        </button>
        <span className="project-scope__keys">↑↓ ⏎ · Esc</span>
      </div>
    </div>
  );
}
