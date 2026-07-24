// Registration of the seven built-in palette commands (FR-6) plus agents-panel's
// eighth "New agent" (FR-7). In this single-App architecture the per-feature
// bootstraps are centralized here and called once at app mount; each command still
// delegates to its owning feature's own action/channel exactly as the spec pins.

import type { Result } from '../contract/common';
import { registerPaletteCommand, requestBodyFocusOnClose, showToast } from './palette';
import { getPaletteDiffCount, getPaletteModels, getPaletteRunningAgents, getPaletteSkills, setPaletteModels } from './paletteData';
import { agentsKill, sessionCompact, sessionModels, sessionSwitchModel, skillsRun } from './api';
import { useStore } from './store';
import { requestUsageRefresh } from './usage';

const formatTokens = (t: number): string => (t >= 1000 ? (t / 1000).toFixed(1) + 'K' : String(t));

/** Fire-and-forget a delegated IPC call, toasting on ok:false or rejection (FR-18). */
function delegate(p: Promise<Result<unknown>>): void {
  p.then((res) => {
    if (!res.ok) showToast(res.error.message, 'error');
  }).catch(() => showToast('Command failed unexpectedly', 'error'));
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

  // 13 — Toggle theme (app-shell): flip light/dark, same action as the status-bar glyph.
  registerPaletteCommand({
    id: 'toggle-theme',
    glyph: '☾',
    name: 'Toggle theme',
    hint: () => (useStore.getState().theme === 'dark' ? 'switch to light' : 'switch to dark'),
    run: () => {
      useStore.getState().toggleTheme();
    },
  });
}
