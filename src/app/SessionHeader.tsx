// The session header — redesign "Graphite & Signal", Figma 01 · Session "Session
// header" (131:512). It replaces the 7a/10a full-bleed session row and sits at
// the top of the main column, above the transcript. Everything here is scoped to
// the FOCUSED pane's session.
//
//   left   name (Title; click → session settings) + the state chip
//          ("Running · 04:12"), then the meta line: branch / worktree (or the
//          cwd leaf), plus the provenance chips — wsl, cloud, remote control
//   right  the Conversation / Changes / Terminal segmented tabs, then the
//          session's dynamic tabs (extensions `◈`, subagent / workflow runs),
//          `Stop` while a turn is in flight, and the session-panel toggle (`]`)
//
// What moved out of this row with the redesign, and where it lives now:
//  · the run chip (model · effort · permission) → the composer;
//  · the context bar → the session panel's footer;
//  · the layout segments → the app bar;
//  · the project switcher → the roster's scope chips (+N opens the same menu);
//  · the roster fold chevron → the roster footer / the rail / `[`.

import type { SessionMeta } from '../../contract/common';
import { formatElapsed } from '../../contract/conversation-view';
import { isBusyStatus } from '../../contract/fleet-board';
import type { ExtensionId } from '../../contract/extensions';
import { CloudChip } from '../features/cloud-sessions/CloudChip';
import { CohorteHeaderChips } from '../features/cohorte/CohorteSessionBits';
import { useHeaderRun } from '../features/cohorte/useCohorte';
import ExtensionsBarMenu from '../features/extensions/ExtensionsBarMenu';
import { RemoteControlBadge } from '../features/remote/RemoteControlBadge';
import { worktreeChipLabel } from '../features/sessions/worktree';
import { agentTabLabel, tabIdFor, type AgentTabRef } from '../lib/agent-tab';
import { sessionInterrupt } from '../lib/api';
import { useElapsedClock } from '../lib/hooks/useElapsedClock';
import { useWindowWidth } from '../lib/hooks/useWindowWidth';
import { sessionCapability } from '../lib/runtimeCapability';
import { useStore, type MainTab } from '../lib/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { StateIcon } from '../ui/StateIcon';
import { WatchedStateIcon } from '../ui/WatchedStateIcon';
import { sessionStateLabel, stateKindForStatus } from '../ui/state-kind';
import { sessionMetaLine } from './session-header';
import './session-header.css';
import { extTabDisplay, topbarTier } from './topbar';
import ViewSwitcher from './ViewSwitcher';

export interface SessionHeaderProps {
  /** The FOCUSED pane's session — null when nothing is selected. */
  active: SessionMeta | null;
  mainTab: MainTab;
  setMainTab: (t: MainTab) => void;
  diffCount: number;
  agentTabs: AgentTabRef[];
  closeAgentTab: (agentId: string) => void;
  openExtTab: (extensionId: ExtensionId) => void;
  home: string;
}

export default function SessionHeader({
  active,
  mainTab,
  setMainTab,
  diffCount,
  agentTabs,
  closeAgentTab,
  openExtTab,
  home,
}: SessionHeaderProps) {
  // The clock ticks only while the focused session's turn is in flight, and only
  // here — ticking it at the tree's root re-rendered every mounted pane.
  const busy = active !== null && isBusyStatus(active.status);
  const clockNow = useElapsedClock(busy);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const setSessionSettingsId = useStore((s) => s.setSessionSettingsId);
  const showSessionPanel = useStore((s) => s.showSessionPanel);
  const toggleSessionPanel = useStore((s) => s.toggleSessionPanel);
  // Split panes carry their own tab strips; a view control here would be a third,
  // ambiguous one, so it steps aside while split.
  const split = useStore((s) => s.extraPanes.length > 0);
  const tier = topbarTier(useWindowWidth());
  // cohorte-integration FR-60: a linked run's chips; a pending gate replaces the status pill.
  const cohorte = useHeaderRun(active?.id);

  const openView = (tab: MainTab) => {
    setFocusedPane('main');
    setMainTab(tab);
  };

  if (!active) {
    return (
      <div className="session-header session-header--empty">
        <span className="session-header__placeholder">No session selected</span>
        <span className="session-header__spacer" />
        <PanelToggle on={showSessionPanel} onToggle={toggleSessionPanel} />
      </div>
    );
  }

  const elapsedMs = busy ? clockNow - active.startedAt : Math.max(0, active.lastActivityAt - active.startedAt);
  const kind = stateKindForStatus(active.status);
  const meta = sessionMetaLine(active, home, active.worktree ? worktreeChipLabel(active.worktree) : null);

  return (
    <div className="session-header">
      <div className="session-header__title">
        <div className="session-header__name-row">
          <button
            type="button"
            className="session-header__name truncate"
            title={`${active.name} — session settings · ⌘,`}
            onClick={() => setSessionSettingsId(active.id)}
          >
            {active.name}
          </button>
          {!cohorte.state?.replacesStatus && (
            <span className={`session-header__state session-header__state--${kind}`}>
              <StateIcon kind={kind} size={11} />
              {sessionStateLabel(active.status)}
              {busy && ` · ${formatElapsed(elapsedMs)}`}
            </span>
          )}
          <CohorteHeaderChips header={cohorte} />
        </div>
        <div className="session-header__meta" title={meta.title}>
          {meta.branch !== null && <Icon name="branch" size={12} />}
          <span className="session-header__meta-text truncate">{meta.text}</span>
          {active.runtime === 'wsl' && <span className="session-header__chip">wsl</span>}
          {active.cloud && <CloudChip cloud={active.cloud} />}
          <RemoteControlBadge key={active.id} sessionId={active.id} capability={sessionCapability(active, 'remoteControl')} />
        </div>
      </div>

      <span className="session-header__spacer" />

      {!split && (
        <div className="session-header__tabs">
          <ViewSwitcher active={mainTab} diffCount={diffCount} onSelect={openView} />

          <ExtensionsBarMenu display={extTabDisplay(tier)} mainTab={mainTab} root={active.cwd} openExtTab={openExtTab} />

          {/* agent-tab FR-12: one chip per opened subagent / workflow run — content,
              not chrome, hence their own close affordance. */}
          {agentTabs.map((t) => (
            <span
              key={tabIdFor(t)}
              title={t.name}
              onClick={() => openView(tabIdFor(t) as MainTab)}
              className={mainTab === tabIdFor(t) ? 'session-header__agent session-header__agent--on' : 'session-header__agent'}
            >
              <WatchedStateIcon status={t.status} size={12} name={t.name} />
              {extTabDisplay(tier) !== 'folded' && <span className="truncate">{agentTabLabel(t.name)}</span>}
              <span
                role="button"
                aria-label="close tab"
                title="close tab · w"
                className="session-header__agent-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeAgentTab(t.id);
                }}
              >
                <Icon name="x" size={10} />
              </span>
            </span>
          ))}
        </div>
      )}

      {busy && (
        <Button className="session-header__stop" title="interrupt this turn · ⌃C" onClick={() => void sessionInterrupt(active.id)}>
          <Icon name="stop" size={12} className="session-header__stop-glyph" />
          Stop
        </Button>
      )}

      <PanelToggle on={showSessionPanel} onToggle={toggleSessionPanel} />
    </div>
  );
}

function PanelToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <IconButton size={30} framed on={on} title={on ? 'Hide the session panel · ]' : 'Show the session panel · ]'} onClick={onToggle}>
      <Icon name="panel-right" size={15} />
    </IconButton>
  );
}
