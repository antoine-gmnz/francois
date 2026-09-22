// Figma "Tab" (125:7944) + the segmented track the session header draws around
// three of them ("View tabs"). A Tab is a 28px pill: selected = --bg-selected
// fill + primary text, unselected = muted text. `count` renders the small mono
// count pill after the label (Changes 7). Use TabGroup for the recessed track.

import type { ReactNode } from 'react';
import './ui.css';

export type TabSize = 'md' | 'sm';

export function tabClassName(selected: boolean, size: TabSize = 'md', className?: string): string {
  const parts = ['tab'];
  if (selected) parts.push('tab--selected');
  if (size === 'sm') parts.push('tab--sm');
  if (className) parts.push(className);
  return parts.join(' ');
}

export interface TabProps {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
  /** Leading glyph (an <Icon />). */
  icon?: ReactNode;
  /** Count pill after the label; hidden when undefined, 0 or ''. */
  count?: number | string;
  size?: TabSize;
  title?: string;
  className?: string;
}

export function Tab({ selected, onSelect, children, icon, count, size = 'md', title, className }: TabProps): JSX.Element {
  const showCount = count !== undefined && count !== 0 && count !== '';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      title={title}
      className={tabClassName(selected, size, className)}
      onClick={onSelect}
    >
      {icon}
      <span className="tab__label">{children}</span>
      {showCount && <span className="tab__count">{count}</span>}
    </button>
  );
}

/** The recessed track a set of Tabs sits in (Figma "View tabs"). */
export function TabGroup({ children, className, label }: { children: ReactNode; className?: string; label?: string }): JSX.Element {
  return (
    <div role="tablist" aria-label={label} className={className ? `tab-group ${className}` : 'tab-group'}>
      {children}
    </div>
  );
}
