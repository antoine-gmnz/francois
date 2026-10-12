// code-editor-agents FR-14 — `path` / `path:line` in an inline-code span. Only the
// shape is decided here; whether it links is the caller's check against the session
// root's `editor_files` list, which is relative and '/'-separated — so an absolute
// or backslashed span never matches and is refused up front.

export interface CodeRef {
  path: string;
  line?: number;
}

const REF = /^(?:\.\/)?([\w.@-][\w.@/-]*[\w.-])(?::(\d+))?$/;

export function parseCodeRef(text: string): CodeRef | null {
  const m = REF.exec(text.trim());
  if (!m) return null;
  const path = m[1];
  if (path.endsWith('/') || path.includes('//')) return null;
  if (m[2] === undefined) return { path };
  const line = Number(m[2]);
  return line >= 1 ? { path, line } : null;
}
