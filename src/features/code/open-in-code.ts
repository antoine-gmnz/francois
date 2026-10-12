// code-editor-agents FR-5 / FR-14 / FR-15 — the jumps between a session and the
// Code tab: a transcript link opens the Code tab rooted at that session on a file
// and line (⌘-click: the external editor instead); a chip confirmation's **Open**
// switches to the session it landed in. Plus the per-session file list an
// inline-code span is checked against before it links.

import { useEffect, useMemo } from 'react';
import type { SessionId } from '../../../contract/common';
import { joinRoot, normPath, relativeTo } from '../../lib/path';
import { useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { getEditorList } from '../sessions/editors';
import { useCodeStore } from './codeStore';
import { rootKey } from './editor-root';
import { openExternally } from './open-external';

function showMain(tab: 'code' | 'session'): void {
  const st = useStore.getState();
  st.setProjectsOpen(false);
  st.setAccountsOpen(false);
  st.setFocusedPane('main');
  st.setMainTab(tab);
}

const cwdOf = (sessionId: SessionId) => {
  const meta = useStore.getState().sessions.find((s) => s.id === sessionId);
  return meta ? normPath(meta.cwd) : null;
};

/** FR-15: the Code tab, rooted at the session, on `path` (absolute, or relative to its root) at `line`. */
export async function openInCode(sessionId: SessionId, path: string, line: number): Promise<void> {
  const cwd = cwdOf(sessionId);
  if (cwd === null) return;
  showMain('code');
  const abs = path.startsWith('/') || /^[A-Za-z]:/.test(path) ? path : joinRoot(cwd, path);
  await useCodeStore.getState().openAt({ kind: 'session', sessionId }, abs, line, cwd);
}

/** FR-15: ⌘-click — the existing external path (`session_open_in_editor` with file/line). */
export async function openInEditorExternally(sessionId: SessionId, path: string, line: number): Promise<void> {
  const cwd = cwdOf(sessionId);
  if (cwd === null) return;
  const [editor] = await getEditorList();
  if (!editor) return showToast('No editor detected.', 'error');
  await openExternally({ kind: 'session', sessionId }, editor, relativeTo(path, cwd) ?? path, line);
}

/** FR-5: the confirmation's **Open**. */
export function openSession(sessionId: SessionId): void {
  useStore.getState().setActiveSessionId(sessionId);
  showMain('session');
}

const requested = new Set<string>();
const pathSets = new WeakMap<readonly string[], Set<string>>();

/**
 * FR-14: whether `path` is in the session root's `editor_files` list. The list is
 * fetched once per session root, the first time a span asks, and cached in the
 * Code store like the explorer's.
 */
export function useSessionHasFile(sessionId: SessionId | null, path: string | null): boolean {
  const rk = sessionId ? rootKey({ kind: 'session', sessionId }) : '';
  const paths = useCodeStore((s) => (rk ? s.filesByRootKey[rk]?.data?.paths : undefined));
  useEffect(() => {
    if (!sessionId || !path || requested.has(rk)) return;
    requested.add(rk);
    if (!useCodeStore.getState().filesByRootKey[rk]) void useCodeStore.getState().refreshFiles({ kind: 'session', sessionId });
  }, [rk, sessionId, path]);
  return useMemo(() => {
    if (!path || !paths) return false;
    let set = pathSets.get(paths);
    if (!set) {
      set = new Set(paths);
      pathSets.set(paths, set);
    }
    return set.has(path);
  }, [paths, path]);
}
