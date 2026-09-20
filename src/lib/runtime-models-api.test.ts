// pi-models-metrics §5 — typed wrapper forwarding, same pattern as the other
// api.ts wrapper tests (pi-runtime-api.test.ts, model-catalog-api.test.ts):
// mock invoke, assert the exact command name and payload shape.

import { expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
import { runtimeModels, sessionMetrics, sessionSwitchModel, sessionSwitchRuntimeModel } from './api';

it('forwards the typed accountId/refresh input to runtime_models verbatim', async () => {
  await runtimeModels({ accountId: 'pi-a' });
  expect(invoke).toHaveBeenLastCalledWith('runtime_models', { accountId: 'pi-a' });

  await runtimeModels({ accountId: 'pi-a', refresh: true });
  expect(invoke).toHaveBeenLastCalledWith('runtime_models', { accountId: 'pi-a', refresh: true });
});

it('forwards the typed sessionId/refresh input to session_metrics verbatim', async () => {
  await sessionMetrics({ sessionId: 's1' });
  expect(invoke).toHaveBeenLastCalledWith('session_metrics', { sessionId: 's1' });

  await sessionMetrics({ sessionId: 's1', refresh: true });
  expect(invoke).toHaveBeenLastCalledWith('session_metrics', { sessionId: 's1', refresh: true });
});

it('sessionSwitchModel is untouched — still a bare modelId, no other callers break', async () => {
  await sessionSwitchModel('s1', 'claude-sonnet-5');
  expect(invoke).toHaveBeenLastCalledWith('session_switch_model', { sessionId: 's1', modelId: 'claude-sonnet-5' });
});

it('sessionSwitchRuntimeModel sends an exact provider/model pair, not a bare id', async () => {
  await sessionSwitchRuntimeModel('s1', { providerId: 'anthropic', modelId: 'claude-sonnet-5' });
  expect(invoke).toHaveBeenLastCalledWith('session_switch_model', {
    sessionId: 's1',
    runtimeModel: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
  });
});
