import { Check, CircleAlert, Columns2, Copy, ExternalLink, Settings, Trash2, TriangleAlert } from 'lucide-react';
import type { RefObject } from 'react';
import { useDelayedFlag } from '../../lib/hooks/useDelayedFlag';
import { Caret } from '../../ui/Loaders';
import type { AppError, SessionId, SessionWorktree } from '../../../contract/common';
import type { EditorId, EditorInfo } from '../../../contract/open-in-vscode';
import { editorMenuLabel } from '../../../contract/open-in-vscode';
import type { WorktreeStatusData } from '../../../contract/session-worktree';
import './sidebar.css';
import { worktreeRemovalBlockReason } from './worktree';

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
  /** Remove clicked and still in flight — the confirm step is locked and shows a loader. */
  removing?: boolean;
  /** Flips to the "copied" glyph+label for a beat after Copy path succeeds. */
  copied?: boolean;
}

export interface SessionContextMenuProps {
  menu: MenuState;
  readOnly?: boolean;
  sessionName: string;
  /** The target session's cwd, already home-abbreviated for display. */
  sessionPath: string;
  /** session-worktree FR-17: the target session's worktree, when it has one. */
  worktree: SessionWorktree | null;
  containerRef: RefObject<HTMLDivElement>;
  onStartConfirm: () => void;
  /**
   * split-by-4 FR-18: puts this row's session in a new pane and focuses it.
   * Absent ⇒ the item is hidden — which is how the FR's suppressions (a session
   * already in a pane, a full grid, and anything that would disable `▯▯`) are
   * expressed: the Sidebar simply does not pass a handler.
   */
  onOpenInNewPane?: (sessionId: SessionId) => void;
  /** `Open in right pane` at one pane, `Open in new pane` above — FR-18. */
  openInNewPaneLabel?: string;
  /** session-settings-sheet FR-19: closes the menu and opens the settings sheet (edit mode) for this row. */
  onOpenSettings: () => void;
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
  readOnly = false,
  sessionName,
  sessionPath,
  worktree,
  containerRef,
  onStartConfirm,
  onOpenInNewPane,
  openInNewPaneLabel = 'Open in new pane',
  onOpenSettings,
  onCopyPath,
  onCancel,
  onToggleRemoveWorktree,
  onRemove,
  onOpenInEditor,
}: SessionContextMenuProps): JSX.Element {
  // A dirty/unpushed worktree — or a status check that failed outright — no
  // longer blocks its removal: the reason is shown as a warning, and ticking the
  // box removes it with force. The branch is always kept, so unpushed commits
  // survive; only uncommitted files are lost.
  const warnReason = menu.worktreeStatusFailed
    ? 'could not check worktree status'
    : menu.worktreeStatus
      ? worktreeRemovalBlockReason(menu.worktreeStatus)
      : null;
  const removeWorktree = menu.removeWorktree ?? false;
  const removing = menu.removing ?? false;
  const showRemovingCaret = useDelayedFlag(removing, 300);
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
      ) : (!menu.confirming || readOnly) ? (
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
          {/* split-by-4 FR-18: above Rename, per the design brief. */}
          {onOpenInNewPane && (
            <button type="button" className="context-menu__item" onClick={() => onOpenInNewPane(menu.sessionId)}>
              <span className="context-menu__glyph">
                <Columns2 {...ICON} />
              </span>
              <span className="context-menu__label">{openInNewPaneLabel}</span>
            </button>
          )}
          <button type="button" className="context-menu__item" onClick={onOpenSettings}>
            <span className="context-menu__glyph">
              <Settings {...ICON} />
            </span>
            <span className="context-menu__label">Settings…</span>
          </button>
          <button type="button" className="context-menu__item" onClick={onCopyPath}>
            <span className={menu.copied ? 'context-menu__glyph context-menu__glyph--ok' : 'context-menu__glyph'}>
              {menu.copied ? <Check {...ICON} /> : <Copy {...ICON} />}
            </span>
            <span className="context-menu__label">{menu.copied ? 'Path copied' : 'Copy path'}</span>
          </button>
          <div className="context-menu__sep" />
          {!readOnly && <button type="button" className="context-menu__item context-menu__item--danger" onClick={onStartConfirm}>
            <span className="context-menu__glyph">
              <Trash2 {...ICON} />
            </span>
            <span className="context-menu__label">Remove session</span>
          </button>}
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
                <label className={warnReason ? 'context-menu__worktree-opt context-menu__worktree-opt--warn' : 'context-menu__worktree-opt'}>
                  <input type="checkbox" checked={removeWorktree} disabled={removing} onChange={onToggleRemoveWorktree} />
                  <span>
                    Also remove the worktree at <code title={worktree.path}>{worktree.path}</code>
                    {warnReason && (
                      <div className="context-menu__worktree-reason">
                        {warnReason} — {menu.worktreeStatus?.dirty ? 'uncommitted changes will be lost; ' : ''}the branch is kept
                      </div>
                    )}
                  </span>
                </label>
              )}
            </div>
          )}
          <div className="context-menu__actions">
            <button type="button" className="context-menu__action" disabled={removing} onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="context-menu__action context-menu__action--danger"
              disabled={removing}
              aria-busy={removing}
              onClick={() => onRemove(removeWorktree)}
            >
              {showRemovingCaret ? <Caret>Removing</Caret> : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
