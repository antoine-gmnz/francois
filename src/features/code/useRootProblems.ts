// code-editor-lsp FR-12: a root's problems — Monaco's markers (useMarkerFeed) plus the
// language servers' diagnostics for files that have no model (lspStore).

import { useMemo } from 'react';
import { useLspStore } from './lspStore';
import { withOrphans, type Problem } from './problems';
import { useWorkspaceStore } from './workspaceStore';

const NONE: Problem[] = [];

export function useRootProblems(rk: string): Problem[] {
  const markers = useWorkspaceStore((s) => s.problemsByRootKey[rk] ?? NONE);
  const orphans = useLspStore((s) => s.orphansByRootKey[rk]);
  return useMemo(() => withOrphans(markers, orphans), [markers, orphans]);
}
