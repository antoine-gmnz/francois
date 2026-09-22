// Building blocks for a section of the right-hand session panel (redesign
// "Graphite & Signal", Figma "Session panel" 130:378). A section renders
//
//   <SidePanelBody>…rows…</SidePanelBody>
//   <SidePanelFooter>
//     <MeterRow label="Context" fraction={…} figure="134K / 1M" />
//     <Button …>Review 7 files</Button>
//   </SidePanelFooter>
//
// and the shell (src/app/session-panel/SessionPanel.tsx) supplies the tab strip
// above it. SidePanelLabel is the uppercase group heading ("RUNNING 3");
// SidePanelEmpty the quiet one-line empty state.

import type { ReactNode } from 'react';
import { Meter } from './Meter';
import './ui.css';

export function SidePanelBody({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={className ? `side-panel__body scz ${className}` : 'side-panel__body scz'}>{children}</div>;
}

export function SidePanelFooter({ children }: { children: ReactNode }): JSX.Element {
  return <div className="side-panel__footer">{children}</div>;
}

export function SidePanelLabel({ children, count }: { children: ReactNode; count?: ReactNode }): JSX.Element {
  return (
    <div className="side-panel__label section-label">
      <span>{children}</span>
      {count !== undefined && <span className="section-label__count">{count}</span>}
    </div>
  );
}

export function SidePanelEmpty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="side-panel__empty">{children}</div>;
}

/** `Context ▬▬▬──── 134K / 1M` — a label, a flexing Meter, a mono figure. */
export function MeterRow({ label, fraction, figure, title }: { label: string; fraction: number; figure: string; title?: string }): JSX.Element {
  return (
    <div className="side-panel__meter-row" title={title}>
      <span className="side-panel__meter-label">{label}</span>
      <Meter fraction={fraction} />
      <span className="side-panel__meter-figure">{figure}</span>
    </div>
  );
}
