// Shared modal shell: backdrop + panel + header/body/footer slots.
// Replaces the near-identical backdrop/panel pairs in AgentsPanel's
// NewAgentModal, NewSessionModal, and SkillsPanel's ModalShell — each of
// which re-implemented the same `position:fixed` backdrop, click-through
// stopPropagation on the panel, and (sometimes) an Escape listener.
//
// Escape-to-close and backdrop-click-to-close are both OFF by default and
// opt in via props: several call sites layer their own keydown listener
// (Escape closes, Enter submits) and would otherwise double-handle Escape.

import { useEffect, type MouseEvent, type ReactNode } from 'react';

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

  const onBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (closeOnBackdropClick && e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className={className ? `modal-backdrop ${className}` : 'modal-backdrop'}
      onClick={onBackdropClick}
      style={alignStyle(align)}
    >
      <div className="modal-panel" onClick={(e) => e.stopPropagation()} style={{ width }}>
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
