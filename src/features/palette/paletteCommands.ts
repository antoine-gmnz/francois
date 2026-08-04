// Registration of the seven built-in palette commands (FR-6) plus agents-panel's
// eighth "New agent" (FR-7). In this single-App architecture the per-feature
// bootstraps are centralized here and called once at app mount; each command still
// delegates to its owning feature's own action/channel exactly as the spec pins.

import type { Result } from '../../../contract/common';
import { registerPaletteCommand, requestBodyFocusOnClose, showToast } from './palette';
import { getPaletteDiffCount, getPaletteModels, getPaletteRunningAgents, getPaletteSkills, setPaletteModels } from './paletteData';
import { agentsKill, sessionClearAttachments, sessionCompact, sessionModels, sessionSwitchModel, skillsRun } from '../../lib/api';
import { useNotificationsStore } from '../../lib/notificationsStore';
import { useStore, type RightPane } from '../../lib/store';
import { requestUsageRefresh } from '../usage/usage';
import { checkUpdateManually } from '../update/update';
import { requestWorktreePreset } from '../sessions/worktree';
import { clearReport, resolveClearProjectId } from '../conversation/attachments';
import { closeDisplayedShell, cycleShell, newShell, requestActiveShellRename } from '../shell/shellActions';

const formatTokens = (t: number): string => (t >= 1000 ? (t / 1000).toFixed(1) + 'K' : String(t));

// collapse-right-column FR-11: toggling a collapsed card to expanded also
// reveals the right column if it was hidden — the palette command list
// otherwise offers no way to notice the toggle "did nothing".
function toggleRightPanelCommand(pane: RightPane): () => void {
  return () => {
    const st = useStore.getState();
    const wasCollapsed = st.collapsedPanes[pane];
    st.toggleCollapsedPane(pane);
    if (wasCollapsed && !st.showRightPane) st.toggleRightPane();
  };
}

/** Fire-and-forget a delegated IPC call, toasting on ok:false or rejection (FR-18). */
function delegate(p: Promise<Result<unknown>>): void {
  p.then((res) => {
    if (!res.ok) showToast(res.error.message, 'error');
  }).catch(() => showToast('Command failed unexpectedly', 'error'));
}

/**
 * session-attachments FR-18: which project "Clear project attachments" sweeps —
 * the selected one, else the active session's. ClearScope has no "everything"
 * member, so a null disables the command.
 */
function clearAttachmentsProjectId(activeSessionId: string | null): string | null {
  const st = useStore.getState();
  return resolveClearProjectId(st.activeProjectId, activeSessionId, st.sessions);
}

let registered = false;

/** Idempotent — call once at app bootstrap. */
export function registerBuiltinCommands(): void {
  if (registered) return;
  registered = true;

  // Prefetch the static model catalog for switch-model's synchronous SecondaryStep (FR-19).
  void sessionModels().then((res) => {
    if (res.ok) setPaletteModels(res.data);
  });

  // 1 — New session (sessions-sidebar)
  registerPaletteCommand({
    id: 'new-session',
    glyph: '＋',
    name: 'New session',
    hint: () => 'spin up in cwd',
    run: () => {
      useStore.getState().setNewSessionOpen(true);
    },
  });

  // 1b — Rename session (session-rename FR-14): opens the same modal the sidebar
  // row's context menu opens, for the ACTIVE session. Not a SecondaryStep — it
  // acts on one session, so it just opens the modal and closes the palette.
  registerPaletteCommand({
    id: 'rename-session',
    glyph: '✎',
    name: 'Rename session',
    // design brief §3: this row carries no right-aligned hint.
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: (ctx) => {
      if (ctx.activeSessionId) useStore.getState().setRenameSessionId(ctx.activeSessionId);
    },
  });

  // 2 — Switch model (session-engine)
  registerPaletteCommand({
    id: 'switch-model',
    glyph: '⇄',
    name: 'Switch model',
    hint: () => 'sonnet · opus · haiku',
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: (ctx) => {
      const sid = ctx.activeSessionId;
      return {
        placeholder: 'switch model',
        items: getPaletteModels().map((m) => ({ id: m.id, label: m.label })),
        onPick: (modelId) => {
          if (sid) delegate(sessionSwitchModel(sid, modelId));
        },
      };
    },
  });

  // 3 — Attach MCP server (mcp-panel)
  registerPaletteCommand({
    id: 'attach-mcp-server',
    glyph: '⊞',
    name: 'Attach MCP server',
    hint: () => 'from registry',
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: () => {
      const st = useStore.getState();
      st.setFocusedPane('mcp'); // reveals the right column if hidden (the overlay lives in McpPanel)
      st.setMcpAttachOpen(true);
    },
  });

  // 4 — Run skill (skills-panel)
  registerPaletteCommand({
    id: 'run-skill',
    glyph: '✦',
    name: 'Run skill',
    hint: () => 'browse installed',
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: (ctx) => {
      const sid = ctx.activeSessionId;
      return {
        placeholder: 'browse installed skills',
        items: getPaletteSkills(sid).map((s) => ({ id: s.name, label: s.name, hint: s.description })),
        onPick: (name) => {
          if (sid) delegate(skillsRun(sid, name) as Promise<Result<unknown>>);
        },
      };
    },
  });

  // 5 — View diff (app-shell) — reuses app-shell's own d/toggleDiff transition (FR-23)
  registerPaletteCommand({
    id: 'view-diff',
    glyph: '≡',
    name: 'View diff',
    hint: () => {
      const n = getPaletteDiffCount();
      return `${n} file${n === 1 ? '' : 's'} changed`;
    },
    run: () => {
      const st = useStore.getState();
      st.setFocusedPane('main');
      st.setMainTab(st.mainTab === 'diff' ? 'session' : 'diff');
      requestBodyFocusOnClose(); // FR-16 exception: don't restore into a now-hidden pane
    },
  });

  // 5b — Overview (overview) — same toggle grammar as View diff, and the same
  // transition app-shell's own `o` key performs.
  registerPaletteCommand({
    id: 'view-overview',
    glyph: '▦',
    name: 'Overview',
    hint: () => {
      const st = useStore.getState();
      const n = st.activeProjectId === null ? st.sessions.length : st.sessions.filter((s) => s.projectId === st.activeProjectId).length;
      return `${n} session${n === 1 ? '' : 's'} across projects`;
    },
    run: () => {
      const st = useStore.getState();
      st.setFocusedPane('main');
      st.setMainTab(st.mainTab === 'overview' ? 'session' : 'overview');
      requestBodyFocusOnClose(); // FR-16 exception: don't restore into a now-hidden pane
    },
  });

  // 6 — Compact context (session-engine)
  registerPaletteCommand({
    id: 'compact-context',
    glyph: '⊙',
    name: 'Compact context',
    hint: () => {
      const st = useStore.getState();
      const s = st.sessions.find((x) => x.id === st.activeSessionId);
      return s ? `${formatTokens(s.contextUsedTokens)} → summary` : '→ summary';
    },
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: (ctx) => {
      const sid = ctx.activeSessionId;
      if (sid) delegate(sessionCompact(sid) as Promise<Result<unknown>>);
    },
  });

  // 7 — Kill agent (agents-panel)
  registerPaletteCommand({
    id: 'kill-agent',
    glyph: '⊗',
    name: 'Kill agent',
    hint: () => 'select running',
    enabled: (ctx) => ctx.runningAgentCount > 0,
    run: (ctx) => ({
      placeholder: 'select running agent',
      items: getPaletteRunningAgents(ctx.activeSessionId).map((a) => ({ id: a.id, label: a.name, hint: a.task })),
      onPick: (agentId) => delegate(agentsKill(agentId) as Promise<Result<unknown>>),
    }),
  });

  // 8 — New agent (agents-panel, FR-7) — opens agents-panel's new-agent modal
  registerPaletteCommand({
    id: 'new-agent',
    glyph: '⇉',
    name: 'New agent',
    hint: () => 'describe a task',
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: () => {
      const st = useStore.getState();
      st.setFocusedPane('agents');
      st.setNewAgentOpen(true);
    },
  });

  // 9/10 — layout toggles (app-shell): hide/show the sessions + side-panel columns
  registerPaletteCommand({
    id: 'toggle-sessions-column',
    glyph: '◧',
    name: 'Toggle sessions column',
    hint: () => (useStore.getState().showLeftPane ? 'hide left · [' : 'show left · ['),
    run: () => {
      useStore.getState().toggleLeftPane();
    },
  });
  registerPaletteCommand({
    id: 'toggle-side-panels',
    glyph: '◨',
    name: 'Toggle side panels',
    hint: () => (useStore.getState().showRightPane ? 'hide right · ]' : 'show right · ]'),
    run: () => {
      useStore.getState().toggleRightPane();
    },
  });

  // 10b/c/d — collapse-right-column FR-11: per-card collapse, one command
  // each. Expanding from the palette also reveals the column if hidden.
  registerPaletteCommand({
    id: 'toggle-agents-panel',
    glyph: '▾',
    name: 'Toggle agents panel',
    hint: () => (useStore.getState().collapsedPanes.agents ? 'expand · [3]' : 'collapse · [3]'),
    run: toggleRightPanelCommand('agents'),
  });
  registerPaletteCommand({
    id: 'toggle-mcp-panel',
    glyph: '▾',
    name: 'Toggle MCP panel',
    hint: () => (useStore.getState().collapsedPanes.mcp ? 'expand · [4]' : 'collapse · [4]'),
    run: toggleRightPanelCommand('mcp'),
  });
  registerPaletteCommand({
    id: 'toggle-skills-panel',
    glyph: '▾',
    name: 'Toggle skills panel',
    hint: () => (useStore.getState().collapsedPanes.skills ? 'expand · [5]' : 'collapse · [5]'),
    run: toggleRightPanelCommand('skills'),
  });

  // 11 — Refresh usage limits (usage-bar FR-28): the mouse-free route to the same
  // channel the bar's click uses. Fire-and-forget — the result arrives as an event.
  registerPaletteCommand({
    id: 'refresh-usage',
    glyph: '↻',
    name: 'Refresh usage limits',
    hint: () => 'plan meters',
    run: () => {
      requestUsageRefresh();
    },
  });

  // 12 — Manage permissions (permission-guardrails FR-26): the only place the
  // rules written by "always allow/deny" are visible, since Claude enforces them
  // upstream and those calls never reach a card again.
  registerPaletteCommand({
    id: 'manage-permissions',
    glyph: '⚿',
    name: 'Manage permissions',
    hint: () => 'view & edit rules',
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: () => {
      useStore.getState().setPermissionsOpen(true);
    },
  });

  // 13 — Manage projects (projects FR-31): the other entry point to the modal,
  // alongside the pane [1] switcher's own "Manage projects…" row. Needs NO
  // session — a project is configured whether or not anything is running.
  registerPaletteCommand({
    id: 'manage-projects',
    glyph: '⊟',
    name: 'Manage projects',
    hint: () => 'defaults & standards',
    run: () => {
      useStore.getState().setProjectsOpen(true);
    },
  });

  // 13c/13d — Accounts (multi-account FR-33): the mouse-free route to the same
  // modal the status-bar chip opens, plus a direct "Add account" that lands
  // straight in the login view via the one-shot accountsAutoAdd flag. Neither
  // needs a session — an account is registered whether or not anything runs.
  registerPaletteCommand({
    id: 'manage-accounts',
    glyph: '◈',
    name: 'Accounts',
    hint: () => {
      const n = useStore.getState().accounts.length;
      return `${n} account${n === 1 ? '' : 's'}`;
    },
    run: () => {
      useStore.getState().setAccountsOpen(true);
    },
  });
  registerPaletteCommand({
    id: 'add-account',
    glyph: '＋',
    name: 'Add account',
    hint: () => 'sign in to Claude Code',
    run: () => {
      const st = useStore.getState();
      st.setAccountsAutoAdd(true);
      st.setAccountsOpen(true);
    },
  });

  // 13b — New session in worktree (session-worktree FR-16): opens the same modal
  // pre-checked. Listed unconditionally — a non-repo cwd simply hides the
  // checkbox once picked (FR-1).
  registerPaletteCommand({
    id: 'new-session-worktree',
    glyph: '⎇',
    name: 'New session in worktree…',
    hint: () => 'isolated git worktree',
    run: () => {
      requestWorktreePreset();
      useStore.getState().setNewSessionOpen(true);
    },
  });

  // 13c — Clear project attachments (session-attachments FR-18): sweeps the
  // attachments dir of every session registered under the project — driven by the
  // session registry, so worktree sessions are included. Destructive, so it goes
  // through a confirmation step before anything is deleted.
  registerPaletteCommand({
    id: 'clear-project-attachments',
    glyph: '⌫',
    name: 'Clear project attachments',
    hint: () => 'delete attached files',
    enabled: (ctx) => clearAttachmentsProjectId(ctx.activeSessionId) !== null,
    run: (ctx) => {
      const projectId = clearAttachmentsProjectId(ctx.activeSessionId);
      return {
        placeholder: 'delete every attached file in this project?',
        items: [
          { id: 'confirm', label: 'Clear attachments', hint: 'deletes the files on disk' },
          { id: 'cancel', label: 'Cancel', hint: 'keep them' },
        ],
        onPick: (id) => {
          if (id !== 'confirm' || !projectId) return;
          sessionClearAttachments({ kind: 'project', projectId })
            .then((res) => {
              if (!res.ok) showToast(res.error.message, 'error');
              else showToast(clearReport(res.data), res.data.failed > 0 ? 'error' : 'info');
            })
            .catch(() => showToast('Command failed unexpectedly', 'error'));
        },
      };
    },
  });

  // 13e — Check for updates (self-update FR-9): always available, and the ONLY
  // path that reports back a failed or up-to-date check — the launch check is
  // silent (FR-7). Runs a fresh check, then opens the modal on the outcome.
  registerPaletteCommand({
    id: 'check-for-updates',
    glyph: '↑',
    name: 'Check for updates',
    hint: () => {
      const check = useStore.getState().update;
      return check?.updateAvailable ? `${check.latest} available` : 'npm registry';
    },
    run: () => {
      void checkUpdateManually();
    },
  });

  // 13f/13g — Notifications (notifications FR-18): the blocking class first,
  // the noisy class second — the design brief's "non-destructive reads first"
  // ordering. Each hint reads the live toggle; running a row flips it and the
  // muted chip appears/disappears in the same frame.
  registerPaletteCommand({
    id: 'toggle-notify-attention',
    glyph: '◈',
    name: 'Notifications: approvals & questions',
    hint: () => (useNotificationsStore.getState().enabled.attention ? 'on' : 'off'),
    run: () => {
      const st = useNotificationsStore.getState();
      st.setNotifyEnabled('attention', !st.enabled.attention);
    },
  });
  registerPaletteCommand({
    id: 'toggle-notify-turn-done',
    glyph: '◈',
    name: 'Notifications: turn finished',
    hint: () => (useNotificationsStore.getState().enabled.turnDone ? 'on' : 'off'),
    run: () => {
      const st = useNotificationsStore.getState();
      st.setNotifyEnabled('turnDone', !st.enabled.turnDone);
    },
  });

  // 14 — Toggle theme (app-shell): flip light/dark, same action as the status-bar glyph.
  registerPaletteCommand({
    id: 'toggle-theme',
    glyph: '☾',
    name: 'Toggle theme',
    hint: () => (useStore.getState().theme === 'dark' ? 'switch to light' : 'switch to dark'),
    run: () => {
      useStore.getState().toggleTheme();
    },
  });

  // 15/15b/15c/15d — Shell tab (multiple-shells FR-22): new/close/next act on
  // the active session's SHELL state directly, independent of which main tab
  // is showing — only "new" also switches to SHELL, mirroring flow 2's own
  // "the new chip becomes active" behavior.
  registerPaletteCommand({
    id: 'shell-new',
    glyph: '❯',
    name: 'Shell: new',
    hint: () => '⌘T',
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: (ctx) => {
      if (!ctx.activeSessionId) return;
      const st = useStore.getState();
      st.setFocusedPane('main');
      st.setMainTab('shell');
      void newShell(ctx.activeSessionId);
    },
  });
  registerPaletteCommand({
    id: 'shell-close',
    glyph: '✕',
    name: 'Shell: close',
    hint: () => '⌘W',
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: (ctx) => {
      if (ctx.activeSessionId) closeDisplayedShell(ctx.activeSessionId);
    },
  });
  registerPaletteCommand({
    id: 'shell-next',
    glyph: '⇥',
    name: 'Shell: next',
    hint: () => '⌃⇥',
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: (ctx) => {
      if (ctx.activeSessionId) cycleShell(ctx.activeSessionId, 1);
    },
  });
  // No free-text SecondaryStep exists (contract/command-palette.ts), so this
  // flags the session's displayed chip for inline rename instead — see
  // shellActions.ts's requestActiveShellRename for the assumption this rests on.
  registerPaletteCommand({
    id: 'shell-rename',
    glyph: '✎',
    name: 'Shell: rename',
    hint: () => 'double-click a chip',
    enabled: (ctx) => ctx.activeSessionId !== null,
    run: (ctx) => {
      if (ctx.activeSessionId) requestActiveShellRename(ctx.activeSessionId);
    },
  });
}
