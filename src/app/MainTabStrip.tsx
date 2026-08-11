import type { SessionMeta } from '../../contract/common';
import { formatContextTokens, formatElapsed } from '../../contract/conversation-view';
import { agentTabLabel, tabIdFor, type AgentTabRef } from '../features/agents/agent-tab';
import { CloudChip } from '../features/cloud-sessions/CloudChip';
import { RemoteControlBadge } from '../features/remote/RemoteControlBadge';
import { truncateBranchLeft } from '../features/sessions/worktree';
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
  showSessionMeta: boolean;
  toggleSessionMeta: () => void;
}

/** The main pane's tab strip (OVERVIEW/SESSION/DIFF/SHELL + dynamic agent
 * tabs) and, when SESSION is active, the right-aligned session meta cluster. */
export default function MainTabStrip({
  mainTab,
  setMainTab,
  diffCount,
  agentTabs,
  closeAgentTab,
  active,
  elapsedMs,
  showSessionMeta,
  toggleSessionMeta,
}: MainTabStripProps) {
  return (
    <div className="app-tabstrip">
      {/* §8: the strip scrolls horizontally past overflow rather than
          clipping or squeezing tabs; it shrinks before the right-aligned
          session meta cluster does. */}
      <div className="app-tabstrip-left scz">
        {/* design-refresh FR-5: the built-in tabs sit on a recessed segmented
            track, sentence-case; agent tabs follow outside it after a
            divider — they are content, not chrome. */}
        <div className="tab-segment">
          {/* overview: the cross-project dashboard. First in the strip because
              it is the zoomed-OUT view — the tabs read left-to-right from the
              whole fleet down to one session's files. */}
          <span onClick={() => setMainTab('overview')} className={tabClassName(mainTab === 'overview')}>
            Overview
          </span>
          <span onClick={() => setMainTab('session')} className={tabClassName(mainTab === 'session')}>
            Session
          </span>
          <span onClick={() => setMainTab('diff')} className={`${tabClassName(mainTab === 'diff')} app-tab--diff`}>
            Diff
            {diffCount > 0 && <BadgePill>{diffCount}</BadgePill>}
          </span>
          <span onClick={() => setMainTab('shell')} className={tabClassName(mainTab === 'shell')}>
            Shell
          </span>
        </div>
        {agentTabs.length > 0 && <span className="tab-segment-divider" />}
        {/* agent-tab FR-9/FR-12: one tab per clicked subagent — and, since
            workflow-details FR-12, per clicked workflow run, in the same strip
            and the same open order (`tabIdFor` keys each ref onto its own tab
            id). Lower-case and un-tracked on purpose — a name is content, not a
            chrome label. */}
        {agentTabs.map((t) => (
          <AgentTabChip
            key={tabIdFor(t)}
            tab={t}
            active={mainTab === tabIdFor(t)}
            onOpen={() => setMainTab(tabIdFor(t) as MainTab)}
            onClose={() => closeAgentTab(t.id)}
          />
        ))}
      </div>
      {mainTab === 'session' && active && (
        <div className="app-meta-cluster">
          {showSessionMeta && (
            <>
              <span>{active.model.label}</span>
              {active.permissionMode !== 'default' && (
                <span
                  title={`permission mode: ${active.permissionMode}`}
                  className={active.permissionMode === 'bypassPermissions' ? 'app-text-error' : 'app-text-faint'}
                >
                  {active.permissionMode === 'acceptEdits'
                    ? 'edits-ok'
                    : active.permissionMode === 'bypassPermissions'
                      ? 'bypass'
                      : 'plan'}
                </span>
              )}
              {active.runtime === 'wsl' && <span className="app-text-faint">wsl</span>}
              {/* cloud-sessions FR-16: adopted from a Claude Code on the web
                  session. The tooltip carries the one-way rule. */}
              {active.cloud && <CloudChip cloud={active.cloud} />}
              {/* session-worktree FR-13: branch glyph + name, focused session only */}
              {active.worktree && (
                <span title={active.worktree.branch} className="app-text-accent">
                  ⎇ {truncateBranchLeft(active.worktree.branch, 24)}
                </span>
              )}
              {/* remote-control: host this session on claude.ai/code + mobile */}
              <RemoteControlBadge key={active.id} sessionId={active.id} />
              {/* design-refresh FR-5: the mock pairs the context figure with a mini
                  fill bar — same numbers, already in the store, just read at a
                  glance. Hidden when the limit is unknown (no denominator, no bar). */}
              <span className="app-ctx">
                {active.contextLimitTokens > 0 && (
                  <span className="app-ctx-track">
                    <span
                      className="app-ctx-fill"
                      style={{ width: `${Math.min(100, (active.contextUsedTokens / active.contextLimitTokens) * 100)}%` }}
                    />
                  </span>
                )}
                <span className="app-ctx-figure">
                  {formatContextTokens(active.contextUsedTokens)}
                  <span className="app-text-faint">/{formatContextTokens(active.contextLimitTokens)}</span>
                </span>
              </span>
              <span className="app-ctx-figure app-text-faint">{formatElapsed(elapsedMs)}</span>
            </>
          )}
          {/* The cluster is flex-shrink:0 — it wins the strip's width and the
              tabs scroll under it, so folding the cluster is what actually
              hands that width back to a long agent-tab run. Last in the row on
              purpose: the chevron keeps the strip's right edge either way, so
              the control never moves when it is clicked. */}
          <span
            onClick={toggleSessionMeta}
            title={showSessionMeta ? 'collapse session meta' : 'expand session meta'}
            className="app-meta-toggle"
          >
            {showSessionMeta ? '›' : '‹'}
          </span>
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
  const statusColor =
    tab.status === 'running'
      ? 'var(--accent-2)'
      : tab.status === 'done'
        ? 'var(--success)'
        : tab.status === 'error'
          ? 'var(--error)'
          : 'var(--text-muted)';
  return (
    <span onClick={onOpen} title={tab.name} className={active ? 'app-tab-chip app-tab-chip--active' : 'app-tab-chip'}>
      <StatusDot color={statusColor} size={6} pulsing={tab.status === 'running'} />
      <span className="app-tab-chip-glyph">⇉</span>
      <span className="truncate">{agentTabLabel(tab.name)}</span>
      {/* design-refresh FR-5: the mock renders `✕` on every agent tab, not just
          the hovered one — gating it on hover made the pill's width jump under
          the cursor. It only brightens on hover now. */}
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
    </span>
  );
}
