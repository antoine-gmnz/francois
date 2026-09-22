// github-page — Pull request detail (specs/github-page.md FR-5..FR-6, frame
// 29 `160:16062`). Rendered by PullsTab for the selected PR.

import { useEffect, useState } from 'react';
import type { PullDetail as PullDetailData } from '../../../contract/github-page';
import { githubGetPull, githubUpdatePullBranch } from '../../lib/api';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { EmptyPane } from '../../ui/EmptyPane';
import { Icon } from '../../ui/Icon';
import { openOnGithub, openSession, startSessionOnBranch } from './actions';
import { sessionForBranch } from './linkage';
import {
  canUpdateBranch,
  checkRollupHeadline,
  mergeButtonLabel,
  mergeableTone,
  pullOpenedBy,
  pullRelativeTime,
  pullReviewText,
  pullStateChip,
  visiblePullFiles,
} from './pulls';
import { useLatestRequest } from './useLatestRequest';
import './pulls.css';

export interface PullDetailProps {
  cwd: string;
  number: number | null;
}

export function PullDetail({ cwd, number }: PullDetailProps): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const setMainTab = useStore((s) => s.setMainTab);
  const [detail, setDetail] = useState<PullDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const beginRequest = useLatestRequest();

  const load = async (): Promise<void> => {
    if (number === null) return;
    const isCurrent = beginRequest();
    setLoading(true);
    setError(null);
    const res = await githubGetPull({ cwd, number });
    if (!isCurrent()) return;
    setLoading(false);
    if (res.ok) setDetail(res.data);
    else setError(res.error.message);
  };

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (number !== null) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- known backlog (PIPELINE.md §Code quality gates)
  }, [cwd, number]);

  if (number === null) {
    return (
      <div className="pull-detail pull-detail--empty">
        <EmptyPane>No pull requests to show.</EmptyPane>
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="pull-detail pull-detail--empty">
        <span className="pull-detail__loading">Loading…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pull-detail pull-detail--empty">
        <div className="pull-detail__error">
          {error}{' '}
          <button type="button" className="pull-detail__retry" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!detail) return <div className="pull-detail pull-detail--empty" />;

  const linkedSession = sessionForBranch(sessions, detail.head);
  const stateChip = pullStateChip(detail.state);
  const headline = checkRollupHeadline(detail.checks);
  const { shown: shownFiles, moreCount } = visiblePullFiles(detail.files);
  const review = pullReviewText(detail);

  async function onUpdateBranch(): Promise<void> {
    setUpdating(true);
    await githubUpdatePullBranch({ cwd, number: detail!.number });
    setUpdating(false);
    void load();
  }

  return (
    <div className="pull-detail">
      <div className="pull-detail__head">
        <div className="pull-detail__title-row">
          <h2 className="pull-detail__title">
            {detail.title} <span className="pull-detail__number">#{detail.number}</span>
          </h2>
          <span className="pull-row__sp" />
          <span className={`pull-state-chip pull-state-chip--${stateChip.tone}`}>{stateChip.label}</span>
        </div>
        <div className="pull-detail__meta-row">
          <p className="pull-detail__meta">
            <span className="pull-detail__meta-strong">{detail.head}</span>
            <span className="pull-detail__meta-dim"> → </span>
            <span className="pull-detail__meta-strong">{detail.base}</span>
            <span className="pull-detail__meta-dim">   ·   </span>
            <span className="pull-detail__meta-dim">opened {pullRelativeTime(detail.createdAt)} by {pullOpenedBy(detail)}</span>
            <span className="pull-detail__meta-dim">   ·   </span>
            <span className="pull-detail__meta-dim">{detail.files.length} files </span>
            <span className="pull-detail__meta-add">+{detail.additions}</span>{' '}
            <span className="pull-detail__meta-del">−{detail.deletions}</span>
          </p>
          <span className="pull-row__sp" />
          <Button variant="ghost" size="sm" onClick={() => void openOnGithub(cwd, detail.url)}>
            Open on GitHub
          </Button>
        </div>
      </div>

      <div className="pull-detail__columns">
        <div className="pull-detail__col pull-detail__col--left">
          {detail.checkRuns.length > 0 && (
            <div className="pull-card">
              <div className="pull-card__head">
                {headline && <span className={`pull-chip pull-chip--${headline.tone}`}>{headline.label}</span>}
                <span className="pull-row__sp" />
                <span className="pull-card__faint">CI · GitHub Actions</span>
              </div>
              <div className="pull-card__list">
                {detail.checkRuns.map((run) => (
                  <div className="pull-check-row" key={run.name}>
                    <Icon name={run.state === 'failed' ? 'x' : 'check'} size={13} />
                    <span className="pull-check-row__name">{run.name}</span>
                    <span className="pull-row__sp" />
                    {run.state === 'failed' ? (
                      <>
                        <span className="pull-check-row__fail">
                          {run.summary ?? 'failed'}
                          {run.durationMs !== undefined ? ` · ${formatDuration(run.durationMs)}` : ''}
                        </span>
                        {run.detailsUrl && (
                          <Button variant="ghost" size="sm" onClick={() => void openOnGithub(cwd, run.detailsUrl!)}>
                            View log
                          </Button>
                        )}
                      </>
                    ) : (
                      <span className="pull-card__faint">{run.durationMs !== undefined ? formatDuration(run.durationMs) : ''}</span>
                    )}
                  </div>
                ))}
              </div>
              {detail.checks.failed > 0 && (
                <div className="pull-card__foot pull-card__foot--danger">
                  <Icon name="spark" size={13} />
                  <span className="pull-card__foot-text">
                    {detail.checkRuns.find((r) => r.state === 'failed')?.summary ?? 'A check is failing.'}
                  </span>
                  <span className="pull-row__sp" />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      // FR-6: the first message names the failing checks and asks to fix them.
                      const failing = detail.checkRuns.filter((r) => r.state === 'failed').map((r) => r.name);
                      void startSessionOnBranch(cwd, detail.head, `Fix the failing checks on PR #${detail.number}: ${failing.join(', ')}.`);
                    }}
                  >
                    Fix in a new session
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="pull-card">
            <div className="pull-card__head">
              <span className="pull-card__title">Files changed</span>
              <span className="pull-card__count">{detail.files.length}</span>
              <span className="pull-row__sp" />
              <Button
                variant="secondary"
                size="sm"
                disabled={!linkedSession}
                title={linkedSession ? undefined : 'No session is linked to this branch'}
                onClick={() => {
                  if (!linkedSession) return;
                  openSession(linkedSession.id);
                  setMainTab('diff');
                }}
              >
                Review in François
              </Button>
            </div>
            <div className="pull-card__list">
              {shownFiles.map((f) => (
                <div className="pull-file-row" key={f.path}>
                  <Icon name="file" size={12} />
                  <span className="pull-file-row__path">{f.path}</span>
                  {f.comments > 0 && <span className="pull-file-note">{f.comments} comments</span>}
                  <span className="pull-row__sp" />
                  <span className="pull-file-row__stat">
                    <span className="pull-detail__meta-add">+{f.additions}</span>{' '}
                    <span className="pull-detail__meta-del">−{f.deletions}</span>
                  </span>
                </div>
              ))}
              {moreCount > 0 && <div className="pull-card__more">{moreCount} more files</div>}
            </div>
          </div>

          {(detail.changesRequested > 0 || detail.comments.length > 0) && (
            <div className="pull-card pull-card--padded">
              <div className="pull-card__head">
                {review && <span className={`pull-review-chip pull-review-chip--${review.tone}`}>{review.text}</span>}
                <span className="pull-row__sp" />
                {detail.comments.length > 0 && <span className="pull-card__faint">{detail.comments.length} unresolved comments</span>}
              </div>
              {detail.comments.slice(0, 1).map((comment) => (
                <div className="pull-comment" key={`${comment.author}-${comment.createdAt}`}>
                  <span className="pull-comment__avatar">{initials(comment.author)}</span>
                  <div className="pull-comment__body">
                    <p className="pull-comment__byline">
                      <span className="pull-comment__author">{comment.author}</span>
                      {comment.path && (
                        <>
                          {' '}on <span className="pull-comment__path">{comment.path}{comment.line !== undefined ? `:${comment.line}` : ''}</span>
                        </>
                      )}
                      {'  · '}
                      {pullRelativeTime(comment.createdAt)}
                    </p>
                    <p className="pull-comment__text">{comment.body}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void openOnGithub(cwd, comment.url)}>
                    Reply
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="pull-detail__col pull-detail__col--right">
          {linkedSession && (
            <div className="pull-side-card">
              <p className="pull-side-card__label">Where this came from</p>
              <div className="pull-origin-card" onClick={() => openSession(linkedSession.id)}>
                <Icon name="terminal" size={13} />
                <div className="pull-origin-card__text">
                  <p className="pull-origin-card__name">{linkedSession.name}</p>
                  <p className="pull-origin-card__sub">session</p>
                </div>
                <Icon name="arrow-right" size={13} />
              </div>
            </div>
          )}

          <div className="pull-side-card">
            <p className="pull-side-card__label">Pull request</p>
            <KeyValue label="Reviewers" value={detail.reviewers.length > 0 ? detail.reviewers.join(', ') : '—'} />
            <KeyValue label="Labels" value={detail.labels.length > 0 ? detail.labels.join(', ') : '—'} />
            <KeyValue label="Milestone" value={detail.milestone ?? '—'} />
            <KeyValue label="Head sha" value={detail.headSha} />
            <KeyValue label="Mergeable" value={detail.mergeable} tone={mergeableTone(detail.mergeable)} />
          </div>

          <div className="pull-side-card">
            <p className="pull-side-card__label">Actions</p>
            <Button
              variant="secondary"
              className={detail.mergeable !== 'clean' ? 'pull-action--faint' : undefined}
              onClick={() => void openOnGithub(cwd, detail.url)}
            >
              {mergeButtonLabel(detail.mergeable)}
            </Button>
            <Button variant="secondary" disabled={!canUpdateBranch(detail.mergeable) || updating} onClick={() => void onUpdateBranch()}>
              Update branch from main
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (linkedSession) openSession(linkedSession.id);
                else void startSessionOnBranch(cwd, detail.head);
              }}
            >
              Open a session on this branch
            </Button>
            <p className="pull-side-card__foot">Merging is done on GitHub. François only opens, updates and fixes.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function KeyValue({ label, value, tone }: { label: string; value: string; tone?: string }): JSX.Element {
  return (
    <div className="pull-kv">
      <span className="pull-kv__label">{label}</span>
      <span className="pull-row__sp" />
      <span className={tone ? `pull-kv__value pull-kv__value--${tone}` : 'pull-kv__value'}>{value}</span>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const chars = parts.length > 1 ? [parts[0][0], parts[1][0]] : [name.slice(0, 2)];
  return chars.join('').toUpperCase();
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} m ${String(seconds).padStart(2, '0')} s` : `${seconds} s`;
}
