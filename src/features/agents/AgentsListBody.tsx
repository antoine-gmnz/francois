// AgentsListBody — pane [3]'s card list: the hydration-error / loading /
// empty states, the agent cards, and each card's expandable activity trail
// (async-agents FR-17..FR-23). Split out of AgentsPanel.tsx.

import { useEffect, useRef } from 'react';
import type { AgentInfo, AgentStep, AppError } from '../../../contract/common';
import { formatElapsed } from '../../../contract/conversation-view';
import {
  ASYNC_MARKER,
  STEP_GLYPH,
  STEP_GLYPH_COLOR,
  TRAIL_EMPTY_LABEL,
  TRAIL_MAX_HEIGHT_PX,
  type TrailState,
  activitySuffix,
  earlierStepsNotice,
  isAtBottom,
  showAsyncMarker,
  stepMetaColor,
  stepToolPrefix,
} from './agent-trail';
import { StatusDot } from '../../ui/StatusDot';

const statusColor: Record<string, string> = {
  running: 'var(--accent-2)',
  idle: 'var(--text-muted)',
  done: 'var(--success)',
  error: 'var(--error)',
};

export interface AgentsListBodyProps {
  listError: AppError | null;
  loading: boolean;
  list: AgentInfo[];
  now: number;
  selectedId: string | null;
  trail: TrailState;
  hoverId: string | null;
  pendingKill: Set<string>;
  onSelect: (agent: AgentInfo, e: React.MouseEvent) => void;
  onHover: (agentId: string | null) => void;
  onKill: (agentId: string) => void;
  onAtBottom: (v: boolean) => void;
}

export function AgentsListBody({
  listError,
  loading,
  list,
  now,
  selectedId,
  trail,
  hoverId,
  pendingKill,
  onSelect,
  onHover,
  onKill,
  onAtBottom,
}: AgentsListBodyProps) {
  return (
    <div className="scz agents-body">
      {listError ? (
        <div className="agents-error-text">{listError.message}</div>
      ) : loading ? null : list.length === 0 ? (
        <div className="agents-empty">
          no agents yet · press <span className="agents-empty-key">a</span>
        </div>
      ) : (
        list.map((agent) => (
          <Card
            key={agent.id}
            agent={agent}
            now={now}
            selected={agent.id === selectedId}
            trail={agent.id === trail.agentId ? trail : null}
            hover={agent.id === hoverId}
            pending={pendingKill.has(agent.id)}
            onClick={(e) => onSelect(agent, e)}
            onHover={(hovering) => onHover(hovering ? agent.id : null)}
            onKill={() => onKill(agent.id)}
            onAtBottom={onAtBottom}
          />
        ))
      )}
    </div>
  );
}

function Card({
  agent,
  now,
  selected,
  trail,
  hover,
  pending,
  onClick,
  onHover,
  onKill,
  onAtBottom,
}: {
  agent: AgentInfo;
  now: number;
  selected: boolean;
  /** The expanded card's trail state, or null when this card is collapsed. */
  trail: TrailState | null;
  hover: boolean;
  pending: boolean;
  onClick: (e: React.MouseEvent) => void;
  onHover: (hovering: boolean) => void;
  onKill: () => void;
  onAtBottom: (v: boolean) => void;
}) {
  const sc = statusColor[agent.status] ?? 'var(--text-muted)';
  const elapsedMs = Math.max(0, (agent.endedAt ?? now) - agent.startedAt);
  const showKill = agent.status === 'running' && hover && !pending;
  const expanded = trail !== null;
  const activity = activitySuffix(agent); // FR-17: rendered for every status
  const cardClass = ['agent-card', selected && 'agent-card--selected', pending && 'agent-card--pending']
    .filter(Boolean)
    .join(' ');
  return (
    <div onClick={onClick} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} className={cardClass}>
      <div className="agent-inline-row">
        <StatusDot color={sc} pulsing={agent.status === 'running'} />
        <span className="agent-card__name truncate">{agent.name}</span>
        {showAsyncMarker(agent) && <span className="agent-async-badge agent-async-badge--shrink">{ASYNC_MARKER}</span>}
        {showKill ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onKill();
            }}
            title="kill agent"
            className="agent-kill-action agent-card__kill"
          >
            ✕
          </span>
        ) : (
          <span className="agent-card__status" style={{ color: sc }}>
            {agent.status}
          </span>
        )}
      </div>
      <div className={expanded ? 'agent-card__task' : 'agent-card__task truncate'}>{agent.task}</div>
      <div className="agent-card__meta">
        <span className="agent-card__meta-shrink" style={{ color: agent.status === 'running' ? sc : 'var(--text-faint)' }}>
          {agent.status === 'running' ? '◷' : '·'}
        </span>
        <span className="agent-card__meta-shrink">{formatElapsed(elapsedMs)}</span>
        {agent.status === 'running' && <span className="agent-card__meta-label">elapsed</span>}
        {activity !== null && (
          <>
            <span className="agent-card__meta-label">·</span>
            <span className="agent-card__activity truncate">{activity}</span>
          </>
        )}
      </div>
      {trail && <Trail state={trail} stepCount={agent.stepCount} onAtBottom={onAtBottom} />}
    </div>
  );
}

/** The expanded card's activity trail (FR-19..FR-21, §8). */
function Trail({
  state,
  stepCount,
  onAtBottom,
}: {
  state: TrailState;
  stepCount: number;
  onAtBottom: (v: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const steps = state.steps;
  const newest = steps.length > 0 ? steps[steps.length - 1].seq : 0;

  // FR-21: jump to the newest step unless the user scrolled up inside the trail.
  useEffect(() => {
    const el = ref.current;
    if (!el || !state.atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [newest, steps.length, state.atBottom]);

  if (state.loading) return null; // FR-19: nothing while the request is in flight

  const earlier = earlierStepsNotice(stepCount, steps.length);
  return (
    <div
      ref={ref}
      className="scz agent-trail"
      onScroll={(e) => onAtBottom(isAtBottom(e.currentTarget))}
      style={{ maxHeight: TRAIL_MAX_HEIGHT_PX }}
    >
      {state.error ? (
        <div className="agent-trail-error-text">{state.error.message}</div>
      ) : steps.length === 0 ? (
        <div className="agent-trail-notice">{TRAIL_EMPTY_LABEL}</div>
      ) : (
        <>
          {earlier && <div className="agent-trail-earlier">{earlier}</div>}
          {steps.map((step) => (
            <StepRow key={step.seq} step={step} />
          ))}
        </>
      )}
    </div>
  );
}

function StepRow({ step }: { step: AgentStep }) {
  const prefix = stepToolPrefix(step);
  return (
    <div className="agent-step-row">
      <span className="agent-step-glyph" style={{ color: STEP_GLYPH_COLOR[step.kind] }}>
        {STEP_GLYPH[step.kind]}
      </span>
      <span className="agent-step-label truncate">
        {prefix !== null && <span className="agent-step-prefix">{prefix} </span>}
        {step.label}
      </span>
      {step.kind === 'tool' && step.meta !== undefined && (
        <span className="agent-step-meta" style={{ color: stepMetaColor(step.meta) }}>
          {step.meta}
        </span>
      )}
    </div>
  );
}
