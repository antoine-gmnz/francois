// code-editor FR-2: the Code tab's body — Explorer (288px) + Editor, in place of the
// roster, the main column and the session panel (Figma 45 · Code / Editor, 46 · No
// file open). Owns the root resolution (FR-3), the tree refresh triggers (FR-5),
// the ⌘S / ⌘W / ⌘P chords, and the FR-14 single-key fence.

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useStore } from '../../lib/store';
import { isSingleKey } from '../../app/shortcut-guard';
import { useCodeStore } from './codeStore';
import { defaultRoot, rootExists, rootKey } from './editor-root';
import EditorArea from './EditorArea';
import Explorer from './Explorer';
import GoToFile from './GoToFile';
import { CloseTabPrompt } from './CloseTabPrompt';
import './code.css';

export default function CodeView(): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const setRoot = useCodeStore((s) => s.setRoot);
  const goToFileOpen = useCodeStore((s) => s.goToFileOpen);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const [closing, setClosing] = useState<string | null>(null);

  // FR-3 / flow 1: first entry (or a root that vanished) picks the default root;
  // re-entering keeps whatever was chosen (FR-2).
  useEffect(() => {
    if (root && rootExists(root, projects, sessions)) return;
    const st = useStore.getState();
    const next = defaultRoot({ activeSessionId: st.activeSessionId, activeProjectId: st.activeProjectId, sessions, projects });
    if (next) setRoot(next);
  }, [root, projects, sessions, setRoot]);

  // FR-5: refresh when the Code tab gains focus (mount / root change) and when the
  // window regains focus.
  const rk = root ? rootKey(root) : null;
  useEffect(() => {
    if (!rk) return;
    const refresh = () => void useCodeStore.getState().refreshFiles();
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [rk]);

  // ⌘S save · ⌘W close tab · ⌘P go to file. Capture phase, so they win over Monaco
  // and every bubble listener; ⌘K stays the app's (useAppShortcuts' own capture).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== 's' && key !== 'w' && key !== 'p') return;
      const st = useCodeStore.getState();
      if (!st.root) return;
      e.preventDefault();
      e.stopPropagation();
      const k = rootKey(st.root);
      const active = st.tabsByRootKey[k]?.active;
      if (key === 'p') return st.setGoToFileOpen(true);
      if (!active) return;
      if (key === 's') return void st.save(k, active);
      const tab = st.tabsByRootKey[k]?.tabs.find((t) => t.path === active);
      if (tab?.dirty) setClosing(active);
      else void st.closeTab(k, active);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // FR-14: no single key typed anywhere in the Code view reaches a window-level
  // shortcut listener (Monaco's own handlers sit below this node and already ran).
  const fence = (e: ReactKeyboardEvent) => {
    if (isSingleKey(e)) e.stopPropagation();
  };

  return (
    <div className="code-view" onKeyDown={fence}>
      <Explorer />
      <EditorArea onRequestClose={setClosing} />
      {goToFileOpen && <GoToFile />}
      {closing && rk && <CloseTabPrompt rootKey={rk} path={closing} onDone={() => setClosing(null)} />}
    </div>
  );
}
