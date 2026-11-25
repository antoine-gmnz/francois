// Shared modal shell: backdrop + panel + header/body/footer slots.
// Replaces the near-identical backdrop/panel pairs in AgentsPanel's
// NewAgentModal, NewSessionModal, and SkillsPanel's ModalShell — each of
// which re-implemented the same `position:fixed` backdrop, click-through
// stopPropagation on the panel, and (sometimes) an Escape listener.
//
// Escape-to-close and backdrop-click-to-close are both OFF by default and
// opt in via props: several call sites layer their own keydown listener
// (Escape closes, Enter submits) and would otherwise double-handle Escape.

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { focusableIn, nextFocusIndex } from './focus-trap';

export type ModalAlign = 'top' | 'center';

export interface ModalProps {
  onClose: () => void;
  /** Panel width in pixels — this varies per call site (380–588) and is
   * genuinely per-instance data, not a design token, so it stays a prop. */
  width: number;
  /** `'top'` (the default) pins the panel near the top of the window, like
   * the command palette and the new-session/new-agent modals. `'center'`
   * vertically centers it, like SkillsPanel's run/install dialogs. */
  align?: ModalAlign;
  closeOnBackdropClick?: boolean;
  closeOnEscape?: boolean;
  /** Extra class on the backdrop, for the rare call site that must override a
   * backdrop property `.modal-backdrop` fixes — currently only `z-index`, which
   * SkillsPanel's dialogs raise to 50 so they stack above the panel popovers
   * (30–40) the way they did before adopting this component. */
  className?: string;
  /** Accessible name of the dialog: the modal's visible title text. */
  ariaLabel?: string;
  ariaLabelledBy?: string;
  children: ReactNode;
}

function alignStyle(align: ModalAlign): React.CSSProperties {
  return align === 'center' ? { alignItems: 'center' } : { alignItems: 'flex-start', paddingTop: 118 };
}

export function Modal({
  onClose,
  width,
  align = 'top',
  closeOnBackdropClick = false,
  closeOnEscape = false,
  className,
  ariaLabel,
  ariaLabelledBy,
  children,
}: ModalProps): JSX.Element {
  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closeOnEscape, onClose]);

  const panelRef = useRef<HTMLDivElement>(null);
  // Captured during the first render, not in the effect: React applies a
  // child's `autoFocus` while committing, before effects run, so by then
  // `document.activeElement` is already the input INSIDE this modal � a node
  // that is detached at unmount, which would leave focus on <body>.
  const restoreRef = useRef<Element | null | undefined>(undefined);
  if (restoreRef.current === undefined) restoreRef.current = document.activeElement;

  // Focus management: move focus in on mount (unless a child, e.g. an
  // `autoFocus` input, already took it) and give it back on unmount.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previous = restoreRef.current instanceof HTMLElement ? restoreRef.current : null;
    if (!panel.contains(document.activeElement)) (focusableIn(panel)[0] ?? panel).focus();
    return () => {
      if (previous && previous.isConnected) previous.focus();
    };
  }, []);

  // Tab trap. Handles ONLY a bare Tab / Shift+Tab; every other key (call sites
  // own Escape/Enter) and every modified Tab (Ctrl+Tab, Alt+Tab) passes untouched.
  // Modal is not portaled, so a modal rendered inside another (ConsentDialog in
  // ExtensionsModal) bubbles its keydown to the outer panel: the inner trap
  // stops the Tab there, or the outer one would move focus a second time.
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusableIn(panel);
    const next = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    e.preventDefault();
    e.stopPropagation();
    (next < 0 ? panel : items[next]).focus();
  };

  const onBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (closeOnBackdropClick && e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className={className ? `modal-backdrop ${className}` : 'modal-backdrop'}
      onClick={onBackdropClick}
      style={alignStyle(align)}
    >
      <div
        ref={panelRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
        style={{ width }}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ children }: { children: ReactNode }): JSX.Element {
  return <div className="modal-header">{children}</div>;
}

export function ModalBody({ children }: { children: ReactNode }): JSX.Element {
  return <div className="modal-body">{children}</div>;
}

export function ModalFooter({ children }: { children: ReactNode }): JSX.Element {
  return <div className="modal-footer">{children}</div>;
}
