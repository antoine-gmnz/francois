// cohorte-integration FR-70..FR-76 — the run view (frame 26, `156:15293`), the
// main-pane tab `cohorte:<runId>`: header with Back and the run controls, the
// phase timeline, the steps table, the REVIEW / ARTIFACTS / SNAPSHOT cards and
// the command bar. It replaces the session header; the session panel stays.

import { ChevronLeft, ChevronRight, File, SquareTerminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CohorteRun } from '../../../contract/cohorte-integration';
import { useCohorteStore } from '../../lib/cohorteStore';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { focusedSessionId } from '../../lib/layoutStore';
import { basename } from '../../lib/path';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { EmptyPane } from '../../ui/EmptyPane';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { StateIcon } from '../../ui/StateIcon';
import { Tag } from '../../ui/Tag';
import { answerGate, closeCohorteRun, controlRun, copyCli, ensurePolicy } from './actions';
import './cohorte.css';
import './cohorte-run.css';
import { AnsweredBy, CohorteStateChip, FindingRow } from './CohorteParts';
import { ACTION_KEYS, actionLabel, gateAction } from './gate-view';
import { sessionAtPath } from './linkage';
import { stepLine } from './outcome';
import {
  formatDuration,
  hostDead,
  isGatePhase,
  orderedSteps,
  phaseBarTone,
  phaseMeta,
  phaseStarted,
  policyLine,
  runControls,
  runViewChip,
  shortDigest,
  shortRunId,
  statusGlyph,
  stepDurationMs,
  stepStateLabel,
} from './run-view';
import { CASE_INSENSITIVE_FS, useRun } from './useCohorte';
import { useGateKeys } from './useGateKeys';

export default function CohorteRunView({ runId }: { runId: string }): JSX.Element {
  const run = useRun(runId);

  // `Esc` with no editable focus goes Back (flow 4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.closest('.xterm'))) return;
      if (document.querySelector('.modal-backdrop')) return;
      closeCohorteRun();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!run) {
    return (
      <div className="cohorte-run">
        <div className="cohorte-run__header">
          <BackButton />
        </div>
        <EmptyPane>Run not found</EmptyPane>
      </div>
    );
  }
  return <RunBody run={run} />;
}

function BackButton() {
  return (
    <button type="button" className="cohorte-run__back" title="Back · Esc" aria-label="Back" onClick={closeCohorteRun}>
      <ChevronLeft size={14} />
    </button>
  );
}

function RunBody({ run }: { run: CohorteRun }) {
  const projects = useStore((s) => s.projects);
  const busy = useCohorteStore((s) => s.busy[run.runId] ?? null);
  const outcome = useCohorteStore((s) => s.lastOutcome[run.runId] ?? null);
  const policy = useCohorteStore((s) => s.policies[run.projectRoot]);
  const [armed, setArmed] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const live = run.view !== 'completed' && run.view !== 'cancelled';
  const now = useElapsedClock(live);
  const chip = runViewChip(run);
  const controls = runControls(run.view);
  const gate = run.gate;
  const deny = gate ? gateAction(gate, 'deny') : null;
  const project = projects.find((p) => p.root === run.projectRoot)?.name ?? basename(run.projectRoot);

  useEffect(() => ensurePolicy(run.projectRoot), [run.projectRoot]);

  useGateKeys({
    runId: run.runId,
    active: gate !== null && !confirmCancel,
    offered: gate?.actions.map((a) => a.id) ?? [],
    denyStopsRun: deny?.stopsRun ?? false,
    armed,
    setArmed,
    onRun: (id) => void answerGate(run, id),
  });

  const elapsed = formatDuration((run.endedAt ?? now) - run.startedAt);
  const meta = [shortRunId(run.runId), elapsed, run.runtime?.id].filter(Boolean).join(' · ');

  return (
    <div className="cohorte-run">
      <header className="cohorte-run__header">
        <BackButton />
        <div className="cohorte-run__title">
          <div className="cohorte-run__crumbs">
            <span className="cohorte-run__crumb">{project}</span>
            <ChevronRight size={11} className="cohorte-run__crumb-sep" />
            <span className="cohorte-run__crumb cohorte-run__crumb--faint">Cohorte run</span>
          </div>
          <div className="cohorte-run__name-row">
            <span className="cohorte-run__name truncate">{run.specId || run.title}</span>
            {run.specKind && <Tag>{`${run.specKind} spec`}</Tag>}
            <CohorteStateChip label={chip.label} tone={chip.tone} glyph={chip.glyph} />
            <span className="cohorte-run__meta" title={run.runId}>
              {meta}
            </span>
          </div>
        </div>
        <span className="cohorte-spacer" />
        {gate &&
          gate.actions
            .filter((a) => a.id !== 'deny')
            .map((a) => (
              <Button
                key={a.id}
                variant={a.id === 'approve' ? 'attention' : 'secondary'}
                shortcut={ACTION_KEYS[a.id]}
                disabled={busy !== null}
                title={a.cli.join('\n')}
                onClick={() => void answerGate(run, a.id)}
              >
                {busy === a.id && <StateIcon kind="running" size={12} />}
                {actionLabel(a, gate.request.kind)}
              </Button>
            ))}
        {controls.pause && (
          <Button variant="ghost" disabled={busy !== null} onClick={() => void controlRun(run, 'pause')}>
            Pause
          </Button>
        )}
        {controls.resume && (
          <Button variant="ghost" disabled={busy !== null} onClick={() => void controlRun(run, 'resume')}>
            Resume
          </Button>
        )}
        {controls.cancel && (
          <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
            Cancel
          </Button>
        )}
      </header>

      {armed && gate && deny && (
        <div className="cohorte-run__strip cohorte-run__strip--danger" role="alert">
          Deny and cancel <code>{shortRunId(run.runId)}</code>? · 3/Enter confirm · Esc back
        </div>
      )}
      <AnsweredBy runId={run.runId} className="cohorte-run__strip" />
      {hostDead(run) && <div className="cohorte-run__strip cohorte-run__strip--warning">Run host is not running — Cohorte restarts it on the next command.</div>}
      {run.lastError && (run.view === 'failed' || run.view === 'blocked') && (
        <div className="cohorte-run__strip cohorte-run__strip--danger">
          {run.lastError.message}
          {run.lastError.remediation && ` — ${run.lastError.remediation}`}
        </div>
      )}
      {outcome && outcome.steps.length > 0 && (
        <div className="cohorte-run__strip" role="status">
          {outcome.steps.map((s, i) => (
            <span key={`${s.cli}:${i}`} className={`cohorte-gate__step cohorte-gate__step--${stepLine(s).tone}`}>
              {stepLine(s).text}
            </span>
          ))}
        </div>
      )}

      <div className="cohorte-run__body scz">
        <PhaseTimeline run={run} now={now} />
        <div className="cohorte-run__columns">
          <StepsTable run={run} now={now} />
          <div className="cohorte-run__side">
            <ReviewCard run={run} />
            <ArtifactsCard run={run} />
            <SnapshotCard run={run} gatedSteps={policy?.gatedSteps} />
          </div>
        </div>
      </div>

      <CommandBar runId={run.runId} />

      {confirmCancel && (
        <Modal onClose={() => setConfirmCancel(false)} width={420} align="center" closeOnEscape closeOnBackdropClick>
          <ModalHeader>
            Cancel <code>{shortRunId(run.runId)}</code>?
          </ModalHeader>
          <ModalBody>
            <p className="cohorte-run__modal-text">Cohorte stops every agent and removes the run's worktrees.</p>
            <code className="cohorte-cli">cohorte cancel {run.runId}</code>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              Keep running
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmCancel(false);
                void controlRun(run, 'cancel');
              }}
            >
              Cancel run
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}

function PhaseTimeline({ run, now }: { run: CohorteRun; now: number }) {
  return (
    <div className="cohorte-timeline">
      {run.phases.map((phase) => {
        const meta = phaseMeta(run, phase, now, true);
        return (
          <div key={phase.state} className="cohorte-timeline__col">
            <span className={`cohorte-timeline__bar cohorte-timeline__bar--${phaseBarTone(run, phase)}`} />
            <div className="cohorte-timeline__label">
              <StateIcon kind={isGatePhase(run, phase) ? 'approval' : statusGlyph(phase.status)} size={12} />
              <span className={phaseStarted(phase) ? 'cohorte-timeline__name' : 'cohorte-timeline__name cohorte-timeline__name--pending'}>
                {phase.label}
              </span>
              <span className="cohorte-timeline__meta">{meta.text}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StepsTable({ run, now }: { run: CohorteRun; now: number }) {
  const sessions = useStore((s) => s.sessions);
  const steps = orderedSteps(run);
  const checks = new Map(run.phases.map((p) => [p.state, p.checks] as const));
  return (
    <section className="cohorte-steps">
      <div className="cohorte-label">STEPS</div>
      {steps.length === 0 ? (
        <div className="cohorte-steps__empty">No steps yet</div>
      ) : (
        <div className="cohorte-steps__scroll">
          <table className="cohorte-steps__table">
            <thead>
              <tr>
                <th className="cohorte-steps__col-step">Step</th>
                <th className="cohorte-steps__col-agent">Agent</th>
                <th className="cohorte-steps__col-session">Session</th>
                <th className="cohorte-steps__col-duration">Duration</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {run.phases.flatMap((phase) =>
                steps
                  .filter((s) => phase.steps.includes(s))
                  .map((step) => {
                    const session = sessionAtPath(sessions, step.worktree?.path, CASE_INSENSITIVE_FS);
                    const ms = stepDurationMs(step, now);
                    const phaseChecks = checks.get(phase.state) ?? [];
                    const title = phaseChecks.length > 0 ? phaseChecks.map((c) => `${c.name}: ${c.status}`).join('\n') : (step.summary ?? step.label);
                    return (
                      <tr key={`${step.agentId}:${step.incarnation}`} title={title}>
                        <td className="cohorte-steps__step">{step.label}</td>
                        <td className="cohorte-steps__agent" title={step.surface}>
                          {step.role}
                        </td>
                        <td>
                          {session ? (
                            <button
                              type="button"
                              className="cohorte-steps__session"
                              onClick={() => {
                                const st = useStore.getState();
                                st.setActiveSessionId(session.id);
                                st.setMainTab('session');
                              }}
                            >
                              {session.name}
                            </button>
                          ) : (
                            <span className="cohorte-steps__none">—</span>
                          )}
                        </td>
                        <td className="cohorte-steps__duration">{ms === null ? '—' : formatDuration(ms)}</td>
                        <td>
                          <span className={`cohorte-steps__state cohorte-steps__state--${String(step.status)}`}>
                            <StateIcon kind={statusGlyph(String(step.status))} size={13} />
                            {stepStateLabel(String(step.status))}
                          </span>
                          {step.lastError && step.status === 'failed' && <span className="cohorte-steps__error">{step.lastError.message}</span>}
                        </td>
                      </tr>
                    );
                  }),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ReviewCard({ run }: { run: CohorteRun }) {
  const review = run.review;
  if (!review) return null;
  const footer = run.gate ? 'Verdict pending — approve to ship, or send back to fix.' : review.clean ? 'Review clean.' : review.verdict ? `Verdict: ${review.verdict}` : null;
  return (
    <div className="cohorte-card">
      <div className="cohorte-label">
        REVIEW · {review.findings.length} FINDING{review.findings.length === 1 ? '' : 'S'}
      </div>
      <div className="cohorte-card__rows">
        {review.findings.map((f) => (
          <FindingRow key={f.id} finding={f} variant="compact" />
        ))}
      </div>
      {footer && <p className="cohorte-card__foot">{footer}</p>}
    </div>
  );
}

function ArtifactsCard({ run }: { run: CohorteRun }) {
  const openLog = () => {
    const st = useStore.getState();
    // R-16: the log opens in the panel of the session the panel is showing.
    const sessionId = focusedSessionId(st);
    if (sessionId) useCohorteStore.getState().setPanelLog(sessionId, run.runId);
    st.setSessionPanelTab('cohorte');
  };
  const logLabel = `cohorte tail ${shortRunId(run.runId)}`;
  return (
    <div className="cohorte-card">
      <div className="cohorte-label">ARTIFACTS</div>
      <div className="cohorte-card__rows">
        {run.artifacts
          .filter((a) => a.kind !== 'log')
          .map((a) => (
            <div key={`${a.kind}:${a.label}`} className="cohorte-artifact" title={a.path ?? a.label}>
              <File size={13} className="cohorte-artifact__icon" />
              <span className="cohorte-artifact__name truncate">{a.label}</span>
              {a.meta && <span className="cohorte-artifact__meta">{a.meta}</span>}
            </div>
          ))}
        <button type="button" className="cohorte-artifact cohorte-artifact--link" title="Show the activity log in the panel" onClick={openLog}>
          <File size={13} className="cohorte-artifact__icon" />
          <span className="cohorte-artifact__name truncate">{logLabel}</span>
          <span className="cohorte-artifact__meta">activity log</span>
        </button>
      </div>
    </div>
  );
}

function SnapshotCard({ run, gatedSteps }: { run: CohorteRun; gatedSteps?: string[] }) {
  const digest = shortDigest(run.snapshotDigest);
  const policy = policyLine(gatedSteps);
  const cost = run.usage?.cost;
  return (
    <div className="cohorte-card">
      <div className="cohorte-label">SNAPSHOT</div>
      {run.runtime && (
        <div className="cohorte-kv">
          <span className="cohorte-kv__k">Runtime</span>
          <span className="cohorte-kv__v">
            {run.runtime.id} · {run.runtime.pinDigest ? 'pinned' : 'unpinned'}
          </span>
        </div>
      )}
      {digest && (
        <div className="cohorte-kv">
          <span className="cohorte-kv__k">Bundle</span>
          <span className="cohorte-kv__v cohorte-kv__v--mono">{digest}</span>
        </div>
      )}
      {policy && (
        <div className="cohorte-kv">
          <span className="cohorte-kv__k">Policy</span>
          <span className="cohorte-kv__v">{policy}</span>
        </div>
      )}
      {cost && (
        <div className="cohorte-kv">
          <span className="cohorte-kv__k">Usage</span>
          <span className="cohorte-kv__v">
            {run.usage?.tokens.total.toLocaleString()} tokens · ${cost.amount.toFixed(2)}
          </span>
        </div>
      )}
      <p className="cohorte-card__foot">Nothing changes provider mid-run.</p>
    </div>
  );
}

function CommandBar({ runId }: { runId: string }) {
  const cli = `cohorte status ${runId} --json`;
  return (
    <div className="cohorte-command-bar">
      <SquareTerminal size={14} className="cohorte-command-bar__icon" />
      <button type="button" className="cohorte-command-bar__cli truncate" title="Copy" onClick={() => copyCli(cli)}>
        {cli}
      </button>
      <span className="cohorte-command-bar__note">Everything here maps to a CLI command</span>
    </div>
  );
}
