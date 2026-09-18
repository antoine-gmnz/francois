// multiple-shells FR-19/FR-21: the three PTY carve-outs, reachable even when
// no terminal has focus (e.g. right after clicking a chip) — a document-level
// listener this feature owns, gated purely on `mainTab === 'shell'` + an
// active session, per FR-19's own wording. The terminal-focused case is
// ShellTerminal's own `attachCustomKeyEventHandler`, which stopPropagation's
// a matched combo so it never double-fires here (FR-20).

import { useEffect } from 'react';
import type { SessionId } from '../../../contract/common';
import { useStore } from '../../lib/store';
import { shellShortcutFor } from './shell';
import { dispatchShellShortcut } from './shellActions';

export function useShellShortcuts(sessionId: SessionId | null, active: boolean): void {
  useEffect(() => {
    if (!active || !sessionId) return;
    const onKey = (e: KeyboardEvent) => {
      const combo = shellShortcutFor(e.key, e.metaKey, e.ctrlKey, e.shiftKey);
      if (!combo) return;
      // useAppShortcuts parity: a modal (new session, new agent, settings sheet,
      // permissions, projects, accounts, update) or a focused text input
      // suppresses these combos too — otherwise ⌘T/⌘W/⌃⇥/⌃⇧⇥ still mutate the
      // shell strip behind an open modal.
      const st = useStore.getState();
      const activeEl = document.activeElement as HTMLElement | null;
      const inInput = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
      if (
        st.newSessionOpen ||
        st.newAgentOpen ||
        st.permissionsOpen ||
        st.projectsOpen ||
        st.accountsOpen ||
        st.sessionSettingsId !== null ||
        st.updateModalOpen ||
        inInput
      )
        return;
      e.preventDefault();
      dispatchShellShortcut(combo, sessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionId, active]);
}
