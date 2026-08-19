// split-by-4 FR-15 — the layout control: `▯` single, `▯▯` two panes and `⊞` up to
// four. This and the sidebar context menu's "Open in … pane" are the feature's ONLY
// two entry points for CHANGING the layout (⌘1–⌘4 and ⌥⇥ only move focus).
//
// design 10a moved it into the ranked session row and gave it a step-down: at full
// width it is the three-button segmented pill it always was; at medium it collapses
// to the ACTIVE mode plus a `▾` that opens the same three as a menu; at the narrowest
// width the bar hands it to `⋯` (which renders the `segments` form again — inside a
// panel there is width to spare, and a menu inside a menu is one level too many).

import { Columns2, Grid2x2, Square } from 'lucide-react';
import { useRef, useState } from 'react';
import { MAX_PANES, layoutModeState, paneCount } from '../../lib/layoutStore';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { useStore } from '../../lib/store';
import './usage.css';

const ICON = { size: 12, strokeWidth: 1.75 } as const;

/**
 * One button per reachable pane count. Splitting needs a PROJECT, not a second
 * session: a project holding one session splits into that session plus an empty
 * pane waiting for the next one (FR-15). Only the empty scope disables them.
 */
const MODES: readonly { count: number; label: string; glyph: JSX.Element }[] = [
  { count: 1, label: 'Single pane', glyph: <Square {...ICON} /> },
  { count: 2, label: 'Split view', glyph: <Columns2 {...ICON} /> },
  { count: MAX_PANES, label: 'Four panes', glyph: <Grid2x2 {...ICON} /> },
];

export interface LayoutToggleProps {
  /** design 10a's step-down. `segments` is the original control. */
  variant?: 'segments' | 'menu';
  /** The leading gap that separates this from the cluster before it. Off inside a panel. */
  divider?: boolean;
}

export default function LayoutToggle({ variant = 'segments', divider = true }: LayoutToggleProps): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const extraPanes = useStore((s) => s.extraPanes);
  const setPaneCount = useStore((s) => s.setPaneCount);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useDismiss(rootRef, { onEscape: () => setOpen(false), onOutsideClick: () => setOpen(false), enabled: open });

  const panes = paneCount({ extraPanes });

  // unbound-panes FR-2: `splitCandidates` reads the WHOLE FLEET now — the
  // activeProjectId===null clause that used to gate this is deleted.
  const canSplit = sessions.length > 0;

  const button = (mode: (typeof MODES)[number], inMenu: boolean) => {
    const { on, disabled, actionable } = layoutModeState(mode.count, panes, canSplit);
    const title = disabled ? `${mode.label} needs a session in the fleet — press n to start one` : mode.label;
    return (
      <button
        key={mode.count}
        type="button"
        className={
          [
            inMenu ? 'layout-toggle__row' : 'layout-toggle__btn',
            on ? (inMenu ? 'layout-toggle__row--on' : 'layout-toggle__btn--on') : null,
            disabled ? 'layout-toggle__btn--disabled' : null,
          ]
            .filter(Boolean)
            .join(' ')
        }
        aria-pressed={on}
        aria-disabled={disabled}
        title={title}
        // Gated on `actionable`, NOT on `on`: `⊞` is lit at three panes and
        // still has a fourth to add, so treating "lit" as "already there"
        // is what made a click on it do nothing.
        onClick={() => {
          if (actionable) setPaneCount(mode.count);
          if (inMenu) setOpen(false);
        }}
      >
        {mode.glyph}
        {inMenu && <span className="layout-toggle__row-label">{mode.label}</span>}
      </button>
    );
  };

  if (variant === 'menu') {
    // The active mode IS the button — a collapsed segmented control should still
    // say which segment is on, or collapsing it has cost a readout as well as width.
    const active = MODES.find((m) => layoutModeState(m.count, panes, canSplit).on) ?? MODES[0]!;
    return (
      <div ref={rootRef} className="layout-toggle-wrap">
        {divider && <span className="titlebar-divider" />}
        <span
          role="button"
          tabIndex={0}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`Layout — ${active.label}`}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
          className={open ? 'layout-toggle__one layout-toggle__one--on' : 'layout-toggle__one'}
        >
          {active.glyph}
          <span className="layout-toggle__caret">▾</span>
        </span>
        {open && (
          <div role="menu" aria-label="layout" className="layout-toggle__menu">
            {MODES.map((mode) => button(mode, true))}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {divider && <span className="titlebar-divider" />}
      <div className="layout-toggle">{MODES.map((mode) => button(mode, false))}</div>
    </>
  );
}
