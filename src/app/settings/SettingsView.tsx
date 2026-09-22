// Settings (redesign "Graphite & Signal", Figma 21–23: 140:7586 / 140:7787 /
// 140:7929 and their light twins). One view below the app bar that replaces
// the roster + workspace while open: a 256px nav on --bg-rail, the page on the
// canvas. It absorbed three modals — Projects (→ General, with the project list
// behind the nav's picker), Accounts (→ Accounts) and pane [4]'s server list
// (→ MCP servers).
//
// Routing: see settings-nav.ts — the old modal flags stay the source of truth.
// Nav items the redesign lists but that still live elsewhere hand off instead
// of duplicating a surface: Skills opens its tab, Profiles / Permissions /
// Extensions / Updates open their modals over this view.
//
// Esc closes, unless something on top claimed it first (a page's own cancel,
// a modal, the palette) — see `onKey`.

import { useEffect, useMemo, useRef, useState } from 'react';
import AccountsPage from '../../features/accounts/AccountsPage';
import { accountSessionCounts } from '../../features/accounts/accounts';
import { providerGroups, splitRail } from '../../features/accounts/providers';
import McpServersPage from '../../features/mcp/McpServersPage';
import { mcpReferenceSessionId } from '../../features/mcp/mcp-settings';
import { useMcpServers } from '../../features/mcp/useMcpServers';
import { isPaletteOpen } from '../../features/palette/palette';
import ProjectSettingsPage from '../../features/projects/ProjectSettingsPage';
import SettingsProjectPicker from '../../features/projects/SettingsProjectPicker';
import { useProjectSettings } from '../../features/projects/useProjectSettings';
import { useStore } from '../../lib/store';
import { SettingsNavGroup, SettingsNavItem } from '../../ui/Settings';
import { flagsForPage, resolveSettingsPage, type SettingsFlags, type SettingsPage } from './settings-nav';
import './settings-view.css';

export interface SettingsViewProps {
  home: string;
  /** The focused pane's session — the MCP page prefers it when it is in the picked project. */
  paneSessionId: string | null;
}

export default function SettingsView({ home, paneSessionId }: SettingsViewProps) {
  const projectsOpen = useStore((s) => s.projectsOpen);
  const accountsOpen = useStore((s) => s.accountsOpen);
  const flags: SettingsFlags = { projectsOpen, accountsOpen };
  const [page, setPage] = useState<SettingsPage | null>(() => resolveSettingsPage({ projectsOpen: false, accountsOpen: false }, flags, null));
  const prevFlags = useRef<SettingsFlags>(flags);

  // A flag raised elsewhere while open (⌘K → Accounts, the avatar) is a new request.
  useEffect(() => {
    const next = resolveSettingsPage(prevFlags.current, { projectsOpen, accountsOpen }, page);
    prevFlags.current = { projectsOpen, accountsOpen };
    if (next === null) return;
    // Also normalises the flags to exactly the one this page owns.
    const want = flagsForPage(next);
    if (next !== page || want.projectsOpen !== projectsOpen || want.accountsOpen !== accountsOpen) go(next);
    // `page` is read, not tracked: navigating is not a flag change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsOpen, accountsOpen]);

  const go = (next: SettingsPage) => {
    const st = useStore.getState();
    const want = flagsForPage(next);
    prevFlags.current = want;
    if (st.projectsOpen !== want.projectsOpen) st.setProjectsOpen(want.projectsOpen);
    if (st.accountsOpen !== want.accountsOpen) st.setAccountsOpen(want.accountsOpen);
    setPage(next);
  };

  const close = () => {
    const st = useStore.getState();
    st.setProjectsOpen(false);
    st.setAccountsOpen(false);
  };

  // Esc closes — bubble phase, after anything layered on top has had its turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const st = useStore.getState();
      if (
        isPaletteOpen() ||
        st.profilesOpen ||
        st.permissionsOpen ||
        st.extensionsOpen ||
        st.updateModalOpen ||
        st.newSessionOpen ||
        st.sessionSettingsId !== null
      )
        return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── the data the nav's counts and the project pages share ──
  const projectSettings = useProjectSettings();
  const selectedProject = projectSettings.registry.selected;
  const sessions = useStore((s) => s.sessions);
  const refSessionId = mcpReferenceSessionId(sessions, selectedProject?.id ?? null, paneSessionId);
  const refSession = sessions.find((s) => s.id === refSessionId) ?? null;
  const mcpFeed = useMcpServers(refSessionId);
  const skillsCount = useStore((s) => (refSessionId ? (s.panelCounts.get(refSessionId)?.skills ?? 0) : 0));
  const profilesCount = useStore((s) => s.profiles.length);
  const extensionsCount = useStore((s) => s.extensions.filter((x) => x.enabled).length);
  const accounts = useStore((s) => s.accounts);
  const connectedProviders = useMemo(
    () => splitRail(providerGroups(accounts, accountSessionCounts(accounts, sessions))).connected.length,
    [accounts, sessions],
  );

  const openSkills = () => {
    const st = useStore.getState();
    close();
    if (refSessionId && refSessionId !== paneSessionId) st.setActiveSessionId(refSessionId);
    st.setFocusedPane('main');
    st.setMainTab('skills');
  };

  // "Add server": the attach flow lives in the MCP tab (⌘K → Attach MCP server's path).
  const addServer = () => {
    if (!refSessionId) return;
    const st = useStore.getState();
    close();
    if (refSessionId !== paneSessionId) st.setActiveSessionId(refSessionId);
    st.setFocusedPane('main');
    st.setMainTab('mcp');
    st.setMcpAttachOpen(true);
  };

  if (page === null) return null;

  return (
    <div className="settings-view">
      <nav className="settings-view__nav" aria-label="Settings">
        <SettingsNavGroup label="Project" action={<SettingsProjectPicker settings={projectSettings} home={home} />}>
          <SettingsNavItem label="General" selected={page === 'general'} onSelect={() => go('general')} />
          <SettingsNavItem label="MCP servers" count={mcpFeed.servers.length} selected={page === 'mcp'} onSelect={() => go('mcp')} />
          <SettingsNavItem label="Skills" count={skillsCount} title="Opens the Skills tab" onSelect={openSkills} />
          <SettingsNavItem
            label="Profiles"
            count={profilesCount}
            title="Opens the Profiles editor"
            onSelect={() => useStore.getState().setProfilesOpen(true)}
          />
          <SettingsNavItem
            label="Permissions"
            disabled={!paneSessionId}
            title={paneSessionId ? 'Opens the permission rules editor' : 'Open a session first — rules are read against its folder'}
            onSelect={() => useStore.getState().setPermissionsOpen(true)}
          />
        </SettingsNavGroup>
        <SettingsNavGroup label="App">
          <SettingsNavItem label="Accounts" count={connectedProviders} selected={page === 'accounts'} onSelect={() => go('accounts')} />
          <SettingsNavItem
            label="Extensions"
            count={extensionsCount}
            title="Opens the Extensions list"
            onSelect={() => useStore.getState().setExtensionsOpen(true)}
          />
          <SettingsNavItem label="Updates" title="Check for updates" onSelect={() => useStore.getState().setUpdateModalOpen(true)} />
        </SettingsNavGroup>
      </nav>

      <main className="settings-view__content">
        <div className="settings-view__page">
          {page === 'general' && <ProjectSettingsPage settings={projectSettings} home={home} />}
          {page === 'mcp' && (
            <McpServersPage
              projectName={selectedProject?.name ?? null}
              sessionId={refSessionId}
              sessionName={refSession?.name ?? null}
              feed={mcpFeed}
              onAddServer={addServer}
            />
          )}
          {page === 'accounts' && <AccountsPage />}
        </div>
      </main>
    </div>
  );
}
