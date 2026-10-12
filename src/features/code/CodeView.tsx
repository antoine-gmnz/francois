// code-editor FR-2: the Code tab's body, in place of the roster, the main column and
// the session panel (Figma 45 · Code / Editor, 46 · No file open). Owns the root
// resolution (FR-3), the tree refresh triggers (FR-5), the chords, and the FR-14
// single-key fence. code-editor-workspace (Figma 52): the activity bar, the sidebar
// switching between Explorer and Search (FR-1/FR-12), and the workspace chords —
// ⌘S / ⌘W / ⌘P on the focused group, ⌘\ split, ⌘⇧F search, ⌘⇧M problems.

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useStore } from '../../lib/store';
import { isSingleKey } from '../../app/shortcut-guard';
import { groupsOfRoot, useCodeStore } from './codeStore';
import { defaultRoot, rootExists, rootKey } from './editor-root';
import ActivityBar from './ActivityBar';
import EditorArea from './EditorArea';
import Explorer from './Explorer';
import SearchView from './SearchView';
import ChangesView from './ChangesView';
import ExtensionsView from './ExtensionsView';
import { CloseTabPrompt } from './CloseTabPrompt';
import { codeChord } from './code-chords';
import { useMarkerFeed } from './useMarkerFeed';
import { useWorkspaceStore } from './workspaceStore';
import { useVsxStore } from './vsxStore';
import './code.css';
import './code-workspace.css';

export default function CodeView(): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const setRoot = useCodeStore((s) => s.setRoot);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const sidebar = useWorkspaceStore((s) => s.sidebar);
  const [closing, setClosing] = useState<string | null>(null);
  const rk = root ? rootKey(root) : null;
  const hasTabs = useCodeStore((s) => (rk ? (s.tabsByRootKey[rk]?.tabs.length ?? 0) > 0 : false));
  useMarkerFeed(rk, hasTabs);

  // FR-3 / flow 1: first entry (or a root that vanished) picks the default root;
  // re-entering keeps whatever was chosen (FR-2).
  useEffect(() => {
    if (root && rootExists(root, projects, sessions)) return;
    const st = useStore.getState();
    const next = defaultRoot({ activeSessionId: st.activeSessionId, activeProjectId: st.activeProjectId, sessions, projects });
    if (next) setRoot(next);
  }, [root, projects, sessions, setRoot]);

  // code-editor-vsx FR-10: the enabled extensions' contributions, read on every mount
  // (local, no network); vsx-apply.ts applies them once Monaco is up.
  useEffect(() => {
    void useVsxStore.getState().reloadContributions();
  }, []);

  // FR-5: refresh when the Code tab gains focus (mount / root change) and when the
  // window regains focus.
  useEffect(() => {
    if (!rk) return;
    const refresh = () => void useCodeStore.getState().refreshFiles();
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [rk]);

  // Capture phase, so they win over Monaco and every bubble listener; ⌘K stays the
  // app's (useAppShortcuts' own capture).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chord = codeChord(e);
      if (!chord) return;
      const st = useCodeStore.getState();
      if (!st.root) return;
      e.preventDefault();
      e.stopPropagation();
      if (chord === 'quick-open') return st.setGoToFileOpen(true);
      if (chord === 'search') return useWorkspaceStore.getState().showSearch();
      if (chord === 'problems') return useWorkspaceStore.getState().toggleProblems();
      if (chord === 'split') return st.splitEditor();
      const k = rootKey(st.root);
      const g = groupsOfRoot(st, k);
      const active = g.groups[g.focused]?.active;
      if (!active) return;
      if (chord === 'save') return void st.save(k, active);
      const tab = st.tabsByRootKey[k]?.tabs.find((t) => t.path === active);
      const elsewhere = g.groups.some((x, i) => i !== g.focused && x.paths.includes(active));
      // §7: a dirty tab still open in the other group closes here without a prompt.
      if (tab?.dirty && !elsewhere) setClosing(active);
      else void st.closeInGroup(k, g.focused, active);
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
    <div className={sidebar ? 'code-view' : 'code-view code-view--collapsed'} onKeyDown={fence}>
      <ActivityBar />
      {sidebar === 'explorer' && <Explorer />}
      {sidebar === 'search' && <SearchView />}
      {sidebar === 'changes' && <ChangesView />}
      {sidebar === 'extensions' && <ExtensionsView />}
      <EditorArea onRequestClose={setClosing} />
      {closing && rk && <CloseTabPrompt rootKey={rk} path={closing} onDone={() => setClosing(null)} />}
    </div>
  );
}
