// fix-agent-view FR-12: one dynamic tab in a split pane's SUB-strip — status
// dot, `⇉`, the truncated agent or workflow name, and a `✕`.
//
// Only the split panes use it. The unsplit shell draws its own chips inside
// `SessionRow`, in the 7a chrome register (icon-height, no glyph) — a pane's
// strip sits a level below that, so one component cannot serve both without
// one of them reading wrong.

import { agentTabLabel, type AgentTabRef } from '../features/agents/agent-tab';
import { StatusDot } from '../ui/StatusDot';

export interface AgentTabChipProps {
  tab: AgentTabRef;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}

/** §8: the strip's status dot. A workflow's status is a subset of an agent's. */
function statusColor(status: AgentTabRef['status']): string {
  if (status === 'running') return 'var(--accent-2)';
  if (status === 'done') return 'var(--success)';
  if (status === 'error') return 'var(--error)';
  return 'var(--text-muted)';
}

export default function AgentTabChip({ tab, active, onOpen, onClose }: AgentTabChipProps) {
  return (
    <span
      onClick={onOpen}
      title={tab.name}
      className={active ? 'split-tab-chip split-tab-chip--active' : 'split-tab-chip'}
    >
      {/* The dot reports the AGENT's liveness, not the pane's focus, so it keeps
          its colour in an unfocused pane — the same licence the diff badge
          already has (split-by-4 FR-8). */}
      <StatusDot color={statusColor(tab.status)} size={6} pulsing={tab.status === 'running'} />
      <span className="split-tab-chip-glyph">⇉</span>
      <span className="truncate">{agentTabLabel(tab.name)}</span>
      {/* design-refresh FR-5: `✕` renders on every chip, not just the hovered
          one — gating it on hover made the chip's width jump under the cursor.
          It only brightens on hover. */}
      <span
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="close tab"
        className="split-tab-chip-close"
      >
        ✕
      </span>
    </span>
  );
}
