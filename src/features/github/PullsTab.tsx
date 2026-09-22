// github-page — Pull requests tab (specs/github-page.md FR-4..FR-6, frame 29
// `160:15836`). Left rail 432px (filter + rows) + detail pane (PullDetail).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GithubRepoInfo, PullSummary } from '../../../contract/github-page';
import { githubListPulls } from '../../lib/api';
import { useStore } from '../../lib/store';
import { EmptyPane } from '../../ui/EmptyPane';
import { HintBar } from '../../ui/HintBar';
import { Icon } from '../../ui/Icon';
import { LoaderPane } from '../../ui/Loader';
import { consumePendingPull } from './github-tab-state';
import { sessionForBranch } from './linkage';
import { PullDetail } from './PullDetail';
import { checkRollupChip, filterMatchesPull, ghUnavailableMessage, pullReviewText, pullRelativeTime, pullStateIcon } from './pulls';
import { useLatestRequest } from './useLatestRequest';
import './pulls.css';

export interface PullsTabProps {
  cwd: string;
  repo: GithubRepoInfo;
  refreshKey: number;
}

export function PullsTab({ cwd, repo, refreshKey }: PullsTabProps): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const [pulls, setPulls] = useState<PullSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const beginRequest = useLatestRequest();

  const ghAvailable = repo.gh === 'ok';

  const load = useMemo(
    () => async () => {
      if (!ghAvailable) return;
      const isCurrent = beginRequest();
      setLoading(true);
      setError(null);
      const res = await githubListPulls({ cwd });
      if (!isCurrent()) return;
      setLoading(false);
      if (res.ok) setPulls(res.data);
      else setError(res.error.message);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- beginRequest is a stable identity from useLatestRequest
    [cwd, ghAvailable],
  );

  useEffect(() => {
    setPulls(null);
    setSelected(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- known backlog (PIPELINE.md §Code quality gates)
  }, [cwd, refreshKey, ghAvailable]);

  const filtered = useMemo(() => (pulls ?? []).filter((p) => filterMatchesPull(p, query)), [pulls, query]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelected(null);
      return;
    }
    // BranchesTab's PULL REQUEST column arms this via selectPullInTab() — a
    // one-shot module read, consumed as soon as the list it targets is ready.
    const pending = consumePendingPull();
    if (pending !== null && filtered.some((p) => p.number === pending)) {
      setSelected(pending);
      return;
    }
    if (selected === null || !filtered.some((p) => p.number === selected)) setSelected(filtered[0].number);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- known backlog (PIPELINE.md §Code quality gates)
  }, [filtered]);

  if (!ghAvailable) {
    return (
      <div className="pulls-tab pulls-tab--empty">
        <EmptyPane>{ghUnavailableMessage(repo.gh)}</EmptyPane>
      </div>
    );
  }

  function moveSelection(delta: 1 | -1): void {
    if (filtered.length === 0) return;
    const i = filtered.findIndex((p) => p.number === selected);
    const next = i === -1 ? 0 : Math.min(Math.max(i + delta, 0), filtered.length - 1);
    setSelected(filtered[next].number);
  }

  return (
    <div className="pulls-tab">
      <div
        ref={railRef}
        className="pulls-rail"
        role="listbox"
        aria-label="Pull requests"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveSelection(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveSelection(-1);
          }
        }}
      >
        <div className="pulls-rail__filters">
          <div className="pulls-search">
            <Icon name="search" size={12} className="pulls-search__icon" />
            <input
              className="pulls-search__input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter pull requests…"
              aria-label="Filter pull requests"
            />
          </div>
          <button type="button" className="pulls-rail__filter-btn" title="Filters" disabled>
            <Icon name="layers" size={14} />
          </button>
        </div>

        <div className="pulls-rail__rows">
          {loading && !pulls && <LoaderPane size={16} label="Loading pull requests…" />}
          {error && (
            <div className="pulls-rail__status pulls-rail__status--error">
              {error}{' '}
              <button type="button" className="pulls-rail__retry" onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}
          {!loading && !error && filtered.length === 0 && <div className="pulls-rail__status">No pull requests.</div>}
          {filtered.map((pull) => (
            <PullRow
              key={pull.number}
              pull={pull}
              selected={pull.number === selected}
              sessionName={sessionForBranch(sessions, pull.head)?.name}
              now={Date.now()}
              onSelect={() => setSelected(pull.number)}
            />
          ))}
        </div>

        <div className="pulls-rail__hint">
          <HintBar items={[{ key: 'ⓘ', label: 'Pull requests opened from a session keep the link to it.' }]} />
        </div>
      </div>

      <PullDetail cwd={cwd} number={selected} key={selected ?? 'none'} onChanged={() => void load()} />
    </div>
  );
}

function PullRow({
  pull,
  selected,
  sessionName,
  now,
  onSelect,
}: {
  pull: PullSummary;
  selected: boolean;
  sessionName: string | undefined;
  now: number;
  onSelect: () => void;
}): JSX.Element {
  const chip = checkRollupChip(pull.checks);
  const review = pullReviewText(pull);
  const hasOrigin = sessionName !== undefined || review !== null;
  return (
    <div
      className={selected ? 'pull-row pull-row--selected' : 'pull-row'}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
    >
      <div className="pull-row__top">
        <Icon name={pullStateIcon(pull.state)} size={13} className={`pull-row__state-icon pull-row__state-icon--${pull.state}`} />
        <p className="pull-row__title">{pull.title}</p>
        <span className="pull-row__sp" />
        {chip && <span className={`pull-chip pull-chip--${chip.tone}`}>{chip.label}</span>}
      </div>
      <div className="pull-row__meta">
        <span className="pull-row__ref">
          #{pull.number} <span className="pull-row__ref-dim">{pull.head}</span>
          <span className="pull-row__ref-dim"> → </span>
          <span className="pull-row__ref-dim">{pull.base}</span>
        </span>
        <span className="pull-row__sp" />
        <span className="pull-row__time">{pullRelativeTime(pull.updatedAt, now)}</span>
      </div>
      {hasOrigin && (
        <div className="pull-row__origin">
          {sessionName && (
            <span className="pull-origin-chip">
              <Icon name="terminal" size={10} />
              {sessionName}
            </span>
          )}
          <span className="pull-row__sp" />
          {review && <span className={`pull-review pull-review--${review.tone}`}>{review.text}</span>}
        </div>
      )}
    </div>
  );
}
