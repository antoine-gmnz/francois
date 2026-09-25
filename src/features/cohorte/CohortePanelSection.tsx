// cohorte-integration FR-67..FR-69 — the session panel's Cohorte tab (frame 25,
// `153:14818`): the run this session belongs to — header, compact gate, phases,
// footer — or, with no linked run, the root's most recent runs. "Tail logs"
// swaps the body for the run's activity log.
//
// cohorte-actions FR-60: a `This run | Pipeline` toggle now sits above the
// body — Pipeline replaces the old NoRun feature-select start UI.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CohorteRun } from '../../../contract/cohorte-integration';
import type { CohorteFeatureChoice } from '../../../contract/cohorte-actions';
import { cohorteFeatures } from '../../lib/api';
import { useCohorteActionsStore } from '../../lib/cohorteActionsStore';
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
import { derivePipeline, type PipelineCard } from './pipeline';
import { PhasesList } from './PhasesList';
import { openCohorteTerminal } from './terminal';
import { cohorteBrainstormDisplay, cohorteSpecDisplay } from './command-display';
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
  // FR-60: default to Pipeline with no linked run, This run otherwise. Reset
  // when the session (hence its run) changes, via the key on the tab body below.
  const [tab, setTab] = useState<'run' | 'pipeline'>(run ? 'run' : 'pipeline');

  if (logRun) return <RunLog run={logRun} onBack={() => setLog(null)} />;

  return (
    <div className="cohorte-panel-wrap" key={session.id}>
      <div className="cohorte-panel__toggle" role="tablist" aria-label="Cohorte view">
        <button type="button" role="tab" aria-selected={tab === 'run'} className={tab === 'run' ? 'cohorte-panel__toggle-btn cohorte-panel__toggle-btn--sel' : 'cohorte-panel__toggle-btn'} onClick={() => setTab('run')}>
          This run
        </button>
        <button type="button" role="tab" aria-selected={tab === 'pipeline'} className={tab === 'pipeline' ? 'cohorte-panel__toggle-btn cohorte-panel__toggle-btn--sel' : 'cohorte-panel__toggle-btn'} onClick={() => setTab('pipeline')}>
          Pipeline
        </button>
      </div>
      {tab === 'run' && run ? (
        <RunPanel run={run} onTail={() => setLog(run.runId)} />
      ) : tab === 'run' ? (
        <SidePanelBody className="cohorte-panel">
          <EmptyPane className="cohorte-panel__empty">No Cohorte run for this session</EmptyPane>
        </SidePanelBody>
      ) : (
        <PipelineView cwd={session.cwd} sessionId={session.id} />
      )}
    </div>
  );
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

const PIPELINE_STAGE_SEGMENTS = 6;

/** cohorte-actions FR-61..FR-64 — the Pipeline view: one card per feature. */
function PipelineView({ cwd, sessionId }: { cwd: string; sessionId: string }) {
  const root = useCohorteStore((s) => detectionFor(s.detections, cwd, CASE_INSENSITIVE_FS)?.root ?? null);
  // Select the stable map, filter in useMemo: a selector that builds a new
  // array on every read makes useSyncExternalStore re-render forever.
  const runs = useCohorteStore((s) => s.runs);
  const runsForRoot = useMemo(() => Object.values(runs).filter((r) => r.projectRoot === root), [runs, root]);
  const newFeatureIds = useCohorteActionsStore((s) => s.newFeatureIds);
  const [features, setFeatures] = useState<CohorteFeatureChoice[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = () => {
    if (!root) return;
    void cohorteFeatures(root).then((result) => {
      setLoaded(true);
      if (result.ok) {
        setFeatures(result.data);
        setError('');
      } else setError(result.error.message);
    });
  };

  // FR-64: on mount / root change, and whenever intake mints a new feature.
  useEffect(() => {
    setFeatures([]);
    setLoaded(false);
    setError('');
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (loaded) load(); }, [newFeatureIds.size]);

  // FR-64: debounced 1s refetch whenever a run for this root is upserted.
  const runsSignature = runsForRoot.map((r) => `${r.runId}:${r.refreshedAt}`).join(',');
  useEffect(() => {
    if (!loaded) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(load, 1000);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsSignature]);

  if (!root) return <SidePanelBody className="cohorte-panel"><EmptyPane className="cohorte-panel__empty">No Cohorte project detected here</EmptyPane></SidePanelBody>;

  const cards = derivePipeline(features, runsForRoot);
  return (
    <SidePanelBody className="cohorte-panel cohorte-pipeline">
      {error && <p role="alert" className="cohorte-panel__note cohorte-panel__note--danger">{error}</p>}
      {loaded && !error && cards.length === 0 && (
        <EmptyPane className="cohorte-panel__empty">
          No features yet
          <Button size="sm" variant="secondary" onClick={() => useCohorteActionsStore.getState().openSheet({ action: 'intake', sessionId })}>
            New feature…
          </Button>
        </EmptyPane>
      )}
      {cards.map((card) => (
        <PipelineCardRow key={card.featureId} card={card} sessionId={sessionId} isNew={newFeatureIds.has(card.featureId)} />
      ))}
      <div className="cohorte-pipeline__project">
        <div className="cohorte-phases__label">PROJECT</div>
        <button type="button" className="cohorte-panel__recent-row" onClick={() => { if (root) useCohorteActionsStore.getState().openSheet({ action: 'audit', sessionId }); }}>
          <span className="cohorte-panel__recent-name">Audit</span>
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void openCohorteTerminal(sessionId, 'cohorte audit ', { execute: false }); }}>
            Run
          </Button>
        </button>
        <button type="button" className="cohorte-panel__recent-row" onClick={() => void openCohorteTerminal(sessionId, 'cohorte retro ', { execute: false })}>
          <span className="cohorte-panel__recent-name">Retro</span>
          <Button size="sm" variant="ghost" onClick={(e) => e.stopPropagation()}>
            Run
          </Button>
        </button>
      </div>
      <div className="cohorte-pipeline__footer">
        <Button size="sm" variant="ghost" onClick={() => useCohorteActionsStore.getState().openSheet({ action: 'intake', sessionId })}>
          New feature…
        </Button>
        <Button size="sm" variant="ghost" onClick={() => useCohorteActionsStore.getState().openMenu(sessionId)}>
          All actions
        </Button>
      </div>
    </SidePanelBody>
  );
}

function PipelineCardRow({ card, sessionId, isNew }: { card: PipelineCard; sessionId: string; isNew: boolean }) {
  const onAction = () => {
    if (card.action.id === 'answer-gate' || card.action.id === 'open-run') {
      if (card.runId) openCohorteRun(card.runId);
      return;
    }
    if (card.action.id === 'start') {
      useCohorteActionsStore.getState().openSheet({ action: 'start', sessionId, featureId: card.featureId });
      return;
    }
    if (card.action.id === 'brainstorm') {
      void openCohorteTerminal(sessionId, cohorteBrainstormDisplay(card.featureId), { execute: true });
      return;
    }
    void openCohorteTerminal(sessionId, cohorteSpecDisplay(card.featureId), { execute: true });
  };
  return (
    <div className={`cohorte-pipeline-card cohorte-pipeline-card--${card.tone}`}>
      <div className="cohorte-pipeline-card__head">
        <span className="cohorte-pipeline-card__id truncate">{card.featureId}</span>
        {isNew && <Tag tone="new">NEW</Tag>}
        <span className="cohorte-spacer" />
        <span className="cohorte-pipeline-card__stage">{card.stageLabel}</span>
      </div>
      <div className="cohorte-pipeline-card__track">
        {Array.from({ length: PIPELINE_STAGE_SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={
              i < card.stage
                ? 'cohorte-pipeline-card__seg cohorte-pipeline-card__seg--done'
                : i === card.stage
                  ? `cohorte-pipeline-card__seg cohorte-pipeline-card__seg--current cohorte-pipeline-card__seg--${card.tone}`
                  : 'cohorte-pipeline-card__seg'
            }
          />
        ))}
      </div>
      <div className="cohorte-pipeline-card__foot">
        <span className="cohorte-pipeline-card__title truncate">{card.title}</span>
        <Button size="sm" variant={card.action.ghost ? 'ghost' : 'secondary'} onClick={onAction}>
          {card.action.label}
        </Button>
      </div>
    </div>
  );
}
