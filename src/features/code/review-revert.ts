// code-editor-agents FR-11/FR-12 — Review's per-hunk Revert, as a pure function over
// Monaco's ILineChange shape (declared here so nothing outside the Monaco host
// imports monaco-editor). `originalEndLineNumber === 0` is an insertion after
// `originalStartLineNumber`; `modifiedEndLineNumber === 0` is a deletion after
// `modifiedStartLineNumber`.

export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

export interface Reverted {
  text: string;
  /** FR-12: the reverted range, in pre-revert buffer lines. */
  startLine: number;
  endLine: number;
}

export function revertHunk(buffer: string, head: string, c: LineChange): Reverted {
  const mod = buffer.split('\n');
  const orig = head.split('\n');
  const headLines = c.originalEndLineNumber === 0 ? [] : orig.slice(c.originalStartLineNumber - 1, c.originalEndLineNumber);
  if (c.modifiedEndLineNumber === 0) {
    mod.splice(c.modifiedStartLineNumber, 0, ...headLines);
    const at = Math.max(c.modifiedStartLineNumber, 1);
    return { text: mod.join('\n'), startLine: at, endLine: at };
  }
  mod.splice(c.modifiedStartLineNumber - 1, c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1, ...headLines);
  return { text: mod.join('\n'), startLine: c.modifiedStartLineNumber, endLine: c.modifiedEndLineNumber };
}

/** The hunk under a hovered modified line: one it spans, or a deletion anchored on it. */
export function hunkAt<C extends LineChange>(changes: readonly C[], line: number): C | null {
  for (const c of changes) {
    if (c.modifiedEndLineNumber === 0) {
      if (Math.max(c.modifiedStartLineNumber, 1) === line) return c;
    } else if (line >= c.modifiedStartLineNumber && line <= c.modifiedEndLineNumber) return c;
  }
  return null;
}
