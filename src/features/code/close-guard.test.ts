// code-editor FR-13: the window close guard, against a fake window.
import { describe, expect, it, vi } from 'vitest';
import { createCloseGuard, type CloseRequestWindow } from './close-guard';

function fakeWindow() {
  let handler: ((e: { preventDefault(): void }) => void | Promise<void>) | null = null;
  const unlisten = vi.fn(() => {
    handler = null;
  });
  const win: CloseRequestWindow = {
    onCloseRequested: vi.fn(async (h) => {
      handler = h;
      return unlisten;
    }),
    close: vi.fn(async () => {}),
  };
  const requestClose = async () => {
    const e = { prevented: false, preventDefault() {
      this.prevented = true;
    } };
    await handler?.(e);
    return e.prevented;
  };
  return { win, unlisten, requestClose, listening: () => handler !== null };
}

describe('createCloseGuard', () => {
  it('listens only while a buffer is dirty', async () => {
    const f = fakeWindow();
    const guard = createCloseGuard(f.win, vi.fn());
    await guard.sync(false);
    expect(f.win.onCloseRequested).not.toHaveBeenCalled();
    await guard.sync(true);
    expect(f.listening()).toBe(true);
    await guard.sync(true);
    expect(f.win.onCloseRequested).toHaveBeenCalledTimes(1);
    await guard.sync(false);
    expect(f.unlisten).toHaveBeenCalled();
  });

  it('a close request with dirty buffers is held and asks (Save all · Discard · Cancel)', async () => {
    const f = fakeWindow();
    const ask = vi.fn();
    const guard = createCloseGuard(f.win, ask);
    await guard.sync(true);
    expect(await f.requestClose()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('proceed drops the hook, then closes the window for real', async () => {
    const f = fakeWindow();
    const guard = createCloseGuard(f.win, vi.fn());
    await guard.sync(true);
    await guard.proceed();
    expect(f.unlisten).toHaveBeenCalled();
    expect(f.win.close).toHaveBeenCalled();
    expect(f.listening()).toBe(false);
  });
});
