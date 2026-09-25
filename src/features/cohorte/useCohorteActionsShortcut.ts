// cohorte-actions FR-33 — `⌘⇧C` (Ctrl+Shift+C on Windows/Linux) opens the
// actions menu while the session view has focus, not the terminal. Mirrors
// multiple-shells' useShellShortcuts: a document-level listener, suppressed by
// the same modals/inputs it already excludes.

import { useEffect } from 'react';
import type { SessionId } from '../../../contract/common';
import { useStore } from '../../lib/store';
import { useCohorteActionsStore } from '../../lib/cohorteActionsStore';

function isCohorteActionsCombo(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === 'c' && e.shiftKey && (e.metaKey || e.ctrlKey);
}

export function useCohorteActionsShortcut(sessionId: SessionId | null, active: boolean): void {
  useEffect(() => {
    if (!active || !sessionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isCohorteActionsCombo(e)) return;
      const st = useStore.getState();
      const activeEl = document.activeElement as HTMLElement | null;
      const inInput = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
      const inTerminal = !!activeEl?.closest?.('.xterm');
      if (
        st.newSessionOpen ||
        st.newAgentOpen ||
        st.permissionsOpen ||
        st.projectsOpen ||
        st.accountsOpen ||
        st.sessionSettingsId !== null ||
        st.updateModalOpen ||
        st.mainTab === 'shell' ||
        inTerminal
      )
        return;
      e.preventDefault();
      if (inInput && activeEl?.tagName !== 'TEXTAREA') return;
      useCohorteActionsStore.getState().openMenu(sessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionId, active]);
}
