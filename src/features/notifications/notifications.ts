// notifications: OS desktop notifications for a blocked turn (attention) or a
// settled turn (turnDone). specs/notifications.md §5/§6. Almost entirely
// frontend — subscribes to the existing francois://session/event stream and
// calls the official tauri-plugin-notification JS API. No IPC of our own.

import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { BlockId, SessionEvent, SessionId, SessionStatus } from '../../../contract/common';
import { isBusyStatus } from '../../../contract/fleet-board';
import type { NotifyClass, NotifyTrigger } from '../../../contract/notifications';
import { NOTIFICATION_TITLE, isSettleStatus, notificationBody } from '../../../contract/notifications';
import { onSessionEvent } from '../../lib/api';
import { useNotificationsStore } from '../../lib/notificationsStore';
import { useStore } from '../../lib/store';

// ---------- pure derivation + gating (FR-6/FR-7/FR-8/FR-14, unit tested with
// no DOM and no Tauri) ----------

export interface DeriveState {
  lastStatus: Map<SessionId, SessionStatus>;
  seenAsks: Set<BlockId>;
}

export interface GateContext {
  enabled: Record<NotifyClass, boolean>;
  activeSessionId: SessionId | null;
  windowFocused: boolean;
}

/** Shared by the three settle sources (§5): one map, so an ask-then-error pair fires at most once. */
function settleTrigger(sessionId: SessionId, nextStatus: SessionStatus, state: DeriveState): NotifyTrigger | null {
  const previous = state.lastStatus.get(sessionId);
  state.lastStatus.set(sessionId, nextStatus);
  // isBusyStatus, not `=== 'running'`: a turn can settle out of any in-flight
  // status. Interrupting an approval card goes awaiting_approval → idle, and a
  // spawn failure goes starting → error — both are turns the user was waiting
  // on, and both fired no notification while this only recognised `running`.
  if (previous !== undefined && isBusyStatus(previous) && isSettleStatus(nextStatus)) {
    return { class: 'turnDone', kind: 'settle', sessionId, status: nextStatus };
  }
  return null;
}

/**
 * FR-6/FR-14 — maps an event to a trigger, mutating `state`. Pure otherwise:
 * gating (whether it actually fires) is `shouldFire`'s job, not this one — a
 * muted class must still update `lastStatus`/`seenAsks` so re-enabling it
 * later sees the correct baseline (§7 "A class is toggled off").
 */
export function deriveTrigger(e: SessionEvent, state: DeriveState): NotifyTrigger | null {
  switch (e.type) {
    case 'permission.asked': {
      if (state.seenAsks.has(e.blockId)) return null; // FR-14: never re-fire a resolved/replayed ask
      state.seenAsks.add(e.blockId);
      return { class: 'attention', kind: 'approval', sessionId: e.sessionId, toolName: e.ask.toolName };
    }
    case 'question.asked': {
      if (state.seenAsks.has(e.blockId)) return null;
      state.seenAsks.add(e.blockId);
      return { class: 'attention', kind: 'question', sessionId: e.sessionId };
    }
    case 'session.status':
      return settleTrigger(e.sessionId, e.status, state);
    case 'session.meta':
      return settleTrigger(e.meta.id, e.meta.status, state);
    case 'session.error':
      return settleTrigger(e.sessionId, 'error', state);
    default:
      return null;
  }
}

/** FR-7/FR-8 — the complete gating rule. */
export function shouldFire(t: NotifyTrigger, ctx: GateContext): boolean {
  if (t.class === 'attention') return ctx.enabled.attention; // FR-7: unconditional beyond the toggle
  return ctx.enabled.turnDone && (t.sessionId !== ctx.activeSessionId || !ctx.windowFocused); // FR-8
}

// ---------- runtime wiring (FR-5/FR-9..FR-13) ----------

const deriveState: DeriveState = { lastStatus: new Map(), seenAsks: new Set() };

let windowFocused = true; // FR-9: conservative default until isFocused() resolves
let permission: 'unknown' | 'granted' | 'denied' = 'unknown';
let nextId = 1;
let lastNotifiedSessionId: SessionId | null = null;
let initialized = false;

/** FR-10: resolve OS permission at most once; a denied/broken outcome is cached forever. */
async function ensurePermission(): Promise<boolean> {
  if (permission !== 'unknown') return permission === 'granted';
  try {
    if (await isPermissionGranted()) {
      permission = 'granted';
      return true;
    }
    const outcome = await requestPermission();
    permission = outcome === 'granted' ? 'granted' : 'denied';
    return permission === 'granted';
  } catch {
    permission = 'denied';
    return false;
  }
}

async function fire(trigger: NotifyTrigger): Promise<void> {
  if (!(await ensurePermission())) return; // FR-10: silent no-op forever
  const name = useStore.getState().sessions.find((s) => s.id === trigger.sessionId)?.name ?? 'session'; // FR-12
  const id = nextId++;
  lastNotifiedSessionId = trigger.sessionId; // FR-13 click-fallback
  try {
    sendNotification({
      title: NOTIFICATION_TITLE,
      body: notificationBody(name, trigger),
      extra: { sessionId: trigger.sessionId },
      id,
    });
  } catch {
    /* FR-11: a throw never breaks the event handler */
  }
}

function handleSessionEvent(e: SessionEvent): void {
  const trigger = deriveTrigger(e, deriveState);
  if (!trigger) return;
  const ctx: GateContext = {
    enabled: useNotificationsStore.getState().enabled,
    activeSessionId: useStore.getState().activeSessionId,
    windowFocused,
  };
  if (!shouldFire(trigger, ctx)) return;
  void fire(trigger);
}

/** FR-13: click-to-focus — best-effort, see contract/notifications.ts §5 desktop limitation. */
function focusFrancois(): void {
  const win = getCurrentWindow();
  void win.unminimize().catch(() => {});
  void win.setFocus().catch(() => {});
}

function handleNotificationAction(n: { extra?: Record<string, unknown> }): void {
  const sessionId = (n.extra?.sessionId as SessionId | undefined) ?? lastNotifiedSessionId ?? null;
  if (sessionId) {
    const st = useStore.getState();
    st.setActiveSessionId(sessionId);
    st.setFocusedPane('main');
    st.setMainTab('session');
  }
  focusFrancois();
}

/** Called once from App's mount effect (FR-5). Idempotent. */
export function initNotifications(): void {
  if (initialized) return;
  initialized = true;

  void onSessionEvent(handleSessionEvent);

  // FR-9: seed once, then track live changes; either rejecting leaves the
  // conservative `true` default rather than over-notifying.
  const win = getCurrentWindow();
  void win
    .isFocused()
    .then((f) => {
      windowFocused = f;
    })
    .catch(() => {
      windowFocused = true;
    });
  void win
    .onFocusChanged(({ payload }) => {
      windowFocused = payload;
    })
    .catch(() => {});

  void onAction(handleNotificationAction).catch(() => {
    /* best-effort per contract/notifications.ts §5 desktop limitation */
  });
}
