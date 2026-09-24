// github-ci-logs FR-9..FR-12 — the in-app log viewer for one step. Rendered
// inline under the step row (PR detail) or inside a wide Modal (commit
// detail); the wrapper decides that, this component only owns the toolbar +
// the folded lines.

import { useEffect, useRef, useState } from 'react';
import type { CheckJob, JobStep, StepLog } from '../../../contract/github-page';
import { githubGetStepLog } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { LoaderCaret } from '../../ui/Loaders';
import { showToast } from '../palette/palette';
import { openOnGithub } from './actions';
import { foldGroups, type FoldedItem } from './ci-logs';

export interface StepLogPanelProps {
  cwd: string;
  job: CheckJob;
  step: JobStep;
}

interface Loaded {
  status: 'loaded';
  log: StepLog;
}
type LoadState = { status: 'loading' } | { status: 'error'; code: string; message: string } | Loaded;

export function StepLogPanel({ cwd, job, step }: StepLogPanelProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [collapsedGroups, setCollapsedGroups] = useState<Record<number, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = async (): Promise<void> => {
    setState({ status: 'loading' });
    const res = await githubGetStepLog({ cwd, jobId: job.jobId, stepNumber: step.number });
    if (res.ok) {
      setState({ status: 'loaded', log: res.data });
      setCollapsedGroups({});
    } else {
      setState({ status: 'error', code: res.error.code, message: res.error.message });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- known backlog (PIPELINE.md §Code quality gates)
  }, [cwd, job.jobId, step.number]);

  // FR-10: scroll so firstErrorLine sits ~5 lines from the top; no error -> bottom.
  useEffect(() => {
    if (state.status !== 'loaded') return;
    const el = scrollRef.current;
    if (!el) return;
    if (state.log.firstErrorLine !== undefined) {
      const target = el.querySelector<HTMLElement>(`[data-line-n="${state.log.firstErrorLine}"]`);
      if (target) el.scrollTop = Math.max(0, target.offsetTop - 5 * 18);
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [state]);

  async function copy(): Promise<void> {
    if (state.status !== 'loaded') return;
    const lines: string[] = [];
    if (state.log.droppedLines > 0) {
      lines.push(`Showing the last ${state.log.lines.length} of ${state.log.totalLines} lines · Open on GitHub for the full log`);
    }
    lines.push(...state.log.lines.map((l) => l.text));
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      showToast('Copied', 'success');
    } catch {
      showToast('Could not copy', 'error');
    }
  }

  const title = state.status === 'loaded' && state.log.stepNumber === 0 ? 'Full job log' : `Step ${step.number} · ${step.name}`;

  return (
    <div className="ci-log">
      <div className="ci-log__toolbar">
        <span className="ci-log__title">{title}</span>
        <span className="pull-row__sp" />
        {state.status === 'loaded' && (
          <button type="button" className="ci-log__icon-btn" title="Copy log" aria-label="Copy log" onClick={() => void copy()}>
            <Icon name="doc" size={13} />
          </button>
        )}
        <button
          type="button"
          className="ci-log__icon-btn"
          title="Open on GitHub"
          aria-label="Open on GitHub"
          onClick={() => void openOnGithub(cwd, job.htmlUrl)}
        >
          <Icon name="external" size={13} />
        </button>
      </div>
      {state.status === 'loaded' && state.log.droppedLines > 0 && (
        <p className="ci-log__notice">
          Showing the last {state.log.lines.length} of {state.log.totalLines} lines · Open on GitHub for the full log
        </p>
      )}
      <div className={state.status === 'loaded' ? 'ci-log__body ci-fade-in' : 'ci-log__body'} ref={scrollRef}>
        {state.status === 'loading' && (
          <p className="ci-log__state">
            <LoaderCaret label="Loading log" />
          </p>
        )}
        {state.status === 'error' && <LogError code={state.code} message={state.message} onRetry={() => void load()} onOpen={() => void openOnGithub(cwd, job.htmlUrl)} />}
        {state.status === 'loaded' &&
          foldGroups(state.log.lines, state.log.firstErrorLine).map((item, i) => (
            <FoldedRow
              key={i}
              item={item}
              collapsed={item.kind === 'group' ? (collapsedGroups[item.startN] ?? item.collapsedByDefault) : false}
              onToggle={() =>
                item.kind === 'group' &&
                setCollapsedGroups((s) => ({ ...s, [item.startN]: !(s[item.startN] ?? item.collapsedByDefault) }))
              }
            />
          ))}
      </div>
    </div>
  );
}

function LogError({ code, message, onRetry, onOpen }: { code: string; message: string; onRetry: () => void; onOpen: () => void }): JSX.Element {
  if (code === 'GH_LOG_NOT_READY') return <p className="ci-log__state">Log available when the job finishes</p>;
  if (code === 'GH_LOG_GONE') {
    return (
      <p className="ci-log__state">
        GitHub no longer keeps this log.
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Open on GitHub
        </Button>
      </p>
    );
  }
  if (code === 'GH_LOG_TOO_LARGE') {
    return (
      <p className="ci-log__state">
        Log too large to show (&gt; 32 MiB).
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Open on GitHub
        </Button>
      </p>
    );
  }
  return (
    <p className="ci-log__state">
      {message}
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </p>
  );
}

function FoldedRow({ item, collapsed, onToggle }: { item: FoldedItem; collapsed: boolean; onToggle: () => void }): JSX.Element {
  if (item.kind === 'group') {
    return (
      <div className="ci-log__group">
        <button type="button" className="ci-log__group-head" aria-expanded={!collapsed} onClick={onToggle}>
          <span className={collapsed ? 'ci-caret ci-log__caret' : 'ci-caret ci-log__caret ci-caret--open'} aria-hidden="true">
            ▸
          </span>
          <span>
            {item.title} · {item.lines.length} lines
          </span>
        </button>
        {!collapsed && item.lines.map((l) => <LogLineRow key={l.n} line={l} />)}
      </div>
    );
  }
  return <LogLineRow line={item.line} />;
}

function LogLineRow({ line }: { line: { n: number; text: string; kind: string } }): JSX.Element {
  return (
    <div className={`ci-log__line ci-log__line--${line.kind}`} data-line-n={line.n}>
      <span className="ci-log__gutter">{line.n}</span>
      <span className="ci-log__text">{line.text}</span>
    </div>
  );
}
