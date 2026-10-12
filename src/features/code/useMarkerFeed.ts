// code-editor-workspace FR-3/FR-4: feeds the workspace store from Monaco — the current
// root's markers (live through `onDidChangeMarkers`) and the bundled TypeScript
// version. Mounted once by CodeView; Monaco is only loaded once a tab is open.

import { useEffect } from 'react';
import { loadMonaco } from './monaco-loader';
import { codePathOf, toProblem, type Problem } from './problems';
import { useWorkspaceStore } from './workspaceStore';

export function useMarkerFeed(rootKey: string | null, hasTabs: boolean): void {
  useEffect(() => {
    if (!rootKey || !hasTabs) return;
    let live = true;
    let sub: { dispose(): void } | null = null;
    void loadMonaco()
      .then((m) => {
        if (!live) return;
        const { monaco } = m;
        const ws = useWorkspaceStore.getState();
        if (!ws.tsVersion) ws.setTsVersion(monaco.typescript.typescriptVersion);
        const read = () => {
          const out: Problem[] = [];
          for (const marker of monaco.editor.getModelMarkers({})) {
            const uri = marker.resource;
            if (uri.scheme !== 'inmemory') continue;
            const path = codePathOf(rootKey, uri.path);
            // A disposed model's markers go with it (§7); belt and braces for stragglers.
            if (path === null || !monaco.editor.getModel(uri)) continue;
            out.push(toProblem(path, marker));
          }
          useWorkspaceStore.getState().setProblems(rootKey, out);
        };
        read();
        sub = monaco.editor.onDidChangeMarkers(read);
      })
      .catch(() => {});
    return () => {
      live = false;
      sub?.dispose();
    };
  }, [rootKey, hasTabs]);
}
