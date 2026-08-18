import { useEffect, useRef, useState } from 'react';
import type { AppError, ProjectId } from '../../contract/common';
import type { ShellEnsureData, ShellId, ShellInfo } from '../../contract/shell-terminal';
import { projectMarker } from '../features/projects/projectMarker';
import ShellTerminal from '../features/shell/ShellTerminal';
import { shellCreate, shellEnsure } from '../lib/api';
import { useStore } from '../lib/store';
import { StatusDot } from '../ui/StatusDot';
import { shellFooterPath } from './appShell';

export interface ProjectShellPaneProps {
  projectId: ProjectId;
  /** null ⇒ this mount owns the FR-7 create-if-none round trip. */
  shellId: ShellId | null;
  focused: boolean;
  home: string;
  /** FR-7: record the spawned shell on the pane, in memory only. */
  onSpawned: (shellId: ShellId) => void;
  /** design brief §Notes: `PROJECT_NOT_FOUND` has no retry — only a way out. */
  onClose?: () => void;
}

/**
 * unbound-panes FR-6/FR-7/FR-9 — a `kind: 'shell'` pane's body: exactly one
 * PTY rooted at a registered project's root, no chip strip, no tab strip. On
 * first mount (`shellId === null`) it calls `shell_create`; on a remount with
 * a live `shellId` (e.g. after a pane rebuild) it calls `shell_ensure` for
 * scrollback replay instead of spawning a second PTY.
 */
export default function ProjectShellPane({ projectId, shellId, focused, home, onSpawned, onClose }: ProjectShellPaneProps) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const [error, setError] = useState<AppError | null>(null);
  const [attaching, setAttaching] = useState(true);
  const [footer, setFooter] = useState<{ alive: boolean; shellName: string; cwd: string } | null>(null);
  const [initialAttach, setInitialAttach] = useState<{ shellId: ShellId; data: ShellEnsureData } | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // Set right before onSpawned(res.data.id) below — that call updates the
  // store and re-renders this component with a non-null `shellId` prop,
  // which changes this effect's own dependency array. Without this guard the
  // effect would re-run and issue a second, unnecessary shell_ensure call for
  // the SAME mount right after the PTY was created (not the "remount with a
  // live shellId" case FR-7 describes).
  const skipNextRunRef = useRef(false);

  useEffect(() => {
    if (skipNextRunRef.current) {
      skipNextRunRef.current = false;
      return;
    }
    let cancelled = false;
    setError(null);
    setAttaching(true);
    setInitialAttach(null);
    const owner = { kind: 'project' as const, projectId };

    const applyInfo = (s: ShellInfo) => setFooter({ alive: s.alive, shellName: s.shellName, cwd: s.cwd });

    const attach = async () => {
      try {
        if (shellId) {
          // FR-7: a live shellId already exists (a rebuild kept this pane's
          // slot) — re-attach for scrollback replay, never spawn a second PTY.
          const res = await shellEnsure({ owner, shellId });
          if (cancelled) return;
          if (!res.ok) {
            setError(res.error);
            setAttaching(false);
            return;
          }
          const mine = res.data.shells.find((s) => s.id === res.data.shellId);
          if (mine) applyInfo(mine);
          setInitialAttach({ shellId: res.data.shellId, data: res.data });
          setAttaching(false);
          return;
        }
        // FR-7: first mount — spawn.
        const res = await shellCreate(owner);
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error);
          setAttaching(false);
          return;
        }
        applyInfo(res.data);
        skipNextRunRef.current = true;
        onSpawned(res.data.id);
        setAttaching(false);
      } catch (e) {
        if (cancelled) return;
        setError({ code: 'PTY_ERROR', message: String(e) });
        setAttaching(false);
      }
    };

    void attach();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, shellId, retryToken]);

  if (error) {
    // design brief §Notes: errors render IN PLACE, never as a toast — the
    // header stays intact so the pane is still closable.
    const copy =
      error.code === 'PROJECT_ROOT_MISSING'
        ? 'project root is gone'
        : error.code === 'SHELL_LIMIT_REACHED'
          ? '6 shells already open for this project'
          : error.code === 'PROJECT_NOT_FOUND'
            ? 'this project is no longer registered'
            : error.message;
    const canRetry = error.code !== 'PROJECT_NOT_FOUND';
    return (
      <div className="app-shell-view">
        <div className="shell-pane-error">
          <div className="shell-pane-error__text">{copy}</div>
          {canRetry ? (
            <button type="button" className="split-pane__empty-new" onClick={() => setRetryToken((t) => t + 1)}>
              Retry
            </button>
          ) : (
            error.code === 'PROJECT_NOT_FOUND' &&
            onClose && (
              <button type="button" className="split-pane__empty-new" onClick={onClose}>
                Close pane
              </button>
            )
          )}
        </div>
      </div>
    );
  }

  if (attaching || (!initialAttach && !footer)) {
    return (
      <div className="app-shell-view">
        <div className="shell-pane-hint">starting shell…</div>
      </div>
    );
  }

  const liveShellId = initialAttach?.shellId ?? shellId;

  return (
    <div className="app-shell-view">
      <div className="app-shell-terminal-wrap">
        {liveShellId && (
          <ShellTerminal
            owner={{ kind: 'project', projectId }}
            shellId={liveShellId}
            visible
            canFocus={focused}
            initialData={initialAttach?.data}
          />
        )}
      </div>
      <div className="app-shell-footer">
        <StatusDot color={footer?.alive ? 'var(--success)' : 'var(--error)'} size={7} />
        <span>
          {footer?.shellName || 'shell'}
          {footer?.cwd && (
            <>
              {' '}
              <span className="app-text-faint">·</span> {shellFooterPath(footer.cwd, footer.shellName, home)}
            </>
          )}
        </span>
        <span className="app-flex-spacer" />
        {project && (
          <span title={project.name} className="split-pane__marker">
            {projectMarker(project.name)}
          </span>
        )}
      </div>
    </div>
  );
}
