import type { RefObject } from 'react';
import { Check, CircleAlert, Copy, ExternalLink, Pencil, Trash2, TriangleAlert } from 'lucide-react';
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
  /** Flips to the "copied" glyph+label for a beat after Copy path succeeds. */
  copied?: boolean;
}

export interface SessionContextMenuProps {
  menu: MenuState;
  sessionName: string;
  /** The target session's cwd, already home-abbreviated for display. */
  sessionPath: string;
  /** session-worktree FR-17: the target session's worktree, when it has one. */
  worktree: SessionWorktree | null;
  containerRef: RefObject<HTMLDivElement>;
  onStartConfirm: () => void;
  /** session-rename FR-12: closes the menu and opens the rename modal for this row. */
  onRename: () => void;
  onCopyPath: () => void;
  onCancel: () => void;
  onToggleRemoveWorktree: () => void;
  onRemove: (removeWorktree: boolean) => void;
  /** open-in-vscode FR-11: spawn `editorId` at the session's cwd. */
  onOpenInEditor: (editorId: EditorId) => void;
}

/**
 * The sidebar row's right-click menu: a header naming the session it acts on, the
 * safe actions, then "Remove session" → inline confirm, or an error.
 *
 * Icons are lucide-react. They inherit `currentColor`, so the tone lives in
 * sidebar.css with the rest of the menu and no icon here names a colour.
 */
// One size and one weight for every icon in the menu — 14px reads level with the
// 12px labels, and 1.75 matches the hairline weight of the app's rules and borders.
const ICON = { size: 14, strokeWidth: 1.75 } as const;

export function SessionContextMenu({
  menu,
  sessionName,
  sessionPath,
  worktree,
  containerRef,
  onStartConfirm,
  onRename,
  onCopyPath,
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
      {/* Which session am I about to rename or delete? The row that was
          right-clicked is not necessarily the selected one, so the menu says so
          itself rather than leaving it to be inferred from the cursor. */}
      <div className="context-menu__header">
        <div className="context-menu__header-name truncate" title={sessionName}>
          {sessionName}
        </div>
        <div className="context-menu__header-path truncate" title={sessionPath}>
          {sessionPath}
        </div>
      </div>

      {menu.error ? (
        <div className="context-menu__error">
          <span className="context-menu__glyph context-menu__glyph--error">
            <CircleAlert {...ICON} />
          </span>
          <span>{menu.error.message}</span>
        </div>
      ) : !menu.confirming ? (
        // session-rename FR-12: the non-destructive actions read first; the
        // destructive one stays last, behind a rule. Neither the confirm nor the
        // error state offers them — those are the remove flow, unchanged.
        <div className="context-menu__items">
          {/* open-in-vscode FR-9: one item per detected editor, above Rename
              session, same .context-menu__item treatment, no divider. []
              (undetected or not-yet-resolved) renders nothing — no spinner, no
              skeleton. FR-9 says "no glyph", which read correctly when no item
              in this menu had one; now that every item does, an iconless row
              would break the label column the fixed slot exists to hold. So
              they take ExternalLink — the same "same treatment" the FR asks for,
              applied to what the treatment has become. */}
          {menu.editors.map((editor) => (
            <button type="button" key={editor.id} className="context-menu__item" title={editor.path} onClick={() => onOpenInEditor(editor.id)}>
              <span className="context-menu__glyph">
                <ExternalLink {...ICON} />
              </span>
              <span className="context-menu__label">{editorMenuLabel(editor)}</span>
            </button>
          ))}
          <button type="button" className="context-menu__item" onClick={onRename}>
            <span className="context-menu__glyph">
              <Pencil {...ICON} />
            </span>
            <span className="context-menu__label">Rename session</span>
          </button>
          <button type="button" className="context-menu__item" onClick={onCopyPath}>
            <span className={menu.copied ? 'context-menu__glyph context-menu__glyph--ok' : 'context-menu__glyph'}>
              {menu.copied ? <Check {...ICON} /> : <Copy {...ICON} />}
            </span>
            <span className="context-menu__label">{menu.copied ? 'Path copied' : 'Copy path'}</span>
          </button>
          <div className="context-menu__sep" />
          <button type="button" className="context-menu__item context-menu__item--danger" onClick={onStartConfirm}>
            <span className="context-menu__glyph">
              <Trash2 {...ICON} />
            </span>
            <span className="context-menu__label">Remove session</span>
          </button>
        </div>
      ) : (
        <div className="context-menu__body context-menu__body--confirm">
          <div className="context-menu__confirm-text">
            <span className="context-menu__glyph context-menu__glyph--warn">
              <TriangleAlert {...ICON} />
            </span>
            <span>remove '{sessionName}'?</span>
          </div>
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
            <button type="button" className="context-menu__action" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="context-menu__action context-menu__action--danger" onClick={() => onRemove(!blockReason && removeWorktree)}>
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
