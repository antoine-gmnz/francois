// notifications (specs/notifications.md §5/§6/§7/§9) — frontend unit tests.
// `deriveTrigger`/`shouldFire` are pure and covered with no DOM/Tauri mocking
// (§9). `initNotifications` is a call-once singleton (FR-5), so its own
// describe block re-imports the module (and its store dependencies) fresh
// per test via `vi.resetModules()` — the same convention layoutStore.test.ts /
// theme.test.ts use for module-init state, extended here to keep the
// dynamically re-imported `useStore`/`useNotificationsStore` instances
// consistent with the freshly re-imported `notifications` module under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionMeta, SessionStatus } from '../../../contract/common';
import { NOTIFICATION_TITLE } from '../../../contract/notifications';
import type { NotifyTrigger } from '../../../contract/notifications';
import { deriveTrigger, shouldFire, type DeriveState } from './notifications';

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

function freshState(): DeriveState {
  return { lastStatus: new Map(), seenAsks: new Set() };
}

const permissionAsked = (sessionId: string, blockId: string, toolName = 'Bash'): SessionEvent => ({
  type: 'permission.asked',
  sessionId,
  blockId,
  ask: { toolName, summary: '', inputJson: '{}', cwd: '/repo', pattern: '', patternLabel: '' },
});
const questionAsked = (sessionId: string, blockId: string): SessionEvent => ({
  type: 'question.asked',
  sessionId,
  blockId,
  questions: [],
});
const status = (sessionId: string, s: SessionStatus): SessionEvent => ({ type: 'session.status', sessionId, status: s });
const metaOf = (id: string, s: SessionStatus): SessionMeta => ({
  id,
  name: 'x',
  cwd: '/repo',
  model: { id: 'm', label: 'M' },
  status: s,
  contextUsedTokens: 0,
  contextLimitTokens: 0,
  startedAt: 0,
  lastActivityAt: 0,
  permissionMode: 'default',
  runtime: 'native',
  accountId: 'default',
});

describe('deriveTrigger (FR-6/FR-14)', () => {
  it('permission.asked yields an attention/approval trigger naming the tool', () => {
    const state = freshState();
    const t = deriveTrigger(permissionAsked('s1', 'b1', 'Bash'), state);
    expect(t).toEqual({ class: 'attention', kind: 'approval', sessionId: 's1', toolName: 'Bash' });
  });

  it('question.asked yields an attention/question trigger', () => {
    const state = freshState();
    const t = deriveTrigger(questionAsked('s1', 'b1'), state);
    expect(t).toEqual({ class: 'attention', kind: 'question', sessionId: 's1' });
  });

  it('FR-14: the same blockId seen twice (permission) fires exactly once', () => {
    const state = freshState();
    expect(deriveTrigger(permissionAsked('s1', 'b1'), state)).not.toBeNull();
    expect(deriveTrigger(permissionAsked('s1', 'b1'), state)).toBeNull();
  });

  it('FR-14: the same blockId seen twice (question) fires exactly once', () => {
    const state = freshState();
    expect(deriveTrigger(questionAsked('s1', 'b1'), state)).not.toBeNull();
    expect(deriveTrigger(questionAsked('s1', 'b1'), state)).toBeNull();
  });

  it('a running → idle transition yields a turnDone/settle trigger', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    const t = deriveTrigger(status('s1', 'idle'), state);
    expect(t).toEqual({ class: 'turnDone', kind: 'settle', sessionId: 's1', status: 'idle' });
  });

  it('a running → error transition yields status error; running → done yields done', () => {
    const errState = freshState();
    deriveTrigger(status('s1', 'running'), errState);
    expect(deriveTrigger(status('s1', 'error'), errState)).toEqual({
      class: 'turnDone',
      kind: 'settle',
      sessionId: 's1',
      status: 'error',
    });

    const doneState = freshState();
    deriveTrigger(status('s1', 'running'), doneState);
    expect(deriveTrigger(status('s1', 'done'), doneState)).toEqual({
      class: 'turnDone',
      kind: 'settle',
      sessionId: 's1',
      status: 'done',
    });
  });

  it('FR-16: a first-observed status (no prior sighting) never yields a trigger, even idle', () => {
    const state = freshState();
    expect(deriveTrigger(status('s1', 'idle'), state)).toBeNull();
  });

  it('FR-15: a repeated identical status yields no trigger the second time', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    expect(deriveTrigger(status('s1', 'idle'), state)).not.toBeNull();
    expect(deriveTrigger(status('s1', 'idle'), state)).toBeNull();
  });

  it('session.meta feeds the same settle map, keyed by meta.id/meta.status', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    const t = deriveTrigger({ type: 'session.meta', meta: metaOf('s1', 'idle') }, state);
    expect(t).toEqual({ class: 'turnDone', kind: 'settle', sessionId: 's1', status: 'idle' });
  });

  it('§5: session.error followed by session.meta{status:"error"} for the same failure fires once', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    const first = deriveTrigger({ type: 'session.error', sessionId: 's1', error: { code: 'INTERNAL', message: 'x' } }, state);
    expect(first).toEqual({ class: 'turnDone', kind: 'settle', sessionId: 's1', status: 'error' });
    const second = deriveTrigger({ type: 'session.meta', meta: metaOf('s1', 'error') }, state);
    expect(second).toBeNull();
  });

  it('every other event member yields null', () => {
    const state = freshState();
    expect(deriveTrigger({ type: 'session.removed', sessionId: 's1' }, state)).toBeNull();
    expect(deriveTrigger({ type: 'permission.resolved', sessionId: 's1', blockId: 'b1', state: 'allowed' }, state)).toBeNull();
    expect(deriveTrigger({ type: 'question.resolved', sessionId: 's1', blockId: 'b1', state: 'answered' }, state)).toBeNull();
  });

  it('a resolved ask never clears seenAsks — a re-emitted asked event for the same blockId still stays silent', () => {
    const state = freshState();
    deriveTrigger(permissionAsked('s1', 'b1'), state);
    deriveTrigger({ type: 'permission.resolved', sessionId: 's1', blockId: 'b1', state: 'allowed' }, state);
    expect(deriveTrigger(permissionAsked('s1', 'b1'), state)).toBeNull();
  });

  it('a muted class still updates lastStatus/seenAsks (gating is shouldFire’s job, not deriveTrigger’s)', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    deriveTrigger(status('s1', 'idle'), state);
    expect(state.lastStatus.get('s1')).toBe('idle');
  });
});

describe('shouldFire (FR-7/FR-8)', () => {
  const approval: NotifyTrigger = { class: 'attention', kind: 'approval', sessionId: 's1', toolName: 'Bash' };
  const settle: NotifyTrigger = { class: 'turnDone', kind: 'settle', sessionId: 's1', status: 'idle' };

  it('FR-7: an attention trigger fires whenever enabled.attention is true, active+focused or not', () => {
    expect(shouldFire(approval, { enabled: { attention: true, turnDone: true }, activeSessionId: 's1', windowFocused: true })).toBe(
      true,
    );
    expect(shouldFire(approval, { enabled: { attention: true, turnDone: true }, activeSessionId: null, windowFocused: false })).toBe(
      true,
    );
  });

  it('FR-7: an attention trigger never fires when enabled.attention is false', () => {
    expect(shouldFire(approval, { enabled: { attention: false, turnDone: true }, activeSessionId: null, windowFocused: false })).toBe(
      false,
    );
  });

  it('FR-8: a turnDone trigger on the active+focused session does not fire', () => {
    expect(shouldFire(settle, { enabled: { attention: true, turnDone: true }, activeSessionId: 's1', windowFocused: true })).toBe(
      false,
    );
  });

  it('FR-8: a turnDone trigger on the active session fires once the window is unfocused', () => {
    expect(shouldFire(settle, { enabled: { attention: true, turnDone: true }, activeSessionId: 's1', windowFocused: false })).toBe(
      true,
    );
  });

  it('FR-8: a turnDone trigger on a non-active session fires focused or not', () => {
    expect(shouldFire(settle, { enabled: { attention: true, turnDone: true }, activeSessionId: 's2', windowFocused: true })).toBe(
      true,
    );
    expect(shouldFire(settle, { enabled: { attention: true, turnDone: true }, activeSessionId: 's2', windowFocused: false })).toBe(
      true,
    );
  });

  it('FR-17: a turnDone trigger never fires when enabled.turnDone is false, regardless of active/focus', () => {
    expect(shouldFire(settle, { enabled: { attention: true, turnDone: false }, activeSessionId: 's2', windowFocused: false })).toBe(
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
