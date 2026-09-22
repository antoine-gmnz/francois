// github-page — Branches & worktrees tab (specs/github-page.md FR-9..FR-11,
// frame 31 `162:16108`). Toolbar (search + filter chips + disk usage +
// "Prune merged worktrees") → table (BRANCH · AHEAD/BEHIND · WORKTREE ·
// SESSION · PULL REQUEST · LAST COMMIT · ⋯) → footer (prune hint).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BranchInfo, GithubRepoInfo, PullSummary } from '../../../contract/github-page';
import { githubCreateWorktree, githubListBranches, githubListPulls, githubOpenUrl, githubWorktreeDiskUsage } from '../../lib/api';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { EmptyPane } from '../../ui/EmptyPane';
import { Icon } from '../../ui/Icon';
import { StateIcon } from '../../ui/StateIcon';
import { openSession, startSessionOnBranch } from './actions';
import {
  BRANCH_FILTERS,
  aheadTone,
  behindTone,
  filterBranches,
  lastCommitRelative,
  pullsByBranch,
  readyToPruneBranches,
  sessionChip,
  type BranchFilter,
} from './branches';
import { sessionForBranch, sessionsByBranch } from './linkage';
import { pullStateIcon } from './pulls';
import { PruneModal } from './PruneModal';
import { useLatestRequest } from './useLatestRequest';
import './github.css';

export interface BranchesTabProps {
  cwd: string;
  repo: GithubRepoInfo;
  refreshKey: number;
  /** Bumps the parent's refreshKey after a prune, so every tab re-reads. */
  onPruned: () => void;
  /** PULL REQUEST column (FR-10): jump to that PR on the Pull requests tab. */
  onOpenPull: (number: number) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

export function BranchesTab({ cwd, repo, refreshKey, onPruned, onOpenPull }: BranchesTabProps): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BranchFilter>('all');
  const [diskUsage, setDiskUsage] = useState<{ bytes: number | null; worktrees: number } | null>(null);
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [pulls, setPulls] = useState<PullSummary[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const beginRequest = useLatestRequest();

  const load = async (): Promise<void> => {
    const isCurrent = beginRequest();
    setLoading(true);
    setError(null);
    const res = await githubListBranches(cwd);
    if (isCurrent()) {
      setLoading(false);
      if (res.ok) setBranches(res.data);
      else setError(res.error.message);
    }
    void githubWorktreeDiskUsage(cwd).then((r) => {
      if (isCurrent() && r.ok) setDiskUsage(r.data);
    });
    if (repo.gh === 'ok') {
      void githubListPulls({ cwd }).then((r) => {
        if (isCurrent() && r.ok) setPulls(r.data);
      });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- known backlog (PIPELINE.md §Code quality gates)
  }, [cwd, refreshKey]);

  useDismiss(menuRef, { onEscape: () => setOpenMenuFor(null), onOutsideClick: () => setOpenMenuFor(null), enabled: openMenuFor !== null });

  const byBranch = useMemo(() => sessionsByBranch(sessions), [sessions]);
  const prByBranch = useMemo(() => pullsByBranch(pulls), [pulls]);
  const now = Date.now();
  const filtered = useMemo(() => filterBranches(branches ?? [], filter, query, now), [branches, filter, query, now]);
  const readyToPrune = useMemo(() => readyToPruneBranches(branches ?? [], byBranch), [branches, byBranch]);

  async function createWorktree(branch: string): Promise<void> {
    setCreatingFor(branch);
    await githubCreateWorktree({ cwd, branch });
    setCreatingFor(null);
    void load();
  }

  async function startHere(branch: BranchInfo): Promise<void> {
    setOpenMenuFor(null);
    await startSessionOnBranch(cwd, branch.name);
  }

  if (loading && !branches) return <EmptyPane className="gh-empty--muted">Loading…</EmptyPane>;
  if (error || !branches) {
    return (
      <EmptyPane>
        <p>{error ?? 'Could not load branches.'}</p>
        <button type="button" className="gh-retry" onClick={() => void load()}>
          Retry
        </button>
      </EmptyPane>
    );
  }

  return (
    <div className="branches-tab">
      <div className="branches-toolbar">
        <div className="branches-search">
          <Icon name="search" size={12} />
          <input
            className="branches-search__input"
            placeholder="Filter branches…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {BRANCH_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={filter === f.id ? 'branches-chip branches-chip--on' : 'branches-chip'}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <span className="branches-toolbar__sp" />
        {diskUsage && (
          <span className="branches-toolbar__usage">
            <strong>{diskUsage.worktrees}</strong> worktree{diskUsage.worktrees === 1 ? '' : 's'}
            {diskUsage.bytes !== null && (
              <>
                {' · '}
                <strong>{formatBytes(diskUsage.bytes)}</strong> on disk
              </>
            )}
          </span>
        )}
        <Button variant="secondary" size="sm" onClick={() => setPruneOpen(true)} disabled={readyToPrune.length === 0}>
          Prune merged worktrees
        </Button>
      </div>

      <div className="branches-table">
        <div className="branches-row branches-row--header">
          <span className="branches-col branches-col--branch">Branch</span>
          <span className="branches-col branches-col--ahead">Ahead / behind</span>
          <span className="branches-col branches-col--worktree">Worktree</span>
          <span className="branches-col branches-col--session">Session</span>
          <span className="branches-col branches-col--pr">Pull request</span>
          <span className="branches-col branches-col--last">Last commit</span>
          <span className="branches-col branches-col--menu" />
        </div>

        {filtered.length === 0 && <div className="branches-empty">No branches match.</div>}

        {filtered.map((b) => {
          const linked = byBranch.get(b.name);
          const chip = sessionChip(linked);
          const soloSession = linked && linked.length === 1 ? linked[0] : null;
          // sessionForBranch prefers the most recently active when several
          // sessions share the branch — the same session the roster's own
          // "n sessions" chip would jump to first.
          const owner = sessionForBranch(sessions, b.name);
          const pr = prByBranch.get(b.name);
          return (
            <div key={b.name} className={b.isCurrent ? 'branches-row branches-row--current' : 'branches-row'}>
              <span className="branches-col branches-col--branch">
                <Icon name="branch" size={13} className={b.isDefault ? 'branches-branch-icon--default' : 'branches-branch-icon'} />
                <span className="branches-branch-name">{b.name}</span>
                {b.isCurrent && <span className="branches-current-pill">current</span>}
              </span>
              <span className="branches-col branches-col--ahead">
                <span className={`branches-count branches-count--${aheadTone(b.vsDefault.ahead)}`}>↑{b.vsDefault.ahead}</span>{' '}
                <span className={`branches-count branches-count--${behindTone(b.vsDefault.behind)}`}>↓{b.vsDefault.behind}</span>
              </span>
              <span className="branches-col branches-col--worktree">
                {b.worktree ? (
                  <>
                    <Icon name="folder" size={12} />
                    <span className="branches-worktree-path" title={b.worktree.path}>
                      {b.worktree.displayPath}
                    </span>
                  </>
                ) : (
                  <button
                    type="button"
                    className="branches-create-btn"
                    disabled={creatingFor === b.name}
                    onClick={() => void createWorktree(b.name)}
                  >
                    <Icon name="plus" size={11} />
                    {creatingFor === b.name ? 'Creating…' : 'Create'}
                  </button>
                )}
              </span>
              <span className="branches-col branches-col--session">
                {chip.tone === 'none' ? (
                  <span className="branches-dim">—</span>
                ) : (
                  <span className={`branches-session-chip branches-session-chip--${chip.tone}`}>
                    {soloSession ? <StateIcon status={soloSession.status} size={11} /> : null}
                    {chip.label}
                  </span>
                )}
              </span>
              <span className="branches-col branches-col--pr">
                {pr ? (
                  <button type="button" className="branches-pr" onClick={() => onOpenPull(pr.number)}>
                    <Icon name={pullStateIcon(pr.state)} size={12} className={`branches-pr__icon branches-pr__icon--${pr.state}`} />
                    <span className="branches-pr__number">#{pr.number}</span>
                  </button>
                ) : (
                  <span className="branches-dim">—</span>
                )}
              </span>
              <span className="branches-col branches-col--last">
                <span className="branches-last-subject">{b.lastCommit.subject}</span>
                <span className="branches-toolbar__sp" />
                <span className="branches-last-time">{lastCommitRelative(b.lastCommit.committedAt, now)}</span>
              </span>
              <span className="branches-col branches-col--menu">
                <button type="button" className="branches-menu-btn" onClick={() => setOpenMenuFor(b.name)} title="More">
                  <Icon name="dots" size={14} />
                </button>
                {openMenuFor === b.name && (
                  <div ref={menuRef} className="branches-menu" role="menu">
                    {owner ? (
                      <button type="button" role="menuitem" onClick={() => openSession(owner.id)}>
                        Open session
                      </button>
                    ) : (
                      <button type="button" role="menuitem" onClick={() => void startHere(b)}>
                        Start a session here
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        void navigator.clipboard.writeText(b.name);
                        setOpenMenuFor(null);
                      }}
                    >
                      Copy branch name
                    </button>
                    {repo.webUrl && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          void githubOpenUrl({ cwd, url: `${repo.webUrl}/tree/${b.name}` });
                          setOpenMenuFor(null);
                        }}
                      >
                        Open on GitHub
                      </button>
                    )}
                  </div>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="branches-footer">
        <Icon name="info" size={12} />
        <span className="branches-footer__hint">
          Merged branches with no session can be pruned — the worktree and its state go with them.
        </span>
        <span className="branches-toolbar__sp" />
        {readyToPrune.length > 0 && <span className="branches-footer__count">{readyToPrune.length} branches ready to prune</span>}
        <Button variant="ghost" size="sm" onClick={() => setPruneOpen(true)} disabled={readyToPrune.length === 0}>
          Review prune
        </Button>
      </div>

      {pruneOpen && (
        <PruneModal
          cwd={cwd}
          branches={readyToPrune}
          onClose={() => setPruneOpen(false)}
          onPruned={() => {
            setPruneOpen(false);
            onPruned();
            void load();
          }}
        />
      )}
    </div>
  );
}
