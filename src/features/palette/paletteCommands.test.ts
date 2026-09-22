// design 7a: the four palette commands that open the dissolved right-column
// panes (open-agents/mcp/skills/workflows-panel) and their shared
// openPanelTabCommand helper — each opens that pane as a MAIN TAB, with the same
// toggle grammar every other view command here uses, so a second run returns to
// SESSION rather than leaving the row as a one-way door.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteContext } from '../../../contract/command-palette';
import type { SessionMeta } from '../../../contract/common';

vi.mock('../../lib/api', () => ({
  agentsKill: vi.fn(),
  sessionCompact: vi.fn(),
  sessionModels: vi.fn(() => Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'n/a' } })),
  sessionSwitchModel: vi.fn(),
  skillsRun: vi.fn(() => Promise.resolve({ ok: true, data: null })),
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

describe('audio-cues palette toggle (FR-12)', () => {
  beforeEach(() => {
    mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers "Sound: audio cues" directly after the two notification commands', async () => {
    const { byId, paletteCommands } = await freshModules();
    const sound = byId('toggle-sound');
    expect(sound.name).toBe('Sound: audio cues');

    const ids = paletteCommands().map((c) => c.id);
    expect(ids.indexOf('toggle-notify-turn-done')).toBeLessThan(ids.indexOf('toggle-sound'));
  });

  it('hint reads "on"/"off" from the live toggle, defaulting to on', async () => {
    const { byId } = await freshModules();
    expect(byId('toggle-sound').hint?.()).toBe('on');
  });

  it('running the row flips the master toggle without touching the notification classes', async () => {
    const { byId, useNotificationsStore } = await freshModules();

    byId('toggle-sound').run(ctx);
    expect(useNotificationsStore.getState().soundEnabled).toBe(false);
    expect(useNotificationsStore.getState().enabled).toEqual({ attention: true, turnDone: true });
    expect(byId('toggle-sound').hint?.()).toBe('off');

    byId('toggle-sound').run(ctx);
    expect(useNotificationsStore.getState().soundEnabled).toBe(true);
  });
});

describe('run-skill palette command (pr-142 §6, frontend half)', () => {
  beforeEach(() => {
    mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses retired Pi skill execution even with a saved true capability', async () => {
    const { useStore, byId } = await freshModules();
    const { setPaletteSkills } = await import('./paletteData');
    const api = await import('../../lib/api');
    useStore.setState({
      activeSessionId: 's1',
      sessions: [{ id: 's1', status: 'idle', agentRuntime: 'pi', effectiveCapabilities: { skills: { available: true } } } as SessionMeta],
    });
    setPaletteSkills('s1', [
      { name: 'deploy', description: 'repo skill', installed: true, invocation: '/skill:deploy' },
      { name: 'deploy', description: 'user command', installed: true, invocation: '/deploy' },
    ]);

    const step = byId('run-skill').run({ activeSessionId: 's1', runningAgentCount: 0 });
    expect(step).toBeUndefined();
    expect(api.skillsRun).not.toHaveBeenCalled();
  });
});


it('excludes retired profiles and rejects stale profile creation picks', async () => {
  mockStorage();
  const { useStore, byId } = await freshModules();
  const retired = { id: 'pi', kind: 'pi', name: 'Saved Pi', createdAt: 0, updatedAt: 0, settings: {} } as import('../../../contract/session-profiles').SessionProfile;
  const legacy = { ...retired, id: 'legacy', kind: 'legacy', name: 'Claude' } as import('../../../contract/session-profiles').SessionProfile;
  useStore.setState({ profiles: [retired], pendingNewSessionProfileId: null, newSessionOpen: false });
  const command = byId('new-session-with-profile');
  expect(command.enabled?.(ctx)).toBe(false);
  useStore.setState({ profiles: [retired, legacy] });
  const step = await command.run(ctx);
  expect(step).toBeDefined();
  if (!step) throw new Error('Expected profile selection');
  expect(step.items.map(item => item.id)).toEqual(['legacy']);
  step.onPick('pi');
  expect(useStore.getState().newSessionOpen).toBe(false);
  useStore.setState({ profiles: [retired] });
  step.onPick('legacy');
  expect(useStore.getState().pendingNewSessionProfileId).toBeNull();
  useStore.setState({ profiles: [legacy] });
  step.onPick('legacy');
  expect(useStore.getState().pendingNewSessionProfileId).toBe('legacy');
  expect(useStore.getState().newSessionOpen).toBe(true);
  vi.unstubAllGlobals();
});
