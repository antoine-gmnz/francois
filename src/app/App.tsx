import { Fragment, useCallback, useEffect, useState } from 'react';
import AccountsModal from '../features/accounts/AccountsModal';
import { startAccountFeed } from '../features/accounts/accounts';
import AgentsPanel from '../features/agents/AgentsPanel';
import { agentIdFromTab, tabsForSession } from '../features/agents/agent-tab';
import AdoptCloudSessionModal from '../features/cloud-sessions/AdoptCloudSessionModal';
import ExtensionsModal from '../features/extensions/ExtensionsModal';
import { visibleExtensions } from '../features/extensions/extensions';
import { detectionRoot, initExtensionEvents, refreshExtensions } from '../features/extensions/extensionsFeed';
import McpPanel from '../features/mcp/McpPanel';
import { initNotifications } from '../features/notifications/notifications';
import { initAudioCues } from '../features/notifications/sound';
import PaletteRoot from '../features/palette/PaletteView';
import { registerBuiltinCommands } from '../features/palette/paletteCommands';
import PermissionsModal from '../features/permissions/PermissionsModal';
import ProfilesModal from '../features/profiles/ProfilesModal';
import { loadProfiles } from '../features/profiles/profiles';
import ProjectsModal from '../features/projects/ProjectsModal';
import NewSessionModal from '../features/sessions/NewSessionModal';
import RenameSessionModal from '../features/sessions/RenameSessionModal';
import Sidebar from '../features/sessions/Sidebar';
import { initShellEvents } from '../features/shell/shellStore';
import SkillsPanel from '../features/skills/SkillsPanel';
import UpdateModal from '../features/update/UpdateModal';
import { checkUpdateOnLaunch } from '../features/update/update';
import WorkflowsPanel from '../features/workflows/WorkflowsPanel';
import { isBusyStatus } from '../../contract/fleet-board';
import { appSetWindowTheme, onRemoteEvent } from '../lib/api';
import { useWindowWidth } from '../lib/hooks/useWindowWidth';
import { focusedSessionId, layoutRegime, paneCount, paneSlotAt } from '../lib/layoutStore';
import { basename } from '../lib/path';
import { clampRosterWidth } from '../lib/rosterWidth';
import { useStore } from '../lib/store';
import './app.css';
import AppRow from './AppRow';
import { dividerGridArea, isPanelTab, PANEL_TABS, paneGridArea, shellColumns, showsPanes } from './appShell';
import MainPaneBody from './MainPaneBody';
import RosterDivider from './RosterDivider';
import SessionRail from './SessionRail';
import SessionRow from './SessionRow';
import SplitDivider from './SplitDivider';
import SplitPane from './SplitPane';
import { useAppIdentity } from './useAppIdentity';
import { useAppShortcuts } from './useAppShortcuts';
import { useDiffBadge } from './useDiffBadge';

// Register the built-in palette commands once, before first paint (FR-6).
registerBuiltinCommands();

/** design 7a: the four dissolved right-column panes, in roster-row order. */
const PANELS = {
  agents: AgentsPanel,
  mcp: McpPanel,
  skills: SkillsPanel,
  workflows: WorkflowsPanel,
} as const;

export default function App() {
  const [clockNow, setClockNow] = useState(() => Date.now());
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const mainTab = useStore((s) => s.mainTab);
  const setMainTab = useStore((s) => s.setMainTab);
  const theme = useStore((s) => s.theme);
  const showLeftPane = useStore((s) => s.showLeftPane);
  const toggleLeftPane = useStore((s) => s.toggleLeftPane);
  const newSessionOpen = useStore((s) => s.newSessionOpen);
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);
  const newAgentOpen = useStore((s) => s.newAgentOpen);
  const setNewAgentOpen = useStore((s) => s.setNewAgentOpen);
  // cloud-sessions FR-14: opened from the pane [1] action AND ⌘K, so the modal
  // is rendered here like every other shared one.
  const adoptCloudOpen = useStore((s) => s.adoptCloudOpen);
  const setAdoptCloudOpen = useStore((s) => s.setAdoptCloudOpen);
  // Stable identity: the modal keys effects (its landing hand-off, its keydown
  // subscription) off this callback, and App re-renders on every store tick.
  const closeAdoptCloud = useCallback(() => setAdoptCloudOpen(false), [setAdoptCloudOpen]);
  // session-rename FR-12/FR-14: opened from the sidebar context menu AND the palette.
  const renameSessionId = useStore((s) => s.renameSessionId);
  const setRenameSessionId = useStore((s) => s.setRenameSessionId);
  const activeProjectId = useStore((s) => s.activeProjectId);
  // projects FR-39: a switch into an empty project auto-opens the new-session
  // modal — these two settle what cancelling vs. creating does to the scope.
  const rollbackProjectSwitch = useStore((s) => s.rollbackProjectSwitch);
  const clearProjectSwitchRollback = useStore((s) => s.clearProjectSwitchRollback);
  const permissionsOpen = useStore((s) => s.permissionsOpen);
  const setPermissionsOpen = useStore((s) => s.setPermissionsOpen);
  const projects = useStore((s) => s.projects);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
  const accountsOpen = useStore((s) => s.accountsOpen);
  const setAccountsOpen = useStore((s) => s.setAccountsOpen);
  const profilesOpen = useStore((s) => s.profilesOpen);
  const setProfilesOpen = useStore((s) => s.setProfilesOpen);
  const setProfiles = useStore((s) => s.setProfiles);
  const updateModalOpen = useStore((s) => s.updateModalOpen);
  const setUpdateModalOpen = useStore((s) => s.setUpdateModalOpen);
  const setAccounts = useStore((s) => s.setAccounts);
  const upsertSession = useStore((s) => s.upsertSession);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  // extensions FR-9..FR-11: the `ext:<id>` tabs, after the view segment and
  // before the dynamic agent/workflow tabs.
  const extensions = useStore((s) => s.extensions);
  const extStickyIds = useStore((s) => s.extStickyIds);
  const extensionsOpen = useStore((s) => s.extensionsOpen);
  const openExtTab = useStore((s) => s.openExtTab);
  // agent-tab FR-9: the dynamic per-subagent tabs, after the view segment.
  // fix-agent-view FR-1/FR-11: keyed by session now, and the session row only
  // shows them unsplit — so PANE 0's session is the right list here. Each
  // SplitPane reads its own.
  const agentTabs = useStore((s) => tabsForSession(s.agentTabs, s.activeSessionId));
  const closeAgentTab = useStore((s) => s.closeAgentTab);
  const clearAgentTabs = useStore((s) => s.clearAgentTabs);
  // split-by-4: panes 1..3. `activeSessionId`/`mainTab` are PANE 0's, unchanged —
  // so nothing below this line remounts when focus moves.
  const extraPanes = useStore((s) => s.extraPanes);
  const focusedPaneIndex = useStore((s) => s.focusedPaneIndex);
  const lastFocusedSessionId = useStore((s) => s.lastFocusedSessionId);
  const setPaneTab = useStore((s) => s.setPaneTab);
  const setFocusedPaneIndex = useStore((s) => s.setFocusedPaneIndex);
  const assignToFocusedPane = useStore((s) => s.assignToFocusedPane);
  // unbound-panes FR-9: the four entry points split by whether they name a
  // pane. The empty pane's affordance and the header menu's `Convert to shell…`
  // both act on a KNOWN index, so they go through `convertPaneToShell` here;
  // the palette command, the roster's project row and the header menu's `Open a
  // shell pane beside…` name none, so they call `openShellPane` themselves
  // (paletteCommands.ts / Sidebar.tsx / PaneHeaderMenu.tsx).
  const convertPaneToShell = useStore((s) => s.convertPaneToShell);
  const setPaneShellId = useStore((s) => s.setPaneShellId);
  // How the panes share the cell, dragged from the dividers between them: the
  // columns everywhere, the rows in the 2×2 regimes.
  const splitRatio = useStore((s) => s.splitRatio);
  const splitRowRatio = useStore((s) => s.splitRowRatio);
  const unsplit = useStore((s) => s.unsplit);
  const closePane = useStore((s) => s.closePane);
  const panes = paneCount({ extraPanes });
  const regime = layoutRegime(panes);
  // unbound-panes FR-1 — see `showsPanes`: OVERVIEW takes the main view over
  // full-width, and the panes wait underneath rather than being unsplit.
  const split = showsPanes(panes, mainTab);
  // resizable-sidebar: the roster's stored width (the user's intent, never
  // clamped by the viewport) and the viewport width the render clamp needs.
  const rosterWidth = useStore((s) => s.rosterWidth);
  const setRosterWidth = useStore((s) => s.setRosterWidth);
  const resetRosterWidth = useStore((s) => s.resetRosterWidth);
  const viewportWidth = useWindowWidth();
  // The shell's tracks + whether the roster is folded to its rail + whether
  // the handle renders at all (FR-11: not in the grid regime).
  const columns = shellColumns(regime, showLeftPane, rosterWidth, viewportWidth);
  const renderedRosterWidth = clampRosterWidth(rosterWidth, viewportWidth, regime);
  // FR-13: the session every pane-scoped consumer reads. Equals activeSessionId
  // whenever not split, so each of them is behaviour-identical outside split.
  // unbound-panes FR-12: falls back to `lastFocusedSessionId` while a shell
  // pane has focus, so nothing here blanks.
  const paneSessionId = focusedSessionId({
    activeSessionId,
    mainTab,
    extraPanes,
    focusedPaneIndex,
    lastFocusedSessionId,
  });

  // design 7a: the session row describes what you are LOOKING at, so it follows
  // the focused pane rather than the left one.
  const active = sessions.find((session) => session.id === paneSessionId) ?? null;
  const activeAgentId = agentIdFromTab(mainTab);
  // Which of the four dissolved panes is on screen, if any.
  const panelTab = isPanelTab(mainTab);

  useEffect(() => {
    initShellEvents();
    // extensions FR-44: ONE app-wide subscription to francois://extensions/event.
    // App-wide rather than per-section because a log-tail stream outlives its
    // section by the FR-43 grace period.
    initExtensionEvents();
    // notifications FR-5: one app-wide subscription to francois://session/event
    // (idempotent — a second mount effect never double-registers).
    initNotifications();
    // audio-cues FR-5: the audio sink registers as a second consumer of the
    // same shared trigger source (trigger.ts) — no gesture needed to init,
    // only to actually hear the first tone (FR-10).
    initAudioCues();
  }, []);

  // multi-account §6: ONE app-wide registry feed — account_list at boot, then
  // francois://account/event. Everything that shows an account (the ACCOUNT
  // field, the sidebar badge, the app-row chip, the Accounts modal) reads the
  // store this writes, so no surface ever fetches the registry itself.
  useEffect(() => startAccountFeed(setAccounts), [setAccounts]);

  // session-profiles: app-scoped registry (FR-2 — shared across every
  // account), hydrated once at boot. No event channel (spec §5 preamble) — the
  // Profiles modal re-reads after every mutation of its own.
  useEffect(() => {
    void loadProfiles(setProfiles);
  }, [setProfiles]);

  // self-update FR-7: ONE check when the shell mounts, and it is SILENT on
  // failure — a launch-time network blip must not shout. The helper itself is
  // idempotent per app run, so StrictMode's double mount still checks once.
  useEffect(() => {
    void checkUpdateOnLaunch();
  }, []);

  const { home, appVersion } = useAppIdentity(active?.name);

  // extensions FR-4/FR-11: one `extensions_list` per project root. Re-runs when
  // the active session's root changes (FR-12's re-scope) and on a session going
  // away (root null ⇒ nothing NEW is offered; an open tab is untouched).
  const extRoot = detectionRoot(active);
  useEffect(() => {
    void refreshExtensions(extRoot);
  }, [extRoot]);

  const extTabs = visibleExtensions(extensions, extStickyIds);
  // FR-13: the name the `not available in <project>` copy carries — the
  // registered project when the session has one, else the root's basename.
  const activeProjectName = active
    ? ((active.projectId ? (projects.find((p) => p.id === active.projectId)?.name ?? null) : null) ?? basename(active.cwd))
    : null;

  // Keep the native caption bar painted to match --bg-app for the active theme
  // (white in light, dark otherwise). Runs on mount and every toggle; no-op off Windows.
  useEffect(() => {
    void appSetWindowTheme(theme).catch(() => {});
  }, [theme]);

  // remote-control: ONE app-wide subscription, not per-session — a host keeps
  // running for a session the user has navigated away from, and `starting` →
  // `active` (the URL landing) must be recorded whichever session is on screen.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let live = true;
    void onRemoteEvent((e) => {
      if (e.type === 'remote.status') {
        useStore.getState().mergeRemote({ sessionId: e.sessionId, state: e.state });
      }
    }).then((unsub) => {
      if (!live) unsub();
      else unlisten = unsub;
    });
    return () => {
      live = false;
      if (unlisten) unlisten();
    };
  }, []);

  // The session row's DIFF badge — and the palette's view-diff hint, which this
  // hook also feeds, hence the FOCUSED session (FR-7).
  const diffCount = useDiffBadge(paneSessionId);

  // Elapsed clock ticks while the focused session's turn is in flight (FR-6) —
  // isBusyStatus, so it keeps counting while the turn sits on an approval. That
  // wait is part of the turn's wall clock, and freezing it there would read as
  // the turn having finished. Unlike before 7a this runs while split too: the
  // session row is always mounted and always shows the readout.
  useEffect(() => {
    if (!(active && isBusyStatus(active.status))) return;
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active?.id, active?.status]);

  useAppShortcuts({
    newSessionOpen,
    adoptCloudOpen,
    newAgentOpen,
    permissionsOpen,
    projectsOpen,
    accountsOpen,
    renameOpen: renameSessionId !== null,
    updateModalOpen,
    extensionsOpen,
    setNewSessionOpen,
    setNewAgentOpen,
    setFocusedPane,
    setMainTab,
  });

  // overview: widening the board's scope back to "All projects" is a zoom-OUT —
  // there is no longer one project in view, so the main pane goes back to the
  // dashboard instead of whichever session was last selected. Scoping DOWN to a
  // project leaves the tab alone (you may well be mid-conversation), and clicking
  // any session card leaves OVERVIEW again (Sidebar.selectSession). This also
  // covers §7 case 16 — the active project being removed falls back to All.
  useEffect(() => {
    if (activeProjectId === null) {
      // agent-tab FR-14: widening back to All projects closes every agent tab —
      // their agentIds are scoped to whichever session was active, and none of
      // that is still in view once the board zooms out.
      clearAgentTabs();
      // unbound-panes FR-1 (supersedes split-by-4 FR-21, deleted): widening to
      // All projects no longer leaves split — the panes, their focus and their
      // tabs are untouched; only the roster and OVERVIEW re-filter.
      setMainTab('overview'); // wins over clearAgentTabs' own fallback
    }
  }, [activeProjectId, setMainTab, clearAgentTabs]);

  // permission-guardrails: the rules editor needs a session (the local tier is
  // its cwd). If the last session is removed while it is open the modal unmounts
  // without ever calling onClose, so `permissionsOpen` would stay true and keep
  // suppressing the single-letter globals with nothing on screen.
  useEffect(() => {
    if (permissionsOpen && !paneSessionId) setPermissionsOpen(false);
  }, [permissionsOpen, paneSessionId, setPermissionsOpen]);

  const mainFocused = focusedPane === 'main';

  const elapsedMs = active
    ? isBusyStatus(active.status)
      ? clockNow - active.startedAt
      : Math.max(0, active.lastActivityAt - active.startedAt)
    : 0;

  return (
    <div className="app-root">
      {/* design 7a: two tiers of chrome, both full-bleed under the native OS
          caption. The outer row is app-scoped, the inner one session-scoped. */}
      <AppRow appVersion={appVersion} />
      <SessionRow
        active={active}
        mainTab={mainTab}
        setMainTab={setMainTab}
        diffCount={diffCount}
        agentTabs={agentTabs}
        closeAgentTab={closeAgentTab}
        openExtTab={openExtTab}
        elapsedMs={elapsedMs}
        home={home}
      />

      {/* body: roster + one main cell. No right column — 7a folds [3]–[6] into
          the roster's own rows, which is what gives the terminal the width.
          split-by-4 FR-2: split pays ~340px for its second pane by narrowing
          the roster; folded, the roster is still the 46px rail (shellColumns). */}
      <div className="app-grid" style={{ gridTemplateColumns: columns.template }}>
        {/* The folded roster — split-by-4 FR-6's 46px tile rail. Rendered BEFORE
            the column so it takes the first track: a `display:none` element
            generates no grid item. */}
        {columns.leftRail && (
          <SessionRail
            onSelect={(id) => {
              if (focusedPaneIndex > 0) assignToFocusedPane(id);
              else setActiveSessionId(id);
            }}
          />
        )}
        {/* Hidden, never unmounted: the roster owns the session-cache subscriptions. */}
        <div className="app-col-left" style={{ display: showLeftPane ? undefined : 'none' }}>
          <Sidebar home={home} />
        </div>

        {/* resizable-sidebar FR-11: no handle in the grid regime — split-by-4
            already forces the roster to the rail there, and a handle fighting
            that setter would be two owners of the same flag. */}
        {columns.showHandle && (
          <RosterDivider
            regime={regime}
            viewportWidth={viewportWidth}
            renderedWidth={renderedRosterWidth}
            showLeftPane={showLeftPane}
            toggleLeftPane={toggleLeftPane}
            setRosterWidth={setRosterWidth}
            resetRosterWidth={resetRosterWidth}
          />
        )}

        <div className="app-main-cell">
          {/* The four dissolved panes. ALWAYS mounted — their feeds publish the
              counts the roster rows read, and re-subscribing on every tab switch
              would both flicker the counts and double the IPC. */}
          <section
            className="app-main-section app-panel-host"
            style={{ display: panelTab ? undefined : 'none', borderColor: mainFocused ? 'var(--border-focus)' : 'var(--border-2)' }}
            onClick={() => setFocusedPane('main')}
          >
            {PANEL_TABS.map((pane) => {
              const Panel = PANELS[pane];
              return (
                <div key={pane} className="app-panel-slot" style={{ display: mainTab === pane ? undefined : 'none' }}>
                  <Panel key={paneSessionId ?? 'none'} sessionId={paneSessionId} />
                </div>
              );
            })}
          </section>

          <div className="app-main-view" style={{ display: panelTab ? 'none' : undefined }}>
            {/* split-by-4 FR-1/FR-2: one section per pane, in a 1fr row at two
                panes and a 2×2 grid above; otherwise the single pane. Each split
                pane keeps its own header + tab strip — the session row's view
                segment steps aside (SessionRow). Every split regime is
                resizable: the panes share the cell in the ratios their dividers
                were last dragged to (50/50 by default), and each gutter track IS
                a handle — hence gap: 0 on the modifiers. The 2×2 also splits its
                rows, so it carries a second handle. */}
            {split ? (
              <div
                className={regime === 'grid' ? `app-split-grid app-split-grid--${panes}` : 'app-split-grid app-split-grid--2'}
                style={{
                  gridTemplateColumns: `${splitRatio}fr var(--space-12) ${1 - splitRatio}fr`,
                  ...(regime === 'grid'
                    ? { gridTemplateRows: `${splitRowRatio}fr var(--space-12) ${1 - splitRowRatio}fr` }
                    : null),
                }}
              >
                {/* The row handle first, so the column handle — which spans the
                    full height at four panes — wins the cell where the two cross. */}
                {regime === 'grid' && <SplitDivider axis="y" area={dividerGridArea('y', panes)} />}
                {Array.from({ length: panes }, (_, i) => (
                  <Fragment key={i}>
                    {/* Placed explicitly above two panes; at two, DOM order
                        (pane, handle, pane) fills the three tracks by itself. */}
                    {i === 1 && <SplitDivider axis="x" area={dividerGridArea('x', panes)} />}
                    <SplitPane
                      index={i}
                      area={paneGridArea(i, panes)}
                      slot={paneSlotAt({ activeSessionId, mainTab, extraPanes }, i)}
                      focused={focusedPaneIndex === i}
                      dense={regime === 'grid'}
                      home={home}
                      onFocus={() => setFocusedPaneIndex(i)}
                      onTab={(t) => setPaneTab(i, t)}
                      // FR-9: a grid pane shows its transcript, so promoting it
                      // opens on SESSION — its remembered DIFF/SHELL tab was never
                      // on screen there, and inheriting it would read as a tab the
                      // user never picked. Review diff is the deliberate way to
                      // land on DIFF.
                      onPromote={() => unsplit(i, regime === 'grid' ? 'session' : undefined)}
                      onClose={() => closePane(i)}
                      onReviewDiff={() => unsplit(i, 'diff')}
                      // unbound-panes FR-9: the empty pane's "open a shell here"
                      // and the pane header menu's "convert to shell" both turn
                      // THIS pane into a shell pane directly — it is already the
                      // slot the user picked, so there is no "fill the first
                      // empty pane" ambiguity here (that's `openShellPane`'s job
                      // for the palette/roster entry points, which name no pane).
                      onConvertToShell={(projectId) => convertPaneToShell(i, projectId)}
                      onShellSpawned={(shellId) => setPaneShellId(i, shellId)}
                    />
                  </Fragment>
                ))}
              </div>
            ) : (
              <section
                onClick={() => setFocusedPane('main')}
                className="app-main-section"
                style={{ borderColor: mainFocused ? 'var(--border-focus)' : 'var(--border-2)' }}
              >
                <MainPaneBody
                  mainTab={mainTab}
                  activeAgentId={activeAgentId}
                  active={active}
                  home={home}
                  setMainTab={setMainTab}
                  projectName={activeProjectName}
                />
              </section>
            )}
          </div>
        </div>
      </div>

      {/* projects FR-39: this modal is also what a switch into an EMPTY project
          opens, so cancelling it has to undo that switch. Both handlers are
          no-ops for every other way the modal is opened (`n`, the palette, the
          roster button) — nothing is pending then. `onCreated` runs BEFORE the
          modal's own `onClose`, so clearing there is what makes the rollback
          below stand down once a session actually exists. */}
      {newSessionOpen && (
        <NewSessionModal
          onClose={() => {
            setNewSessionOpen(false);
            rollbackProjectSwitch();
          }}
          onCreated={(m) => {
            upsertSession(m);
            // Unconditional, and BEFORE the guard below: standing the rollback
            // down is owed to the session having been created, not to the modal
            // still being open.
            clearProjectSwitchRollback();
            if (!useStore.getState().newSessionOpen) return;
            // split-by-4 FR-19: a new session lands in the FOCUSED pane, like
            // every other "assign a session" path (roster click/⏎, the rail, the
            // palette) — creating one from pane 3 must not silently replace
            // pane 0's session.
            if (focusedPaneIndex > 0) assignToFocusedPane(m.id);
            else setActiveSessionId(m.id);
          }}
        />
      )}

      {/* cloud-sessions FR-14: the adopt modal. Needs NO session — adoption is
          what brings one into the fleet — so it is gated on the flag alone. */}
      {adoptCloudOpen && <AdoptCloudSessionModal onClose={closeAdoptCloud} />}

      {/* session-rename FR-8: the rename modal, keyed to the session so a second
          open always restarts from that session's current name. Rendered here
          because all three entry points (row context menu, the session row's
          breadcrumb, ⌘K) open the same one. */}
      {/* Gated on the id alone, never on the session still existing: a session
          removed while the modal is up must stay renameable-looking until the
          commit answers SESSION_NOT_FOUND (§7), not vanish under the cursor. */}
      {renameSessionId !== null && (
        <RenameSessionModal
          key={renameSessionId}
          sessionId={renameSessionId}
          currentName={sessions.find((s) => s.id === renameSessionId)?.name ?? ''}
          onClose={() => setRenameSessionId(null)}
        />
      )}

      {/* permission-guardrails FR-26: the rules editor. Needs a session (the
          local tier is its cwd), so it closes itself if the session goes away. */}
      {permissionsOpen && paneSessionId && (
        <PermissionsModal sessionId={paneSessionId} onClose={() => setPermissionsOpen(false)} />
      )}

      {/* projects FR-31: the Projects modal. Unlike the permissions editor it
          needs NO session — a project is configured whether or not anything is
          running — so it is gated on `projectsOpen` alone. */}
      {projectsOpen && <ProjectsModal home={home} onClose={() => setProjectsOpen(false)} />}

      {/* multi-account FR-34: the Accounts modal. Like Projects it needs NO
          session — an account is registered whether or not anything is running. */}
      {accountsOpen && <AccountsModal onClose={() => setAccountsOpen(false)} />}

      {/* session-profiles: the Profiles modal, sibling to Projects. Needs NO
          session — a profile is authored whether or not anything is running. */}
      {profilesOpen && <ProfilesModal onClose={() => setProfilesOpen(false)} />}

      {/* extensions FR-56: the Extensions modal, from ⌘K and the app row. Needs
          NO session — every registry entry is listed either way, undetected ones
          included; only `Re-detect` requires a root. */}
      {extensionsOpen && <ExtensionsModal root={extRoot} projectName={activeProjectName} />}

      {/* self-update FR-10: opened by the app row's version chip and by the
          palette's `Check for updates`. Needs no session. */}
      {updateModalOpen && <UpdateModal onClose={() => setUpdateModalOpen(false)} />}

      <PaletteRoot />
    </div>
  );
}
