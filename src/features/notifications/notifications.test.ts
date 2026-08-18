// notifications (specs/notifications.md §5/§6/§7/§9) — frontend unit tests.
// `shouldFire` is pure and covered with no DOM/Tauri mocking (§9); the trigger
// derivation cases moved to trigger.test.ts (audio-cues FR-1). `initNotifications`
// is a call-once singleton (FR-5), so its own describe block re-imports the
// module (and its store dependencies) fresh per test via `vi.resetModules()` —
// the same convention layoutStore.test.ts / theme.test.ts use for module-init
// state, extended here to keep the dynamically re-imported
// `useStore`/`useNotificationsStore` instances consistent with the freshly
// re-imported `notifications` module under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionMeta } from '../../../contract/common';
import { NOTIFICATION_TITLE } from '../../../contract/notifications';
import type { NotifyTrigger } from '../../../contract/notifications';
import { shouldFire } from './notifications';

const { listenMock, isPermissionGrantedMock, requestPermissionMock, sendNotificationMock, onActionMock, windowMock } =
  vi.hoisted(() => ({
    listenMock: vi.fn(),
    isPermissionGrantedMock: vi.fn(),
    requestPermissionMock: vi.fn(),
    sendNotificationMock: vi.fn(),
    onActionMock: vi.fn(),
    windowMock: {
      isFocused: vi.fn(),
      onFocusChanged: vi.fn(),
      unminimize: vi.fn(),
      setFocus: vi.fn(),
    },
  }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowMock }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: isPermissionGrantedMock,
  requestPermission: requestPermissionMock,
  sendNotification: sendNotificationMock,
  onAction: onActionMock,
}));

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('shouldFire (FR-7/FR-8)', () => {
  const approval: NotifyTrigger = { class: 'attention', kind: 'approval', sessionId: 's1', toolName: 'Bash' };
  const settle: NotifyTrigger = { class: 'turnDone', kind: 'settle', sessionId: 's1', status: 'idle' };

  it('FR-7: an attention trigger fires whenever enabled.attention is true, visible+focused or not', () => {
    expect(
      shouldFire(approval, { enabled: { attention: true, turnDone: true }, visibleSessionIds: ['s1'], windowFocused: true }),
    ).toBe(true);
    expect(shouldFire(approval, { enabled: { attention: true, turnDone: true }, visibleSessionIds: [], windowFocused: false })).toBe(
      true,
    );
  });

  it('FR-7: an attention trigger never fires when enabled.attention is false', () => {
    expect(shouldFire(approval, { enabled: { attention: false, turnDone: true }, visibleSessionIds: [], windowFocused: false })).toBe(
      false,
    );
  });

  it('FR-8: a turnDone trigger on the visible+focused session does not fire', () => {
    expect(shouldFire(settle, { enabled: { attention: true, turnDone: true }, visibleSessionIds: ['s1'], windowFocused: true })).toBe(
      false,
    );
  });

  it('FR-8: a turnDone trigger on the visible session fires once the window is unfocused', () => {
    expect(shouldFire(settle, { enabled: { attention: true, turnDone: true }, visibleSessionIds: ['s1'], windowFocused: false })).toBe(
      true,
    );
  });

  it('FR-8: a turnDone trigger on a non-visible session fires focused or not', () => {
    expect(shouldFire(settle, { enabled: { attention: true, turnDone: true }, visibleSessionIds: ['s2'], windowFocused: true })).toBe(
      true,
    );
    expect(shouldFire(settle, { enabled: { attention: true, turnDone: true }, visibleSessionIds: ['s2'], windowFocused: false })).toBe(
      true,
    );
  });

  // split-session FR-19: BOTH paned sessions are visible, so a settle in the
  // unfocused pane is suppressed exactly like one in the focused pane.
  it('FR-19: a turnDone trigger on the SPLIT pane’s session is suppressed while the window is focused', () => {
    expect(
      shouldFire(settle, { enabled: { attention: true, turnDone: true }, visibleSessionIds: ['s9', 's1'], windowFocused: true }),
    ).toBe(false);
    expect(
      shouldFire(settle, { enabled: { attention: true, turnDone: true }, visibleSessionIds: ['s9', 's8'], windowFocused: true }),
    ).toBe(true);
  });

  it('FR-17: a turnDone trigger never fires when enabled.turnDone is false, regardless of visibility/focus', () => {
    expect(shouldFire(settle, { enabled: { attention: true, turnDone: false }, visibleSessionIds: ['s2'], windowFocused: false })).toBe(
      false,
    );
  });
});

describe('initNotifications runtime wiring', () => {
  let sessionHandler: ((e: { payload: SessionEvent }) => void) | undefined;
  let focusHandler: ((e: { payload: boolean }) => void) | undefined;
  let clickHandler: ((n: { extra?: Record<string, unknown> }) => void) | undefined;
  let notifications: typeof import('./notifications');
  let store: typeof import('../../lib/store');
  let notifStore: typeof import('../../lib/notificationsStore');

  beforeEach(async () => {
    vi.resetModules();
    sessionHandler = undefined;
    focusHandler = undefined;
    clickHandler = undefined;

    listenMock.mockReset().mockImplementation((channel: string, cb: (e: { payload: unknown }) => void) => {
      if (channel === 'francois://session/event') sessionHandler = cb as (e: { payload: SessionEvent }) => void;
      return Promise.resolve(vi.fn());
    });
    windowMock.isFocused.mockReset().mockResolvedValue(true);
    windowMock.onFocusChanged.mockReset().mockImplementation((cb: (e: { payload: boolean }) => void) => {
      focusHandler = cb;
      return Promise.resolve(vi.fn());
    });
    windowMock.unminimize.mockReset().mockResolvedValue(undefined);
    windowMock.setFocus.mockReset().mockResolvedValue(undefined);
    isPermissionGrantedMock.mockReset().mockResolvedValue(true);
    requestPermissionMock.mockReset().mockResolvedValue('granted');
    sendNotificationMock.mockReset();
    onActionMock.mockReset().mockImplementation((cb: (n: { extra?: Record<string, unknown> }) => void) => {
      clickHandler = cb;
      return Promise.resolve({ unregister: vi.fn() });
    });

    store = await import('../../lib/store');
    notifStore = await import('../../lib/notificationsStore');
    notifications = await import('./notifications');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is idempotent — a second call registers the listener only once', async () => {
    notifications.initNotifications();
    notifications.initNotifications();
    await tick();
    expect(listenMock.mock.calls.filter((c) => c[0] === 'francois://session/event')).toHaveLength(1);
  });

  it('fires a granted notification with title/body/extra for an attention trigger', async () => {
    notifications.initNotifications();
    await tick();
    store.useStore.setState({ sessions: [{ id: 's1', name: 'api-refactor' } as unknown as SessionMeta] });
    sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's1', blockId: 'b1', questions: [] } });
    await tick();

    expect(sendNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: NOTIFICATION_TITLE, body: 'api-refactor · needs an answer', extra: { sessionId: 's1' } }),
    );
  });

  it('FR-12: falls back to "session" when the session name is not cached', async () => {
    notifications.initNotifications();
    await tick();
    sessionHandler?.({ payload: { type: 'question.asked', sessionId: 'unknown', blockId: 'b1', questions: [] } });
    await tick();
    expect(sendNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ body: 'session · needs an answer' }));
  });

  it('FR-10: requests permission at most once, and never fires again once denied', async () => {
    isPermissionGrantedMock.mockResolvedValue(false);
    requestPermissionMock.mockResolvedValue('denied');
    notifications.initNotifications();
    await tick();
    sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's1', blockId: 'b1', questions: [] } });
    await tick();
    sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's1', blockId: 'b2', questions: [] } });
    await tick();

    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('FR-10: skips the prompt entirely when already granted', async () => {
    notifications.initNotifications();
    await tick();
    sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's1', blockId: 'b1', questions: [] } });
    await tick();
    expect(requestPermissionMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('a sendNotification throw never breaks the event handler (FR-11)', async () => {
    sendNotificationMock.mockImplementation(() => {
      throw new Error('boom');
    });
    notifications.initNotifications();
    await tick();
    expect(() =>
      sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's1', blockId: 'b1', questions: [] } }),
    ).not.toThrow();
  });

  it('FR-8/FR-9: an unfocused window lets a turnDone trigger fire on the active session', async () => {
    windowMock.isFocused.mockResolvedValue(false);
    notifications.initNotifications();
    await tick();
    store.useStore.setState({ activeSessionId: 's1' });
    sessionHandler?.({ payload: { type: 'session.status', sessionId: 's1', status: 'running' } });
    sessionHandler?.({ payload: { type: 'session.status', sessionId: 's1', status: 'idle' } });
    await tick();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('FR-8: a turnDone trigger on the active AND focused session does not fire', async () => {
    notifications.initNotifications(); // windowFocused seeds true by default
    await tick();
    store.useStore.setState({ activeSessionId: 's1' });
    sessionHandler?.({ payload: { type: 'session.status', sessionId: 's1', status: 'running' } });
    sessionHandler?.({ payload: { type: 'session.status', sessionId: 's1', status: 'idle' } });
    await tick();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('FR-9: a focus change flips gating for a later transition', async () => {
    notifications.initNotifications();
    await tick();
    store.useStore.setState({ activeSessionId: 's1' });
    sessionHandler?.({ payload: { type: 'session.status', sessionId: 's1', status: 'running' } });
    focusHandler?.({ payload: false }); // alt-tab away
    sessionHandler?.({ payload: { type: 'session.status', sessionId: 's1', status: 'idle' } });
    await tick();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('FR-9: isFocused()/onFocusChanged rejecting degrades to the conservative focused=true default', async () => {
    windowMock.isFocused.mockRejectedValue(new Error('unavailable'));
    windowMock.onFocusChanged.mockRejectedValue(new Error('unavailable'));
    notifications.initNotifications();
    await tick();
    store.useStore.setState({ activeSessionId: 's1' });
    sessionHandler?.({ payload: { type: 'session.status', sessionId: 's1', status: 'running' } });
    sessionHandler?.({ payload: { type: 'session.status', sessionId: 's1', status: 'idle' } });
    await tick();
    expect(sendNotificationMock).not.toHaveBeenCalled(); // active + "focused" default → gated out
  });

  it('FR-17: turning turnDone off suppresses settle notifications while attention keeps firing', async () => {
    notifications.initNotifications();
    await tick();
    notifStore.useNotificationsStore.getState().setNotifyEnabled('turnDone', false);
    sessionHandler?.({ payload: { type: 'session.status', sessionId: 's2', status: 'running' } });
    sessionHandler?.({ payload: { type: 'session.status', sessionId: 's2', status: 'idle' } });
    await tick();
    expect(sendNotificationMock).not.toHaveBeenCalled();

    sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's2', blockId: 'b1', questions: [] } });
    await tick();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('FR-13: clicking with an extra.sessionId selects that session, unminimizes and focuses', async () => {
    notifications.initNotifications();
    await tick();
    store.useStore.setState({
      sessions: [{ id: 's9', name: 's9' } as unknown as SessionMeta],
      activeSessionId: null,
      mainTab: 'diff',
      focusedPane: 'agents',
    });
    clickHandler?.({ extra: { sessionId: 's9' } });

    expect(store.useStore.getState().activeSessionId).toBe('s9');
    expect(store.useStore.getState().focusedPane).toBe('main');
    expect(store.useStore.getState().mainTab).toBe('session');
    expect(windowMock.unminimize).toHaveBeenCalled();
    expect(windowMock.setFocus).toHaveBeenCalled();
  });

  it('FR-13: clicking without extra falls back to lastNotifiedSessionId', async () => {
    notifications.initNotifications();
    await tick();
    store.useStore.setState({ sessions: [{ id: 's7', name: 's7' } as unknown as SessionMeta], activeSessionId: null });
    sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's7', blockId: 'b1', questions: [] } });
    await tick();

    clickHandler?.({});
    expect(store.useStore.getState().activeSessionId).toBe('s7');
  });

  it('FR-13: a click resolving to no id at all still raises the window without touching selection', async () => {
    notifications.initNotifications();
    await tick();
    store.useStore.setState({ activeSessionId: null });
    clickHandler?.({});
    expect(store.useStore.getState().activeSessionId).toBeNull();
    expect(windowMock.unminimize).toHaveBeenCalled();
    expect(windowMock.setFocus).toHaveBeenCalled();
  });
});
