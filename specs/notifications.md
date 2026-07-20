---
id: notifications
title: Desktop notifications for background sessions
status: frozen
created: 2026-07-19
depends_on: [app-shell, session-engine]
---

# Desktop notifications for background sessions

## 1. Summary

Francois is built for running several Claude Code workstreams at once, but the
window shows exactly one session at a time. When a background session finishes a
turn, errors out, or completes, nothing tells you — you have to keep clicking
around the sidebar to notice. This feature fires an **OS desktop notification**
whenever a session you are **not currently looking at** transitions to a state
that needs your attention: `idle` (a turn just finished — ready for your next
message), `error`, or `done`. The notification names the session and why
(e.g. *"explorer · turn finished"*, *"api-refactor · error"*), and clicking it
brings Francois to the foreground and selects that session. The feature is almost
entirely frontend: a small module subscribes to the existing
`francois://session/event` stream, applies the gating, requests OS notification
permission once, and calls the official **`tauri-plugin-notification`** JS API. A
single global on/off toggle in the status bar (default on, persisted to
localStorage) lets you silence it. No new IPC command or event of our own is
added. Together with the parallel `fleet-board` glance and `session-brake`
stop-turn work, this is the last piece that makes concurrent background sessions
practical to actually run.

## 2. Goals & non-goals

- **Goals**:
  - Fire an OS notification when a session transitions to `idle`, `error`, or `done` **and** it is not the active (on-screen) session.
  - Name the session and the reason in the notification body (*"`<name>` · turn finished | error | done"*).
  - Request OS notification permission lazily on the first fire; if denied, silently no-op forever (no nagging, no repeated prompts).
  - Click-to-focus: activating a notification brings the app to the foreground and selects the notified session (best-effort payload routing; window-focus fallback).
  - A single global enable/disable toggle (default **on**), persisted across restarts (localStorage for v1).
  - Wire the official `tauri-plugin-notification`: Cargo dep, `main.rs` registration, capability grant, and its `@tauri-apps/plugin-notification` JS API — **no new IPC command of our own**.
  - Never fire for the session you are already looking at, and never double-fire the same transition.
- **Non-goals** (elsewhere / later):
  - The rich session status board / glance — separate spec (`fleet-board`); this feature only *pings*, it does not render session state.
  - "Stop this turn" kill switch + per-session worktree isolation — separate spec (`session-brake`).
  - Per-session notification preferences, mute-per-session, quiet hours, or notification categories/channels — v1 is one global toggle.
  - In-app toast/banner notifications (the command-palette already owns in-app toasts); this feature is strictly **OS-level** desktop notifications.
  - Styling/theming the notification surface — it is OS-rendered and not styleable in-app (only title/body/icon are controllable).
  - Sound customization, badges, notification grouping/threading, action buttons beyond a plain click.
  - Notifying on turn *start*, tool events, subagent events, or context-limit warnings — only the three settle states (`idle`/`error`/`done`).
  - Persisting the toggle in the Rust core / a real settings store — localStorage is the accepted v1 mechanism (named follow-up in §7).

## 3. User stories / flows

1. **Background turn finishes.** You kick off a long turn in session `api-refactor`,
   then switch to session `explorer` to keep working. When `api-refactor`'s turn
   completes, its status goes `running → idle`. Because it is not the active
   session, an OS notification appears: title **francois**, body
   **"api-refactor · turn finished"**. You keep reading `explorer`; when ready you
   click the notification — Francois comes to the foreground, the sidebar selection
   and SESSION tab switch to `api-refactor`, and you type your follow-up.

2. **Background error.** A session errors while you are elsewhere. You get
   **"deploy-bot · error"**. Clicking focuses the app and selects `deploy-bot` so
   you can see what happened. (The red error detail itself lives in
   conversation-view; the notification is just the ping.)

3. **First-run permission.** The very first time a notification would fire, the OS
   permission prompt appears. If you **allow**, the notification shows (and every
   later one shows with no further prompt). If you **deny**, nothing shows now or
   later — the app never asks again this session and never surfaces an in-app nag.

4. **Looking right at it.** A turn finishes in the session that is currently active
   and on screen. **No notification** — you are already looking at it. (You see the
   status change in the existing UI.)

5. **Silence it.** Notifications feel noisy during a focused stretch. You click the
   **`◈ notify`** control in the status bar; it flips to **`◇ notify`** (dim). No
   notifications fire while off. You quit and reopen Francois days later; the
   toggle is still off (persisted). You click it again to re-enable.

6. **Restart, no false pings.** You reopen Francois with several persisted sessions.
   They reload as `idle` (durable-sessions), which is a settle state — but because
   this is the *first* status seen for each (not a `running → idle` transition),
   **no notifications fire** on startup.

## 4. Functional requirements

**Integration (build wiring — small, one-time)**

- **FR-1 (Cargo dep).** `src-tauri/Cargo.toml` gains `tauri-plugin-notification = "2"` under `[dependencies]`.
- **FR-2 (plugin registration).** `src-tauri/src/main.rs` registers the plugin in the builder chain: `.plugin(tauri_plugin_notification::init())` (alongside the existing `tauri_plugin_dialog::init()`).
- **FR-3 (capability grant).** `src-tauri/capabilities/default.json` gains `"notification:default"` in `permissions` (covers `allow-is-permission-granted`, `allow-request-permission`, `allow-notify`, and the plugin's action/listener commands used for click-to-focus).
- **FR-4 (JS dep).** The frontend depends on `@tauri-apps/plugin-notification` (add to `package.json`; same major version, `^2`).

**Frontend module (`src/notifications.ts`)**

- **FR-5 (init once).** `initNotifications()` is called exactly once from `App`'s mount effect (next to `initShellEvents()`). It seeds the enabled flag from the store, subscribes to `onSessionEvent`, and registers the click-to-focus handler. Idempotent — a second call is a no-op.
- **FR-6 (transition detection).** The module keeps a per-session `Map<SessionId, SessionStatus>` of last-seen status. For each consumed event it derives `(sessionId, nextStatus)` (§5 mapping), then updates the map. A fire is eligible **iff** the *previous* status for that session was exactly `'running'` **and** `nextStatus ∈ {'idle','error','done'}`. First sighting of a session (previous `undefined`) never fires.
- **FR-7 (active-session gate).** An eligible transition fires **only if** `sessionId !== useStore.getState().activeSessionId` — you are never pinged about the session you are looking at.
- **FR-8 (enabled gate).** A fire happens **only if** the global toggle is on (`useStore.getState().notificationsEnabled === true`).
- **FR-9 (permission, lazy + once).** On the first fire that passes FR-6/7/8, the module ensures permission: if `isPermissionGranted()` is false, call `requestPermission()` once; cache the outcome in a module variable. If the outcome is not `'granted'`, set a `permissionDenied` flag and **silently no-op** — never call `requestPermission()` again and never show any in-app prompt. If granted, all subsequent fires skip straight to sending.
- **FR-10 (fire).** A granted fire calls `sendNotification({ title: 'francois', body: notificationBody(name, status), extra: { sessionId }, id })` (§5). The body is exactly `"<name> · <reason>"` where reason is `turn finished` (idle) / `error` / `done` per `NOTIFY_REASON`. `id` is a module-scoped incrementing integer used to correlate the click (FR-12).
- **FR-11 (name resolution).** The `<name>` in the body comes from the session cache (`useStore.getState().sessions.find(s => s.id === sessionId)?.name`). If the session is not (yet) in the cache, fall back to `'session'`.
- **FR-12 (click-to-focus).** A registered click handler (`onAction`) resolves the notification's `extra.sessionId`; if present and known, it selects that session (`setActiveSessionId(sessionId)`, `setFocusedPane('main')`, `setMainTab('session')`) and calls `getCurrentWindow().setFocus()`. If the payload is missing (platform did not round-trip `extra`), it falls back to the **last-notified** session id; if that too is unresolvable, it just calls `setFocus()` to bring the app forward. This is **best-effort** — see §5/§7 for the desktop platform limitation.
- **FR-13 (toggle control).** The status bar renders a single clickable control bound to `notificationsEnabled`: `◈ notify` (accent) when on, `◇ notify` (faint) when off. Clicking flips it via `setNotificationsEnabled(!on)`.
- **FR-14 (persistence).** `setNotificationsEnabled` persists the value to `localStorage[NOTIFICATIONS_ENABLED_KEY]` as `'1'`/`'0'`; the store initializes from that key at startup, defaulting to **on** when the key is absent or unreadable.
- **FR-15 (no re-fire on repeated snapshots).** Repeated `session.meta`/`session.status` events carrying the same status do not re-fire (the map's previous value already equals `nextStatus`, so FR-6's `previous === 'running'` guard is false).
- **FR-16 (no startup false-fire).** Sessions reloaded at startup arrive `idle` as their first observed status (previous `undefined`), so FR-6 does not fire for them.
- **FR-17 (no new IPC).** This feature adds **no** Tauri command and **no** new `SessionEvent` member. It only consumes the existing stream and calls the notification plugin's JS API.

## 5. API contract

The wire boundary is **unchanged**: there is **no new IPC command** and **no new
`SessionEvent` member**. This feature *consumes* three existing members of the
`SessionEvent` union on `francois://session/event` (defined in
`contract/common.ts`, emitted by session-engine) and calls the
`tauri-plugin-notification` JS API. The only new file is `contract/notifications.ts`
(tiny frontend-only vocabulary + helpers) plus the runtime module `src/notifications.ts`.

### Consumed events (from `contract/common.ts` — do not redefine)

| Member | Derives `(sessionId, nextStatus)` as |
|---|---|
| `{ type: 'session.status'; sessionId; status }` | `(sessionId, status)` |
| `{ type: 'session.meta'; meta }` | `(meta.id, meta.status)` |
| `{ type: 'session.error'; sessionId; error }` | `(sessionId, 'error')` |

All other `SessionEvent` members are ignored. The three above are unified through
the same map (FR-6), so a `session.error` followed by a `session.meta` carrying
`status: 'error'` fires at most once (whichever arrives first sees
`previous === 'running'`; the second sees `previous === 'error'`).

### Build wiring (FR-1..FR-4)

```toml
# src-tauri/Cargo.toml — [dependencies]
tauri-plugin-notification = "2"
```

```rust
// src-tauri/src/main.rs — builder chain (add next to the existing dialog plugin)
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())   // NEW
    // …unchanged: .manage(...), .setup(...), .invoke_handler(...)
```

```json
// src-tauri/capabilities/default.json — permissions (add one entry)
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-title",
    "core:window:allow-set-focus",
    "core:path:default",
    "dialog:default",
    "notification:default"
  ]
}
```

> Note: `core:window:allow-set-focus` is listed because click-to-focus calls
> `getCurrentWindow().setFocus()` (FR-12). If app-shell has not already granted it,
> this feature adds it; if it is already present, leave it. `notification:default`
> is the plugin's default permission set and grants the JS calls below.

```json
// package.json — dependencies (FR-4)
"@tauri-apps/plugin-notification": "^2"
```

### `tauri-plugin-notification` JS API surface used

Imported from `@tauri-apps/plugin-notification`:

```ts
// Permission (FR-9)
isPermissionGranted(): Promise<boolean>;
requestPermission(): Promise<'granted' | 'denied' | 'default'>;

// Fire (FR-10) — fire-and-forget; returns void
sendNotification(options: {
  title: string;
  body?: string;
  extra?: Record<string, unknown>;  // we carry { sessionId } here
  id?: number;                       // correlation id for the click handler
  icon?: string;                     // omitted in v1 → OS uses the app icon
}): void;

// Click-to-focus (FR-12) — resolves to a handle with .unregister()
onAction(cb: (notification: { id?: number; extra?: Record<string, unknown> }) => void):
  Promise<{ unregister: () => void }>;
```

**Desktop limitation (documented, not a bug).** `onAction` and the `extra`
payload round-trip are fully supported on mobile; on desktop (Windows/macOS/Linux)
delivery of a plain body-click and its `extra` payload is **not guaranteed** across
all platforms for `sendNotification`-created notifications. FR-12 is therefore
best-effort: (a) if the platform delivers the click *with* `extra.sessionId`, we
route to the exact session; (b) if it delivers the click *without* payload, we
route to the **last-notified** session; (c) if it delivers nothing, the OS default
(usually focusing the app) applies and the session selection simply doesn't change.
We never depend on the click firing for correctness — the notification's job (the
ping) is done at `sendNotification`.

### `contract/notifications.ts` (new — authored at /build)

```ts
// contract/notifications.ts — desktop notifications for background sessions.
// Authored from specs/notifications.md §5. Frontend-only feature: there is NO
// core boundary to mirror and NO IPC channel of our own. This file imports the
// shared vocabulary from common.ts and never redefines it; it consumes existing
// SessionEvent members and exposes the tiny shared constants/helpers the runtime
// module (src/notifications.ts) and the status-bar control both use.

import type { SessionId, SessionStatus, SessionEvent } from './common';

/** The session statuses that fire a background notification (idle = a turn just finished). */
export type NotifyStatus = Extract<SessionStatus, 'idle' | 'error' | 'done'>;

/** Reason phrase shown in the notification body, keyed by trigger status. */
export const NOTIFY_REASON: Record<NotifyStatus, string> = {
  idle: 'turn finished',
  error: 'error',
  done: 'done',
};

/** Build the OS notification body: "<session name> · <reason>" (FR-10). */
export function notificationBody(sessionName: string, status: NotifyStatus): string {
  return `${sessionName} · ${NOTIFY_REASON[status]}`;
}

/** Notification title — the stable app identity, so pings group as "francois". */
export const NOTIFICATION_TITLE = 'francois';

/** localStorage key for the global enable toggle (v1 persistence, FR-14). */
export const NOTIFICATIONS_ENABLED_KEY = 'francois:notifications:enabled';

/** Type guard: is this status a notify trigger? */
export function isNotifyStatus(s: SessionStatus): s is NotifyStatus {
  return s === 'idle' || s === 'error' || s === 'done';
}

// Consumed from common.ts SessionEvent — no members added:
//   'session.status' | 'session.meta' | 'session.error'
export type { SessionEvent, SessionId, SessionStatus };
```

### Runtime module `src/notifications.ts` (public surface)

Frontend-only, mirrors the pattern of `src/shellStore.ts`/`src/palette.ts`
(runtime functions documented in the contract, implemented in `src/`):

```ts
// Called once from App's mount effect (FR-5). Idempotent.
export function initNotifications(): void;

// Click-to-focus handler target (FR-12) — exported for testing; wired internally by init.
export function focusSession(sessionId: SessionId | null): void;
```

The enabled flag lives in the shared store (below), so both the firing module
(`useStore.getState().notificationsEnabled`) and the status-bar control
(`useStore(s => s.notificationsEnabled)`) read the same source of truth.

### Store additions (`src/store.ts`)

```ts
// AppState — new slice (initialized from localStorage; default on, FR-14)
notificationsEnabled: boolean;
setNotificationsEnabled: (on: boolean) => void;   // updates state AND writes localStorage
```

Initialization reads `localStorage[NOTIFICATIONS_ENABLED_KEY]`; absent/unreadable → `true`.
`setNotificationsEnabled(on)` sets the state and writes `'1'`/`'0'` back.

**No new error codes.** All calls are frontend JS-API calls that resolve locally;
a denied permission or a plugin error is handled by silently no-oping (FR-9, §7).

## 6. Data & state

**Frontend runtime (module-local, in `src/notifications.ts`):**
- `lastStatus: Map<SessionId, SessionStatus>` — previous status per session, for transition detection (FR-6). Transient; rebuilt from the event stream, never persisted.
- `permission: 'unknown' | 'granted' | 'denied'` — cached OS permission outcome (FR-9). Starts `'unknown'`; set on first fire. Once `'denied'`, no further `requestPermission()` and no fires.
- `nextId: number` — incrementing notification id (FR-10), used as the `extra`-less fallback correlation.
- `lastNotifiedSessionId: SessionId | null` — the most recently notified session, used as the click-to-focus fallback when the platform delivers a click without payload (FR-12).
- `initialized: boolean` — guards `initNotifications()` idempotency (FR-5).

**Shared store (`src/store.ts`):**
- `notificationsEnabled: boolean` — the single global toggle. Read by the firing module (via `getState()`) and the status-bar control (reactively). Persisted to localStorage (FR-14).

**Persistence:** exactly one localStorage key, `francois:notifications:enabled`
(`'1'`/`'0'`). Default on. No core-side persistence, no database, no file. (A move
to a real settings store is a named follow-up — §7.)

**Derived / not stored:** the session name in the body is read live from the
session cache at fire time (FR-11); the reason phrase is a pure function of the
trigger status (`NOTIFY_REASON`).

**Ownership boundary:** the session cache (`sessions`) and `activeSessionId` are
owned by sessions-sidebar/app-shell; this feature only *reads* them. It *adds* the
`notificationsEnabled` slice. It never mutates session data.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| Session finishes a turn while it is the active/on-screen session | No notification (FR-7 active gate). |
| Session finishes a turn while a *different* session is active | Notification fires: `"<name> · turn finished"` (FR-6/7/10). |
| Toggle is off | Nothing fires (FR-8). Transition detection still runs so the `lastStatus` map stays correct for when it is re-enabled. |
| First-ever fire, user allows permission | Notification shows; permission cached `granted`; later fires skip the prompt (FR-9). |
| First-ever fire, user denies permission | No notification; `permission = denied`; **never** prompts again this session and shows no in-app nag (FR-9). |
| Permission was granted in an earlier run | `isPermissionGranted()` returns true on first fire → fire immediately, no prompt. |
| App restart with several persisted (idle) sessions | No pings — each session's first observed status is `idle` (previous `undefined`), not a `running → idle` transition (FR-16). |
| Rapid duplicate `session.meta`/`session.status` with same status | Fires at most once; repeats see `previous === next`, guard fails (FR-15). |
| `session.error` and a `session.meta{status:'error'}` for the same failure | Fires once — unified map dedupes (§5). |
| Session removed right after finishing | If the notification already fired, it stays in the OS tray; clicking it resolves to an unknown session id → falls back to focusing the window only (FR-12). |
| Click delivered without `extra` payload (desktop limitation) | Route to `lastNotifiedSessionId`; if null, just `setFocus()` (FR-12). |
| Click not delivered at all (platform doesn't support body-click) | Notification still served its purpose; OS default (app focus) applies; selection unchanged. Documented limitation, not an error. |
| Session name not yet in the cache at fire time | Body uses `'session'` as the name (FR-11). |
| Notification is active but the session is now the active one | The OS notification is OS-owned and not retracted; harmless — clicking it just re-selects the already-active session. |
| localStorage unavailable/throws | Reads default to on; writes are wrapped and swallowed — the in-memory toggle still works for the session (FR-14). |
| `sendNotification` throws (plugin/OS failure) | Caught and swallowed — a failed ping never breaks the event handler or the app. |
| Many background sessions settle at once | One notification each (no coalescing in v1); acceptable — grouping is a non-goal. |

## 8. Design brief

Almost all of this feature is invisible (the notification is **OS-rendered** — not
styleable in-app; only its title/body/icon are controllable). The only in-app UI is
the **status-bar toggle**.

### Screens / regions
- **Status bar** — the full-width bar at `gridRow: 2` of the app shell (`App.tsx`), background `#16171c`, `1px solid #24262d`, `border-radius: 5px`, base text `#6b7079`, font 10.5px JetBrains Mono. Reference `Claude Terminal.dc.html` bottom status strip. The toggle sits in the **right cluster**, immediately after the `⌘K commands` control and before the flex spacer / `focus:` readout.

### Component — `notify` toggle
A single inline, clickable `<span>` (cursor pointer), matching the existing status-bar item rhythm (glyph + label, gap `16px` from neighbors):
- **On (default):** glyph `◈` (filled diamond) in accent `#c8a15a`, followed by label `notify` in dim `#868a93`.
- **Off:** glyph `◇` (hollow diamond) in faint `#565a63`, label `notify` also faint `#565a63`.
- `title` attribute (native tooltip): *"OS notifications when a background session needs you"*.

### States
- **on** — `◈ notify`, accent glyph. **off** — `◇ notify`, faint. **hover** (either state) — label brightens to hint `#a9adb6`; glyph unchanged; no background change. No focused/disabled/loading states; it is always interactive.

### Interactions
- **Click** anywhere on the span → `setNotificationsEnabled(!notificationsEnabled)`; the glyph/label swap is immediate. No confirmation, no modal.
- No keyboard shortcut in v1 (kept minimal; the command-palette could later register a `toggle-notifications` command — out of scope here).

### Visual notes
- Tokens: accent `#c8a15a`, dim `#868a93`, faint `#565a63`, hover hint `#a9adb6`. Font 10.5px, weight 400, JetBrains Mono, letter-spacing as the surrounding status bar. Glyphs `◈`/`◇` (U+25C8 / U+25C7). No animation, no pulse, no blink — a static state indicator.

### Resize / responsive
- The status bar is a single flex row; the toggle keeps its natural width and never wraps. If the bar is ever too narrow, the flex spacer (`flex: 1`) absorbs the shortfall before any status item; the toggle is short enough (`◈ notify`) to remain visible at all supported widths.

### OS notification content (not styleable — reference only)
- **Title:** `francois` (`NOTIFICATION_TITLE`) — a stable identity so pings group under the app name.
- **Body:** `"<session name> · <reason>"` — e.g. `explorer · turn finished`, `api-refactor · error`, `nightly-build · done`. The `·` is U+00B7 to match the app's separators.
- **Icon:** the app's bundled icon (from `tauri.conf.json`); `Options.icon` is omitted in v1. The OS renders the surface (system font, system chrome) — Francois cannot theme it.

## 9. Acceptance criteria

- [ ] When a session transitions `running → idle` while a **different** session is active, an OS notification fires with body `"<name> · turn finished"` (FR-6/7/10).
- [ ] The same holds for `→ error` (`"<name> · error"`) and `→ done` (`"<name> · done"`) transitions of a non-active session (FR-6/10).
- [ ] A session that finishes while it **is** the active session fires **no** notification (FR-7).
- [ ] With the toggle **off**, no notification fires for any transition; turning it back **on** resumes firing on the next transition (FR-8).
- [ ] On the first fire, OS permission is requested exactly once; if denied, no notification appears then or later and no further prompt is ever shown (FR-9).
- [ ] After an app restart, reloaded (`idle`) sessions produce **no** notifications on startup (FR-16).
- [ ] Repeated identical status events for a session do not produce duplicate notifications; a `session.error` + `session.meta{error}` pair fires at most once (FR-15, §5 dedupe).
- [ ] Clicking a notification brings Francois to the foreground and selects the notified session (where the platform delivers the click + payload); when payload is absent it selects the last-notified session; when the click isn't delivered, at minimum the app is not broken (FR-12, best-effort documented).
- [ ] The status bar shows a `◈ notify` (on) / `◇ notify` (off) control that toggles on click and persists across restarts via `localStorage['francois:notifications:enabled']`, defaulting to **on** (FR-13/14, §8).
- [ ] `tauri-plugin-notification` is added to `Cargo.toml`, registered in `main.rs` via `.plugin(tauri_plugin_notification::init())`, granted `notification:default` in `capabilities/default.json`, and used from the frontend via `@tauri-apps/plugin-notification`; `getCurrentWindow().setFocus()` is permitted (`core:window:allow-set-focus`) (FR-1..FR-4, §5).
- [ ] **No** new IPC command and **no** new `SessionEvent` member are introduced; the feature only consumes `session.status` / `session.meta` / `session.error` (FR-17, §5).

## Remediation

(Empty until a review returns findings.)
