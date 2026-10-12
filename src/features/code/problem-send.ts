// code-editor-workspace FR-9 — every Monaco marker contributes one more code action,
// "Send to <target> with this problem", and ⌘L on a marker with nothing selected does
// the same: the marker's line(s) go to the session as a selection chip whose note is
// the message + `ts(code)`, through the editor's own useChipSender path.
//
// Monaco's code-action providers are global (per language, not per editor), so the
// mounted CodeEditors register a target per model URI here and the one provider —
// installed once by monaco-setup — routes through it.

import type * as Monaco from 'monaco-editor';
import type { ContextChip } from '../../../contract/code-editor-agents';
import { selectionChip } from '../../lib/context-chips';
import { resolveTarget, type TargetSession } from './send-target';

export const SEND_PROBLEM_COMMAND = 'francois.code.sendProblem';

/** The slice of Monaco's IMarkerData this feature reads. */
export interface ProblemMarker {
  severity: number;
  message: string;
  code?: string | { value: string; target?: unknown };
  source?: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

const holds = (m: ProblemMarker, line: number, col: number): boolean => {
  if (line < m.startLineNumber || line > m.endLineNumber) return false;
  if (line === m.startLineNumber && col < m.startColumn) return false;
  if (line === m.endLineNumber && col > m.endColumn) return false;
  return true;
};

const span = (m: ProblemMarker) => (m.endLineNumber - m.startLineNumber) * 100_000 + (m.endColumn - m.startColumn);

/** The marker under the caret: the most severe, then the narrowest. */
export function markerAt<M extends ProblemMarker>(markers: readonly M[], line: number, col: number): M | null {
  let best: M | null = null;
  for (const m of markers) {
    if (!holds(m, line, col)) continue;
    if (!best || m.severity > best.severity || (m.severity === best.severity && span(m) < span(best))) best = m;
  }
  return best;
}

/** `<message> ts(<code>)` — the marker's own source when it names one. */
export function problemNote(m: ProblemMarker): string {
  const code = typeof m.code === 'string' ? m.code : m.code?.value;
  return code ? `${m.message} ${m.source || 'ts'}(${code})` : m.message;
}

export function problemChip(m: ProblemMarker, lineAt: (line: number) => string, at: { path: string; language?: string; now: number }): ContextChip {
  const lines: string[] = [];
  for (let l = m.startLineNumber; l <= m.endLineNumber; l++) lines.push(lineAt(l));
  return { ...selectionChip({ path: at.path, startLine: m.startLineNumber, lines, language: at.language, now: at.now }), note: problemNote(m) };
}

/** The action title, naming the target as code-editor-agents FR-5 resolves it. */
export function problemTargetTitle(sessions: readonly TargetSession[], rootDir: string): string {
  const r = resolveTarget(sessions, rootDir);
  const name = r.kind === 'direct' ? sessions.find((s) => s.id === r.sessionId)?.name : undefined;
  return `Send to ${name || 'session'} with this problem`;
}

export interface ProblemAction<M> {
  title: string;
  kind: string;
  diagnostics: M[];
  isPreferred: boolean;
  command: { id: string; title: string; arguments: [string, M] };
}

export function problemActions<M extends ProblemMarker>(markers: readonly M[], title: string, uri: string): ProblemAction<M>[] {
  return markers.map((m) => ({
    title,
    kind: 'quickfix',
    diagnostics: [m],
    isPreferred: false,
    command: { id: SEND_PROBLEM_COMMAND, title, arguments: [uri, m] },
  }));
}

export interface ProblemTarget {
  title: () => string;
  send: (marker: ProblemMarker) => void;
}

/** Model URI → the editors showing it; the last registered or focused one answers. */
export class ProblemTargets {
  private byUri = new Map<string, ProblemTarget[]>();

  register(uri: string, target: ProblemTarget): () => void {
    this.focus(uri, target);
    return () => {
      const list = (this.byUri.get(uri) ?? []).filter((t) => t !== target);
      if (list.length) this.byUri.set(uri, list);
      else this.byUri.delete(uri);
    };
  }

  focus(uri: string, target: ProblemTarget): void {
    this.byUri.set(uri, [...(this.byUri.get(uri) ?? []).filter((t) => t !== target), target]);
  }

  get(uri: string): ProblemTarget | undefined {
    const list = this.byUri.get(uri);
    return list?.[list.length - 1];
  }
}

export const problemTargets = new ProblemTargets();

/** Once, from monaco-setup: the provider for every language + the command it invokes. */
export function installProblemActions(monaco: typeof Monaco): void {
  monaco.editor.registerCommand(SEND_PROBLEM_COMMAND, (_accessor, uri: string, marker: ProblemMarker) => {
    problemTargets.get(uri)?.send(marker);
  });
  monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, _range, context) {
      const uri = model.uri.toString();
      const target = problemTargets.get(uri);
      if (!target || context.markers.length === 0) return { actions: [], dispose: () => {} };
      return { actions: problemActions(context.markers, target.title(), uri), dispose: () => {} };
    },
  });
}
