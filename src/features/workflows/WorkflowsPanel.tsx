// WorkflowsPanel — pane [6]: the session's `Workflow` runs.
//
// Read-only by construction: a run is dispatched by the assistant during a turn
// (the harness's Workflow tool), never from here, so unlike pane [3] there is no
// "+"/dispatch affordance and no kill. A card carries what the stream can
// honestly report — name, description, elapsed, last activity — and expands to
// the phases the script DECLARED (see PHASES_NOTE: per-phase progress never
// reaches the parent session's stream, so the panel does not pretend to it).

import { useEffect, useState } from 'react';
import type { WorkflowRun } from '../../../contract/common';
import { formatElapsed } from '../../../contract/conversation-view';
import { useStore } from '../../lib/store';
import { PanelHeader } from '../../ui/PanelHeader';
import { StatusDot } from '../../ui/StatusDot';
import { useWorkflowsFeed } from './useWorkflowsFeed';
import {
  EMPTY_LABEL,
  PHASES_NOTE,
  activityText,
  orderedRuns,
  phaseCountLabel,
  resolveCardClick,
  resolveWorkflowKeyAction,
  workflowTabRef,
} from './workflow-run';
import './workflows.css';

const statusColor: Record<string, string> = {
  running: 'var(--accent-2)',
  done: 'var(--success)',
  error: 'var(--error)',
};

export default function WorkflowsPanel({ sessionId }: { sessionId: string | null }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  // workflow-details FR-11/FR-12: a run's tab rides the SHARED dynamic-tab list.
  const openAgentTab = useStore((s) => s.openAgentTab);
  const syncAgentTab = useStore((s) => s.syncAgentTab);

  const { runs, loading, listError, selectedId, setSelectedId, expandedId, setExpandedId } = useWorkflowsFeed(
    sessionId,
    syncAgentTab,
  );

  const [clockNow, setClockNow] = useState(() => Date.now());

  const focused = focusedPane === 'workflows';
  const list = orderedRuns(runs);
  const hasRunning = list.some((run) => run.status === 'running');

  // Tick the elapsed timer once a second while any run is in flight.
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
      const action = resolveWorkflowKeyAction(e.key, { list, selectedId });
      if (action.kind === 'none') return;
      e.preventDefault();
      if (action.kind === 'select') {
        setSelectedId(action.id);
        setExpandedId(null); // selection collapses, as in pane [3]
      } else {
        setExpandedId((cur) => (cur === action.id ? null : action.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, list, selectedId, setSelectedId, setExpandedId]);

  return (
    <section
      onClick={() => setFocusedPane('workflows')}
      className={focused ? 'workflows-panel workflows-panel--focused' : 'workflows-panel'}
    >
      <PanelHeader title="WORKFLOWS" count={runs.size} paneKey={6} focused={focused} />

      <div className="scz workflows-body">
        {listError ? (
          <div className="workflows-error-text">{listError.message}</div>
        ) : loading ? null : list.length === 0 ? (
          <div className="workflows-empty">{EMPTY_LABEL}</div>
        ) : (
          list.map((run) => (
            <Card
              key={run.id}
              run={run}
              now={clockNow}
              selected={run.id === selectedId}
              expanded={run.id === expandedId}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedId(run.id);
                // FR-11: a CLICK on a run whose ack named a transcript dir opens
                // (or re-activates) its main-pane tab and hands it focus — you
                // clicked to read it. A run with nothing on disk keeps today's
                // select-and-expand, and `⏎` (the keyboard path above) never
                // opens a tab at all.
                if (resolveCardClick(run).kind === 'open') {
                  openAgentTab(workflowTabRef(run));
                  setFocusedPane('main');
                  return;
                }
                setFocusedPane('workflows');
                setExpandedId((cur) => (cur === run.id ? null : run.id));
              }}
            />
          ))
        )}
      </div>
    </section>
  );
}

function Card({
  run,
  now,
  selected,
  expanded,
  onClick,
}: {
  run: WorkflowRun;
  now: number;
  selected: boolean;
  expanded: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const sc = statusColor[run.status] ?? 'var(--text-muted)';
  const elapsedMs = Math.max(0, (run.endedAt ?? now) - run.startedAt);
  const phaseCount = phaseCountLabel(run);
  const cardClass = selected ? 'workflow-card workflow-card--selected' : 'workflow-card';
  return (
    <div onClick={onClick} className={cardClass}>
      <div className="workflow-inline-row">
        <StatusDot color={sc} pulsing={run.status === 'running'} />
        <span className="workflow-card__name truncate">{run.name}</span>
        {phaseCount && <span className="workflow-phase-badge">{phaseCount}</span>}
        <span className="workflow-card__status" style={{ color: sc }}>
          {run.status}
        </span>
      </div>

      {run.description !== '' && (
        <div className={expanded ? 'workflow-card__description' : 'workflow-card__description truncate'}>
          {run.description}
        </div>
      )}

      <div className="workflow-card__meta">
        <span className="workflow-card__meta-shrink" style={{ color: run.status === 'running' ? sc : 'var(--text-faint)' }}>
          {run.status === 'running' ? '◷' : '·'}
        </span>
        <span className="workflow-card__meta-shrink">{formatElapsed(elapsedMs)}</span>
        {run.status === 'running' && <span className="workflow-card__meta-label">elapsed</span>}
        <span className="workflow-card__meta-label">·</span>
        <span className="workflow-card__activity truncate">{activityText(run)}</span>
      </div>

      {expanded && <Phases run={run} />}
    </div>
  );
}

function Phases({ run }: { run: WorkflowRun }) {
  return (
    <div className="workflow-phases">
      {run.runId && <div className="workflow-phases-runid">{run.runId}</div>}
      {run.phases.length === 0 ? (
        <div className="workflow-phases-note">no phases declared</div>
      ) : (
        <>
          <div className="workflow-phases-note">{PHASES_NOTE}</div>
          {run.phases.map((phase, i) => (
            <div key={`${phase.title}-${i}`} className="workflow-phase-row">
              <span className="workflow-phase-index">{i + 1}</span>
              <span className="workflow-phase-title truncate">{phase.title}</span>
              {phase.detail && <span className="workflow-phase-detail truncate">{phase.detail}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
