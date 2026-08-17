---
id: audio-cues
title: Audio cues — attention and turn-done
status: shipped
branch: feat/audio-cues
created: 2026-08-17
depends_on: [notifications, session-engine, app-shell, command-palette]
loop_pass: 0
loop_phase:
reviewed_base: 8b1fd67346b411339933e6cbc2935dd513b24c3d
reviewed_digest: ef5fb549252beb14
design_files: []
---

# Audio cues — attention and turn-done

## 1. Summary

`notifications` (shipped) fires an OS banner when a session needs you or a turn settles, but a banner
only helps when you are looking where banners appear. The common Francois posture — several sessions
running, Francois in the foreground, your eyes on an editor on the same screen — gets no cue: FR-8
suppresses the turn-done banner exactly then, and an `attention` banner in a corner is easy to miss.
This feature plays a **short synthesized tone** for the same two trigger classes, **with no focus
gate**, so the cue reaches peripheral attention. Two tones only (`attention`, `turnDone`), Web Audio
`OscillatorNode` with no asset, one master toggle, at most one tone per 1.5s, and silence while the OS
reports Do Not Disturb. It adds one IPC command (`francois:app:dndState`) and **refactors the trigger
derivation out of `notifications.ts`** so banners and sound are two sinks on one trigger source.

## 2. Goals & non-goals

- **Goals**:
  - Two tones: `attention` (approval + question) and `turnDone` (`idle`/`error`/`done`), pinned in §5.
  - **No focus gate** — both classes chime whether or not the session is visible and whether or not the
    window is focused. This is the deliberate divergence from `notifications` FR-7/FR-8.
  - Global coalescer: at most one tone per 1500ms; a tone inside the window is **dropped, never queued**.
  - One master `sound` toggle, own localStorage key, default **on**, one palette command.
  - The existing `◇ muted` chip covers sound too, so there is never a silent app with no visible reason.
  - DND suppression via a core probe, **permissive degrade**: unknown/unsupported/failed ⇒ play.
  - Extract `deriveTrigger` + its state into one shared trigger source; **no banner behaviour changes**.
- **Non-goals**:
  - A third tone for `error`; per-session or per-project tones; speech.
  - User-supplied sound files or any sound customization — decoding attacker-chosen media inside the
    webview that holds IPC authority (2026-08-04 security decision). Not without its own brainstorm.
  - Volume control or any new settings surface. OS volume is the user's dial.
  - Quiet hours, categories, badges, grouping — non-goals in `notifications.md`, still non-goals.
  - Sound on turn *start*, tool events, subagent/workflow events, context-limit warnings.
  - Parsing Windows Focus Assist levels or any Linux DND source (see FR-16/FR-17).

## 3. User stories / flows

1. **Peripheral catch.** Four sessions run; you read a browser on the same screen. `api-refactor` hits a
   gated `Bash`. You hear the rising two-note tone and look over — the approval card is there. No banner
   was needed and none was missed.
2. **Chatty by design.** You converse with the active, visible session. Each reply settles the turn and
   plays the quiet single note. That is intended: the escape hatch is the master toggle, not a gate.
3. **Fleet settle.** `/cohorte-build` fans out; four sessions settle inside 900ms. **One** tone plays.
4. **Attention loses a race.** A turn settles, then 200ms later another session asks for approval. The
   approval tone is **dropped** — the coalescer is class-blind (§5). The banner still fires.
5. **Focus mode.** macOS Focus is on. Nothing chimes. Banners still behave per `notifications`.
6. **Silence it.** `⌘K` → *Sound: audio cues* → off. The `◇ muted` chip appears, its `title` reading
   `audio cues are off`. Survives a restart.
7. **Cold boot.** Francois opens, sits idle for minutes, a background turn settles — the webview has had
   no user gesture, so `AudioContext` is suspended and the tone is swallowed. No error, no prompt. The
   next tone after your first click or keypress plays normally.
8. **Linux.** The probe reports `supported: false`; tones always play.

## 4. Functional requirements

**Trigger source refactor (`src/features/notifications/trigger.ts`, new)**

- **FR-1 (extraction).** `DeriveState`, `deriveTrigger`, `settleTrigger` and the single module-level
  `deriveState` move verbatim from `notifications.ts` into `trigger.ts`. Behaviour is unchanged,
  including the two shipped divergences from `notifications.md` §5 that the code already carries:
  `isBusyStatus(previous)` (not `previous === 'running'`) and `visibleSessionIds` gating. The moved
  tests move with them (`notifications.test.ts` → `trigger.test.ts` for the derivation cases).
- **FR-2 (one subscription, many sinks).** `registerTriggerSink(sink: (t: NotifyTrigger) => void): void`
  appends a sink. The module subscribes to `onSessionEvent` **exactly once**, on the first
  registration. Every event runs `deriveTrigger` once against the one `deriveState`, and a non-null
  trigger is handed to every registered sink in registration order. A sink that throws is caught and
  never blocks the others.
- **FR-3 (single source of truth).** There is exactly one `lastStatus` map and one `seenAsks` set in the
  app. `notifications.ts` no longer owns either, and neither does `sound.ts`.
- **FR-4 (banner sink unchanged).** `initNotifications()` keeps FR-5/FR-9..FR-13 of `notifications.md`
  and registers `shouldFire`-gated firing as a sink instead of subscribing itself. `shouldFire` stays
  in `notifications.ts`, exported and tested as before. No banner behaviour changes.

**Audio sink (`src/features/notifications/sound.ts`, new)**

- **FR-5 (init once).** `initAudioCues()` is called from `App`'s mount effect alongside
  `initNotifications()`. It registers the audio sink (FR-2) and installs the gesture listener (FR-10).
  Idempotent — a second call is a no-op.
- **FR-6 (pure coalescer).** `coalesce(now: number, state: CoalesceState): 'play' | 'drop'` returns
  `'play'` iff `now - state.lastPlayedAt >= COALESCE_WINDOW_MS` (1500), and on `'play'` sets
  `lastPlayedAt = now`. **Class-blind**: `attention` inside the window drops exactly like `turnDone`.
  Nothing is queued. Exported and unit-tested with an injected `now`.
- **FR-7 (play path order).** On a trigger the sink evaluates, in order, stopping at the first that
  says no: (a) `soundEnabled` is true; (b) `coalesce(...) === 'play'`; (c) `await dndSuppressed(...)`
  is false. Only then does it play. **The coalescer clock advances at (b)**, before the awaited DND
  read — so a burst that is later suppressed by DND still collapses to one probe, not four.
- **FR-8 (tone synthesis).** A play builds an `OscillatorNode` + `GainNode` from the `TONES` spec in §5:
  sine wave, `attackMs` linear ramp to `peakGain`, then `exponentialRampToValueAtTime(0.0001, durationMs)`
  and `stop()`. `attention` additionally schedules `frequency.setValueAtTime(freqTo, freqAtMs)`. The
  ramp is exponential and never a hard stop — a linear cutoff clicks. Fixed level; no volume input.
- **FR-9 (injectable backend).** The sink takes its audio backend through one injectable seam
  (`AudioBackend { play(spec: ToneSpec): void }`), defaulting to the Web Audio implementation. Vitest
  never constructs a real `AudioContext`; tests assert the seam was called with the right `ToneSpec`.
- **FR-10 (autoplay policy).** A single `AudioContext` is created lazily on first play. If its state is
  `'suspended'`, `resume()` is attempted. A `pointerdown`/`keydown` listener (`{ once: true }`, on
  `window`, capture) resumes the context on the first user gesture and then unregisters. Every audio
  call is wrapped: a rejected `resume()`, a throw, or a missing `AudioContext` is **swallowed
  silently** — never an error path, never an in-app prompt (the FR-11 wrapped-fire pattern).
- **FR-11 (toggle + persistence).** `useNotificationsStore` gains `soundEnabled: boolean` and
  `setSoundEnabled(on: boolean)`, persisted to `SOUND_ENABLED_KEY` as `'1'`/`'0'`, default **on** when
  the key is absent, malformed, or unreadable. Reads and writes are wrapped (`layoutStore.ts:14-32`).
- **FR-12 (palette command).** One command in `paletteCommands.ts`: `toggle-sound`, name
  *"Sound: audio cues"*, glyph `◈`, `hint()` reading `on`/`off`, `run()` flips it. It sits next to the
  two existing notification commands.
- **FR-13 (muted chip covers sound).** `notifyChip.ts` derives over three channels
  (`MutedChannel = 'attention' | 'turnDone' | 'sound'`) instead of two. `mutedChipLabel` returns `null`
  when all three are on, `'muted (all)'` when all three are off, `'muted'` otherwise. `mutedChipTitle`
  enumerates the off channels via `MUTED_CHANNEL_LABEL`, comma-separated, suffixed `' are off'`; all
  three off reads `'all notifications and audio cues are off'`. Both stay pure and unit-tested.

**DND probe (`src-tauri/src/dnd.rs`, new top-level module)**

- **FR-14 (command).** `app_dnd_state` implements `francois:app:dndState` → `Result<DndState>`. It is
  registered in `main.rs`'s `invoke_handler`. It takes no payload.
- **FR-15 (permissive degrade, core-side).** The command **never returns `err` for a probe failure**. A
  missing file, an unparseable payload, a non-zero subprocess, a timeout, or an unknown OS all resolve
  to `Ok(DndState { dnd: false, supported: false })`. This keeps the probe non-authoritative per the
  2026-08-11 `api` decision: it may only *suppress* a convenience cue, never gate anything.
- **FR-16 (macOS probe).** Reads `~/Library/DoNotDisturb/DB/ModeConfigurations.json` (Ventura+) and
  falls back to `~/Library/DoNotDisturb/DB/Assertions.json` (Monterey). DND is on iff an assertion /
  active mode configuration is present. Both paths are undocumented and have moved between OS
  versions — hence FR-15 and FR-18.
- **FR-17 (Windows probe).** Reads `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings`
  value `NOC_GLOBAL_SETTING_TOASTS_ENABLED` (DWORD); `0` ⇒ `dnd: true`. Absent ⇒ `dnd: false,
  supported: true`. Focus Assist *levels* live in an undocumented CloudStore binary blob and are
  **not** parsed (non-goal).
- **FR-18 (canary tests, mandatory).** Each platform probe has a `#[cfg(test)]` canary, `#[cfg]`-gated
  to its own target, asserting that the source it depends on still has the expected **shape** (macOS:
  the DB directory exists and any present file parses as JSON; Windows: the registry key path is
  readable). A canary that fails means the OS moved the surface — it must fail loudly in `cargo test`,
  not degrade silently in production. Parsing itself is tested against in-repo fixtures, not live OS
  state, so the suite is deterministic on CI.
- **FR-19 (Linux).** `#[cfg(target_os = "linux")]` returns `DndState { dnd: false, supported: false }`
  and executes nothing. No DBus, no subprocess, no canary needed.
- **FR-20 (frontend TTL cache).** `dndSuppressed(now)` calls `app_dnd_state` at most once per
  `DND_CACHE_TTL_MS` (10 000) and caches the result. A transport `err` caches `false`. There is **no
  timer and no polling** — the probe runs only when a tone is about to play. Pure apart from the
  injected clock and the injected api call, so it is unit-testable.

## 5. API contract

New file `contract/audio-cues.ts`. It **imports** `NotifyClass`/`NotifyTrigger` from
`contract/notifications.ts` and `SessionId` from `contract/common.ts`, and redefines neither. No new
`SessionEvent` member — the audio sink consumes the existing `francois://session/event` stream through
the shared trigger source (FR-2).

### IPC

| Logical channel | Tauri command | Payload | Resolves | Error codes |
|---|---|---|---|---|
| `francois:app:dndState` | `app_dnd_state` | *(none)* | `Result<DndState>` | *(none — FR-15)* |

```ts
// contract/audio-cues.ts — short synthesized tones for the two notification
// trigger classes. Authored from specs/audio-cues.md §5. Imports the shared
// vocabulary from common.ts / notifications.ts and never redefines it.

import type { NotifyClass } from './notifications';

/** OS Do Not Disturb / Focus / Quiet Hours state (FR-14..FR-19).
 *  `supported:false` means we have no probe for this platform (or it failed) —
 *  the caller MUST treat that as "not suppressed" and play (FR-15). */
export interface DndState {
  dnd: boolean;
  supported: boolean;
}

/** The audio sink reuses the notification classes 1:1 — one tone each. */
export type AudioClass = NotifyClass;

/** Envelope for one tone. Frequencies in Hz, gains 0..1, times in ms from start. */
export interface ToneSpec {
  /** Starting frequency. */
  freq: number;
  /** Second note, for a two-note tone. Undefined ⇒ single note. */
  freqTo?: number;
  /** When the second note starts (ms from tone start). */
  freqAtMs?: number;
  /** Peak gain after the attack ramp. Fixed — there is no volume control. */
  peakGain: number;
  /** Linear ramp 0 → peakGain. */
  attackMs: number;
  /** Total tone length; the gain decays exponentially to 0.0001 by this point. */
  durationMs: number;
}

/**
 * The two tones (FR-8), pinned here so "quiet" is not the implementer's call.
 * attention: a rising perfect fourth — reads as a question, carries in noise.
 * turnDone : one soft note an interval below — plainly a different event.
 */
export const TONES: Record<AudioClass, ToneSpec> = {
  attention: { freq: 660, freqTo: 880, freqAtMs: 90, peakGain: 0.26, attackMs: 8, durationMs: 180 },
  turnDone: { freq: 440, peakGain: 0.19, attackMs: 8, durationMs: 140 },
};

/** At most one tone per window; a tone inside it is dropped, never queued (FR-6). */
export const COALESCE_WINDOW_MS = 1500;

/** How long a DND probe result is reused before re-probing (FR-20). */
export const DND_CACHE_TTL_MS = 10_000;

/** localStorage key for the master toggle (FR-11). Absent ⇒ on. */
export const SOUND_ENABLED_KEY = 'francois.sound.enabled';

/** Everything the `◇ muted` chip can be reporting (FR-13). */
export type MutedChannel = NotifyClass | 'sound';

/** Chip-title phrase per channel — enumerated so the chip is never a mystery. */
export const MUTED_CHANNEL_LABEL: Record<MutedChannel, string> = {
  attention: 'approvals & questions notifications',
  turnDone: 'turn finished notifications',
  sound: 'audio cues',
};

/** All three off — read as one phrase rather than a list (FR-13). */
export const MUTED_ALL_TITLE = 'all notifications and audio cues are off';
```

```rust
// src-tauri/src/dnd.rs — serde mirror. Registered in main.rs invoke_handler.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DndState { pub dnd: bool, pub supported: bool }

#[tauri::command]
pub fn app_dnd_state() -> Result<DndState, AppError>;  // never Err — FR-15
```

### Frontend module surfaces (exported, pure, unit-tested)

```ts
// src/features/notifications/trigger.ts
export function registerTriggerSink(sink: (t: NotifyTrigger) => void): void;   // FR-2
export function deriveTrigger(e: SessionEvent, state: DeriveState): NotifyTrigger | null;  // moved, FR-1

// src/features/notifications/sound.ts
export interface CoalesceState { lastPlayedAt: number }
export interface AudioBackend { play(spec: ToneSpec): void }                    // FR-9 seam
export function coalesce(now: number, state: CoalesceState): 'play' | 'drop';   // FR-6
export function initAudioCues(backend?: AudioBackend): void;                    // FR-5, idempotent

// src/features/notifications/notifyChip.ts (amended)
export function mutedChipLabel(off: readonly MutedChannel[]): string | null;    // FR-13
export function mutedChipTitle(off: readonly MutedChannel[]): string;           // FR-13
```

### Store (`src/lib/notificationsStore.ts`, amended)

```ts
soundEnabled: boolean;                       // seeded from localStorage; default on
setSoundEnabled: (on: boolean) => void;      // sets state AND persists
```

## 6. Data & state

**Module-local (`sound.ts`), all transient:** `lastPlayedAt: number` (coalescer, seeded `-Infinity` so
the first tone always plays) · `ctx: AudioContext | null` (lazy, FR-10) · `dndCache: { value: boolean;
at: number }` (FR-20) · `initialized: boolean`.

**Module-local (`trigger.ts`):** the one `deriveState` (`lastStatus`, `seenAsks`) moved from
`notifications.ts` (FR-3) · `sinks: Array<(t) => void>` · `subscribed: boolean`.

**Store:** `soundEnabled` — read by the sink via `getState()`, reactively by the palette hint and the
chip.

**Persistence:** one localStorage key, `francois.sound.enabled`. No core-side persistence; the DND
probe is stateless and reads live OS state on each uncached call.

**Core:** none. `dnd.rs` holds no state between calls.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| Approval on the active, visible session, window focused | **Plays** — no focus gate (FR-7). This is the feature. |
| Four sessions settle within 900ms | One tone (FR-6). |
| turnDone then attention 200ms later | Only the turnDone tone plays; the attention tone is dropped (FR-6, class-blind). The banner still fires. |
| OS in DND / Focus / Quiet Hours | No tone (FR-7c). Banners unaffected. |
| DND probe fails, file missing, OS unknown, Linux | `supported: false` ⇒ **plays** (FR-15/FR-19). |
| `app_dnd_state` transport error (invoke rejects) | Cached as not-suppressed for the TTL ⇒ plays (FR-20). |
| DND toggled off, tone within 10s | Uses the stale cached answer — may stay silent for up to 10s (FR-20). Accepted. |
| No user gesture yet (cold boot, idle) | `AudioContext` suspended; `resume()` attempted and may reject; the tone is swallowed silently (FR-10). The gesture listener fixes it from the next tone on. |
| `AudioContext` unavailable / constructor throws | Swallowed; the sink no-ops for the session. No error surface (FR-10). |
| Sound toggled off | No tones. `deriveTrigger` still runs (it is shared, FR-2/FR-3), so `lastStatus`/`seenAsks` stay correct and banners are unaffected. |
| localStorage unavailable or throws | Defaults to on; writes swallowed; the in-memory toggle still works this session (FR-11). |
| Same ask re-emitted (hydration, resume) | One tone — `seenAsks` dedupes in the shared source (FR-3). |
| App restart with restored `idle` sessions | No tones — first observed status, not a transition (inherited FR-16 of `notifications.md`). |
| A sink throws | Caught; the other sink still runs (FR-2). |
| Notification permission denied by the OS | Irrelevant — audio is independent of `tauri-plugin-notification` (this is why the plugin's `sound` field was rejected). |
| Windows Focus Assist on but toasts enabled | Reported as not-DND ⇒ plays. Documented non-goal (FR-17). |

## 8. Design brief

Almost nothing is visible. The audible surface is the two tones (pinned in §5 `TONES`, not a design
artifact); the in-app surface is one palette row and one word in an existing chip.

- **Palette row** — glyph `◈`, name *"Sound: audio cues"*, hint `on` / `off`, listed directly after the
  two `Notifications:` commands so the three mute controls read as one group.
- **Muted chip** — unchanged chrome: right cluster of `.app-status-bar` before `AccountChip`, dim
  (`--text-faint`), glyph `◇` (U+25C7). Only its condition and `title` widen to three channels
  (FR-13). Still renders **nothing** in the all-on default state — zero added chrome.
- **No acid.** Nothing here is the live/focused thing (2026-08-17 `ui` decision); the chip stays
  `--text-faint`.

> full brief: `specs/design/audio-cues.md`

## 9. Acceptance criteria

- [ ] An approval or question plays the rising 660→880 Hz tone **even when that session is visible and
      the window is focused** (FR-7); a settle plays the 440 Hz tone under the same conditions.
- [x] Four settles inside 900ms produce exactly one tone; an `attention` 200ms after a `turnDone` is
      dropped, not queued (FR-6, unit-tested with an injected clock).
- [x] The coalescer clock advances before the awaited DND read, so a suppressed burst issues one probe
      (FR-7).
- [x] `app_dnd_state` returns `Ok({ dnd:false, supported:false })` — never `Err` — for a missing file,
      an unparseable payload, a failed subprocess, and an unknown OS (FR-15, unit-tested per platform).
- [x] Each platform probe has a `#[cfg]`-gated canary test that fails when its OS source moves; parsing
      is covered against in-repo fixtures so CI is deterministic (FR-18). Linux executes nothing (FR-19).
- [x] With DND reported on, no tone plays; with `supported:false`, tones play (FR-7c/FR-15).
- [x] The DND probe is called at most once per 10s and never on a timer (FR-20).
- [x] No test constructs a real `AudioContext`; the backend seam is asserted with the exact `ToneSpec`
      for each class (FR-9).
- [x] A suspended `AudioContext`, a rejected `resume()`, or a throw anywhere in the audio path is
      swallowed with no error surface and no in-app prompt (FR-10).
- [x] `Sound: audio cues` toggles from the palette with an `on`/`off` hint and survives a restart via
      `francois.sound.enabled`, defaulting to on (FR-11/FR-12).
- [ ] The status bar renders nothing with all three channels on, `◇ muted` with one or two off, and
      `◇ muted (all)` with all three off; the `title` enumerates exactly which (FR-13).
- [x] There is exactly one `lastStatus` map and one `seenAsks` set in the app, and exactly one
      `onSessionEvent` subscription for triggers (FR-2/FR-3) — verifiable by grep and by a test that
      registers two sinks and asserts both receive one trigger per event.
- [x] **No banner behaviour changed**: the moved `notifications.test.ts` derivation and `shouldFire`
      cases pass unmodified apart from their import path (FR-1/FR-4).
- [x] No new `SessionEvent` member is introduced (§5).

## Remediation

- 2026-08-17 — 4 findings (1 CRITICAL, 2 MEDIUM, 1 LOW), all fixed: dnd.rs degrade-path seams + tests and a bounded `reg query` timeout (core); FR-7 single-probe coalescer test and a try/catch around `backend.play` (frontend).
