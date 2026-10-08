import { expect, it, vi } from 'vitest';
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
import { editorOpenTarget } from './api';
it('sends the target and owning session through the native command', async () => {
  invokeMock.mockResolvedValue({ ok: true, data: null });
  const req = { sessionId: 'session-1', target: 'src/app.ts:12:3' };
  await expect(editorOpenTarget(req)).resolves.toEqual({ ok: true, data: null });
  expect(invokeMock).toHaveBeenCalledWith('editor_open_target', { req });
});
