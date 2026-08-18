// notifications: OS desktop notifications for a blocked turn (attention) or a
// settled turn (turnDone). specs/notifications.md §5/§6. Almost entirely
// frontend — reacts to the shared trigger source (audio-cues FR-1..FR-4) and
// calls the official tauri-plugin-notification JS API. No IPC of our own.

import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { SessionId } from '../../../contract/common';
import type { NotifyClass, NotifyTrigger } from '../../../contract/notifications';
import { NOTIFICATION_TITLE, notificationBody } from '../../../contract/notifications';
import { visibleSessionIds } from '../../lib/layoutStore';
import { useNotificationsStore } from '../../lib/notificationsStore';
import { useStore } from '../../lib/store';
import { registerTriggerSink } from './trigger';

export interface GateContext {
  enabled: Record<NotifyClass, boolean>;
  /**
   * split-session FR-19: every session currently ON SCREEN — one when not
   * split, BOTH panes' otherwise. A settle in the unfocused pane is as visible
   * as one in the focused pane, so it must be suppressed the same way.
   */
  visibleSessionIds: readonly SessionId[];
  windowFocused: boolean;
}

/** FR-7/FR-8 — the complete gating rule. */
export function shouldFire(t: NotifyTrigger, ctx: GateContext): boolean {
  if (t.class === 'attention') return ctx.enabled.attention; // FR-7: unconditional beyond the toggle
  return ctx.enabled.turnDone && (!ctx.visibleSessionIds.includes(t.sessionId) || !ctx.windowFocused); // FR-8
}

// ---------- runtime wiring (FR-5/FR-9..FR-13) ----------

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

/** audio-cues FR-4: registered as a sink instead of subscribing directly. */
function handleTrigger(trigger: NotifyTrigger): void {
  const ctx: GateContext = {
    enabled: useNotificationsStore.getState().enabled,
    visibleSessionIds: visibleSessionIds(useStore.getState()),
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

  registerTriggerSink(handleTrigger);

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
