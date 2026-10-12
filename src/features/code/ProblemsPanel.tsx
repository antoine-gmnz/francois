// code-editor-workspace FR-3 — the PROBLEMS panel under the editor groups (Figma 52):
// a header (tab + count, filter, maximise, close) over one group per file and one row
// per marker. A row opens its file in the focused group with the caret on the marker.

import { useMemo, useState } from 'react';
import { CircleX, Maximize2, Minimize2 } from 'lucide-react';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { useCodeStore } from './codeStore';
import { codeLabel, groupProblems, type Problem } from './problems';
import { useRootProblems } from './useRootProblems';
import { useWorkspaceStore } from './workspaceStore';
import './code-workspace.css';


export function SeverityIcon({ severity }: { severity: Problem['severity'] }): JSX.Element {
  if (severity === 'error') return <CircleX size={14} className="code-sev code-sev--error" aria-label="Error" />;
  if (severity === 'warning') return <Icon name="warn" size={14} className="code-sev code-sev--warning" title="Warning" />;
  return <Icon name="info" size={14} className="code-sev code-sev--info" title="Info" />;
}

export default function ProblemsPanel({ rootKey }: { rootKey: string }): JSX.Element {
  const problems = useRootProblems(rootKey);
  const filter = useWorkspaceStore((s) => s.problemFilter);
  const maximized = useWorkspaceStore((s) => s.problemsMaximized);
  const { setProblemFilter, toggleMaximized, toggleProblems } = useWorkspaceStore.getState();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => groupProblems(problems, filter), [problems, filter]);

  const fold = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const open = (p: Problem) =>
    void useCodeStore.getState().revealRange(p.path, { startLineNumber: p.line, startColumn: p.column, endLineNumber: p.line, endColumn: p.column });

  return (
    <section className={maximized ? 'code-problems code-problems--max' : 'code-problems'} aria-label="Problems">
      <header className="code-problems__header">
        <span className="code-problems__tab">
          Problems
          <span className="code-problems__count">{problems.length}</span>
        </span>
        <input
          className="code-problems__filter"
          placeholder="Filter problems…"
          aria-label="Filter problems"
          value={filter}
          onChange={(e) => setProblemFilter(e.target.value)}
        />
        <IconButton title={maximized ? 'Restore panel size' : 'Maximise panel'} size={24} className="code-problems__action" onClick={toggleMaximized}>
          {maximized ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
        </IconButton>
        <IconButton title="Close · ⌘⇧M" size={24} className="code-problems__action" onClick={toggleProblems}>
          <Icon name="x" size={13} />
        </IconButton>
      </header>
      <div className="code-problems__body" role="tree">
        {groups.length === 0 && (
          <p className="code-problems__empty">{problems.length === 0 ? 'No problems in the open files.' : 'No problems match the filter.'}</p>
        )}
        {groups.map((g) => {
          const open_ = !collapsed.has(g.path);
          return (
            <div key={g.path} role="treeitem" aria-expanded={open_}>
              <div className="code-problems__file" title={g.path} onClick={() => fold(g.path)}>
                <span className={open_ ? 'code-tree__chevron code-tree__chevron--open' : 'code-tree__chevron'}>
                  <Icon name="chevron-right" size={12} />
                </span>
                <Icon name="file" size={14} className="code-problems__file-icon" />
                <span className="code-problems__name">{g.name}</span>
                {g.dir && <span className="code-problems__dir">{g.dir}</span>}
                <span className="code-problems__badge">{g.problems.length}</span>
              </div>
              {open_ &&
                g.problems.map((p, i) => (
                  <div key={i} className="code-problems__row" role="button" tabIndex={0} onClick={() => open(p)} onKeyDown={(e) => e.key === 'Enter' && open(p)}>
                    <SeverityIcon severity={p.severity} />
                    <span className="code-problems__message">{p.message}</span>
                    {p.code && <span className="code-problems__meta">{codeLabel(p)}</span>}
                    <span className="code-problems__meta">
                      [Ln {p.line}, Col {p.column}]
                    </span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
