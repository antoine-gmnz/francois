// fix-agent-view FR-12: one dynamic tab in a split pane's tab row — state
// glyph, the truncated agent or workflow name, and a close `x`. Drawn in the
// pane tabs' register (Figma 13 · Split, "Pane tabs"): underlined when active.
//
// Only the split panes use it. The unsplit shell draws its own chips inside
// `SessionHeader`, in the segmented-tab register — a pane's row sits a level
// below that, so one component cannot serve both without one reading wrong.

import { agentTabLabel, type AgentTabRef } from '../lib/agent-tab';
import { Icon } from '../ui/Icon';
import { StateIcon } from '../ui/StateIcon';
import type { StateKind } from '../ui/state-kind';

export interface AgentTabChipProps {
  tab: AgentTabRef;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}

/** A workflow's status is a subset of an agent's. */
function stateKind(status: AgentTabRef['status']): StateKind {
  if (status === 'running') return 'running';
  if (status === 'done') return 'done';
  if (status === 'error') return 'failed';
  return 'idle';
}

export default function AgentTabChip({ tab, active, onOpen, onClose }: AgentTabChipProps) {
  return (
    <span
      role="tab"
      aria-selected={active}
      onClick={onOpen}
      title={tab.name}
      className={active ? 'split-tab split-tab--agent split-tab--on' : 'split-tab split-tab--agent'}
    >
      {/* The glyph reports the AGENT's liveness, not the pane's focus, so it
          keeps its colour in an unfocused pane (split-by-4 FR-8). */}
      <StateIcon kind={stateKind(tab.status)} size={11} />
      <span className="truncate">{agentTabLabel(tab.name)}</span>
      {/* design-refresh FR-5: the close renders on every chip, not just the
          hovered one — gating it on hover made the width jump under the cursor. */}
      <span
        role="button"
        aria-label="close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="close tab"
        className="split-tab__close"
      >
        <Icon name="x" size={9} />
      </span>
    </span>
  );
}
