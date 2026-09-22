// The session panel's Activity section — redesign "Graphite & Signal", Figma
// "16 · Panel / Activity" (134:3540, light 142:14231): the focused session's
// subagents and Workflow runs in one list, RUNNING then FINISHED. A running row
// carries its live clock and a stop control; a finished row a chevron. Clicking
// a row opens that agent's (or workflow's) transcript tab — the same tab a card
// in the AGENTS / FLOWS main tabs opens. The footer's "Stop all" stops every
// running subagent.
//
// It reads through the same hydrate-then-subscribe feeds the AGENTS and FLOWS
// tabs use (useAgentsFeed / useWorkflowsFeed), scoped to this one session.

import { useMemo, useState } from 'react';
import type { SessionMeta } from '../../../contract/common';
import type { SessionPanelSectionProps } from '../../app/session-panel/sections';
import { agentsKill } from '../../lib/api';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { sessionCapability } from '../../lib/runtimeCapability';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { SidePanelBody, SidePanelEmpty, SidePanelFooter, SidePanelLabel } from '../../ui/SidePanel';
import { StateIcon } from '../../ui/StateIcon';
import { Tag } from '../../ui/Tag';
import type { StateKind } from '../../ui/state-kind';
import { useWorkflowsFeed } from '../workflows/useWorkflowsFeed';
import { activityElapsed, groupActivity, stoppableIds, type ActivityItem } from './activity-section';
import './activity-section.css';
import { useAgentsFeed } from './useAgentsFeed';

/** The tab's compact figure: the subagents the fleet sync already counts as running. */
export function ActivityBadge({ session }: { session: SessionMeta }) {
  const count = useStore((s) => s.derived.get(session.id)?.runningAgentCount ?? 0);
  return count > 0 ? <>{count}</> : null;
}

const GLYPH: Record<ActivityItem['status'], StateKind> = {
  running: 'running',
  idle: 'pending',
  done: 'done',
  error: 'failed',
};

export default function ActivitySection({ session }: SessionPanelSectionProps) {
  const syncAgentTab = useStore((s) => s.syncAgentTab);
  const openAgentTab = useStore((s) => s.openAgentTab);
  const { agents, loading, listError } = useAgentsFeed({ sessionId: session.id, syncAgentTab });
  const { runs } = useWorkflowsFeed(session.id, syncAgentTab);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());

  const groups = useMemo(() => groupActivity(agents.values(), runs.values()), [agents, runs]);
  const now = useElapsedClock(groups.running.length > 0);
  const canStop = sessionCapability(session, 'subagents').available;
  const stoppable = canStop ? stoppableIds(groups).filter((id) => !stopping.has(id)) : [];

  const stop = (ids: string[]) => {
    if (ids.length === 0) return;
    setStopping((prev) => new Set([...prev, ...ids]));
    for (const id of ids) {
      void agentsKill(id).then((res) => {
        // Success clears on the next agent.update; a refusal re-arms the control.
        if (!res.ok)
          setStopping((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
      });
    }
  };

  const open = (item: ActivityItem) => {
    if (!item.openable) return;
    openAgentTab(session.id, {
      id: item.id,
      name: item.name,
      status: item.status,
      ...(item.kind === 'workflow' ? { kind: 'workflow' as const } : {}),
    });
  };

  const empty = groups.running.length === 0 && groups.finished.length === 0;

  return (
    <>
      <SidePanelBody className="activity-section">
        {listError ? (
          <SidePanelEmpty>Could not list this session's agents: {listError.message}</SidePanelEmpty>
        ) : empty ? (
          loading ? null : <SidePanelEmpty>No subagents or workflows in this session yet.</SidePanelEmpty>
        ) : (
          <>
            {groups.running.length > 0 && (
              <>
                <SidePanelLabel count={groups.running.length}>Running</SidePanelLabel>
                {groups.running.map((item, i) => (
                  <ActivityRow
                    key={item.id}
                    item={item}
                    now={now}
                    lead={i === 0}
                    canStop={canStop && item.stoppable && !stopping.has(item.id)}
                    onStop={() => stop([item.id])}
                    onOpen={() => open(item)}
                  />
                ))}
              </>
            )}
            {groups.finished.length > 0 && (
              <>
                <SidePanelLabel count={groups.finished.length}>Finished</SidePanelLabel>
                {groups.finished.map((item) => (
                  <ActivityRow key={item.id} item={item} now={now} lead={false} canStop={false} onStop={() => {}} onOpen={() => open(item)} />
                ))}
              </>
            )}
          </>
        )}
      </SidePanelBody>

      <SidePanelFooter>
        <div className="activity-section__footer">
          <span className="activity-section__hint">Click a row to open its transcript</span>
          {stoppable.length > 0 && (
            <Button size="sm" title="Stop every running subagent" onClick={() => stop(stoppable)}>
              Stop all
            </Button>
          )}
        </div>
      </SidePanelFooter>
    </>
  );
}

/**
 * One row. `lead` is the design's raised first running row — the thing that has
 * been going longest, so the eye lands on it first.
 */
function ActivityRow({
  item,
  now,
  lead,
  canStop,
  onStop,
  onOpen,
}: {
  item: ActivityItem;
  now: number;
  lead: boolean;
  canStop: boolean;
  onStop: () => void;
  onOpen: () => void;
}) {
  const live = item.status === 'running' || item.status === 'idle';
  const classes = ['activity-row'];
  if (lead) classes.push('activity-row--lead');
  if (item.openable) classes.push('activity-row--openable');

  return (
    <div className="activity-row-wrap">
      <div className={classes.join(' ')} onClick={onOpen} title={item.openable ? `${item.name} — open its transcript` : item.name}>
        <div className="activity-row__head">
          <StateIcon kind={GLYPH[item.status]} size={13} />
          <span className="activity-row__name truncate">{item.name}</span>
          <Tag>{item.kind}</Tag>
          <span className={live ? 'activity-row__clock activity-row__clock--live' : 'activity-row__clock'}>
            {activityElapsed(item, now)}
          </span>
          {live ? (
            canStop ? (
              <IconButton
                size={24}
                className="activity-row__stop"
                title={`Stop ${item.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onStop();
                }}
              >
                <Icon name="stop" size={12} />
              </IconButton>
            ) : (
              <span className="activity-row__slot" />
            )
          ) : (
            <span className="activity-row__chevron">
              <Icon name="chevron-right" size={12} />
            </span>
          )}
        </div>
        {item.line && (
          <div className="activity-row__line truncate">
            {item.status === 'error' ? (
              <>
                <span className="activity-row__failed">Failed</span> — {item.line}
              </>
            ) : (
              item.line
            )}
          </div>
        )}
        {item.phases.length > 0 && <div className="activity-row__phases truncate">{item.phases.join(' · ')}</div>}
      </div>
    </div>
  );
}
