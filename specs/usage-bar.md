---
id: usage-bar
title: Usage bar — account plan limits under the system title bar
status: shipped
created: 2026-07-22
depends_on: [app-shell, session-engine, interactive-commands]
---

# Usage bar — account plan limits under the system title bar

## 1. Summary

A always-visible horizontal strip directly under the native window chrome, spanning the full window
width, that shows the user's **Claude plan usage limits** — the same meters the Claude Code CLI
returns for `/usage` (`Current session: 42% used · resets Jul 22, 5:29pm (Europe/Paris)`), rendered as
compact labelled bars. Usage limits are an **account-level** fact, not a session-level one: the bar is
owned by the `app` domain, refreshes on its own schedule, and is identical no matter which session is
selected. It exists so the user can see how close they are to a limit without interrupting a session
to type `/usage`, and so a session that suddenly stalls has a visible explanation.

The core already knows how to obtain and parse this data — `interactive-commands` spawns
`claude -p /usage` per session and parses meters with `parse_meter_line` / `usage_card`
(`src-tauri/src/session.rs:3798`). This feature lifts that parsing into a shared helper and adds an
**app-scoped** probe and cache alongside it. The existing `/usage` transcript card is unchanged.

## 2. Goals & non-goals

**Goals**

- One app-level source of truth for plan-limit meters, cached in the Rust core and pushed to the
  frontend by event.
- A persistent bar that renders every meter the CLI returns, with a threshold color and the reset
  time available on hover.
- Automatic refresh (startup, interval, after a turn ends) plus an explicit manual refresh, without
  ever spawning more than one probe at a time.
- Degrade quietly: a missing CLI, an unauthenticated user, a timeout, or a drifted output format
  must never blank the app, throw, or produce a modal.

**Non-goals**

- **Per-session usage** — that is `/usage` in the transcript (`interactive-commands`), which stays as
  is. This bar never renders into a transcript and never consumes a session's probe slot.
- **Cost in currency**, token counts, or historical charts. The CLI's meters are percentages; this
  feature displays exactly what it is given.
- **Threshold alerts / notifications** when usage crosses a limit. That belongs to `notifications`;
  this feature only colors the meter.
- **Context-window usage** — already shown per session in the main pane header (`ctx 26.4k/200k`).
- Changing the native window chrome. The bar sits *under* it; the caption stays a real OS caption.
- Showing the active session name in the bar. The native window title already reads
  `<session name> — Francois` (`src/App.tsx:89`); repeating it 28px below would be pure duplication.

## 3. User stories / flows

1. **Cold start.** User launches Francois. The bar renders immediately in its loading state (label
   placeholders, no meters). The core fires a probe during setup; within a few seconds the meters
   populate. No layout shift — the bar's height is fixed whether or not it has data.
2. **Passive monitoring.** User works in a session for an hour. The bar refreshes every 5 minutes and
   ~15s after each turn finishes; the user notices `Current week (all models)` cross 80% and turn
   red without ever having asked for it.
3. **Manual refresh (mouse).** User clicks anywhere in the bar's meter region. If no probe is in
   flight, one starts: meters dim to their stale state and restore when fresh data lands. If a probe
   is already running the click is a no-op (the meters are already dimmed, so the UI is honest).
4. **Manual refresh (keyboard).** No dedicated key. The command palette (`⌘K`) gains a
   `Refresh usage limits` command that invokes the same channel, so the flow is reachable without a
   mouse. Focus never moves to the bar — it is not a focusable pane and `1`–`5` are unaffected.
5. **Hovering a meter.** User hovers `Current session 42%`. A native `title` tooltip shows the full
   label and `resets Jul 22, 5:29pm (Europe/Paris)` — the reset text is too long to sit inline
   without crowding out the other meters.
6. **CLI missing.** User has no `claude` on PATH. The bar shows `usage unavailable` in error red;
   hovering gives the actionable message (`Claude Code CLI not found…`). Clicking retries. Every
   other part of the app is unaffected.
7. **Never authenticated.** `claude` runs but returns no answer. Same error presentation, message
   `Run 'claude' once in a terminal to authenticate.`
8. **Format drift.** A future CLI version changes the `/usage` wording so no line parses as a meter.
   Treated exactly like "no answer": error state, no crash, no partial garbage rendered.

## 4. Functional requirements

**Bar presence & layout**

- **FR-1**: The bar renders as the first child of the app root, above the existing content grid and
  below the native window chrome. It is always mounted — it does not depend on a session existing.
- **FR-2**: The bar has a fixed height (§8) in every state. Transitions between empty / loading /
  ready / error must not change the height or reflow the grid below it.
- **FR-3**: The bar is not a focusable pane. It is absent from the `1`–`5` pane cycle, takes no focus
  ring, and never captures keyboard input.

**Data acquisition (core)**

- **FR-4**: The core owns an app-scoped `UsageSnapshot` (§5) as the single source of truth. It is
  in-memory only — never persisted to disk. A snapshot from a previous run is worse than no data.
- **FR-5**: A probe spawns `claude -p /usage --output-format stream-json --verbose`, with **no**
  `--resume`, **no** `--model`, and **no** permission flags, in the user's home directory.
- **FR-6**: The probe always runs on the **native** runtime (`claude`, never `wsl.exe claude`).
  Plan limits are per-account, not per-machine, so there is no session whose runtime it should
  inherit. On a machine where `claude` exists only inside WSL, FR-16's error path applies.
- **FR-7**: At most **one** probe is in flight for the whole application. A refresh request arriving
  while a probe runs is a no-op and resolves `{ started: false }`.
- **FR-8**: A probe is killed after 30 seconds (the existing `PROBE_TIMEOUT_SECS`). As in
  `interactive-commands` FR-10 / Remediation R1, a fully-parsed answer read just before the kill wins
  over the timeout — `timed_out` only decides the outcome when nothing parsed.
- **FR-9**: The answer is parsed with the same meter grammar as `/usage`
  (`^(.+?): (\d+)% used · resets (.+)$`, `·` = U+00B7). Zero parsed meters is an **error**, not an
  empty success — unlike `/usage`, this bar has no raw-text fallback to render.
- **FR-10**: The probe process must not flash a console window (`CREATE_NO_WINDOW`, as
  `no_window` already does).

**Refresh policy**

- **FR-11**: A probe fires once during app setup, before any session exists.
- **FR-12**: A probe fires every **5 minutes** thereafter.
- **FR-13**: A probe fires **15 seconds** after any session transitions out of `running` (i.e. a turn
  ended, so usage moved). Multiple sessions finishing inside that window coalesce into one probe.
- **FR-14**: Automatic probes (FR-12, FR-13) are throttled to a **60-second floor** — an automatic
  trigger less than 60s after the last probe *started* is dropped. A **manual** refresh (FR-15)
  bypasses the floor but never bypasses FR-7.
- **FR-15**: `francois:app:refreshUsage` requests a probe. It resolves `{ started: boolean }` and
  never carries the result — the result always arrives as a `usage.state` event.
- **FR-16**: Every probe outcome updates the snapshot and emits exactly one `usage.state` event.
  Outcomes: success → `status: 'ready'`; spawn failure → `status: 'error'`, code `SPAWN_FAILED`;
  no answer / unauthenticated / timeout / zero parsed meters → `status: 'error'`, code
  `USAGE_UNAVAILABLE`.
- **FR-17**: Starting a probe emits a `usage.state` event with `status: 'loading'` **before** the
  spawn, so the frontend can show the stale-dim state without polling.

**Snapshot semantics**

- **FR-18**: `meters` holds the meters from the **last successful** probe and is **retained** across
  `loading` and `error`. It is `[]` only before the first success. A failed refresh must never erase
  data the user can still read.
- **FR-19**: `fetchedAt` is the epoch-ms timestamp of the last **successful** probe, `null` before
  the first one. It is not updated by a failed probe.
- **FR-20**: `error` is non-null **iff** `status === 'error'`, and is cleared on the next success.

**Rendering**

- **FR-21**: On mount the frontend calls `francois:app:getUsage` once to seed from the cache (so a
  reload does not wait for the next probe), then subscribes to `francois://app/event`. It
  unsubscribes on unmount.
- **FR-22**: `francois:app:getUsage` returns the cached snapshot and **never** triggers a probe.
- **FR-23**: The bar renders **every** meter in `meters`, in the order the core returned them, with
  no client-side filtering, reordering, or relabelling.
- **FR-24**: A meter's fill and percent use the `interactive-commands` threshold convention:
  `percentUsed < 80` → accent `#c8a15a`; `≥ 80` → error `#c46b62`. `percentUsed` is clamped to 0–100
  for the fill width only; the printed number is what the core sent.
- **FR-25**: `status: 'loading'` with a non-empty `meters` renders the meters at reduced opacity
  (§8) — **not** a spinner and **not** a placeholder. Per the note at the top of `src/styles.css`,
  this feature introduces **no looping animation**: the webview falls back to software compositing
  and a continuous animation in always-mounted chrome would burn CPU at idle forever.
- **FR-26**: `status: 'error'` renders a single one-line error affordance (§8) instead of meters when
  `meters` is empty; when `meters` is non-empty it renders the stale meters **plus** a compact error
  glyph, so existing data stays readable.
- **FR-27**: Clicking the meter region invokes `francois:app:refreshUsage`. The click is
  fire-and-forget: the UI reacts only to the resulting events, never to the ack.
- **FR-28**: The command palette registers `Refresh usage limits`, invoking the same channel (FR-15).
- **FR-29**: Each meter carries a native `title` tooltip: `` `${label} — resets ${resetsAt}` ``.
  Neither string is parsed, reformatted, or localized — `resetsAt` is verbatim CLI text.
- **FR-30**: The bar's **trailing slot** shows the cache freshness **and** the **session limit's
  reset countdown** — the limit that actually gates the next turn — joined by ` · ` (U+00B7, the
  separator the CLI itself uses between a meter's percentage and its reset), e.g.
  `updated 2m ago · resets in 4h 12m`. Rules:
  - The slot degrades to whichever half exists and is **never empty** — it is also the refresh
    click target, so it must always present a hit area. No meters → freshness alone. No successful
    probe yet (`fetchedAt === null`) → the reset alone, since pairing a live countdown with `never`
    would be self-contradictory. Neither → `never`.
  - The session meter is the first whose `label` matches `/session/i`, falling back to the first
    meter, so a renamed or single-meter plan still reads sensibly.
  - `resetsAt` is verbatim CLI free text with **no year**. Observed forms include
    `Jul 22, 5:29pm (Europe/Paris)`, `Jul 25, 11:00am`, bare `Jul 22`, and non-timestamps such as
    `soon`. Parsing must **degrade, never guess**: an unparseable value renders verbatim as
    `resets <resetsAt>`, never a wrong number and never dropped.
  - The parenthetical timezone is informational — the clock reading is already in the machine's
    local zone, so it parses as local time.
  - With no year in the text, the candidate year closest to `now` wins. Limits reset hours-to-days
    out, so this resolves a Dec→Jan boundary correctly in both directions.
  - Format: `resets in 3d 2h` / `resets in 4h 12m` / `resets in 47m`; under a minute or already
    past collapses to `resets now` — never a negative or a zero countdown.
  - The countdown's finest unit is the minute, which is exactly what the existing one-tick-per-minute
    text refresh provides. This introduces **no** new timer and no motion (FR-25 still holds).

## 5. API contract

Contract file: `contract/usage-bar.ts`. Shared vocabulary (`Result`, `AppError`, `ErrorCode`,
`UsageMeter`) is imported from `contract/common.ts` and never redefined — `UsageMeter` already exists
there (`common.ts:143`) and is reused as-is.

### 5.1 Channels

| logical channel | direction | request | success `data` | error codes |
|---|---|---|---|---|
| `francois:app:getUsage` | frontend → core (`invoke`) | `void` | `UsageSnapshot` | `INTERNAL` |
| `francois:app:refreshUsage` | frontend → core (`invoke`) | `void` | `UsageRefreshAck` | `INTERNAL` |
| `francois:app:event` | core → frontend (`listen`) | — | `AppEvent` (tagged union) | — |

Physical binding (PIPELINE §Conventions):

```
francois:app:getUsage      → invoke('app_get_usage')      → Promise<Result<UsageSnapshot>>
francois:app:refreshUsage  → invoke('app_refresh_usage')  → Promise<Result<UsageRefreshAck>>
francois:app:event         → listen('francois://app/event', e => …)   // e.payload: AppEvent
```

`francois://app/event` is a **new** event channel (the app domain had only `invoke` commands before).
It is deliberately a tagged union with one member today so later app-scoped events join it rather
than adding channels.

### 5.2 Types — `contract/usage-bar.ts`

```ts
// contract/usage-bar.ts — usage bar (app-scoped plan limits).
// Authored from specs/usage-bar.md §5. Imports shared vocabulary from common.ts;
// never redefines it. UsageMeter is the SAME type interactive-commands uses for
// the /usage card — the parse grammar is shared, so the shape must be too.

import type { AppError, UsageMeter } from './common';

/**
 * Lifecycle of the app-scoped usage cache.
 * - 'empty'   — no probe has ever succeeded and none is running.
 * - 'loading' — a probe is in flight. `meters` may still hold the previous result (FR-18).
 * - 'ready'   — the last probe succeeded; `meters` is non-empty.
 * - 'error'   — the last probe failed; `error` is set; `meters` may hold a stale result.
 */
export type UsageStatus = 'empty' | 'loading' | 'ready' | 'error';

/**
 * The app-scoped usage cache. In-memory in the core, never persisted (FR-4).
 * Invariants (FR-18/19/20):
 *   status === 'ready' → meters.length > 0 && fetchedAt !== null && error === null
 *   status === 'error' → error !== null
 *   status === 'empty' → meters.length === 0 && fetchedAt === null && error === null
 *   meters/fetchedAt are NEVER cleared by a failed probe.
 */
export interface UsageSnapshot {
  status: UsageStatus;
  /** Meters from the last successful probe, in the order the CLI emitted them. */
  meters: UsageMeter[];
  /** Epoch ms of the last SUCCESSFUL probe; null before the first one. */
  fetchedAt: number | null;
  /** Non-null iff status === 'error'. */
  error: AppError | null;
}

/** Ack for francois:app:refreshUsage — the result itself arrives as a usage.state event. */
export interface UsageRefreshAck {
  /** false when a probe was already in flight (FR-7). */
  started: boolean;
}

/** Payload of francois://app/event. Tagged union — one member today, extensible. */
export type AppEvent = { type: 'usage.state'; snapshot: UsageSnapshot };

/** FR-24 threshold — shared by the bar and any future meter renderer. */
export const USAGE_HIGH_THRESHOLD = 80;
```

### 5.3 `contract/common.ts` amendment

One value is added to the shared `ErrorCode` union (a type alias cannot be widened from a feature
file, and no feature contract in this repo declares its own codes):

```ts
export type ErrorCode =
  | …existing members…
  | 'USAGE_UNAVAILABLE' // usage bar: the CLI ran but returned no parseable meters
  | 'INTERNAL';
```

### 5.4 Error semantics

| condition | `status` | `error.code` | `error.message` |
|---|---|---|---|
| `claude` could not be spawned | `error` | `SPAWN_FAILED` | `Claude Code CLI not found. Install it and ensure 'claude' is on PATH.` |
| probe killed by the 30s watchdog, nothing parsed | `error` | `USAGE_UNAVAILABLE` | `Timed out fetching usage.` |
| probe exited, no answer text | `error` | `USAGE_UNAVAILABLE` | `The Claude Code CLI returned no answer. Run 'claude' once in a terminal to authenticate.` |
| answer present but zero lines parsed as meters | `error` | `USAGE_UNAVAILABLE` | `Could not read the usage response.` |

`INTERNAL` is reserved for a poisoned state lock; neither command has a domain failure of its own —
both always resolve `{ ok: true }` in practice, and the frontend logs `{ ok: false }` to the console
and takes no other action.

## 6. Data & state

**Core (Rust, `src-tauri/`)**

- New Tauri-managed state `UsageState`, held in its own `Mutex` and **not** inside `session::Engine`.
  This is deliberate: the recorded lock-ordering constraints around `Engine.sessions` are avoided
  entirely if the usage lock is a leaf that no session code ever takes while holding another lock.
  The usage probe thread must never acquire `Engine.sessions`.

  ```rust
  struct UsageState {
      snapshot: UsageSnapshot,     // mirrors the contract shape
      probe: Option<Child>,        // Some iff a probe is in flight (FR-7)
      last_started_at: u64,        // epoch ms, for the FR-14 throttle floor
  }
  ```

- `parse_meter_line` / `parse_meter_tail` and the stream-json answer extraction (`probe_answer`) move
  out of the `/usage`-card path into a shared location so both features use one grammar. Their
  existing unit tests move with them and must keep passing unchanged — the `/usage` card's behavior
  is not modified by this feature.
- The 5-minute ticker (FR-12) and the 15-second post-turn debounce (FR-13) are core-side timers, so
  the schedule survives a frontend reload and does not depend on a mounted component.
- Nothing is persisted. On startup the snapshot is `{ status: 'empty', meters: [], fetchedAt: null,
  error: null }` until FR-11's probe lands.

**Frontend (`src/`)**

- A `usage` slice in the existing zustand store (`src/store.ts`) holding one `UsageSnapshot`, plus a
  setter fed by the `francois://app/event` subscription. No derived state is stored — threshold color
  and fill width are computed at render.
- `src/api.ts` gains the two contract-typed wrappers (`appGetUsage`, `appRefreshUsage`) and the
  `onAppEvent` subscription helper, matching the existing wrapper idiom.
- A new `src/UsageBar.tsx` component, mounted by `src/App.tsx` as the first child of the app root.

## 7. Edge cases & errors

| # | situation | behavior |
|---|---|---|
| 1 | No `claude` on PATH | `SPAWN_FAILED` error state; bar shows the error affordance; click retries. Rest of the app unaffected. |
| 2 | `claude` exists only inside WSL | Same as #1 — FR-6 pins the probe to the native runtime by design. The message is accurate (the CLI is genuinely not on the host PATH). |
| 3 | User never authenticated | `USAGE_UNAVAILABLE` with the actionable "run `claude` once" message. |
| 4 | Probe exceeds 30s | Killed; if an answer was already fully parsed it wins (FR-8), else `USAGE_UNAVAILABLE` / `Timed out`. |
| 5 | CLI output format drifts | Zero meters parsed → `USAGE_UNAVAILABLE` (FR-9). Never render raw text in the bar. |
| 6 | Refresh clicked during a probe | Ack `{ started: false }`; no second spawn (FR-7); UI already dimmed, so no visible dead click. |
| 7 | Turn ends while a probe is in flight | The FR-13 debounce still schedules; when it fires FR-7/FR-14 drop it. Never queues a backlog. |
| 8 | Many sessions finish at once | One probe (FR-13 coalescing). |
| 9 | App quits mid-probe | The child is killed on `RunEvent::Exit` alongside the existing shell/session teardown. No orphan `claude` process. |
| 10 | Probe succeeds with meters the UI has never seen (new plan tier, 4+ meters) | Rendered as-is (FR-23). The bar's meter region scrolls nothing and truncates nothing; §8 pins the layout that must absorb it. |
| 11 | `percentUsed` > 100 (CLI over-report) | Fill width clamped to 100%; the printed number is verbatim (FR-24). |
| 12 | Event arrives after unmount | Subscription is torn down on unmount (FR-21); no setState on an unmounted component. |
| 13 | Frontend reloads (dev HMR) | `getUsage` reseeds from the core cache (FR-21/22) — no probe, no flicker back to `empty`. |

## 8. Design brief

### Screens / regions

One new full-width region: the **usage bar**, spanning the window between the native OS caption and
the existing content grid. It is new chrome — the mock (`Claude Terminal.dc.html`) has no usage
treatment, so the visual language is inherited from the app's own status bar (`src/App.tsx:392`) and
from the `/usage` meter rows already specified in `specs/interactive-commands.md` §8.

### Components

1. **Usage bar container** — full-width strip, fixed height.
2. **Meter chip** — one per `UsageMeter`: label + track/fill + percent. Repeats horizontally.
3. **Trailing label** — right-aligned `updated 2m ago · resets in 4h 12m`; doubles as the refresh
   affordance.
4. **Error affordance** — one-line `⚠ usage unavailable`, replaces the meter row when there is no
   stale data to show; shrinks to a bare `⚠` glyph beside stale meters when there is (FR-26).

### States

- **Container**: single state (always present, fixed height).
- **Meter chip**: normal (`< 80%`) / high (`≥ 80%`) / stale (parent is `loading`).
- **Trailing label**: both halves / freshness only / reset only / verbatim-unparseable reset / hover.
- **Error affordance**: full (no stale data) / compact glyph (stale data present).

### Visual notes (exact tokens; JetBrains Mono throughout)

**Container**: `height:28px; flex:0 0 28px; display:flex; align-items:center; justify-content:
space-between; gap:16px; padding:0 12px; background:#0f1015; border-bottom:1px solid #24262d;
font-size:10.5px;`. The background is the app-root shell color so there is **no seam** between the
tinted OS caption (also `#0f1015`, set via DWM in `src-tauri/src/main.rs`) and this bar — the two
read as one continuous surface.

**Meter region** (left): `display:flex; align-items:center; gap:18px; cursor:pointer; min-width:0;`.
Click target = the whole region (FR-27).

**Meter chip**: `display:flex; align-items:center; gap:7px; flex:0 0 auto;`
- Label: `color:#868a93; white-space:nowrap;` — verbatim `UsageMeter.label`.
- Track: `width:52px; height:4px; border-radius:2px; background:#24262d; overflow:hidden;`
- Fill: `height:100%; width:<clamped percentUsed>%;` `background:#c8a15a`, or `#c46b62` when
  `percentUsed >= 80`. **No transition, no animation** — renders at final width (FR-25).
- Percent: `color:#c8a15a` / `#c46b62` (matching the fill); `font-variant-numeric:tabular-nums;` so
  the strip does not jitter as the number changes width.
- `title` attribute: `` `${label} — resets ${resetsAt}` `` (FR-29).

**Stale (loading with data)**: the meter region gets `opacity:0.45`. Nothing else changes — no
spinner, no pulse, no skeleton (FR-25).

**Empty (`status: 'empty'`, first launch)**: meter region renders a single `usage —`
`color:#565a63;`. Fixed height is unchanged.

**Trailing label** (right): `color:#565a63; flex:0 0 auto; cursor:pointer;` — freshness
(`updated <n>m ago`, `just now` under 60s, or `never`) and the FR-30 session reset countdown
(`resets in 4h 12m`) joined by ` · `, e.g. `updated 2m ago · resets in 4h 12m`; degrades to
whichever half exists. `title` = `` `${label} — resets ${resetsAt} · click to refresh` `` when a
meter exists, else `click to refresh` — the countdown is rounded, so the tooltip keeps the CLI's
exact wording available. Hover → `color:#868a93`.

**Error affordance**: glyph `⚠` `color:#c46b62;` + (full form only) `usage unavailable`
`color:#c46b62;`. `title` = `error.message`. Click retries (FR-27).

### Interactions

- Click meter region or freshness label → `refreshUsage`. `cursor:pointer` on both.
- Hover a meter chip → native tooltip with label + reset time.
- No focus ring, no tab stop, no hover lift on the container (it is chrome, not an interactive row).

### Motion

**None.** This bar is always mounted; per the `src/styles.css` header note the webview may fall back
to software compositing, where a looping animation in permanent chrome repaints forever and pegs a
CPU core at idle. State changes are instant swaps.

### Responsive / resize behavior

- Window minimum is 1080px wide (`tauri.conf.json`), so 2–3 meter chips plus the freshness label fit
  comfortably; no wrapping is expected.
- Should the meter region ever overflow (edge case 10), the **freshness label** truncates first
  (`overflow:hidden; text-overflow:ellipsis; white-space:nowrap` — it keeps `flex:0 0 auto` from §8,
  so it truncates rather than flex-shrinking), then the meter region clips (`overflow:hidden`).
  Meter chips themselves never shrink, never wrap to a second line, and never change the 28px height.

## 9. Acceptance criteria

- [ ] A fixed-height bar renders under the native caption, above the grid, with no session present,
      and its background is visually continuous with the OS caption (FR-1, FR-2, §8).
- [ ] The bar is not reachable by `1`–`5`, takes no focus ring, and does not appear in the pane cycle
      (FR-3).
- [ ] `app_get_usage` returns the cached `UsageSnapshot` and provably spawns no process (FR-22).
- [ ] `app_refresh_usage` resolves `{ started: true }` when idle and `{ started: false }` when a
      probe is in flight, and never spawns a second probe (FR-7, FR-15).
- [ ] Starting a probe emits `usage.state` with `status: 'loading'` before the spawn (FR-17).
- [ ] A successful probe emits exactly one `usage.state` with `status: 'ready'`, non-empty `meters`,
      a fresh `fetchedAt`, and `error: null` (FR-16, FR-19, FR-20).
- [ ] A failed probe leaves the previous `meters` and `fetchedAt` intact and sets `status: 'error'`
      with the §5.4 code (FR-18, FR-20).
- [ ] Serde round-trip test: `UsageSnapshot` and `AppEvent` serialize to exactly the §5.2 shapes,
      including `fetchedAt: null` and `error: null` as JSON `null` (never omitted).
- [ ] Meter parsing is exercised by the existing `/usage` grammar tests after the shared-helper move,
      all still green, and the `/usage` transcript card behaves identically (§6).
- [ ] Zero parsed meters produces `USAGE_UNAVAILABLE`, not an empty `ready` snapshot (FR-9).
- [ ] The 30s watchdog kills the probe, and a fully-parsed answer read just before the kill still
      wins (FR-8).
- [ ] Automatic triggers within 60s of the last probe start are dropped; a manual refresh in the same
      window is not (FR-14).
- [ ] Two sessions finishing turns inside the debounce window produce exactly one probe (FR-13).
- [ ] Every returned meter renders, in order, unfiltered and unrelabelled (FR-23).
- [ ] A meter at 79% is accent-colored and at 80% is error-colored, fill and number matching (FR-24).
- [ ] `percentUsed: 130` clamps the fill to 100% while printing `130%` (edge case 11).
- [ ] Loading-with-data dims the meters and introduces no animation; a CSS/JS search of the bar finds
      no `@keyframes`, `animation`, or `transition` (FR-25).
- [ ] With no `claude` on PATH the bar shows the error affordance with the actionable message, the
      app is otherwise fully usable, and clicking retries (FR-26, FR-27, §7 #1).
- [ ] The palette exposes `Refresh usage limits` and it drives the same channel (FR-28).
- [ ] The trailing slot counts down the **session** meter's reset, not the weekly one and not the
      first meter, when a `/session/i` label is present (FR-30).
- [ ] An unparseable `resetsAt` (`soon`, empty, `Smarch 4`, `Feb 30`, `25:00`) renders verbatim as
      `resets <text>` — never a wrong number, never dropped (FR-30).
- [ ] A reset on `Jan 2` read on `Dec 31` counts forward, and one on `Dec 30` read on `Jan 1` counts
      back — the year is inferred as the candidate closest to `now` (FR-30).
- [ ] A past or sub-minute reset renders `resets now`, never a negative or `resets in 0m` (FR-30).
- [ ] The trailing slot reads `updated <n>m ago · resets in <countdown>` when both halves exist,
      and degrades to either half alone rather than rendering a dangling separator (FR-30).
- [ ] The trailing slot is never empty in any state — it is the refresh click target (FR-30).
- [ ] Quitting mid-probe leaves no orphan `claude` process (§7 #9).
- [ ] Unmounting the bar tears down the event subscription (FR-21, §7 #12).

## Remediation

### Round 1 — `/review` 2026-07-22 (verdict SHIP · 0 critical · 0 high · 5 medium · 10 low)

Fixed before ship:

- [x] MEDIUM · `src-tauri/src/usage.rs:439` · quality · The 30s watchdog killed the child but never
      released the FR-7 slot; a descendant holding the stdout pipe would leave `inner.probe` as
      `Some` forever, wedging `should_start` and freezing the bar in `loading` app-wide.
      `time_out_probe` now publishes the timeout, releases the slot and retires the generation in one
      critical section; `settle` retires its generation too, so the two finishers are mutually
      exclusive and exactly one outcome event is still emitted (FR-16).
- [x] MEDIUM · `src/UsageBar.tsx:80,120` · quality · Clicking the bar blurred focus to `<body>`, after
      which `App.tsx`'s global keys treated the next bare keystroke as a shortcut (`n`/`d`/`t`).
      Both click targets now `preventDefault` on mousedown, so focus never moves (FR-3).

Deferred — tracked, not blocking:

- [ ] MEDIUM · `contract/usage-bar.ts:57` · spec-violation · The contract exports four helper
      *functions* that §5.2 does not list. They are pure render derivations with no serde counterpart;
      either document them in §5.2 or move them into `src/usage.ts`.
- [ ] MEDIUM · `src-tauri/src/usage.rs:337` · quality · FR-16/FR-17 emit ordering, FR-7's no-second-spawn,
      §7 #9 and the FR-12/FR-13 timers are untestable while `request_probe` does gate + emit + spawn in
      one body taking an `AppHandle`. Split at the side-effect seams with injected `emit`/`spawn`.
- [ ] MEDIUM · `src/paletteCommands.ts:181` · quality · FR-28 (the palette command) has no test.
- [ ] LOW · `src-tauri/src/usage.rs:341` · quality · A poisoned lock makes `app_refresh_usage` resolve
      `{ started: false }`, which the frontend reads as "already in flight" and waits forever; §5.1
      says it should surface `INTERNAL`.
- [ ] LOW · `src-tauri/src/usage.rs:341` · quality · The usage mutex is held across `Command::spawn`,
      so `app_get_usage` can block despite FR-22 expecting an instant cache read.
- [ ] LOW · `src-tauri/src/usage.rs:141` · quality · `status: String` is stringly-typed against a
      four-literal contract union; use a `#[serde(rename_all = "lowercase")]` enum.
- [ ] LOW · `src-tauri/src/usage.rs:842` · quality · `probe_runs_in_the_user_home_directory` restates
      the implementation and can never fail.
- [ ] LOW · `src-tauri/src/usage.rs:461` · quality · `kill_probe` kills without `wait()`, unlike the
      session probe path.
- [ ] LOW · `src/usage.ts:86` · quality · The cache seed and `listen()` registration race; an event
      emitted inside the registration window is dropped. Chain the seed off the subscription.
- [ ] LOW · `src/UsageBar.tsx:123` · quality · §8 pins the trailing label `flex:0 0 auto` while
      §Responsive says it truncates first — a `0 0 auto` item never shrinks, so the meter region clips
      first instead. Pick one and make spec and code agree.
- [ ] LOW · `src/usage.ts:68` · quality · `loading` with no meters renders undimmed, so a click during
      the very first probe gives no feedback. Consider dimming the placeholder too.
- [ ] LOW · `src/usage.ts:70` · quality · Record the `error: null` defensive fallback in §5.4 so it is
      not mistaken for dead code.
- [ ] LOW · `src/usage.test.ts` · quality · Untested: the `freshnessLabel` 60s boundary, a future
      `fetchedAt`, and a non-finite `meterFillPercent` input.

> **Not re-reviewed:** FR-30 (the session reset countdown and the combined trailing label) was added
> after this review ran. Its date parsing is covered by 17 unit tests but has had no review pass.
