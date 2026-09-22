// github-page — Commits tab (specs/github-page.md FR-7..FR-8, frame 30
// `161:15989`). Left rail 432px (branch select + toggle + day-grouped rows) +
// detail pane (CommitDetail).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CheckRun, CommitSummary, GithubRepoInfo } from '../../../contract/github-page';
import { githubListBranches, githubListCommits } from '../../lib/api';
import { useStore } from '../../lib/store';
import { HintBar } from '../../ui/HintBar';
import { Icon } from '../../ui/Icon';
import { CommitDetail } from './CommitDetail';
import { commitChecksIcon, commitOrigin, commitTimeLabel, filterCommits, groupCommitsByDay } from './commits';
import { sessionForBranch } from './linkage';
import { useLatestRequest } from './useLatestRequest';
import './pulls.css';
import './commits.css';

export interface CommitsTabProps {
  cwd: string;
  repo: GithubRepoInfo;
  refreshKey: number;
}

export function CommitsTab({ cwd, repo, refreshKey }: CommitsTabProps): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const [ref, setRef] = useState(repo.currentBranch ?? repo.defaultBranch);
  const [scopeCwd, setScopeCwd] = useState(cwd);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commits, setCommits] = useState<{ totalCount: number; commits: CommitSummary[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromSessionsOnly, setFromSessionsOnly] = useState(false);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [checksBySha, setChecksBySha] = useState<Record<string, CheckRun[] | undefined>>({});
  const railRef = useRef<HTMLDivElement>(null);
  const beginRequest = useLatestRequest();

  // Review fix #4: adjust `ref` for a new cwd during render (React's documented
  // pattern for resetting derived state when a "key"-like prop changes) rather
  // than in a separate effect keyed on [cwd]. That used to leave a window where
  // the [cwd, ref, refreshKey] load effect fired once with the NEW cwd but the
  // PREVIOUS repo's ref, before the ref-reset effect ran and fired it again —
  // two fetches, the first against a branch that may not even exist in the new
  // repo. Updating `ref` here keeps [cwd, ref] consistent within one render
  // pass, so the load effect below only ever runs once per cwd change.
  if (scopeCwd !== cwd) {
    setScopeCwd(cwd);
    setRef(repo.currentBranch ?? repo.defaultBranch);
  }

  const load = async (): Promise<void> => {
    const isCurrent = beginRequest();
    setLoading(true);
    setError(null);
    const res = await githubListCommits({ cwd, ref });
    if (!isCurrent()) return;
    setLoading(false);
    if (res.ok) setCommits({ totalCount: res.data.totalCount, commits: res.data.commits });
    else setError(res.error.message);
  };

  useEffect(() => {
    setCommits(null);
    setSelectedSha(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- known backlog (PIPELINE.md §Code quality gates)
  }, [cwd, ref, refreshKey]);

  async function openMenu(): Promise<void> {
    setMenuOpen(true);
    if (branches !== null) return;
    const res = await githubListBranches(cwd);
    if (res.ok) setBranches(res.data.map((b) => b.name));
  }

  const linkedSession = sessionForBranch(sessions, ref);
  const filtered = useMemo(() => filterCommits(commits?.commits ?? [], fromSessionsOnly), [commits, fromSessionsOnly]);
  const groups = useMemo(() => groupCommitsByDay(filtered), [filtered]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedSha(null);
      return;
    }
    if (selectedSha === null || !filtered.some((c) => c.sha === selectedSha)) setSelectedSha(filtered[0].sha);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- known backlog (PIPELINE.md §Code quality gates)
  }, [filtered]);

  function moveSelection(delta: 1 | -1): void {
    if (filtered.length === 0) return;
    const i = filtered.findIndex((c) => c.sha === selectedSha);
    const next = i === -1 ? 0 : Math.min(Math.max(i + delta, 0), filtered.length - 1);
    setSelectedSha(filtered[next].sha);
  }

  return (
    <div className="commits-tab">
      <div
        ref={railRef}
        className="commits-rail"
        role="listbox"
        aria-label="Commits"
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
        <div className="commits-rail__filters">
          <div className="commits-branch-select">
            <button type="button" className="commits-branch-select__btn" onClick={() => void openMenu()}>
              <Icon name="branch" size={12} />
              <span className="commits-branch-select__ref">{ref}</span>
              <span className="pull-row__sp" />
              <span className="commits-branch-select__count">
                {commits ? `${commits.totalCount} commits` : ''}
              </span>
              <Icon name="chevron-down" size={11} />
            </button>
            {menuOpen && branches && (
              <>
                <button type="button" className="commits-branch-menu__backdrop" aria-label="Close branch menu" onClick={() => setMenuOpen(false)} />
                <div className="commits-branch-menu" role="menu">
                  {branches.map((b) => (
                  <button
                    type="button"
                    key={b}
                    className="commits-branch-menu__item"
                    role="menuitem"
                    onClick={() => {
                      setRef(b);
                      setMenuOpen(false);
                    }}
                  >
                    {b}
                  </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            className={fromSessionsOnly ? 'commits-toggle commits-toggle--on' : 'commits-toggle'}
            onClick={() => setFromSessionsOnly((v) => !v)}
            aria-pressed={fromSessionsOnly}
          >
            <Icon name="terminal" size={11} />
            From sessions
          </button>
        </div>

        <div className="commits-rail__rows">
          {loading && !commits && <div className="commits-rail__status">Loading…</div>}
          {error && (
            <div className="commits-rail__status commits-rail__status--error">
              {error}{' '}
              <button type="button" className="commits-rail__retry" onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}
          {!loading && !error && filtered.length === 0 && <div className="commits-rail__status">No commits.</div>}
          {groups.map((group) => (
            <div key={group.label} className="commits-day">
              <div className="commits-day__label">{group.label}</div>
              {group.commits.map((commit) => (
                <CommitRow
                  key={commit.sha}
                  commit={commit}
                  selected={commit.sha === selectedSha}
                  origin={commitOrigin(commit, linkedSession)}
                  checksIcon={commit.sha === selectedSha ? checksBySha[commit.sha] : undefined}
                  onSelect={() => setSelectedSha(commit.sha)}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="commits-rail__hint">
          <HintBar items={[{ key: 'ⓘ', label: 'Every commit carries the session that wrote it.' }]} />
        </div>
      </div>

      <CommitDetail
        cwd={cwd}
        repo={repo}
        sha={selectedSha}
        key={selectedSha ?? 'none'}
        onChecksLoaded={(sha, checkRuns) => setChecksBySha((m) => ({ ...m, [sha]: checkRuns }))}
      />
    </div>
  );
}

function CommitRow({
  commit,
  selected,
  origin,
  checksIcon,
  onSelect,
}: {
  commit: CommitSummary;
  selected: boolean;
  origin: ReturnType<typeof commitOrigin>;
  checksIcon: CheckRun[] | undefined;
  onSelect: () => void;
}): JSX.Element {
  const icon = commitChecksIcon(checksIcon);
  return (
    <div className={selected ? 'commit-row commit-row--selected' : 'commit-row'} role="option" aria-selected={selected} onClick={onSelect}>
      <div className="commit-row__top">
        <p className="commit-row__title">{commit.subject}</p>
        <span className="pull-row__sp" />
        {icon && <Icon name={icon} size={12} className={icon === 'x' ? 'commit-row__glyph--fail' : 'commit-row__glyph--ok'} />}
      </div>
      <div className="commit-row__meta">
        <span className="commit-row__sha">{commit.shortSha}</span>
        {origin.kind === 'session' && (
          <span className="commit-origin-chip commit-origin-chip--session">
            <Icon name="terminal" size={10} />
            {origin.sessionName}
          </span>
        )}
        {origin.kind === 'agent' && <span className="commit-origin-chip commit-origin-chip--agent">agent</span>}
        {origin.kind === 'hand' && <span className="commit-origin-chip commit-origin-chip--hand">by hand</span>}
        <span className="pull-row__sp" />
        <span className="commit-row__time">{commitTimeLabel(commit.committedAt)}</span>
      </div>
    </div>
  );
}

