---
id: notifications
title: Desktop notifications — blocked turns and finished turns
status: shipped
created: 2026-08-01
depends_on: [app-shell, session-engine, session-questions, permission-guardrails, command-palette]
design_files: [https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Notifications.dc.html]
reviewed_base: 8ad40dc0b79aa6be8e66d2ae79e671a43f5e0f96
reviewed_digest: c2c2021716a5f37c
---

# Desktop notifications — blocked turns and finished turns

## 1. Summary

Francois runs several Claude Code workstreams at once but shows one session at a
time, so a session that **needs you** — parked on an approval card or a question —
can sit blocked indefinitely while you work elsewhere, and a session that
**finished its turn** goes unnoticed until you click back to it. This feature fires
an **OS desktop notification** for both classes: `attention` (a turn parked on
`permission.asked` / `question.asked`) and `turnDone` (a turn settled to
`idle`/`error`/`done`). The two classes are gated differently on purpose — a
blocked turn always pings, because nothing progresses until you act, while a
finished turn pings only when you are not looking at it. Clicking a notification
raises Francois and selects that session. Each class has its own on/off toggle
(palette commands, persisted; default on), and the status bar shows a dim `muted`
chip only while one is off. Almost entirely frontend: a module subscribes to the
existing `francois://session/event` stream and calls the official
**`tauri-plugin-notification`** JS API. **No new IPC command and no new
`SessionEvent` member.**

## 2. Goals & non-goals

- **Goals**:
  - **Attention class** — fire on `permission.asked` (body names the tool) and `question.asked`, **unconditionally** while enabled: a blocked turn is worth a ping even if that session is on screen.
  - **Turn-done class** — fire on a `running → idle | error | done` transition, but only when that session is **not** the active one **or** the app window is **unfocused**.
  - Name the session and the reason in the body (§5 `notificationBody`).
  - Request OS permission lazily on the first fire; if denied, silently no-op forever (no nagging, no in-app prompt).
  - Click-to-focus: raise + unminimize the window and select the notified session (best-effort payload routing, §5).
  - Two independent toggles (`attention`, `turnDone`), default **on**, persisted to localStorage; flipped from the command palette; a `◇ muted` status-bar chip appears only while at least one is off.
  - Wire `tauri-plugin-notification`: Cargo dep, `main.rs` registration, capability grants, JS dep — **no IPC of our own**.
  - Never double-fire the same ask or the same transition, and never fire on app startup for restored sessions.
- **Non-goals** (elsewhere / later):
  - In-app toasts/banners — strictly **OS-level** notifications here.
  - Per-session mute, quiet hours, notification categories/channels, sound customization, badges, grouping/threading, action buttons beyond a plain click.
  - Retracting a notification when its ask is resolved elsewhere (e.g. from remote-control) — not reliably supported on desktop; documented in §7.
  - Notifying on turn *start*, tool events, subagent/workflow events, or context-limit warnings.
  - Persisting the toggles in the Rust core / a real settings store — localStorage matches `layoutStore`'s existing convention.
  - Styling the notification surface — OS-rendered; only title/body/icon are ours.

## 3. User stories / flows

1. **Blocked on approval.** `api-refactor` hits a gated `Bash` call while you read
   `explorer`. A notification appears: **"api-refactor · needs approval: Bash"**.
   You click it — Francois raises, the sidebar and SESSION tab switch to
   `api-refactor`, and the approval card is right there.

2. **Blocked while you're looking at it, in another app.** You alt-tab to a browser
   while `api-refactor` — the active session — runs. It asks a question. You still
   get **"api-refactor · needs an answer"**, because attention pings are
   unconditional (FR-7). Nothing progresses until you answer.

3. **Background turn finishes.** You kick off a long turn in `api-refactor`, switch
   to `explorer`. When it settles you get **"api-refactor · turn finished"**.

4. **Looking right at it.** The active session finishes a turn while Francois is
   focused and on screen. **No notification** — you can see it (FR-8).

5. **Alt-tabbed away.** Same as (4) but Francois is in the background. The
   notification **does** fire, because the window is unfocused (FR-8).

6. **First-run permission.** The first time a notification would fire, the OS
   permission prompt appears. Deny it and nothing shows now or ever — the app never
   asks again and never nags in-app (FR-10).

7. **Silence the noise.** Turn-finished pings feel chatty during a focused stretch.
   `⌘K` → *Notifications: turn finished* → off. A dim `◇ muted` chip appears in the
   status bar so you know you are partially deaf. Approval/question pings keep
   coming. The setting survives a restart.

8. **Restart, no false pings.** You reopen Francois with several persisted sessions.
   They load as `idle`, a settle status — but it is the *first* status seen for each,
   not a `running → idle` transition, so **nothing fires** (FR-18).

## 4. Functional requirements

**Integration (build wiring — one-time)**

- **FR-1 (Cargo dep).** `src-tauri/Cargo.toml` gains `tauri-plugin-notification = "2"`.
- **FR-2 (plugin registration).** `src-tauri/src/main.rs` adds `.plugin(tauri_plugin_notification::init())` to the builder chain, next to the existing `tauri_plugin_dialog::init()` (`main.rs:36`).
- **FR-3 (capability grants).** `src-tauri/capabilities/default.json` gains `"notification:default"`, plus whichever of `"core:window:allow-set-focus"`, `"core:window:allow-unminimize"`, `"core:window:allow-is-focused"` `core:default` does not already grant (FR-9/FR-13 call all three).
- **FR-4 (JS dep).** `package.json` gains `"@tauri-apps/plugin-notification": "^2"`.

**Runtime module (`src/features/notifications/notifications.ts`)**

- **FR-5 (init once).** `initNotifications()` is called once from `App`'s mount effect, alongside `initShellEvents()` (`App.tsx:72`). It subscribes to `onSessionEvent`, starts window-focus tracking (FR-9), and registers the click handler (FR-13). Idempotent — a second call is a no-op.
- **FR-6 (trigger derivation).** `deriveTrigger(event, state)` maps a `SessionEvent` to a `NotifyTrigger | null` (§5):
  - `permission.asked` → `{ class:'attention', kind:'approval', sessionId, toolName: ask.toolName }`
  - `question.asked` → `{ class:'attention', kind:'question', sessionId }`
  - `session.status` / `session.meta` / `session.error` → derive `(sessionId, nextStatus)` per the §5 table, write it into `lastStatus`, and return `{ class:'turnDone', kind:'settle', sessionId, status: nextStatus }` **iff** the *previous* value was exactly `'running'` **and** `nextStatus ∈ {'idle','error','done'}`. A first sighting (previous `undefined`) never yields a trigger.
  - Every other member → `null`.
- **FR-7 (attention gate).** An `attention` trigger fires whenever `enabled.attention` is true. **No** active-session gate and **no** focus gate — a parked turn blocks everything until you act.
- **FR-8 (turn-done gate).** A `turnDone` trigger fires iff `enabled.turnDone` **and** (`sessionId !== activeSessionId` **or** the window is unfocused).
- **FR-9 (focus tracking).** The module tracks window focus via `getCurrentWindow().onFocusChanged(...)`, seeded once with `isFocused()`. If either call rejects, focus is treated as **`true`** (focused) — the conservative default, so a broken focus API degrades to the old active-session-only behaviour rather than pinging on every turn.
- **FR-10 (permission, lazy + once).** On the first fire that passes FR-7/FR-8: if `isPermissionGranted()` is false, call `requestPermission()` exactly once and cache the outcome. If it is not `'granted'`, no notification ever fires again and `requestPermission()` is never called again. No in-app nag in any case.
- **FR-11 (fire).** A granted fire calls `sendNotification({ title: NOTIFICATION_TITLE, body: notificationBody(name, trigger), extra: { sessionId }, id })` where `id` is a module-scoped incrementing integer. `sendNotification` is wrapped — a throw is swallowed and never breaks the event handler.
- **FR-12 (name resolution).** `name` is `useSessionsStore.getState().sessions.find(s => s.id === sessionId)?.name`, falling back to `'session'` when the session is not yet cached.
- **FR-13 (click-to-focus).** The `onAction` handler resolves `extra.sessionId`; if absent it falls back to `lastNotifiedSessionId`. With a resolvable id it calls `setActiveSessionId(id)`, `setFocusedPane('main')`, `setMainTab('session')`. In every case it calls `unminimize()` then `setFocus()`. Best-effort — see §5's desktop limitation.
- **FR-14 (ask dedupe).** A `blockId` already present in the module's `seenAsks` set never fires again. This makes a replayed or re-emitted `permission.asked` / `question.asked` (session hydration, resume) idempotent. `permission.resolved` / `question.resolved` do **not** clear the entry — a resolved ask must never re-ping.
- **FR-15 (no re-fire on repeated snapshots).** Repeated `session.meta` / `session.status` carrying an unchanged status yield no trigger — the previous value already equals `nextStatus`, so FR-6's `previous === 'running'` guard is false.
- **FR-16 (no startup false-fire).** Sessions restored at startup arrive `idle` as their first observed status, so FR-6 yields nothing for them.
- **FR-17 (toggles + persistence).** `useNotificationsStore` (`src/lib/notificationsStore.ts`) holds `enabled: Record<NotifyClass, boolean>` and `setNotifyEnabled(cls, on)`. Each class persists to its own localStorage key (§5), `'1'`/`'0'`, default **on** when the key is absent, malformed, or unreadable. Reads and writes are wrapped so a restricted storage environment degrades silently (the `layoutStore.ts:14-32` pattern).
- **FR-18 (palette commands).** Two commands registered in `paletteCommands.ts`: `toggle-notify-attention` (*"Notifications: approvals & questions"*) and `toggle-notify-turn-done` (*"Notifications: turn finished"*). Each `hint()` reads the current value and reads `on` / `off`; `run()` flips it.
- **FR-19 (muted chip).** The status bar renders a single dim chip **only when at least one class is off**: `◇ muted` when one is off, `◇ muted (all)` when both are. Its `title` names which classes are silenced. Clicking it opens the command palette. When both classes are on it renders **nothing** — zero added chrome in the default state.
- **FR-20 (no new IPC).** This feature adds no Tauri command and no `SessionEvent` member; it only consumes the existing stream and the plugin's JS API.

## 5. API contract

The wire boundary is **unchanged**. This feature consumes five existing members of
the `SessionEvent` union on `francois://session/event` (all declared in
`contract/common.ts`, emitted by session-engine / session-questions /
permission-guardrails) and calls the `tauri-plugin-notification` JS API. The only
new contract file is `contract/notifications.ts` — a frontend-only vocabulary with
no core counterpart to mirror.

### Consumed events (from `contract/common.ts` — never redefine)

| Member | Yields |
|---|---|
| `{ type:'permission.asked'; sessionId; blockId; ask: PermissionAsk }` | attention/approval, `toolName = ask.toolName` |
| `{ type:'question.asked'; sessionId; blockId; questions }` | attention/question |
| `{ type:'session.status'; sessionId; status }` | `(sessionId, status)` → settle check |
| `{ type:'session.meta'; meta }` | `(meta.id, meta.status)` → settle check |
| `{ type:'session.error'; sessionId; error }` | `(sessionId, 'error')` → settle check |

All other members are ignored. The three status sources feed **one** `lastStatus`
map, so a `session.error` followed by a `session.meta{status:'error'}` for the same
failure fires at most once (whichever arrives first sees `previous === 'running'`;
the second sees `previous === 'error'`).

> A turn parked on an ask stays `running` in the core (`session/commands/turn.rs:244`
> only writes `idle` at turn end), so an attention ping and a turn-done ping are
> never emitted for the same moment.

### Build wiring (FR-1..FR-4)

```toml
# src-tauri/Cargo.toml — [dependencies]
tauri-plugin-notification = "2"
```

```rust
// src-tauri/src/main.rs:36 — builder chain
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())   // NEW
```

```json
// src-tauri/capabilities/default.json — "permissions" gains:
"notification:default",
"core:window:allow-set-focus",
"core:window:allow-unminimize",
"core:window:allow-is-focused"
```

```json
// package.json — dependencies
"@tauri-apps/plugin-notification": "^2"
```

### `tauri-plugin-notification` JS API used

```ts
isPermissionGranted(): Promise<boolean>;
requestPermission(): Promise<'granted' | 'denied' | 'default'>;
sendNotification(options: {
  title: string; body?: string;
  extra?: Record<string, unknown>;   // we carry { sessionId }
  id?: number;                       // correlation id for the click handler
}): void;                            // fire-and-forget
onAction(cb: (n: { id?: number; extra?: Record<string, unknown> }) => void):
  Promise<{ unregister: () => void }>;
```

**Desktop limitation (documented, not a bug).** `onAction` and the `extra`
round-trip are guaranteed on mobile only; on desktop, delivery of a plain
body-click and its payload varies by platform for `sendNotification`-created
notifications. FR-13 is therefore best-effort: (a) click **with** payload → route
to that session; (b) click **without** payload → route to `lastNotifiedSessionId`;
(c) click never delivered → the OS default applies and selection is unchanged.
Correctness never depends on the click — the ping's job is done at
`sendNotification`.

### `contract/notifications.ts` (new — authored at /build)

```ts
// contract/notifications.ts — desktop notifications for blocked and finished
// turns. Authored from specs/notifications.md §5. Frontend-only: NO core
// boundary to mirror, NO IPC channel of our own. Imports the shared vocabulary
// from common.ts and never redefines it.

import type { SessionId, SessionStatus } from './common';

/** The two independently-toggleable notification classes (FR-7/FR-8/FR-17). */
export type NotifyClass = 'attention' | 'turnDone';

/** A settle status — the turn ended. */
export type SettleStatus = Extract<SessionStatus, 'idle' | 'error' | 'done'>;

/** What a consumed event resolved to, before gating (FR-6). */
export type NotifyTrigger =
  | { class: 'attention'; kind: 'approval'; sessionId: SessionId; toolName: string }
  | { class: 'attention'; kind: 'question'; sessionId: SessionId }
  | { class: 'turnDone'; kind: 'settle'; sessionId: SessionId; status: SettleStatus };

/** Notification title — a stable identity so pings group under the app name. */
export const NOTIFICATION_TITLE = 'Francois';

/** Reason phrase for a settled turn, keyed by status. */
export const SETTLE_REASON: Record<SettleStatus, string> = {
  idle: 'turn finished',
  error: 'error',
  done: 'done',
};

/**
 * The OS notification body: "<session name> · <reason>" (FR-11).
 *  approval → "api-refactor · needs approval: Bash"
 *  question → "api-refactor · needs an answer"
 *  settle   → "api-refactor · turn finished" | "· error" | "· done"
 * The separator is U+00B7, matching the app's separators. The ask summary and
 * tool input are deliberately NOT included — they would leak command text and
 * paths into the OS notification history.
 */
export function notificationBody(sessionName: string, t: NotifyTrigger): string {
  const reason =
    t.kind === 'approval' ? `needs approval: ${t.toolName}`
    : t.kind === 'question' ? 'needs an answer'
    : SETTLE_REASON[t.status];
  return `${sessionName} · ${reason}`;
}

/** Type guard: does this status end a turn? */
export function isSettleStatus(s: SessionStatus): s is SettleStatus {
  return s === 'idle' || s === 'error' || s === 'done';
}

/** localStorage keys for the per-class toggles (FR-17). Absent ⇒ on. */
export const NOTIFY_ENABLED_KEYS: Record<NotifyClass, string> = {
  attention: 'francois.notify.attention',
  turnDone: 'francois.notify.turnDone',
};

/** Palette + chip label for each class (FR-18/FR-19). */
export const NOTIFY_CLASS_LABEL: Record<NotifyClass, string> = {
  attention: 'approvals & questions',
  turnDone: 'turn finished',
};
```

### Runtime module surface (`src/features/notifications/notifications.ts`)

The two gate functions are **pure and exported**, so the whole rule set is unit
testable with no DOM and no Tauri (§Testing in PIPELINE.md):

```ts
export interface DeriveState { lastStatus: Map<SessionId, SessionStatus>; seenAsks: Set<BlockId> }
export interface GateContext {
  enabled: Record<NotifyClass, boolean>;
  activeSessionId: SessionId | null;
  windowFocused: boolean;
}

/** FR-6/FR-14 — maps an event to a trigger, mutating `state`. Pure otherwise. */
export function deriveTrigger(e: SessionEvent, state: DeriveState): NotifyTrigger | null;

/** FR-7/FR-8 — the complete gating rule. */
export function shouldFire(t: NotifyTrigger, ctx: GateContext): boolean;

/** Called once from App's mount effect (FR-5). Idempotent. */
export function initNotifications(): void;
```

### Store (`src/lib/notificationsStore.ts`, new)

```ts
enabled: Record<NotifyClass, boolean>;          // seeded from localStorage; default on
setNotifyEnabled: (cls: NotifyClass, on: boolean) => void;  // sets state AND persists
```

**No new error codes.** Every call resolves locally; a denied permission or a
plugin throw is handled by silently no-oping (FR-10/FR-11).

## 6. Data & state

**Module-local (`src/features/notifications/notifications.ts`), all transient:**
- `lastStatus: Map<SessionId, SessionStatus>` — previous status per session (FR-6).
- `seenAsks: Set<BlockId>` — ask blockIds already notified (FR-14). Never cleared.
- `permission: 'unknown' | 'granted' | 'denied'` — cached OS outcome (FR-10).
- `windowFocused: boolean` — seeded from `isFocused()`, updated by `onFocusChanged` (FR-9). Defaults `true`.
- `nextId: number` — incrementing notification id (FR-11).
- `lastNotifiedSessionId: SessionId | null` — click fallback (FR-13).
- `initialized: boolean` — idempotency guard (FR-5).

**Store (`src/lib/notificationsStore.ts`):** `enabled` — read by the firing module
via `getState()` and reactively by the palette hints and the muted chip.

**Persistence:** exactly two localStorage keys, `francois.notify.attention` and
`francois.notify.turnDone` (`'1'`/`'0'`), both defaulting to on. No core-side
persistence, no file, no DB.

**Read-only dependencies:** `sessions` and `activeSessionId` (sessionsStore),
`setFocusedPane`/`setMainTab` (store). This feature never mutates session data.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| Approval/question asked while that session is active and focused | **Fires** — attention pings are unconditional (FR-7). A card on screen plus a ping is the accepted trade for never missing a blocked turn. |
| Same ask re-emitted (hydration, resume, duplicate event) | Fires once — `seenAsks` dedupes on `blockId` (FR-14). |
| Ask resolved from remote-control / the phone | The OS notification stays in the tray; it is not retracted (desktop plugins do not reliably support withdrawal). Clicking it just selects the session. Non-goal. |
| Turn settles on the active session while the window is focused | No notification (FR-8). |
| Turn settles on the active session while the window is unfocused | Fires (FR-8). |
| Turn settles on a non-active session | Fires, focused or not (FR-8). |
| `onFocusChanged` / `isFocused()` unavailable or rejects | `windowFocused` stays `true`; behaviour degrades to the active-session-only gate (FR-9) — never to over-notifying. |
| A class is toggled off | Nothing fires for that class. `deriveTrigger` still runs, so `lastStatus`/`seenAsks` stay correct for when it is re-enabled (FR-6). |
| First-ever fire, permission allowed | Notification shows; cached `granted`; later fires skip the prompt (FR-10). |
| First-ever fire, permission denied | Nothing shows now or later; never prompts again; no in-app nag (FR-10). |
| Permission granted in an earlier run | `isPermissionGranted()` is true on first fire → fire with no prompt. |
| App restart with restored `idle` sessions | No pings — first observed status, not a transition (FR-16). |
| Repeated identical status events | At most one fire (FR-15). |
| `session.error` + `session.meta{status:'error'}` for one failure | Fires once — one unified map (§5). |
| Session removed right after a fire | Notification stays in the tray; clicking resolves to an unknown id → window is raised, selection unchanged (FR-13). |
| Click delivered without `extra` | Routes to `lastNotifiedSessionId`; if null, raise the window only (FR-13). |
| Click never delivered (platform) | Documented limitation, not an error — the ping already did its job. |
| Session name not yet cached | Body uses `'session'` (FR-12). |
| localStorage unavailable or throws | Reads default to on; writes are swallowed; the in-memory toggles still work for the session (FR-17). |
| `sendNotification` throws | Caught and swallowed — a failed ping never breaks the event handler (FR-11). |
| Many sessions settle at once | One notification each; no coalescing in v1 (non-goal). |

## 8. Design brief

Nearly all of this feature is invisible — the notification is **OS-rendered**
(only title/body/icon are ours). The in-app surface is two palette commands and a
status-bar chip that appears **only while a class is muted**, so the default state
adds zero chrome to the bar design-refresh FR-10 deliberately condensed.

- **Muted chip** — right cluster of `.app-status-bar`, before `AccountChip`. Dim
  (`--text-faint`), glyph `◇` (U+25C7) + label `muted` / `muted (all)`; native
  `title` names the silenced classes; clicking opens the palette. Rendered only
  when at least one class is off.
- **Palette rows** — glyph `◈`, names *"Notifications: approvals & questions"* and
  *"Notifications: turn finished"*, hint reads `on` / `off`.
- **OS body copy** — `"<session> · needs approval: Bash"`, `"<session> · needs an
  answer"`, `"<session> · turn finished"`, `"· error"`, `"· done"`. Title `Francois`.

> full brief: `specs/design/notifications.md`

## 9. Acceptance criteria

- [x] `permission.asked` fires `"<name> · needs approval: <toolName>"` and `question.asked` fires `"<name> · needs an answer"` — **including** when that session is active and the window is focused (FR-6/FR-7/FR-11).
- [x] The same ask `blockId` seen twice fires exactly once (FR-14).
- [x] A `running → idle` transition on a **non-active** session fires `"<name> · turn finished"`; `→ error` and `→ done` fire their reasons (FR-6/FR-8/FR-11).
- [x] A turn settling on the **active** session fires **no** notification while the window is focused, and **does** fire while it is unfocused (FR-8/FR-9).
- [x] With `turnDone` off, no settle notification fires while approval/question pings keep working; turning it back on resumes firing on the next transition (FR-17).
- [x] On the first fire, OS permission is requested exactly once; if denied nothing fires then or later and no further prompt is ever shown (FR-10).
- [x] Reloaded (`idle`) sessions produce no notifications at startup (FR-16); repeated identical status events and a `session.error` + `session.meta{error}` pair fire at most once (FR-15, §5).
- [ ] Clicking a notification raises + unminimizes Francois and selects the notified session where the platform delivers the payload; without payload it selects the last-notified session; with no click delivery nothing breaks (FR-13). — **left open**: `deferred:notifications` MEDIUM finding (`specs/refactor-backlog.md`) — the removed-session sub-case doesn't yet skip selection.
- [x] Two palette commands toggle the classes, each hint showing `on`/`off`; both settings survive a restart via `francois.notify.attention` / `francois.notify.turnDone`, defaulting to on (FR-17/FR-18).
- [x] The status bar shows **nothing** when both classes are on, and a dim `◇ muted` / `◇ muted (all)` chip when one or both are off (FR-19).
- [ ] `deriveTrigger` and `shouldFire` are exported and covered by unit tests for every row of the §7 table that they own — no DOM, no Tauri mocking needed (§5). — **left open**: the removed-session §7 row has no test yet (same deferred finding).
- [x] `tauri-plugin-notification` is in `Cargo.toml`, registered in `main.rs`, granted in `capabilities/default.json` alongside the window focus/unminimize permissions, and used from `@tauri-apps/plugin-notification` (FR-1..FR-4).
- [x] **No** new IPC command and **no** new `SessionEvent` member are introduced (FR-20).

No `/smoke` ran this cycle; runtime/OS-level confirmation (actual notification delivery, click routing)
rests on the `/review` code-read + the unit-test suite, not a live run.

## Remediation

(Empty until a review returns findings. The one MEDIUM + one LOW from the 2026-08-01 review were
parked instead — see `specs/refactor-backlog.md` § `deferred:notifications`.)
