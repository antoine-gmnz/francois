// session-panel store slice: the right-hand session panel of the redesign
// ("Graphite & Signal", Figma "Session panel" 130:378) — whether it is open and
// which of its tabs is showing. Both are window chrome, so both persist to
// localStorage. `]` and the session header's panel toggle flip it; picking a tab
// always opens it. The panel's CONTENT registry lives in src/app/session-panel/.

import type { StateCreator } from 'zustand';
import type { AppState } from './store';

/** The panel's tabs, in the design's order. cohorte-integration FR-67: `cohorte`
 *  is last, and only shown where a Cohorte project is detected. */
export const SESSION_PANEL_TABS = ['changes', 'plan', 'activity', 'context', 'cohorte'] as const;
export type SessionPanelTab = (typeof SESSION_PANEL_TABS)[number];

const OPEN_KEY = 'francois.sessionPanel';
const TAB_KEY = 'francois.sessionPanelTab';

/** Open unless the stored flag is exactly '0'. */
export function parseSessionPanelOpen(raw: string | null): boolean {
  return raw !== '0';
}

export function parseSessionPanelTab(raw: string | null): SessionPanelTab {
  return (SESSION_PANEL_TABS as readonly string[]).includes(raw ?? '') ? (raw as SessionPanelTab) : 'changes';
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export interface SessionPanelSlice {
  showSessionPanel: boolean;
  sessionPanelTab: SessionPanelTab;
  toggleSessionPanel: () => void;
  setShowSessionPanel: (open: boolean) => void;
  /** Switch tab — and open the panel if it was closed. */
  setSessionPanelTab: (tab: SessionPanelTab) => void;
}

export const createSessionPanelSlice: StateCreator<AppState, [], [], SessionPanelSlice> = (set) => ({
  showSessionPanel: parseSessionPanelOpen(read(OPEN_KEY)),
  sessionPanelTab: parseSessionPanelTab(read(TAB_KEY)),
  toggleSessionPanel: () =>
    set((s) => {
      const next = !s.showSessionPanel;
      write(OPEN_KEY, next ? '1' : '0');
      return { showSessionPanel: next };
    }),
  setShowSessionPanel: (open) => {
    write(OPEN_KEY, open ? '1' : '0');
    set({ showSessionPanel: open });
  },
  setSessionPanelTab: (tab) => {
    write(TAB_KEY, tab);
    write(OPEN_KEY, '1');
    set({ sessionPanelTab: tab, showSessionPanel: true });
  },
});
