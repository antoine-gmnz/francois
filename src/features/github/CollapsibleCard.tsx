// github-ci-logs refinement — a pull-card / commit-card section that
// collapses to its head row. The head is the toggle (button semantics,
// Enter/Space); interactive controls already in the head (Open on GitHub,
// Copy, the rollup chip…) must stopPropagation so they don't also fire it.
// Collapse animates with the same grid-rows motion the CI check accordion
// uses (`.ci-caret` / `.ci-reveal`, shared in pulls.css) and persists per
// section id across detail switches and restarts.

import { useState, type ReactNode } from 'react';
import { loadCollapsedSections, saveCollapsedSections, toggleCollapsedSection } from './collapsible-card';
import './pulls.css';

export interface CollapsibleCardProps {
  /** persistence key, e.g. 'description', 'checks', 'files', 'comments', 'commit-checks'. */
  id: string;
  className?: string;
  /** rendered after the caret in the head row; stays visible while collapsed. */
  head: ReactNode;
  children: ReactNode;
}

export function CollapsibleCard({ id, className, head, children }: CollapsibleCardProps): JSX.Element {
  const [open, setOpen] = useState(() => !loadCollapsedSections()[id]);

  function toggle(): void {
    const nextSections = toggleCollapsedSection(loadCollapsedSections(), id);
    saveCollapsedSections(nextSections);
    setOpen(!nextSections[id]);
  }

  const panelId = `collapsible-card-${id}`;

  return (
    <div className={className ? `pull-card ${className}` : 'pull-card'}>
      <div
        className="pull-card__head collapsible-card__head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className={open ? 'ci-caret ci-caret--open' : 'ci-caret'} aria-hidden="true">
          ▸
        </span>
        {head}
      </div>
      <div id={panelId} className={open ? 'ci-reveal ci-reveal--open' : 'ci-reveal'} aria-hidden={!open}>
        <div className="ci-reveal__inner">{children}</div>
      </div>
    </div>
  );
}
