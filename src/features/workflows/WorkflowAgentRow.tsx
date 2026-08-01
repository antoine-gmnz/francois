// workflow-details FR-16 / design §2b — one agent of a run, in the left rail.
//
// Pane [3]'s card metrics plus the one genuinely new element in this feature:
// the span bar, measured against the RUN's window so concurrent agents visibly
// overlap. Every value here is derived (workflow-detail.ts), never stored.

import { useRef } from 'react';
import { formatElapsed } from '../../../contract/conversation-view';
import type { WorkflowAgentInfo } from '../../../contract/workflow-details';
import { StatusDot } from '../../ui/StatusDot';
import {
  agentElapsedMs,
  agentStatusColor,
  formatTokens,
  resultPreview,
  spanBar,
  spanFillColor,
  sumTokens,
} from './workflow-detail';
import './workflow-detail.css';

export interface WorkflowAgentRowProps {
  agent: WorkflowAgentInfo;
  /** The run's own window — the ONE origin every row's bar is measured against. */
  run: { startedAt: number; endedAt?: number };
  now: number;
  selected: boolean;
  onSelect: () => void;
}

export default function WorkflowAgentRow({ agent, run, now, selected, onSelect }: WorkflowAgentRowProps) {
  const color = agentStatusColor(agent.status);
  const waiting = agent.status === 'waiting';

  // §2b: the bar keeps its live fill while waiting but must stop extending.
  // Capture the `now` this row FIRST observed `waiting` and reuse it every
  // render after — that freezes the width without freezing the clock.
  const frozenAtRef = useRef<number | null>(null);
  if (!waiting) {
    frozenAtRef.current = null;
  } else if (frozenAtRef.current === null) {
    frozenAtRef.current = now;
  }
  const bar = spanBar(agent, run, now, frozenAtRef.current ?? undefined);
  const preview = resultPreview(agent.result);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={selected ? 'wfd-agent wfd-agent--selected' : 'wfd-agent'}
    >
      <div className="wfd-agent__head">
        {/* waiting is stalled, not working — the dot stops pulsing (§2b) */}
        <StatusDot color={color} size={7} pulsing={agent.status === 'running'} />
        <span className="wfd-agent__type truncate">{agent.agentType}</span>
        {agent.model && <span className="wfd-agent__model">{agent.model}</span>}
        <span className="wfd-agent__spacer" />
        <span className={waiting ? 'wfd-agent__figure wfd-agent__figure--waiting' : 'wfd-agent__figure'}>
          {waiting ? 'waiting' : formatElapsed(agentElapsedMs(agent, now))}
        </span>
        <span className="wfd-agent__figure">{formatTokens(sumTokens(agent.tokens))} tok</span>
      </div>

      {/* stands in for the CLI's `opts.label`, which is not recoverable from disk */}
      {agent.prompt !== '' && <div className="wfd-agent__prompt truncate">{agent.prompt}</div>}

      {/* §Accessibility: decorative — the elapsed figure above carries the same
          information. The offsets are runtime-computed, hence inline. */}
      <div className="wfd-span" aria-hidden="true">
        <span
          className="wfd-span__fill"
          style={{ left: `${bar.left}%`, width: `${bar.width}%`, background: spanFillColor(agent.status) }}
        />
      </div>

      {preview !== null && <div className="wfd-agent__result truncate">→ {preview}</div>}
    </button>
  );
}
