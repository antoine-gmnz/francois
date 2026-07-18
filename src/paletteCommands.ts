// Registration of the seven built-in palette commands (FR-6) plus agents-panel's
// eighth "New agent" (FR-7). In this single-App architecture the per-feature
// bootstraps are centralized here and called once at app mount; each command still
// delegates to its owning feature's own action/channel exactly as the spec pins.

import type { Result } from '../contract/common';
import { registerPaletteCommand, requestBodyFocusOnClose, showToast } from './palette';
import { getPaletteDiffCount, getPaletteModels, getPaletteRunningAgents, getPaletteSkills, setPaletteModels } from './paletteData';
import { agentsKill, sessionCompact, sessionModels, sessionSwitchModel, skillsRun } from './api';
import { useStore } from './store';

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
      useStore.getState().setMcpAttachOpen(true);
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
}
