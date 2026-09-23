// cohorte-integration FR-67..FR-69 — the session panel's Cohorte tab (frame 25,
// `153:14818`): the run this session belongs to — header, compact gate, phases,
// footer — or, with no linked run, the root's most recent runs. "Tail logs"
// swaps the body for the run's activity log.

import { useEffect, useState } from 'react';
import type { CohorteRun } from '../../../contract/cohorte-integration';
import { cohorteFeatures, cohorteStart, type CohorteFeatureChoice } from '../../lib/api';
import { useCohorteStore } from '../../lib/cohorteStore';
import { Button } from '../../ui/Button';
import { EmptyPane } from '../../ui/EmptyPane';
import { SidePanelBody, SidePanelFooter } from '../../ui/SidePanel';
import { StateIcon } from '../../ui/StateIcon';
import { Tag } from '../../ui/Tag';
import type { SessionPanelSectionProps } from '../../app/session-panel/sections';
import { controlRun, openCohorteRun } from './actions';
import './cohorte.css';
import { AnsweredBy, CohorteMark } from './CohorteParts';
import { GateCard } from './GateCard';
import { detectionFor } from './linkage';
import { PhasesList } from './PhasesList';
import { RunLog } from './RunLog';
import { authHint, hostDead, panelSummary, runControls, runtimeLine, shortDigest, shortRunId } from './run-view';
import { CASE_INSENSITIVE_FS, useSessionRun } from './useCohorte';

export function CohorteTabIcon(): JSX.Element {
  return <CohorteMark size={12.25} />;
}

export default function CohortePanelSection({ session }: SessionPanelSectionProps): JSX.Element {
  const { run } = useSessionRun(session.id);
  // R-16: the log view is per session — another session's tab keeps its own.
  const logRunId = useCohorteStore((s) => s.panelLog[session.id] ?? null);
  const setPanelLog = useCohorteStore((s) => s.setPanelLog);
  const setLog = (runId: string | null) => setPanelLog(session.id, runId);
  const logRun = useCohorteStore((s) => (logRunId ? (s.runs[logRunId] ?? null) : null));
  if (logRun) return <RunLog run={logRun} onBack={() => setLog(null)} />;
  if (!run) return <NoRun cwd={session.cwd} />;
  return <RunPanel run={run} onTail={() => setLog(run.runId)} />;
}

function RunPanel({ run, onTail }: { run: CohorteRun; onTail: () => void }) {
  const summary = panelSummary(run);
  const busy = useCohorteStore((s) => s.busy[run.runId] ?? null);
  const health = useCohorteStore((s) => s.watchHealth[run.projectRoot]);
  const authCli = useCohorteStore((s) => s.authCli[run.runId]);
  const controls = runControls(run.view);
  const runtime = runtimeLine(run);
  const digest = shortDigest(run.snapshotDigest);
  return (
    <>
      <SidePanelBody className="cohorte-panel">
        <div className="cohorte-panel__head">
          <div className="cohorte-panel__row">
            <span className="cohorte-panel__title truncate">{run.specId || run.title}</span>
            {run.specKind && <Tag>{`${run.specKind} spec`}</Tag>}
          </div>
          <div className="cohorte-panel__row">
            <StateIcon kind={summary.glyph} size={13} />
            <span className={`cohorte-panel__summary cohorte-tone--${summary.tone} truncate`}>{summary.text}</span>
            <span className="cohorte-spacer" />
            <span className="cohorte-panel__id" title={run.runId}>
              {shortRunId(run.runId)}
            </span>
          </div>
          <AnsweredBy runId={run.runId} className="cohorte-panel__note" />
          {hostDead(run) && <div className="cohorte-panel__note cohorte-panel__note--warning">Run host is not running — Cohorte restarts it on the next command.</div>}
          {health && !health.healthy && (
            <div className="cohorte-panel__note">Cohorte not responding — retrying in {Math.ceil(health.nextPollInMs / 1000)}s</div>
          )}
          {run.lastError && (run.view === 'failed' || run.view === 'blocked') && (
            <div className="cohorte-panel__note cohorte-panel__note--danger">
              {run.lastError.message}
              {run.lastError.remediation && ` — ${run.lastError.remediation}`}
            </div>
          )}
          {run.view === 'auth' && (
            <div className="cohorte-panel__note">
              Log in with <code>{authHint(authCli)}</code>
            </div>
          )}
        </div>
        {run.gate && (
          <div className="cohorte-panel__gate">
            <GateCard run={run} gate={run.gate} variant="compact" />
          </div>
        )}
        <PhasesList run={run} />
      </SidePanelBody>
      <SidePanelFooter>
        {runtime && (
          <div className="cohorte-panel__runtime">
            <StateIcon kind="done" size={12} />
            <span className="cohorte-panel__runtime-text truncate">{runtime}</span>
            {digest && <span className="cohorte-panel__id">{digest}</span>}
          </div>
        )}
        <div className="cohorte-panel__actions">
          <Button size="sm" variant="secondary" className="cohorte-panel__open" onClick={() => openCohorteRun(run.runId)}>
            Open run
          </Button>
          <Button size="sm" variant="ghost" onClick={onTail}>
            Tail logs
          </Button>
          {controls.pause && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void controlRun(run, 'pause')}>
              Pause
            </Button>
          )}
          {controls.resume && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void controlRun(run, 'resume')}>
              Resume
            </Button>
          )}
        </div>
      </SidePanelFooter>
    </>
  );
}

function NoRun({ cwd }: { cwd: string }) {
  const root = useCohorteStore((s) => detectionFor(s.detections, cwd, CASE_INSENSITIVE_FS)?.root ?? null);
  const runs = useCohorteStore((s) => s.runs);
  const [features, setFeatures] = useState<CohorteFeatureChoice[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setFeatures([]);
    setSelected('');
    setError('');
    if (!root) return;
    let current = true;
    void cohorteFeatures(root).then((result) => {
      if (!current) return;
      if (result.ok) {
        setFeatures(result.data);
        setSelected(result.data[0]?.id || '');
      } else setError(result.error.message);
    });
    return () => { current = false; };
  }, [root]);
  const start = async () => {
    if (!root || !selected || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await cohorteStart({ root, featureId: selected });
      if (result.ok) {
        useCohorteStore.getState().upsertRun(result.data);
        openCohorteRun(result.data.runId);
      } else setError(result.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const recent = Object.values(runs)
    .filter((r) => r.projectRoot === root)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 3);
  return (
    <SidePanelBody className="cohorte-panel">
      <EmptyPane className="cohorte-panel__empty">No Cohorte run for this session</EmptyPane>
      {root && features.length > 0 && (
        <div className="cohorte-panel__recent">
          <label className="cohorte-phases__label" htmlFor="cohorte-feature-select">FEATURE</label>
          <select id="cohorte-feature-select" value={selected} onChange={(event) => setSelected(event.target.value)}>
            {features.map((feature) => <option key={feature.id} value={feature.id}>{feature.title}</option>)}
          </select>
          <Button size="sm" variant="secondary" disabled={busy || !selected} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start run'}
          </Button>
        </div>
      )}
      {error && <p role="alert" className="cohorte-panel__note cohorte-panel__note--danger">{error}</p>}
      {recent.length > 0 && (
        <div className="cohorte-panel__recent">
          <div className="cohorte-phases__label">
            <span>RECENT RUNS</span>
          </div>
          {recent.map((r) => {
            const s = panelSummary(r);
            return (
              <button key={r.runId} type="button" className="cohorte-panel__recent-row" onClick={() => openCohorteRun(r.runId)}>
                <StateIcon kind={s.glyph} size={12} />
                <span className="cohorte-panel__recent-name truncate">{r.specId || r.title}</span>
                <span className="cohorte-panel__id">{shortRunId(r.runId)}</span>
              </button>
            );
          })}
        </div>
      )}
    </SidePanelBody>
  );
}
