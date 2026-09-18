import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { ModelCatalog, SessionModelsResponse } from '../../../contract/session-engine';
const { models, switchModel } = vi.hoisted(() => ({ models: vi.fn(), switchModel: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../../lib/api', () => ({ sessionModels: models, sessionSwitchModel: switchModel }));
const catalog = (accountId: string): ModelCatalog => ({ accountId, agentRuntime: 'codex', models: [{ id: `${accountId}-new`, label: 'New model', efforts: ['ultra'] }], defaultModelId: `${accountId}-new`, source: 'codex-app-server', freshness: 'fresh', fetchedAt: 1, warning: null });
async function setup() {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const { useStore } = await import('../../lib/store');
  const { usePaletteState } = await import('./palette');
  const { modelCatalogStep } = await import('./model-catalog');
  useStore.setState({ activeSessionId: 'a', sessions: [{ id: 'a', accountId: 'A' }, { id: 'b', accountId: 'B' }] as SessionMeta[] });
  usePaletteState.getState()._open(null);
  return { useStore, usePaletteState, modelCatalogStep };
}
beforeEach(() => { vi.resetModules(); models.mockReset(); switchModel.mockClear(); });
describe('palette model catalog', () => {
  it('queries the active account on opening and supports explicit refresh without switching a model', async () => {
    models.mockImplementation(({ accountId }) => Promise.resolve({ ok: true, data: catalog(accountId) }));
    const { usePaletteState, modelCatalogStep } = await setup();
    const first = modelCatalogStep('a')!;
    usePaletteState.getState().enterSecondary(first, 'Switch model');
    await Promise.resolve(); await Promise.resolve();
    expect(models).toHaveBeenCalledWith({ accountId: 'A' });
    let step = usePaletteState.getState().secondaryStep!;
    expect(step.items.map(i => i.id)).toEqual(['A-new', '\0refresh']);
    step.onPick('\0refresh');
    expect(models).toHaveBeenLastCalledWith({ accountId: 'A', refresh: true });
    expect(switchModel).not.toHaveBeenCalled();
    await Promise.resolve(); await Promise.resolve();
    step = usePaletteState.getState().secondaryStep!; step.onPick('A-new');
    expect(switchModel).toHaveBeenCalledWith('a', 'A-new');
    usePaletteState.getState()._close();
  });
  it('ignores the previous account after an active-session switch and prevents stale selection', async () => {
    const pending = new Map<string, (v: SessionModelsResponse) => void>();
    models.mockImplementation(({ accountId }) => new Promise(resolve => pending.set(accountId, resolve)));
    const { useStore, usePaletteState, modelCatalogStep } = await setup();
    const a = modelCatalogStep('a')!; usePaletteState.getState().enterSecondary(a, 'Switch model');
    useStore.setState({ activeSessionId: 'b' });
    expect(usePaletteState.getState().secondaryStep).toBeNull();
    const b = modelCatalogStep('b')!; usePaletteState.getState().enterSecondary(b, 'Switch model');
    pending.get('B')!({ ok: true, data: catalog('B') }); await Promise.resolve(); await Promise.resolve();
    pending.get('A')!({ ok: true, data: catalog('A') }); await Promise.resolve(); await Promise.resolve();
    expect(usePaletteState.getState().secondaryStep!.items[0].id).toBe('B-new');
    a.onPick('A-new'); expect(switchModel).not.toHaveBeenCalled();
    usePaletteState.getState()._close();
  });
  it('does not repopulate a dismissed palette', async () => {
    let resolve!: (v: SessionModelsResponse) => void;
    models.mockReturnValue(new Promise(r => { resolve = r; }));
    const { usePaletteState, modelCatalogStep } = await setup();
    usePaletteState.getState().enterSecondary(modelCatalogStep('a')!, 'Switch model');
    usePaletteState.getState()._close(); resolve({ ok: true, data: catalog('A') });
    await Promise.resolve(); await Promise.resolve(); expect(usePaletteState.getState().secondaryStep).toBeNull();
  });
});
