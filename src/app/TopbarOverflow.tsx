// design 10a — the `⋯` the ranked bar folds into below ~840px.
//
// It is not a dumping ground: it holds exactly what the bar stopped rendering, in
// the same drop order, so what is behind it is derivable from the width rather than
// from taste. Its tooltip names its contents, which is what makes "where did the
// model chip go" answerable without opening it.
//
// design 11c: the run chip's own panel opens from here UNCHANGED, with the context
// and branch readouts stacked above its Model heading — one menu language, not a
// second, smaller model picker that would then have to be kept in step.

import { useRef, useState } from 'react';
import type { SessionMeta } from '../../contract/common';
import RunChip from '../features/sessions/RunChip';
import { useDismiss } from '../lib/hooks/useDismiss';
import { overflowTooltip } from './topbar';

export interface TopbarOverflowProps {
  session: SessionMeta;
  /** The readouts the bar dropped — context, branch — in drop order. */
  readouts: { label: string; value: string }[];
  /** The layout control, which has no readout form: it is a control or it is nothing. */
  layout: JSX.Element;
}

export default function TopbarOverflow({ session, readouts, layout }: TopbarOverflowProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, { onEscape: () => setOpen(false), onOutsideClick: () => setOpen(false), enabled: open });

  const tooltip = overflowTooltip([
    session.model.label,
    session.permissionMode === 'default' ? null : session.permissionMode,
    ...readouts.map((r) => r.value),
    'layout',
  ]);

  return (
    <div ref={rootRef} className="session-row__overflow">
      <span
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tooltip}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className={open ? 'session-row__overflow-btn session-row__overflow-btn--on' : 'session-row__overflow-btn'}
      >
        ⋯
      </span>

      {open && (
        <div className="session-row__overflow-panel">
          {/* The run chip's panel, bare — same shell, same footer, anchored here. */}
          <RunChip session={session} readouts={readouts} bare />
          <div className="session-row__overflow-layout">
            <span className="session-row__overflow-layout-label">Layout</span>
            {layout}
          </div>
        </div>
      )}
    </div>
  );
}
