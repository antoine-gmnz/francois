// split-by-4 FR-15 — the titlebar's layout control: `▯` single, `▯▯` two panes
// and `⊞` up to four, a three-button segmented pill after the quota cluster.
// This and the sidebar context menu's "Open in … pane" are the feature's ONLY
// two entry points for CHANGING the layout (⌘1–⌘4 and ⌥⇥ only move focus).

import { Columns2, Grid2x2, Square } from 'lucide-react';
import { MAX_PANES, layoutModeState, paneCount } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';

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

export default function LayoutToggle(): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const extraPanes = useStore((s) => s.extraPanes);
  const setPaneCount = useStore((s) => s.setPaneCount);

  const panes = paneCount({ extraPanes });

  // unbound-panes FR-2: `splitCandidates` reads the WHOLE FLEET now — the
  // activeProjectId===null clause that used to gate this is deleted.
  const canSplit = sessions.length > 0;

  return (
    <>
      <span className="titlebar-divider" />
      <div className="layout-toggle">
        {MODES.map((mode) => {
          const { on, disabled, actionable } = layoutModeState(mode.count, panes, canSplit);
          const title = disabled ? `${mode.label} needs a session in the fleet — press n to start one` : mode.label;
          return (
            <button
              key={mode.count}
              type="button"
              className={
                [
                  'layout-toggle__btn',
                  on ? 'layout-toggle__btn--on' : null,
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
              }}
            >
              {mode.glyph}
            </button>
          );
        })}
      </div>
    </>
  );
}
