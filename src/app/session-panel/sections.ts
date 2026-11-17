// The session panel's section registry — redesign "Graphite & Signal", Figma
// "Session panel" 130:378: Changes · Plan · Activity · Context.
//
// HOW TO ADD A SECTION (screen agents):
//  1. Build its component in the feature that owns the data, e.g.
//     src/features/agents/ActivitySection.tsx, typed `SessionPanelSectionProps`.
//     Compose it from src/ui/SidePanel.tsx: <SidePanelBody> for the scrolling
//     rows, <SidePanelFooter> (with <MeterRow> for the context readout) for the
//     pinned bottom, <SidePanelLabel> for "RUNNING 3" headings.
//  2. Append an entry below with the matching `SessionPanelTab` id (the ids and
//     their order are fixed in src/lib/sessionPanelStore.ts), a label, an icon
//     from src/ui/icons.ts, and — optionally — a `Badge` component returning the
//     compact figure the tab shows when it is NOT selected ("7", "1/4", "3").
//  3. Nothing else: the shell renders only registered sections, falls back to
//     the first one when the persisted tab is not registered, and passes every
//     section the focused session plus its context readout.

import type { ComponentType } from 'react';
import type { SessionMeta } from '../../../contract/common';
import ActivitySection, { ActivityBadge } from '../../features/agents/ActivitySection';
import ChangesSection, { ChangesBadge } from '../../features/diff/ChangesSection';
import ContextSection from '../../features/mcp/ContextSection';
import type { SessionPanelTab } from '../../lib/sessionPanelStore';
import type { IconName } from '../../ui/icons';

export { resolveSection } from './resolve-section';

/** The focused session's context occupancy, or null when it has no window to measure. */
export interface PanelContext {
  fraction: number;
  /** "134K / 1M" */
  figure: string;
}

export interface SessionPanelSectionProps {
  session: SessionMeta;
  context: PanelContext | null;
}

export interface SessionPanelSection {
  id: SessionPanelTab;
  label: string;
  icon: IconName;
  /** The compact figure on the tab; render null for none. */
  Badge?: ComponentType<{ session: SessionMeta }>;
  Body: ComponentType<SessionPanelSectionProps>;
}

export const SESSION_PANEL_SECTIONS: readonly SessionPanelSection[] = [
  { id: 'changes', label: 'Changes', icon: 'branch', Badge: ChangesBadge, Body: ChangesSection },
  { id: 'activity', label: 'Activity', icon: 'activity', Badge: ActivityBadge, Body: ActivitySection },
  { id: 'context', label: 'Context', icon: 'layers', Body: ContextSection },
];
