// code-editor-workspace FR-3/FR-4: Monaco markers → problems. Pure: the marker shape
// is structural (no monaco import), the panel and the counts read from here.

export type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint';

/** The fields of `monaco.editor.IMarker` this module reads. */
export interface MarkerLike {
  severity: number;
  message: string;
  code?: string | { value: string; target: unknown };
  source?: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface Problem {
  /** Root-relative path of the file. */
  path: string;
  severity: ProblemSeverity;
  message: string;
  /** The bare code — null when the marker carries none. */
  code: string | null;
  /** The marker's source (`ts`, `rustc`, …); null when it names none (Monaco's own TS markers). */
  source: string | null;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface ProblemGroup {
  path: string;
  name: string;
  dir: string;
  problems: Problem[];
}

/** The model uri path monaco-models.ts gives a Code-tab buffer. */
export const modelUriPath = (rootKey: string, path: string) => `/${encodeURIComponent(rootKey)}/${path}`;

/** The root key and root-relative path behind any Code-tab model uri path. */
export function parseModelUriPath(uriPath: string): { rootKey: string; path: string } | null {
  const cut = uriPath.indexOf('/', 1);
  if (!uriPath.startsWith('/') || cut < 0 || cut === uriPath.length - 1) return null;
  try {
    return { rootKey: decodeURIComponent(uriPath.slice(1, cut)), path: uriPath.slice(cut + 1) };
  } catch {
    return null;
  }
}

/** code-editor-lsp FR-12: how a problem's code reads — `<source>(<code>)`, `ts(<code>)` when no source. */
export function codeLabel(p: Pick<Problem, 'code' | 'source'>): string | null {
  return p.code ? `${p.source || 'ts'}(${p.code})` : null;
}

/** The root-relative path behind a model uri path, or null when it is not this root's. */
export function codePathOf(rootKey: string, uriPath: string): string | null {
  const prefix = `/${encodeURIComponent(rootKey)}/`;
  return uriPath.startsWith(prefix) ? uriPath.slice(prefix.length) : null;
}

// monaco.MarkerSeverity: Hint 1 · Info 2 · Warning 4 · Error 8.
function severityOf(n: number): ProblemSeverity {
  if (n >= 8) return 'error';
  if (n >= 4) return 'warning';
  if (n >= 2) return 'info';
  return 'hint';
}

export function toProblem(path: string, m: MarkerLike): Problem {
  const code = m.code === undefined ? null : typeof m.code === 'string' ? m.code : m.code.value;
  return {
    path,
    severity: severityOf(m.severity),
    message: m.message,
    code: code || null,
    source: m.source || null,
    line: m.startLineNumber,
    column: m.startColumn,
    endLine: m.endLineNumber,
    endColumn: m.endColumn,
  };
}

export function problemCounts(problems: readonly Problem[]): { errors: number; warnings: number; infos: number } {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const p of problems) {
    if (p.severity === 'error') errors++;
    else if (p.severity === 'warning') warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

const RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

export function groupProblems(problems: readonly Problem[], filter: string): ProblemGroup[] {
  const q = filter.trim().toLowerCase();
  const byPath = new Map<string, Problem[]>();
  for (const p of problems) {
    if (q && !p.message.toLowerCase().includes(q) && !p.path.toLowerCase().includes(q)) continue;
    const list = byPath.get(p.path) ?? [];
    list.push(p);
    byPath.set(p.path, list);
  }
  return [...byPath.keys()].sort().map((path) => {
    const cut = path.lastIndexOf('/');
    const rows = (byPath.get(path) ?? []).sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.line - b.line || a.column - b.column);
    return { path, name: path.slice(cut + 1), dir: cut < 0 ? '' : path.slice(0, cut), problems: rows };
  });
}

/** code-editor-lsp FR-12: the panel's source — markers ∪ the diagnostics of files with no model. */
export function withOrphans(markers: Problem[], orphans: Record<string, { problems: Problem[] }> | undefined): Problem[] {
  if (!orphans) return markers;
  const extra = Object.values(orphans).flatMap((o) => o.problems);
  return extra.length ? [...markers, ...extra] : markers;
}
