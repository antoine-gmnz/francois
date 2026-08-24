// design 10a (turn 10 — "the shipped topbar, below fullscreen"), with 11a's plugin
// surface and 11c's run chip — the SESSION row: the inner of the two chrome tiers.
// Everything here is scoped to ONE session, the one the main pane is showing: where
// it lives, what state it is in, what it runs on, which of its views is open, and
// the `Stop` that ends its turn.
//
// What turn 10 changed, and why:
//  · The row is RANKED, not source-ordered. `topbar.ts` owns the drop order; this
//    file reads it. That is the whole fix — the old row packed eleven things in
//    source order, so the first casualty of a narrow window was whatever happened to
//    sit in the middle, and the worktree path cropped mid-string while the controls
//    either side of it kept their full width.
//  · The path LEFT the bar. It is the least glanceable string in it, and the project
//    chip's tooltip already carries it.
//  · The two clocks MERGED. `active 19:13` and `· 19:13` were the same number; the
//    status pill keeps it and the context readout is now context alone.
//  · Every control is 26px tall, and only the session title is elastic. Everything
//    else is `flex-shrink: 0`, which is what stops mid-string crops coming back.
//
// Three things never shrink and never leave: the status pill, `Stop`, and the project
// chip. They are the only controls whose absence would be dangerous or disorienting.
// The view segment joins them — it is how you get anywhere, so it is not something a
// narrow window may take away.
//
// Sans throughout — the mock's font boundary is drawn at the panel edge, so chrome is
// sans and clickable, the body is mono and historical.

import { FileDiff, MessageSquare, PanelLeft, SquareTerminal } from 'lucide-react';
import type { SessionMeta } from '../../contract/common';
import { formatContextTokens, formatElapsed } from '../../contract/conversation-view';
import { isBusyStatus, STATUS_COLOR, STATUS_LABEL, statusPulses } from '../../contract/fleet-board';
import type { ExtensionId } from '../../contract/extensions';
import { agentTabLabel, tabIdFor, type AgentTabRef } from '../features/agents/agent-tab';
import { CloudChip } from '../features/cloud-sessions/CloudChip';
import ExtensionsBarMenu from '../features/extensions/ExtensionsBarMenu';
import ProjectSwitcher from '../features/projects/ProjectSwitcher';
import { RemoteControlBadge } from '../features/remote/RemoteControlBadge';
import RunChip from '../features/sessions/RunChip';
import { truncateBranchLeft, worktreeChipLabel } from '../features/sessions/worktree';
import LayoutToggle from '../features/usage/LayoutToggle';
import { sessionInterrupt } from '../lib/api';
import { useWindowWidth } from '../lib/hooks/useWindowWidth';
import { useStore, type MainTab } from '../lib/store';
import { toneVar } from '../lib/tone';
import { StatusDot } from '../ui/StatusDot';
import TopbarOverflow from './TopbarOverflow';
import { branchDisplay, contextDisplay, extTabDisplay, layoutDisplay, showsStatusWord, topbarShows, topbarTier } from './topbar';

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
  /** extensions FR-10 / design 11a: opening a tab from the `◈` menu or a pinned tab. */
  openExtTab: (extensionId: ExtensionId) => void;
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
  openExtTab,
  elapsedMs,
  home,
}: SessionRowProps) {
  const showLeftPane = useStore((s) => s.showLeftPane);
  const toggleLeftPane = useStore((s) => s.toggleLeftPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const setSessionSettingsId = useStore((s) => s.setSessionSettingsId);
  // split-session: the two panes carry their own strips, so this row's view
  // control would be a third, ambiguous one. It steps aside while split.
  const split = useStore((s) => s.extraPanes.length > 0);

  // The row is full-bleed under the native caption, so it IS the window width —
  // no ResizeObserver, and no container query to keep in step with the roster.
  const tier = topbarTier(useWindowWidth());
  const branch = branchDisplay(tier);
  const context = contextDisplay(tier);
  const layout = layoutDisplay(tier);

  const openView = (tab: MainTab) => {
    setFocusedPane('main');
    setMainTab(tab);
  };

  // toneVar: STATUS_COLOR is the contract's DARK hex map — without it the pill
  // reads acid lime on the light theme's white row (lib/tone.ts).
  const statusColor = toneVar(active ? (STATUS_COLOR[active.status] ?? 'var(--text-dim)') : 'var(--text-dim)');

  const branchLabel = active?.worktree ? worktreeChipLabel(active.worktree) : null;
  const contextFigure = active
    ? `${formatContextTokens(active.contextUsedTokens)}${active.contextLimitTokens > 0 ? `/${formatContextTokens(active.contextLimitTokens)}` : ''}`
    : '';
  const contextFraction =
    active && active.contextLimitTokens > 0 ? Math.min(1, Math.max(0, active.contextUsedTokens / active.contextLimitTokens)) : 0;

  // What `⋯` has to state rather than render. Built here because the bar already
  // computed both strings for its own row (topbar.ts owns WHICH, not WHAT).
  const overflowReadouts = [
    { label: 'Context', value: contextFigure },
    ...(branchLabel ? [{ label: 'Branch', value: `⑂ ${branchLabel}` }] : []),
  ];

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

      {/* The project chip. Never drops — you cannot tell which session you are
          looking at without it — and 10a hands it the worktree path it took off the
          row (titlebar-project-switcher FR-1; `switcherTooltip` already composes it). */}
      <ProjectSwitcher home={home} sessionCwd={active?.cwd ?? null} />

      {active && (
        <>
          {/* The one elastic element in the row. */}
          <span
            className="session-row__name truncate"
            title={`${active.name} — click for session settings`}
            onClick={() => setSessionSettingsId(active.id)}
          >
            {active.name}
          </span>

          {branchLabel && branch === 'name' && (
            <span className="session-row__branch" title={branchLabel}>
              ⑂ {truncateBranchLeft(branchLabel, 18)}
            </span>
          )}
          {branchLabel && branch === 'glyph' && (
            <span className="session-row__branch session-row__branch--glyph" title={`⑂ ${branchLabel}`}>
              ⑂
            </span>
          )}
        </>
      )}

      {/* 11a: the plugin surface — pinned tabs, then `◈`. Separated from the title
          by a gap rather than a rule: 9a's chrome has no strokes. */}
      {!split && (
        <>
          <span className="session-row__gap" />
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

          <ExtensionsBarMenu
            display={extTabDisplay(tier)}
            mainTab={mainTab}
            root={active?.cwd ?? null}
            openExtTab={openExtTab}
          />

          {/* agent-tab FR-12: one chip per opened subagent/workflow run. They are
              content, not chrome — hence their own close affordance. Their labels
              go with the extension labels, on the same argument. */}
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
              {/* An agent chip's label is its ONLY identifier — it has no tile to
                  fall back on the way an extension tab does — so it survives one
                  tier longer than 11a's extension labels, to the last width where
                  anything but the essentials is still in the bar. */}
              {extTabDisplay(tier) !== 'folded' && <span className="truncate">{agentTabLabel(t.name)}</span>}
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

      <span className="app-flex-spacer" />

      {/* The status pill. Never leaves, never shrinks — but its LABEL does: at the
          narrowest width the merged clock carries the state on its own, and the
          colour and the dot were always the part doing the work. */}
      {active && (
        <span className="session-row__status" style={{ color: statusColor }}>
          <StatusDot color={statusColor} size={5} pulsing={statusPulses(active.status)} />
          {showsStatusWord(tier) && (STATUS_LABEL[active.status] ?? active.status)}
          {isBusyStatus(active.status) && <span className="session-row__status-age">{formatElapsed(elapsedMs)}</span>}
        </span>
      )}

      {/* 11c: model + permission mode, one chip, one panel. */}
      {active && topbarShows(tier, 'modelChip') && <RunChip session={active} />}

      {active && context !== 'overflow' && (
        <span className="session-row__context" title={`context ${contextFigure}`}>
          <span className="session-row__context-track">
            <span className="session-row__context-fill" style={{ width: `${Math.round(contextFraction * 100)}%` }} />
          </span>
          {context === 'bar+figure' && <span className="session-row__figure">{contextFigure}</span>}
        </span>
      )}

      {active?.runtime === 'wsl' && <span className="session-row__mode">wsl</span>}
      {/* cloud-sessions FR-16: adopted from a Claude Code on the web session. */}
      {active?.cloud && <CloudChip cloud={active.cloud} />}
      {/* remote-control: host this session on claude.ai/code + mobile */}
      {active && <RemoteControlBadge key={active.id} sessionId={active.id} />}

      {layout === 'segments' && <LayoutToggle />}
      {layout === 'menu' && <LayoutToggle variant="menu" />}
      {active && layout === 'overflow' && (
        <TopbarOverflow
          session={active}
          readouts={overflowReadouts}
          layout={<LayoutToggle divider={false} />}
        />
      )}

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
