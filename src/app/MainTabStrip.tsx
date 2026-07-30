import { useState } from 'react';
import type { SessionMeta } from '../../contract/common';
import { formatContextTokens, formatElapsed } from '../../contract/conversation-view';
import { agentTabId, agentTabLabel, type AgentTabRef } from '../features/agents/agent-tab';
import { RemoteControlBadge } from '../features/remote/RemoteControlBadge';
import type { MainTab } from '../lib/store';
import { BadgePill } from '../ui/BadgePill';
import { StatusDot } from '../ui/StatusDot';
import { tabClassName } from './appShell';

export interface MainTabStripProps {
  mainTab: MainTab;
  setMainTab: (t: MainTab) => void;
  diffCount: number;
  agentTabs: AgentTabRef[];
  closeAgentTab: (agentId: string) => void;
  active: SessionMeta | null;
  elapsedMs: number;
}

/** The main pane's tab strip (OVERVIEW/SESSION/DIFF/SHELL + dynamic agent
 * tabs) and, when SESSION is active, the right-aligned session meta cluster. */
export default function MainTabStrip({ mainTab, setMainTab, diffCount, agentTabs, closeAgentTab, active, elapsedMs }: MainTabStripProps) {
  return (
    <div className="app-tabstrip">
      {/* §8: the strip scrolls horizontally past overflow rather than
          clipping or squeezing tabs; it shrinks before the right-aligned
          session meta cluster does. */}
      <div className="app-tabstrip-left scz">
        {/* overview: the cross-project dashboard. First in the strip because
            it is the zoomed-OUT view — the tabs read left-to-right from the
            whole fleet down to one session's files. */}
        <span onClick={() => setMainTab('overview')} className={tabClassName(mainTab === 'overview')}>
          OVERVIEW
        </span>
        <span onClick={() => setMainTab('session')} className={tabClassName(mainTab === 'session')}>
          SESSION
        </span>
        <span onClick={() => setMainTab('diff')} className={`${tabClassName(mainTab === 'diff')} app-tab--diff`}>
          DIFF
          {diffCount > 0 && <BadgePill>{diffCount}</BadgePill>}
        </span>
        <span onClick={() => setMainTab('shell')} className={tabClassName(mainTab === 'shell')}>
          SHELL
        </span>
        {/* agent-tab FR-9/FR-12: one tab per clicked subagent, in open
            order. Lower-case and un-tracked on purpose — an agent name is
            content, not a chrome label. */}
        {agentTabs.map((t) => (
          <AgentTabChip
            key={t.id}
            tab={t}
            active={mainTab === agentTabId(t.id)}
            onOpen={() => setMainTab(agentTabId(t.id) as MainTab)}
            onClose={() => closeAgentTab(t.id)}
          />
        ))}
      </div>
      {mainTab === 'session' && active && (
        <div className="app-meta-cluster">
          <span>{active.model.label}</span>
          {active.permissionMode !== 'default' && (
            <span
              title={`permission mode: ${active.permissionMode}`}
              className={active.permissionMode === 'bypassPermissions' ? 'app-text-error' : 'app-text-faint'}
            >
              {active.permissionMode === 'acceptEdits' ? 'edits-ok' : active.permissionMode === 'bypassPermissions' ? 'bypass' : 'plan'}
            </span>
          )}
          {active.runtime === 'wsl' && <span className="app-text-faint">wsl</span>}
          {/* remote-control: host this session on claude.ai/code + mobile */}
          <RemoteControlBadge key={active.id} sessionId={active.id} />
          <span>
            <span className="app-text-faint">ctx </span>
            <span className="app-text-bright">{formatContextTokens(active.contextUsedTokens)}</span>
            <span className="app-text-faint">/{formatContextTokens(active.contextLimitTokens)}</span>
          </span>
          <span className="app-text-faint">{formatElapsed(elapsedMs)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * agent-tab FR-12 / §8: one agent tab in the strip — status dot, `⇉`, the
 * truncated agent name, and a `✕` that appears on hover. Not upper-cased or
 * letter-spaced like the built-in tabs: this is content, not chrome.
 */
function AgentTabChip({
  tab,
  active,
  onOpen,
  onClose,
}: {
  tab: AgentTabRef;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [hover, setHover] = useState(false);
  const statusColor =
    tab.status === 'running'
      ? 'var(--accent-2)'
      : tab.status === 'done'
        ? 'var(--success)'
        : tab.status === 'error'
          ? 'var(--error)'
          : 'var(--text-muted)';
  return (
    <span
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={tab.name}
      className={active ? 'app-tab-chip app-tab-chip--active' : 'app-tab-chip'}
    >
      <StatusDot color={statusColor} size={6} pulsing={tab.status === 'running'} />
      <span className="app-tab-chip-glyph">⇉</span>
      <span className="truncate">{agentTabLabel(tab.name)}</span>
      {hover && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="close tab"
          className="app-tab-chip-close"
        >
          ✕
        </span>
      )}
    </span>
  );
}
