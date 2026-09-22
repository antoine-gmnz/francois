// github-page — Commit detail (specs/github-page.md FR-8, frame 30
// `161:16438`). Rendered by CommitsTab for the selected commit. "Your
// instruction" (the last user message before committedAt) is shown only when
// that session's transcript is already in memory — this feature never fetches
// a transcript just to fill the card (see the handoff note at the bottom).

import { useEffect, useState } from 'react';
import type { CheckRun, CommitDetail as CommitDetailData, GithubRepoInfo } from '../../../contract/github-page';
import { githubGetCommit } from '../../lib/api';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { EmptyPane } from '../../ui/EmptyPane';
import { Icon } from '../../ui/Icon';
import { LoaderOrbit, LoaderPane } from '../../ui/Loader';
import { openOnGithub, openSession, startSessionAtCommit } from './actions';
import { commitAuthorLabel, commitChecksChip, commitTimeLabel, otherCommitFiles } from './commits';
import { sessionForBranch } from './linkage';
import { useLatestRequest } from './useLatestRequest';
import './pulls.css';
import './commits.css';

export interface CommitDetailProps {
  cwd: string;
  repo: GithubRepoInfo;
  sha: string | null;
  /** Lifted to CommitsTab so the row list can show the check glyph for the selected row. */
  onChecksLoaded?: (sha: string, checkRuns: CheckRun[] | undefined) => void;
}

export function CommitDetail({ cwd, repo, sha, onChecksLoaded }: CommitDetailProps): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const [detail, setDetail] = useState<CommitDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useLatestRequest();

  const load = async (): Promise<void> => {
    if (sha === null) return;
    const isCurrent = beginRequest();
    setLoading(true);
    setError(null);
    const res = await githubGetCommit({ cwd, sha });
    if (!isCurrent()) return;
    setLoading(false);
    if (res.ok) {
      setDetail(res.data);
      onChecksLoaded?.(sha, res.data.checkRuns);
    } else {
      setError(res.error.message);
    }
  };

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (sha !== null) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- known backlog (PIPELINE.md §Code quality gates)
  }, [cwd, sha]);

  if (sha === null) {
    return (
      <div className="commit-detail commit-detail--empty">
        <EmptyPane>No commits to show.</EmptyPane>
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="commit-detail commit-detail--empty">
        <LoaderPane label="Loading commit…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="commit-detail commit-detail--empty">
        <div className="commit-detail__error">
          {error}{' '}
          <button type="button" className="commit-detail__retry" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!detail) return <div className="commit-detail commit-detail--empty" />;

  const chip = commitChecksChip(detail.checkRuns);
  const linkedSession = sessionForBranch(sessions, detail.branches[0] ?? '');
  const firstFile = detail.files[0];
  const otherFiles = otherCommitFiles(detail.files);

  return (
    <div className="commit-detail">
      <div className="commit-detail__head">
        <div className="commit-detail__title-row">
          <h2 className="commit-detail__title">{detail.subject}</h2>
          <span className="pull-row__sp" />
          {chip && <span className={`pull-chip pull-chip--${chip.tone}`}>{chip.label}</span>}
        </div>
        <div className="commit-detail__meta-row">
          <p className="commit-detail__meta">
            <span className="commit-detail__meta-strong">{detail.shortSha}</span>
            <span className="commit-detail__meta-dim">   ·   </span>
            <span className="commit-detail__meta-dim">on </span>
            <span className="commit-detail__meta-strong">{detail.branches[0] ?? '—'}</span>
            {detail.pullNumber !== undefined && (
              <>
                <span className="commit-detail__meta-dim">   ·   </span>
                <span className="commit-detail__meta-dim">in </span>
                <span className="commit-detail__meta-strong">#{detail.pullNumber}</span>
              </>
            )}
            <span className="commit-detail__meta-dim">   ·   </span>
            <span className="commit-detail__meta-dim">
              {commitAuthorLabel(detail)}, {commitTimeLabel(detail.committedAt)}
            </span>
          </p>
          <span className="pull-row__sp" />
          <Button
            variant="ghost"
            size="sm"
            disabled={!repo.webUrl}
            title={repo.webUrl ? undefined : 'No web URL available for this repo'}
            onClick={() => repo.webUrl && void openOnGithub(cwd, `${repo.webUrl}/commit/${detail.sha}`)}
          >
            Open on GitHub
          </Button>
        </div>
      </div>

      <div className="pull-detail__columns">
        <div className="pull-detail__col pull-detail__col--left">
          {linkedSession && (
            <div className="pull-card pull-card--padded">
              <div className="pull-card__head">
                <Icon name="terminal" size={13} />
                <span className="commit-origin__text">
                  Written by session <span className="commit-origin__name">{linkedSession.name}</span>
                </span>
                <span className="pull-row__sp" />
                <Button variant="secondary" size="sm" onClick={() => openSession(linkedSession.id)}>
                  Open transcript
                </Button>
              </div>
              <div className="commit-stats">
                <span className="commit-stats__item">
                  <span className="commit-stats__label">model</span>
                  <span className="commit-stats__value">{linkedSession.model.label}</span>
                </span>
                {linkedSession.worktree && (
                  <span className="commit-stats__item">
                    <span className="commit-stats__label">worktree</span>
                    <span className="commit-stats__value">{linkedSession.worktree.path}</span>
                  </span>
                )}
              </div>
            </div>
          )}

          {firstFile && (
            <div className="pull-card">
              <div className="pull-card__head">
                <Icon name="file" size={12} />
                <span className="commit-file__path">{firstFile.path}</span>
                <span className="commit-file__stat">
                  <span className="pull-detail__meta-add">+{firstFile.additions}</span>{' '}
                  <span className="pull-detail__meta-del">−{firstFile.deletions}</span>
                </span>
                <span className="pull-row__sp" />
                <span className="pull-card__faint">
                  1 of {detail.files.length} file{detail.files.length === 1 ? '' : 's'}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!linkedSession}
                  title={linkedSession ? undefined : 'No session is linked to this branch'}
                  onClick={() => {
                    if (linkedSession) openSession(linkedSession.id);
                  }}
                >
                  Review in François
                </Button>
              </div>
              {detail.firstFileDiff && !detail.firstFileDiff.binary && (
                <div className="commit-diff-lines">
                  {detail.firstFileDiff.hunks.flatMap((hunk) =>
                    hunk.lines.map((line, i) => (
                      <div key={`${hunk.header}-${i}`} className={`commit-diff-line commit-diff-line--${line.kind}`}>
                        <span className="commit-diff-line__no">{line.newNo ?? line.oldNo ?? ''}</span>
                        <span className="commit-diff-line__text">{line.text}</span>
                      </div>
                    )),
                  )}
                </div>
              )}
              {otherFiles.length > 0 && (
                <div className="commit-other-files">
                  {otherFiles.map((f) => (
                    <span className="commit-other-files__item" key={f.path}>
                      <span className="commit-other-files__path">{f.path}</span>
                      <span className="commit-other-files__stat">
                        +{f.additions} −{f.deletions}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="pull-detail__col pull-detail__col--right">
          {detail.checkRuns && detail.checkRuns.length > 0 && (
            <div className="pull-side-card">
              <p className="pull-side-card__label">Checks on this commit</p>
              {detail.checkRuns.map((run) => (
                <div className="pull-kv" key={run.name}>
                  {run.state === 'pending' ? (
                    <LoaderOrbit size={14} title={`${run.name} running`} />
                  ) : (
                    <Icon name={run.state === 'failed' ? 'x' : 'check'} size={12} />
                  )}
                  <span className="commit-check__name">{run.name}</span>
                  <span className="pull-row__sp" />
                  <span className="commit-check__value">
                    {run.state === 'failed' ? (run.summary ?? 'failed') : run.durationMs !== undefined ? formatDuration(run.durationMs) : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="pull-side-card">
            <p className="pull-side-card__label">Commit</p>
            <KeyValue label="Parent" value={detail.parents[0] ?? '—'} />
            <KeyValue label="Signed" value={detail.signed} />
            <KeyValue label="Branch" value={detail.branches[0] ?? '—'} />
            <KeyValue label="On main" value={detail.onDefaultBranch ? 'yes' : 'no'} />
            <KeyValue label="Pull request" value={detail.pullNumber !== undefined ? `#${detail.pullNumber}` : '—'} />
          </div>

          <div className="pull-side-card">
            <p className="pull-side-card__label">Actions</p>
            <Button variant="primary" disabled={!linkedSession} onClick={() => linkedSession && openSession(linkedSession.id)}>
              Continue this session
            </Button>
            <Button variant="secondary" onClick={() => void startSessionAtCommit(cwd, detail.sha)}>
              Start a session from this commit
            </Button>
            <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(detail.sha)}>
              Copy sha
            </Button>
            <p className="pull-side-card__foot">
              François never rewrites history — revert and force-push stay on GitHub or in your terminal.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="pull-kv">
      <span className="pull-kv__label">{label}</span>
      <span className="pull-row__sp" />
      <span className="pull-kv__value">{value}</span>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} m ${String(seconds).padStart(2, '0')} s` : `${seconds} s`;
}
