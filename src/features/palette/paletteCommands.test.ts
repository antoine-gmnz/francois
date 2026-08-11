// design 7a: the four palette commands that open the dissolved right-column
// panes (open-agents/mcp/skills/workflows-panel) and their shared
// openPanelTabCommand helper — each opens that pane as a MAIN TAB, with the same
// toggle grammar every other view command here uses, so a second run returns to
// SESSION rather than leaving the row as a one-way door.

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

describe('panel-tab palette commands (design 7a)', () => {
  beforeEach(() => {
    mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers one command per dissolved pane, named after the pane itself', async () => {
    const { byId } = await freshModules();
    expect(byId('open-agents-panel').name).toBe('Agents');
    expect(byId('open-mcp-panel').name).toBe('MCP servers');
    expect(byId('open-skills-panel').name).toBe('Skills');
    expect(byId('open-workflows-panel').name).toBe('Workflows');
  });

  it('no longer registers the right-column toggles it replaced', async () => {
    const { paletteCommands } = await freshModules();
    const ids = paletteCommands().map((c) => c.id);
    expect(ids).not.toContain('toggle-side-panels');
    expect(ids).not.toContain('toggle-agents-panel');
    expect(ids).not.toContain('toggle-mcp-panel');
    expect(ids).not.toContain('toggle-skills-panel');
  });

  it('hint names the pane hotkey, and flips once that tab is the one on screen', async () => {
    const { useStore, byId } = await freshModules();
    expect(byId('open-agents-panel').hint?.()).toBe('open panel · 3');
    expect(byId('open-mcp-panel').hint?.()).toBe('open panel · 4');
    expect(byId('open-skills-panel').hint?.()).toBe('open panel · 5');
    expect(byId('open-workflows-panel').hint?.()).toBe('open panel · 6');

    useStore.getState().setMainTab('skills');
    expect(byId('open-skills-panel').hint?.()).toBe('back to session · 5');
    expect(byId('open-agents-panel').hint?.()).toBe('open panel · 3');
  });

  it('running the command opens that pane as the main tab and focuses the pane', async () => {
    const { useStore, byId } = await freshModules();
    byId('open-mcp-panel').run(ctx);
    expect(useStore.getState().mainTab).toBe('mcp');
    expect(useStore.getState().focusedPane).toBe('main');
  });

  it('running it again returns to SESSION rather than re-opening the same tab', async () => {
    const { useStore, byId } = await freshModules();
    byId('open-workflows-panel').run(ctx);
    expect(useStore.getState().mainTab).toBe('workflows');
    byId('open-workflows-panel').run(ctx);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('switching between two panel commands never lands on SESSION', async () => {
    const { useStore, byId } = await freshModules();
    byId('open-agents-panel').run(ctx);
    byId('open-skills-panel').run(ctx);
    expect(useStore.getState().mainTab).toBe('skills');
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
