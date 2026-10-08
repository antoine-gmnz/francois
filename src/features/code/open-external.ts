// code-editor FR-15: "Open in VS Code" at the current file and line. A session root
// goes through open-in-vscode's `session_open_in_editor` (with its new file/line); a
// project root through `editor_open_external`. The control is hidden when no editor
// is detected — the first detected editor (open-in-vscode's probe order) is used.

import { useEffect, useState } from 'react';
import type { EditorRoot } from '../../../contract/code-editor';
import type { EditorInfo } from '../../../contract/open-in-vscode';
import { editorOpenExternal, sessionOpenInEditor } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { getEditorList } from '../sessions/editors';

export async function openExternally(root: EditorRoot, editor: EditorInfo, file: string, line?: number): Promise<void> {
  const at = line === undefined ? {} : { line };
  const res =
    root.kind === 'session'
      ? await sessionOpenInEditor({ sessionId: root.sessionId, editorId: editor.id, file, ...at })
      : await editorOpenExternal({ root, editorId: editor.id, file, ...at });
  if (!res.ok) showToast(res.error.message, 'error');
}

/** The editor Open in VS Code launches, or null while none is detected. */
export function useDetectedEditor(): EditorInfo | null {
  const [editor, setEditor] = useState<EditorInfo | null>(null);
  useEffect(() => {
    let live = true;
    void getEditorList().then((editors) => {
      if (live) setEditor(editors[0] ?? null);
    });
    return () => {
      live = false;
    };
  }, []);
  return editor;
}
