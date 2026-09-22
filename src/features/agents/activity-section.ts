// The pure half of the session panel's Activity section (redesign "Graphite &
// Signal", Figma "16 · Panel / Activity" 134:3540): one list over the focused
// session's subagents AND its Workflow runs, split RUNNING / FINISHED, each row
// naming what it is (`subagent` / `workflow`), its clock, and one line of what
// it is doing or how it ended. Unit-tested in activity-section.test.ts.

import type { AgentInfo, WorkflowRun } from '../../../contract/common';
import { formatElapsed } from '../../../contract/conversation-view';

export interface ActivityItem {
  kind: 'subagent' | 'workflow';
  id: string;
  name: string;
  status: 'running' | 'idle' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
  /** One line: what it is doing now, or what it last did. */
  line: string;
  /** A workflow's declared phase titles; empty for a subagent. */
  phases: string[];
  /** Subagents only — a workflow cannot be stopped from here. */
  stoppable: boolean;
  /** Whether a click has a tab to open (a workflow needs its transcript dir). */
  openable: boolean;
}

function agentItem(agent: AgentInfo): ActivityItem {
  return {
    kind: 'subagent',
    id: agent.id,
    name: agent.name,
    status: agent.status,
    startedAt: agent.startedAt,
    endedAt: agent.endedAt,
    line: agent.lastActivity?.trim() || agent.task,
    phases: [],
    stoppable: agent.status === 'running',
    openable: true,
  };
}

function workflowItem(run: WorkflowRun): ActivityItem {
  const line =
    (run.pendingAsks ?? 0) > 0 ? 'waiting on you' : run.lastActivity?.trim() || run.description || (run.status === 'running' ? 'dispatched' : '');
  return {
    kind: 'workflow',
    id: run.id,
    name: run.name,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    line,
    phases: run.phases.map((p) => p.title),
    stoppable: false,
    openable: typeof run.transcriptDir === 'string' && run.transcriptDir !== '',
  };
}

export interface ActivityGroups {
  running: ActivityItem[];
  finished: ActivityItem[];
}

/**
 * RUNNING holds whatever is still going (an `idle` subagent is still alive, so
 * it stays here), oldest first — the longest-running thing is on top.
 * FINISHED holds done + failed, most recently ended first.
 */
export function groupActivity(agents: Iterable<AgentInfo>, runs: Iterable<WorkflowRun>): ActivityGroups {
  const items = [...Array.from(agents, agentItem), ...Array.from(runs, workflowItem)];
  const live = (i: ActivityItem) => i.status === 'running' || i.status === 'idle';
  return {
    running: items.filter(live).sort((a, b) => a.startedAt - b.startedAt),
    finished: items.filter((i) => !live(i)).sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
  };
}

/** The row clock: live elapsed while running, frozen at the end once finished. */
export function activityElapsed(item: Pick<ActivityItem, 'startedAt' | 'endedAt'>, now: number): string {
  return formatElapsed(Math.max(0, (item.endedAt ?? now) - item.startedAt));
}

/** The ids "Stop all" would stop. */
export function stoppableIds(groups: ActivityGroups): string[] {
  return groups.running.filter((i) => i.stoppable).map((i) => i.id);
}
