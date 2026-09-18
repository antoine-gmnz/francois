import { expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
import { runtimeInstallation } from './api';

it('forwards the typed probe input to runtime_installation verbatim', async () => {
  await runtimeInstallation({ runtime: 'native', refresh: false });
  expect(invoke).toHaveBeenLastCalledWith('runtime_installation', { runtime: 'native', refresh: false });

  await runtimeInstallation({ runtime: 'wsl', distro: 'Ubuntu', refresh: true });
  expect(invoke).toHaveBeenLastCalledWith('runtime_installation', {
    runtime: 'wsl',
    distro: 'Ubuntu',
    refresh: true,
  });
});
