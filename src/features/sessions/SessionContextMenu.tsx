import type { RefObject } from 'react';
import type { AppError } from '../../../contract/common';
import './sidebar.css';

export interface MenuState {
  sessionId: string;
  x: number;
  y: number;
  confirming: boolean;
  error: AppError | null;
}

export interface SessionContextMenuProps {
  menu: MenuState;
  sessionName: string;
  containerRef: RefObject<HTMLDivElement>;
  onStartConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}

/** The sidebar row's right-click menu: "Remove session" → inline confirm, or an error. */
export function SessionContextMenu({
  menu,
  sessionName,
  containerRef,
  onStartConfirm,
  onCancel,
  onRemove,
}: SessionContextMenuProps): JSX.Element {
  return (
    // stopPropagation keeps a click inside the menu (e.g. "Remove session" →
    // confirm) from also reaching the window-level outside-click listener that
    // closes the menu, since that listener has no way to tell an inside click
    // from an outside one without it.
    <div ref={containerRef} onClick={(e) => e.stopPropagation()} className="context-menu" style={{ left: menu.x, top: menu.y }}>
      {menu.error ? (
        <div className="context-menu__error">{menu.error.message}</div>
      ) : !menu.confirming ? (
        <div className="context-menu__item" onClick={onStartConfirm}>
          Remove session
        </div>
      ) : (
        <div className="context-menu__body">
          <div className="context-menu__confirm-text">remove '{sessionName}'?</div>
          <div className="context-menu__actions">
            <span className="context-menu__action" onClick={onCancel}>
              Cancel
            </span>
            <span className="context-menu__action context-menu__action--danger" onClick={onRemove}>
              Remove
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
