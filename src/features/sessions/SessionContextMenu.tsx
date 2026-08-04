import type { RefObject } from 'react';
import type { AppError, SessionWorktree } from '../../../contract/common';
import type { EditorId, EditorInfo } from '../../../contract/open-in-vscode';
import { editorMenuLabel } from '../../../contract/open-in-vscode';
import type { WorktreeStatusData } from '../../../contract/session-worktree';
import { worktreeRemovalBlockReason } from './worktree';
import './sidebar.css';

export interface MenuState {
  sessionId: string;
  x: number;
  y: number;
  confirming: boolean;
  error: AppError | null;
  // open-in-vscode FR-9/10: detected editors for the default state's "Open in
  // <label>" group. [] until the FR-10 probe resolves — renders as absent, same
  // as a machine with none installed (no spinner, no skeleton).
  editors: EditorInfo[];
  // session-worktree FR-17/18: the dirty/unpushed probe for the delete-confirm's
  // removal checkbox. Absent for a session with no worktree.
  worktreeChecking?: boolean;
  worktreeStatus?: WorktreeStatusData | null;
  worktreeGone?: boolean; // WORKTREE_NOT_FOUND: the directory is already gone
  // A non-WORKTREE_NOT_FOUND status-check failure (FR-20): the confirm step still
  // renders normally, but the removal checkbox is disabled — a git-side check
  // failure must never block removing the session itself.
  worktreeStatusFailed?: boolean;
  removeWorktree?: boolean;
}

export interface SessionContextMenuProps {
  menu: MenuState;
  sessionName: string;
  /** session-worktree FR-17: the target session's worktree, when it has one. */
  worktree: SessionWorktree | null;
  containerRef: RefObject<HTMLDivElement>;
  onStartConfirm: () => void;
  /** session-rename FR-12: closes the menu and opens the rename modal for this row. */
  onRename: () => void;
  onCancel: () => void;
  onToggleRemoveWorktree: () => void;
  onRemove: (removeWorktree: boolean) => void;
  /** open-in-vscode FR-11: spawn `editorId` at the session's cwd. */
  onOpenInEditor: (editorId: EditorId) => void;
}

/** The sidebar row's right-click menu: "Remove session" → inline confirm, or an error. */
export function SessionContextMenu({
  menu,
  sessionName,
  worktree,
  containerRef,
  onStartConfirm,
  onRename,
  onCancel,
  onToggleRemoveWorktree,
  onRemove,
  onOpenInEditor,
}: SessionContextMenuProps): JSX.Element {
  // session-worktree FR-18/FR-20: a dirty/unpushed worktree — or a status check
  // that failed outright — disables the removal checkbox without ever blocking
  // removal of the session itself.
  const blockReason = menu.worktreeStatusFailed
    ? 'could not check worktree status'
    : menu.worktreeStatus
      ? worktreeRemovalBlockReason(menu.worktreeStatus)
      : null;
  const removeWorktree = menu.removeWorktree ?? false;
  return (
    // stopPropagation keeps a click inside the menu (e.g. "Remove session" →
    // confirm) from also reaching the window-level outside-click listener that
    // closes the menu, since that listener has no way to tell an inside click
    // from an outside one without it.
    <div ref={containerRef} onClick={(e) => e.stopPropagation()} className="context-menu" style={{ left: menu.x, top: menu.y }}>
      {menu.error ? (
        <div className="context-menu__error">{menu.error.message}</div>
      ) : !menu.confirming ? (
        // session-rename FR-12: the non-destructive action reads first; the
        // destructive one stays last. Neither the confirm nor the error state
        // offers rename — those are the remove flow, unchanged.
        <>
          {/* open-in-vscode FR-9: one item per detected editor, above Rename
              session, same .context-menu__item treatment, no glyph, no divider.
              [] (undetected or not-yet-resolved) renders nothing — the menu is
              byte-identical to today's. */}
          {menu.editors.map((editor) => (
            <div key={editor.id} className="context-menu__item" title={editor.path} onClick={() => onOpenInEditor(editor.id)}>
              {editorMenuLabel(editor)}
            </div>
          ))}
          <div className="context-menu__item" onClick={onRename}>
            Rename session
          </div>
          <div className="context-menu__item" onClick={onStartConfirm}>
            Remove session
          </div>
        </>
      ) : (
        <div className="context-menu__body context-menu__body--confirm">
          <div className="context-menu__confirm-text">remove '{sessionName}'?</div>
          {/* session-worktree §8 screen 5: the delete-confirm removal step. */}
          {worktree && (
            <div className="context-menu__worktree">
              {menu.worktreeChecking ? (
                <span className="context-menu__worktree-hint">checking worktree…</span>
              ) : menu.worktreeGone ? (
                <span className="context-menu__worktree-hint">worktree already removed</span>
              ) : (
                <label className={blockReason ? 'context-menu__worktree-opt context-menu__worktree-opt--blocked' : 'context-menu__worktree-opt'}>
                  <input type="checkbox" checked={blockReason ? false : removeWorktree} disabled={!!blockReason} onChange={onToggleRemoveWorktree} />
                  <span>
                    Also remove the worktree at <code title={worktree.path}>{worktree.path}</code>
                    {blockReason && <div className="context-menu__worktree-reason">{blockReason}</div>}
                  </span>
                </label>
              )}
            </div>
          )}
          <div className="context-menu__actions">
            <span className="context-menu__action" onClick={onCancel}>
              Cancel
            </span>
            <span className="context-menu__action context-menu__action--danger" onClick={() => onRemove(!blockReason && removeWorktree)}>
              Remove
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
