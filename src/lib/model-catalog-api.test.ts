import { expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
import { sessionModels } from './api';
it('forwards the typed account/refresh input, including an explicit empty id for core validation', async () => {
  await sessionModels({ accountId: 'codex-a', refresh: true });
  expect(invoke).toHaveBeenLastCalledWith('session_models', { accountId: 'codex-a', refresh: true });
  await sessionModels({ accountId: '' }); expect(invoke).toHaveBeenLastCalledWith('session_models', { accountId: '' });
  await sessionModels(); expect(invoke).toHaveBeenLastCalledWith('session_models', {});
});
