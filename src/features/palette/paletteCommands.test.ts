// collapse-right-column FR-11: the three per-card palette toggles
// (toggle-agents-panel/mcp/skills) and their shared toggleRightPanelCommand
// helper — hint reflects collapsedPanes, and expanding a collapsed card also
// reveals the right column when it was hidden (running the toggle should
// never leave the user staring at "nothing happened").

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteContext } from '../../../contract/command-palette';

vi.mock('../../lib/api', () => ({
  agentsKill: vi.fn(),
  sessionCompact: vi.fn(),
  sessionModels: vi.fn(() => Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'n/a' } })),
  sessionSwitchModel: vi.fn(),
  skillsRun: vi.fn(),
}));

function mockStorage(seed: Record<string, string> = {}): { store: Record<string, string> } {
  const state = { store: { ...seed } };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in state.store ? state.store[k] : null),
    setItem: (k: string, v: string) => {
      state.store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete state.store[k];
    },
    clear: () => {
      state.store = {};
    },
  });
  return state;
}

const ctx: PaletteContext = { activeSessionId: null, runningAgentCount: 0 };

/** Fresh module graph per test: paletteCommands' `registered` guard and palette.ts's
 * module-level registry are both idempotent-once, so a stale import would leak
 * registrations (and stale store state) across tests. */
async function freshModules() {
  vi.resetModules();
  const storeMod = await import('../../lib/store');
  const notifStoreMod = await import('../../lib/notificationsStore');
  const paletteMod = await import('./palette');
  const commandsMod = await import('./paletteCommands');
  commandsMod.registerBuiltinCommands();
  const byId = (id: string) => {
    const cmd = paletteMod.paletteCommands().find((c) => c.id === id);
    if (!cmd) throw new Error(`command '${id}' not registered`);
    return cmd;
  };
  return { useStore: storeMod.useStore, useNotificationsStore: notifStoreMod.useNotificationsStore, paletteCommands: paletteMod.paletteCommands, byId };
}

describe('collapse-right-column palette toggles (FR-11)', () => {
  beforeEach(() => {
    mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers one toggle command per right pane, keyed to its pane hotkey', async () => {
    const { byId } = await freshModules();
    expect(byId('toggle-agents-panel').name).toBe('Toggle agents panel');
    expect(byId('toggle-mcp-panel').name).toBe('Toggle MCP panel');
    expect(byId('toggle-skills-panel').name).toBe('Toggle skills panel');
  });

  it('hint reads "collapse · [n]" while expanded and "expand · [n]" once collapsed', async () => {
    const { useStore, byId } = await freshModules();
    const agents = byId('toggle-agents-panel');
    const mcp = byId('toggle-mcp-panel');
    const skills = byId('toggle-skills-panel');

    expect(agents.hint?.()).toBe('collapse · [3]');
    expect(mcp.hint?.()).toBe('collapse · [4]');
    expect(skills.hint?.()).toBe('collapse · [5]');

    useStore.getState().setCollapsedPane('agents', true);
    useStore.getState().setCollapsedPane('mcp', true);
    useStore.getState().setCollapsedPane('skills', true);

    expect(agents.hint?.()).toBe('expand · [3]');
    expect(mcp.hint?.()).toBe('expand · [4]');
    expect(skills.hint?.()).toBe('expand · [5]');
  });

  it('running the command flips collapsedPanes for that pane only', async () => {
    const { useStore, byId } = await freshModules();
    byId('toggle-mcp-panel').run(ctx);
    expect(useStore.getState().collapsedPanes).toEqual({ agents: false, mcp: true, skills: false });
    byId('toggle-mcp-panel').run(ctx);
    expect(useStore.getState().collapsedPanes.mcp).toBe(false);
  });

  it('expanding a collapsed card also reveals the right column when it was hidden', async () => {
    const { useStore, byId } = await freshModules();
    useStore.getState().setCollapsedPane('agents', true);
    useStore.getState().toggleRightPane(); // hide the whole column
    expect(useStore.getState().showRightPane).toBe(false);

    byId('toggle-agents-panel').run(ctx); // expand: was collapsed, column hidden → reveal too
    expect(useStore.getState().collapsedPanes.agents).toBe(false);
    expect(useStore.getState().showRightPane).toBe(true);
  });

  it('collapsing a card never reveals a hidden column (independent toggles, FR-7)', async () => {
    const { useStore, byId } = await freshModules();
    useStore.getState().toggleRightPane(); // hide the column while every card is expanded
    expect(useStore.getState().showRightPane).toBe(false);

    byId('toggle-skills-panel').run(ctx); // collapse: wasCollapsed=false → no reveal
    expect(useStore.getState().collapsedPanes.skills).toBe(true);
    expect(useStore.getState().showRightPane).toBe(false);
  });

  it('expanding a collapsed card leaves an already-visible column untouched', async () => {
    const { useStore, byId } = await freshModules();
    useStore.getState().setCollapsedPane('skills', true);
    expect(useStore.getState().showRightPane).toBe(true);

    byId('toggle-skills-panel').run(ctx);
    expect(useStore.getState().collapsedPanes.skills).toBe(false);
    expect(useStore.getState().showRightPane).toBe(true);
  });
});

describe('adopt cloud session (cloud-sessions FR-14)', () => {
  beforeEach(() => {
    mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers the command next to New session, and never says "Remote Control"', async () => {
    const { byId, paletteCommands } = await freshModules();
    const cmd = byId('adopt-cloud-session');
    expect(cmd.name).toBe('Adopt cloud session');
    // §7 #4: the CLI's auth errors say "Remote Control"; this feature's UI never does.
    expect(`${cmd.name} ${cmd.hint?.() ?? ''}`).not.toMatch(/remote control/i);
    const ids = paletteCommands().map((c) => c.id);
    expect(ids.indexOf('adopt-cloud-session')).toBe(ids.indexOf('new-session') + 1);
  });

  it('needs no session — a cloud session is adopted INTO the fleet, from empty', async () => {
    const { byId } = await freshModules();
    expect(byId('adopt-cloud-session').enabled?.(ctx) ?? true).toBe(true);
  });

  it('running it opens the modal the pane [1] action opens', async () => {
    const { useStore, byId } = await freshModules();
    byId('adopt-cloud-session').run(ctx);
    expect(useStore.getState().adoptCloudOpen).toBe(true);
  });
});

describe('notifications palette toggles (FR-18)', () => {
  beforeEach(() => {
    mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers the two commands with the design brief names, blocking class first', async () => {
    const { byId, paletteCommands } = await freshModules();
    const attention = byId('toggle-notify-attention');
    const turnDone = byId('toggle-notify-turn-done');
    expect(attention.name).toBe('Notifications: approvals & questions');
    expect(turnDone.name).toBe('Notifications: turn finished');

    const ids = paletteCommands().map((c) => c.id);
    expect(ids.indexOf('toggle-notify-attention')).toBeLessThan(ids.indexOf('toggle-notify-turn-done'));
  });

  it('hint reads "on"/"off" from the live toggle, defaulting to on', async () => {
    const { byId } = await freshModules();
    expect(byId('toggle-notify-attention').hint?.()).toBe('on');
    expect(byId('toggle-notify-turn-done').hint?.()).toBe('on');
  });

  it('running a row flips only that class', async () => {
    const { byId, useNotificationsStore } = await freshModules();

    byId('toggle-notify-turn-done').run(ctx);
    expect(useNotificationsStore.getState().enabled).toEqual({ attention: true, turnDone: false });
    expect(byId('toggle-notify-turn-done').hint?.()).toBe('off');
    expect(byId('toggle-notify-attention').hint?.()).toBe('on');

    byId('toggle-notify-turn-done').run(ctx);
    expect(useNotificationsStore.getState().enabled.turnDone).toBe(true);
  });
});
