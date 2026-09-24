// github-ci-logs FR-1..FR-14 — the shared check list: rollup header, rows
// with a disclosure caret for Actions jobs, expanded job/step rows, and the
// in-app log viewer. Replaces both the PR detail "Checks" card body and the
// commit detail "Checks on this commit" side card.

import { useEffect, useRef, useState } from 'react';
import type { CheckJob, CheckRun } from '../../../contract/github-page';
import { githubGetJob, githubListChecks } from '../../lib/api';
import { Icon } from '../../ui/Icon';
import { Modal, ModalHeader } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { LoaderCaret, Orbit } from '../../ui/Loaders';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { openOnGithub } from './actions';
import { canOpenStep, checkCountLine, checkKey, checkRowOrder, currentStep, firstFailedStep, pollingActive } from './ci-logs';
import { CollapsibleCard } from './CollapsibleCard';
import { StepLogPanel } from './StepLogPanel';
import './ci-logs.css';
import './pulls.css'; // .ci-caret / .ci-reveal* live there now (shared with CollapsibleCard)

const LIST_POLL_MS = 10_000;
const JOB_POLL_MS = 5_000;

export interface CheckRunListProps {
  cwd: string;
  /** full 40-hex sha the checks belong to; polling target (FR-13). */
  sha: string;
  initialChecks: CheckRun[];
  /** commit detail opens a step's log in a wide Modal instead of inline. */
  variant: 'pr' | 'commit';
  /** lifted so the PR card's danger footer (Fix / Re-run) can see live checks. */
  onChecksChange?: (checks: CheckRun[]) => void;
}

type JobState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'loaded'; job: CheckJob };

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

export function CheckRunList({ cwd, sha, initialChecks, variant, onChecksChange }: CheckRunListProps): JSX.Element | null {
  const [checks, setChecks] = useState<CheckRun[]>(initialChecks);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const [openStep, setOpenStep] = useState<Record<string, number | null>>({});
  const autoExpandApplied = useRef(false);
  const visible = useDocumentVisible();
  const now = useElapsedClock(checks.some((c) => c.state === 'pending'));

  // A new detail (sha change) resets everything — a fresh "once per open".
  useEffect(() => {
    setChecks(initialChecks);
    setExpanded({});
    setJobs({});
    setOpenStep({});
    autoExpandApplied.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset is keyed on sha only
  }, [sha]);

  useEffect(() => {
    onChecksChange?.(checks);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires whenever `checks` changes
  }, [checks]);

  const loadJob = async (check: CheckRun): Promise<void> => {
    if (check.jobId === undefined) return;
    const key = checkKey(check);
    // A poll re-fetch keeps the loaded job on screen (no flash back to
    // "Loading", no re-run of the fade-in); only a first load or a retry
    // shows the loader.
    setJobs((s) => (s[key]?.status === 'loaded' ? s : { ...s, [key]: { status: 'loading' } }));
    const res = await githubGetJob({ cwd, jobId: check.jobId });
    if (res.ok) {
      setJobs((s) => ({ ...s, [key]: { status: 'loaded', job: res.data } }));
      // FR-13: a job that finishes failed while expanded opens its failed
      // step by itself, unless the user already opened a step in it.
      if (res.data.completed && res.data.state === 'failed') {
        setOpenStep((s) => {
          if (s[key] !== undefined && s[key] !== null) return s;
          const step = firstFailedStep(res.data);
          return step ? { ...s, [key]: step.number } : s;
        });
      }
    } else {
      setJobs((s) => ({ ...s, [key]: { status: 'error', message: res.error.message } }));
    }
  };

  // FR-5: once per detail open, expand the first failed Actions job and open
  // its failed step's log.
  useEffect(() => {
    if (autoExpandApplied.current) return;
    const target = checks.find((c) => c.state === 'failed' && c.jobId !== undefined);
    if (!target) return;
    autoExpandApplied.current = true;
    const key = checkKey(target);
    setExpanded((s) => ({ ...s, [key]: true }));
    void loadJob(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once checks arrive
  }, [checks]);

  // FR-13: poll the list every 10s while any check is pending and the view
  // is visible; keeps expansion state (keyed by checkKey).
  useEffect(() => {
    if (!pollingActive(checks.some((c) => c.state === 'pending'), visible)) return undefined;
    const id = setInterval(() => {
      void githubListChecks({ cwd, sha }).then((res) => {
        if (res.ok) setChecks(res.data);
      });
    }, LIST_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-armed by checks/visible
  }, [checks, visible, cwd, sha]);

  // FR-14: coming back visible re-fetches immediately.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (!wasVisible.current && visible) {
      void githubListChecks({ cwd, sha }).then((res) => {
        if (res.ok) setChecks(res.data);
      });
    }
    wasVisible.current = visible;
  }, [visible, cwd, sha]);

  // FR-7: poll each expanded, not-yet-completed job every 5s.
  useEffect(() => {
    if (!visible) return undefined;
    const ids = Object.entries(expanded)
      .filter(([, on]) => on)
      .map(([key]) => key)
      .filter((key) => {
        const j = jobs[key];
        return j?.status === 'loaded' && !j.job.completed;
      });
    if (ids.length === 0) return undefined;
    const id = setInterval(() => {
      for (const key of ids) {
        const check = checks.find((c) => checkKey(c) === key);
        if (check) void loadJob(check);
      }
    }, JOB_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-armed by expanded/jobs/visible
  }, [expanded, jobs, visible, checks]);

  if (checks.length === 0) return null;

  const ordered = checkRowOrder(checks);
  const failed = checks.find((c) => c.state === 'failed');

  const sectionId = variant === 'pr' ? 'checks' : 'commit-checks';
  const head = (
    <>
      {failed ? (
        <span className="pull-chip pull-chip--danger">{checks.filter((c) => c.state === 'failed').length} check{checks.filter((c) => c.state === 'failed').length === 1 ? '' : 's'} failing</span>
      ) : checks.some((c) => c.state === 'pending') ? (
        <span className="pull-chip pull-chip--faint">checks pending</span>
      ) : (
        <span className="pull-chip pull-chip--success">checks passed</span>
      )}
      <span className="pull-row__sp" />
      <span className="pull-card__faint">{checkCountLine(checks)}</span>
    </>
  );

  return (
    <CollapsibleCard id={sectionId} head={head}>
      <div className="pull-card__list">
        {ordered.map((check) => {
          const key = checkKey(check);
          const jobState = jobs[key];
          const job = jobState?.status === 'loaded' ? jobState.job : undefined;
          const step = job ? currentStep(job) : undefined;
          return (
            <div key={key} className="ci-job">
              <CheckRow
                cwd={cwd}
                check={check}
                step={step}
                now={now}
                expanded={!!expanded[key]}
                onToggle={() => {
                  const willExpand = !expanded[key];
                  setExpanded((s) => ({ ...s, [key]: willExpand }));
                  if (willExpand && !jobs[key]) void loadJob(check);
                }}
              />
              {check.jobId !== undefined && (
                <div className={expanded[key] ? 'ci-reveal ci-reveal--open' : 'ci-reveal'} aria-hidden={!expanded[key]}>
                  <div className="ci-reveal__inner">
                    {/* Stays mounted once loaded so a collapse can animate out. */}
                    {(expanded[key] || jobState !== undefined) && (
                      <ExpandedJob
                        cwd={cwd}
                        variant={variant}
                        jobState={jobState}
                        openStepNumber={openStep[key] ?? null}
                        now={now}
                        onRetry={() => void loadJob(check)}
                        onToggleStep={(stepNumber) => setOpenStep((s) => ({ ...s, [key]: s[key] === stepNumber ? null : stepNumber }))}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </CollapsibleCard>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

function CheckRow({
  cwd,
  check,
  step,
  now,
  expanded,
  onToggle,
}: {
  cwd: string;
  check: CheckRun;
  step: ReturnType<typeof currentStep>;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const isActionsJob = check.jobId !== undefined;
  return (
    <div
      className={isActionsJob ? 'pull-check-row ci-check-row--clickable' : 'pull-check-row'}
      role={isActionsJob ? 'button' : undefined}
      tabIndex={isActionsJob ? 0 : undefined}
      aria-expanded={isActionsJob ? expanded : undefined}
      onClick={isActionsJob ? onToggle : undefined}
      onKeyDown={
        isActionsJob
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle();
              }
            }
          : undefined
      }
    >
      {isActionsJob && (
        <span className={expanded ? 'ci-caret ci-caret--open' : 'ci-caret'} aria-hidden="true">
          ▸
        </span>
      )}
      {check.state === 'pending' ? <Orbit size={14} label={`${check.name} running`} /> : <Icon name={check.state === 'failed' ? 'x' : 'check'} size={13} />}
      <span className="pull-check-row__name">{check.name}</span>
      <span className="pull-row__sp" />
      {check.state === 'pending' && isActionsJob && step ? (
        <span className="pull-card__faint">
          › {step.name} · {formatDuration(now - (check.startedAt ?? now))}
        </span>
      ) : check.state === 'failed' ? (
        <span className="pull-check-row__fail">
          {check.summary ?? 'failed'}
          {check.durationMs !== undefined ? ` · ${formatDuration(check.durationMs)}` : ''}
        </span>
      ) : (
        <span className="pull-card__faint">{check.durationMs !== undefined ? formatDuration(check.durationMs) : ''}</span>
      )}
      {!isActionsJob && check.detailsUrl && (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            void openOnGithub(cwd, check.detailsUrl!);
          }}
        >
          Open on GitHub
        </Button>
      )}
    </div>
  );
}

function ExpandedJob({
  cwd,
  variant,
  jobState,
  openStepNumber,
  now,
  onRetry,
  onToggleStep,
}: {
  cwd: string;
  variant: 'pr' | 'commit';
  jobState: JobState | undefined;
  openStepNumber: number | null;
  now: number;
  onRetry: () => void;
  onToggleStep: (stepNumber: number) => void;
}): JSX.Element {
  if (!jobState || jobState.status === 'loading') {
    return (
      <div className="ci-job__body">
        <p className="ci-log__state">
          <LoaderCaret label="Loading steps" />
        </p>
      </div>
    );
  }
  if (jobState.status === 'error') {
    return (
      <div className="ci-job__body">
        <p className="ci-log__state">
          {jobState.message}
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </p>
      </div>
    );
  }
  const job = jobState.job;

  return (
    <div className="ci-job__body ci-fade-in">
      <div className="ci-job__head">
        <span className="ci-job__title">
          {job.workflowName ? `${job.workflowName} / ${job.name}` : job.name}
        </span>
        {job.runAttempt > 1 && <span className="pull-chip pull-chip--faint">attempt {job.runAttempt}</span>}
        <span className="pull-row__sp" />
        <Button variant="ghost" size="sm" onClick={() => void openOnGithub(cwd, job.htmlUrl)}>
          Open on GitHub
        </Button>
      </div>
      {job.steps.map((s) => {
        const openable = canOpenStep(job, s);
        return (
          <div key={s.number} className={`ci-step ci-step--${s.state}`}>
            <button
              type="button"
              className="ci-step__row"
              disabled={!openable}
              aria-expanded={openStepNumber === s.number}
              title={!job.completed && s.state !== 'running' && s.state !== 'queued' ? 'log when the job finishes' : undefined}
              onClick={() => openable && onToggleStep(s.number)}
            >
              {s.state === 'running' ? <Orbit size={12} label={`${s.name} running`} /> : <StepGlyph state={s.state} />}
              <span className="ci-step__no">{s.number}</span>
              <span className="ci-step__name">{s.name}</span>
              <span className="pull-row__sp" />
              <span className="ci-step__dur">
                {s.state === 'running' ? formatDuration(now - (s.startedAt ?? now)) : s.durationMs !== undefined ? formatDuration(s.durationMs) : ''}
              </span>
            </button>
            {openStepNumber === s.number &&
              (variant === 'pr' ? (
                <div className="ci-step__log">
                  <div className="ci-reveal__inner">
                    <StepLogPanel cwd={cwd} job={job} step={s} />
                  </div>
                </div>
              ) : (
                <Modal onClose={() => onToggleStep(s.number)} width={Math.min(960, window.innerWidth * 0.9)} align="center" closeOnEscape closeOnBackdropClick>
                  <ModalHeader>
                    {job.name} › {s.name}
                  </ModalHeader>
                  <StepLogPanel cwd={cwd} job={job} step={s} />
                </Modal>
              ))}
          </div>
        );
      })}
    </div>
  );
}

function StepGlyph({ state }: { state: string }): JSX.Element {
  if (state === 'failed') return <Icon name="x" size={12} />;
  if (state === 'passed') return <Icon name="check" size={12} />;
  if (state === 'queued') return <span className="ci-step__dot" aria-hidden="true" />;
  if (state === 'cancelled') return <Icon name="x" size={12} />;
  return <span className="ci-step__dot" aria-hidden="true" />;
}
