import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeCapability, SessionMeta } from '../../../contract/common';
vi.mock('../../lib/api', () => ({ sessionModels: vi.fn(async () => ({ ok: false })), sessionSwitchModel: vi.fn(), sessionCompact: vi.fn(), skillsRun: vi.fn(), agentsKill: vi.fn() }));
const commands: [string, RuntimeCapability][] = [['switch-model', 'modelSwitching'], ['compact-context', 'compaction'], ['run-skill', 'skills'], ['attach-mcp-server', 'mcp'], ['new-agent', 'subagents'], ['manage-permissions', 'permissions']];
beforeEach(() => { vi.resetModules(); vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} }); });
describe('palette runtime capabilities', () => {
  it.each([undefined, { available: true }, { available: false, reason: 'Model disabled this action.' }])('blocks availability and direct execution with snapshot %j', async (snapshot) => {
    const { useStore } = await import('../../lib/store');
    const { paletteCommands } = await import('./palette');
    (await import('./paletteCommands')).registerBuiltinCommands();
    for (const [id, capability] of commands) {
      useStore.setState({ activeSessionId: 's', sessions: [{ id: 's', agentRuntime: 'pi', effectiveCapabilities: snapshot ? { [capability]: snapshot } : undefined } as SessionMeta] });
      const cmd = paletteCommands().find(c => c.id === id)!;
      expect(cmd.enabled?.({ activeSessionId: 's', runningAgentCount: 0 })).toBe(false);
      expect(cmd.hint?.()).toBe('Pi is unavailable in this version. Saved history is read-only.');
      expect(cmd.run({ activeSessionId: 's', runningAgentCount: 0 })).toBeUndefined();
    }
    expect(useStore.getState().mcpAttachOpen).toBe(false);
    expect(useStore.getState().newAgentOpen).toBe(false);
    expect(useStore.getState().permissionsOpen).toBe(false);
  });
  it.each([['switch-model', 'modelSwitching', 'sessionSwitchModel'], ['run-skill', 'skills', 'skillsRun']] as const)('rechecks %s capability when picking', async (id, capability, method) => {
    const { useStore } = await import('../../lib/store');
    const api = await import('../../lib/api');
    vi.mocked(api[method]).mockClear();
    const { paletteCommands } = await import('./palette');
    (await import('./paletteCommands')).registerBuiltinCommands();
    const meta = { id: 's', agentRuntime: 'pi', effectiveCapabilities: { [capability]: { available: true } } } as SessionMeta;
    useStore.setState({ activeSessionId: 's', sessions: [meta] });
    const step = paletteCommands().find(c => c.id === id)!.run({ activeSessionId: 's', runningAgentCount: 0 });
    useStore.setState({ activeSessionId: 'other', sessions: [{ ...meta, effectiveCapabilities: undefined }, { ...meta, id: 'other' }] });
    step?.onPick('choice');
    expect(api[method]).not.toHaveBeenCalled();
  });
});
