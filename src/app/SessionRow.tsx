// design 7a (the composite) — the SESSION row: the inner of the two chrome
// tiers. Everything here is scoped to ONE session, the one the main pane is
// showing: where it lives, what state it is in, what it runs on, which of its
// views is open, and the `Stop` that ends its turn.
//
// It replaces the old MainTabStrip: the tabs moved OUT of the main pane's card
// and into window chrome, which is what lets the pane below be a bare terminal
// surface. Sans throughout — the mock's font boundary is drawn at the panel
// edge, so chrome is sans and clickable, the body is mono and historical.

import { Blocks, FileDiff, MessageSquare, PanelLeft, Puzzle, SquareTerminal } from 'lucide-react';
import type { SessionMeta } from '../../contract/common';
import { formatContextTokens, formatElapsed } from '../../contract/conversation-view';
import { isBusyStatus, STATUS_COLOR, STATUS_LABEL, statusPulses } from '../../contract/fleet-board';
import { displayWslCwd } from '../../contract/wsl-filesystem';
import type { ExtensionId, ExtensionInfo } from '../../contract/extensions';
import { agentTabLabel, tabIdFor, type AgentTabRef } from '../features/agents/agent-tab';
import { CloudChip } from '../features/cloud-sessions/CloudChip';
import ProjectSwitcher from '../features/projects/ProjectSwitcher';
import { RemoteControlBadge } from '../features/remote/RemoteControlBadge';
import { truncateBranchLeft, worktreeChipLabel } from '../features/sessions/worktree';
import { extTabId, sanitizeForDisplay } from '../features/extensions/extensions';
import '../features/extensions/extensions.css';
import LayoutToggle from '../features/usage/LayoutToggle';
import { sessionInterrupt } from '../lib/api';
import { abbreviate } from '../lib/path';
import { useStore, type MainTab } from '../lib/store';
import { toneVar } from '../lib/tone';
import { StatusDot } from '../ui/StatusDot';

const ICON = { size: 13, strokeWidth: 1.75 } as const;

/** The three views one session has. Icon-only, as drawn — the row is 36px. */
const VIEWS = [
  { tab: 'session', label: 'Session', glyph: <MessageSquare {...ICON} /> },
  { tab: 'diff', label: 'Diff', glyph: <FileDiff {...ICON} /> },
  { tab: 'shell', label: 'Shell', glyph: <SquareTerminal {...ICON} /> },
] as const;

export interface SessionRowProps {
  /** The FOCUSED pane's session — null when nothing is selected. */
  active: SessionMeta | null;
  mainTab: MainTab;
  setMainTab: (t: MainTab) => void;
  diffCount: number;
  agentTabs: AgentTabRef[];
  closeAgentTab: (agentId: string) => void;
  /** extensions FR-10: the available extensions, in registry order. */
  extTabs: ExtensionInfo[];
  openExtTab: (extensionId: ExtensionId) => void;
  closeExtTab: (extensionId: ExtensionId) => void;
  elapsedMs: number;
  home: string;
}

export default function SessionRow({
  active,
  mainTab,
  setMainTab,
  diffCount,
  agentTabs,
  closeAgentTab,
  extTabs,
  openExtTab,
  closeExtTab,
  elapsedMs,
  home,
}: SessionRowProps) {
  const showLeftPane = useStore((s) => s.showLeftPane);
  const toggleLeftPane = useStore((s) => s.toggleLeftPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const setRenameSessionId = useStore((s) => s.setRenameSessionId);
  // split-session: the two panes carry their own strips, so this row's view
  // control would be a third, ambiguous one. It steps aside while split.
  const split = useStore((s) => s.extraPanes.length > 0);

  const openView = (tab: MainTab) => {
    setFocusedPane('main');
    setMainTab(tab);
  };

  // toneVar: STATUS_COLOR is the contract's DARK hex map — without it the pill
  // reads acid lime on the light theme's white row (lib/tone.ts).
  const statusColor = toneVar(active ? (STATUS_COLOR[active.status] ?? 'var(--text-dim)') : 'var(--text-dim)');

  return (
    <div className="session-row">
      <button
        type="button"
        className={showLeftPane ? 'session-row__fold session-row__fold--on' : 'session-row__fold'}
        title={showLeftPane ? 'hide the roster · [' : 'show the roster · ['}
        onClick={toggleLeftPane}
      >
        <PanelLeft {...ICON} />
      </button>

      {/* breadcrumb — project / session. The project element IS the switcher
          (titlebar-project-switcher FR-1); 7a moved it down here from the
          titlebar, where the mock puts `acme-api / api-refactor`. */}
      <div className="session-row__crumbs">
        <ProjectSwitcher home={home} sessionCwd={active?.cwd ?? null} />
        {/* extensions FR-56: the chrome entry to the Extensions modal, beside the
            project control it is scoped by. ⌘K → `Extensions` is the twin. */}
        <span
          className="ext-titlebar-btn"
          title="Extensions"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useStore.getState().setExtensionsOpen(true)}
        >
          <Blocks {...ICON} />
        </span>
        {active && (
          <>
            <span className="session-row__slash">/</span>
            <span
              className="session-row__name truncate"
              title="rename this session"
              onClick={() => setRenameSessionId(active.id)}
            >
              {active.name}
            </span>
            <span className="session-row__path truncate" title={active.cwd}>
              {displayWslCwd(active.cwd) ?? abbreviate(active.cwd, home)}
            </span>
          </>
        )}
      </div>

      {active && (
        <span className="session-row__status" style={{ color: statusColor, borderColor: statusColor }}>
          <StatusDot color={statusColor} size={5} pulsing={statusPulses(active.status)} />
          {STATUS_LABEL[active.status] ?? active.status}
          {isBusyStatus(active.status) && <span className="session-row__status-age">{formatElapsed(elapsedMs)}</span>}
        </span>
      )}

      <span className="app-flex-spacer" />

      {active && (
        <>
          <span className="session-row__chip" title={active.model.brief ?? active.model.label}>
            {active.model.label}
          </span>
          {active.permissionMode !== 'default' && (
            <span
              title={`permission mode: ${active.permissionMode}`}
              className={
                active.permissionMode === 'bypassPermissions' ? 'session-row__mode session-row__mode--danger' : 'session-row__mode'
              }
            >
              {active.permissionMode === 'acceptEdits' ? 'edits-ok' : active.permissionMode === 'bypassPermissions' ? 'bypass' : 'plan'}
            </span>
          )}
          {active.runtime === 'wsl' && <span className="session-row__mode">wsl</span>}
          <span className="session-row__figure" title="context used · turn elapsed">
            {formatContextTokens(active.contextUsedTokens)}
            {active.contextLimitTokens > 0 && (
              <span className="session-row__figure-faint">/{formatContextTokens(active.contextLimitTokens)}</span>
            )}
            <span className="session-row__figure-faint"> · {formatElapsed(elapsedMs)}</span>
          </span>
        </>
      )}

      {/* view control + the dynamic agent/workflow tabs. Hidden while split —
          each pane owns its own strip there (split-session FR-4). */}
      {!split && (
        <>
          <div className="session-row__views">
            {VIEWS.map((v) => (
              <span
                key={v.tab}
                title={`${v.label}${v.tab === 'diff' ? ' · d' : v.tab === 'shell' ? ' · t' : ''}`}
                onClick={() => openView(v.tab)}
                className={mainTab === v.tab ? 'session-row__view session-row__view--on' : 'session-row__view'}
              >
                {v.glyph}
                {v.tab === 'diff' && diffCount > 0 && <span className="session-row__view-badge">{diffCount}</span>}
              </span>
            ))}
          </div>
          {/* extensions FR-10: extension tabs sit AFTER the view segment and
              BEFORE any agent/workflow tab, in registry order. They are not
              subject to AGENT_TAB_CAP and never evict a dynamic tab. No status
              dot — an extension has no lifecycle the chrome should report. */}
          {extTabs.map((e) => (
            <span
              key={e.id}
              title={`${sanitizeForDisplay(e.label)} extension`}
              onClick={() => openExtTab(e.id)}
              className={mainTab === extTabId(e.id) ? 'session-row__agent session-row__agent--on' : 'session-row__agent'}
            >
              <Puzzle size={11} strokeWidth={1.75} />
              <span className="truncate">{sanitizeForDisplay(e.label)}</span>
              <span
                onClick={(ev) => {
                  ev.stopPropagation();
                  closeExtTab(e.id);
                }}
                title="close tab"
                className="session-row__agent-close"
              >
                ✕
              </span>
            </span>
          ))}
          {agentTabs.map((t) => (
            <span
              key={tabIdFor(t)}
              title={t.name}
              onClick={() => openView(tabIdFor(t) as MainTab)}
              className={mainTab === tabIdFor(t) ? 'session-row__agent session-row__agent--on' : 'session-row__agent'}
            >
              <StatusDot
                color={
                  t.status === 'running'
                    ? 'var(--accent-2)'
                    : t.status === 'done'
                      ? 'var(--success)'
                      : t.status === 'error'
                        ? 'var(--error)'
                        : 'var(--text-muted)'
                }
                size={5}
                pulsing={t.status === 'running'}
              />
              <span className="truncate">{agentTabLabel(t.name)}</span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  closeAgentTab(t.id);
                }}
                title="close tab"
                className="session-row__agent-close"
              >
                ✕
              </span>
            </span>
          ))}
        </>
      )}

      {/* split-session FR-9: the layout control, right of the view segment. */}
      <LayoutToggle />

      {active?.worktree && (
        <span className="session-row__branch" title={worktreeChipLabel(active.worktree)}>
          ⎇ {truncateBranchLeft(worktreeChipLabel(active.worktree), 18)}
        </span>
      )}
      {/* cloud-sessions FR-16: adopted from a Claude Code on the web session.
          The tooltip carries the one-way rule. Sits beside the `rc` chip whose
          shape it reuses. */}
      {active?.cloud && <CloudChip cloud={active.cloud} />}
      {/* remote-control: host this session on claude.ai/code + mobile */}
      {active && <RemoteControlBadge key={active.id} sessionId={active.id} />}

      {active && isBusyStatus(active.status) && (
        <>
          <span className="session-row__divider" />
          <button
            type="button"
            className="session-row__stop"
            title="interrupt this turn · ⌃C"
            onClick={() => void sessionInterrupt(active.id)}
          >
            ◼ Stop
          </button>
        </>
      )}
    </div>
  );
}
