---
id: message-history
title: Composer message history (arrow-up recall)
status: shipped
created: 2026-07-30
depends_on: [conversation-view, slash-menu]
reviewed_base: 55616e66ad1fb7d2f5c10f3d49167c55de4a1b39
reviewed_digest: 20e9a07d44afe516
---

# Composer message history (arrow-up recall)

## 1. Summary

The SESSION tab's composer keeps the messages you have already sent in this session and lets you walk
back through them with ArrowUp / ArrowDown, exactly the way the native Claude Code CLI (and any
readline shell) does. Re-asking a variation of a previous prompt currently means retyping it or
scrolling the transcript and copying it out; this makes it two keystrokes. The whole feature lives in
the frontend: history is held in memory, keyed by session, and is never persisted or sent to the core,
so it adds no IPC channel and no contract types.

## 2. Goals & non-goals

- **Goals**
  - ArrowUp / ArrowDown walk the current session's sent-message history from the composer.
  - Recall never destroys work in progress: the draft that was in the box is restored by walking back
    down past the newest entry.
  - Arrow keys still do ordinary caret movement inside a multi-line draft — recall only triggers at
    the edges (§4 FR-2/FR-6).
  - Zero new chrome. The only visible effect is the composer's own text changing.
- **Non-goals**
  - **Persistence.** History is in-memory. Reloading the app (or quitting it) clears every session's
    history. A future feature can back this with a core-owned per-project store — that is the shape
    native Claude Code uses — but it is out of scope here and would need its own `francois:conversation:*`
    channel.
  - **Cross-session history.** Each session has its own list; a new session starts empty and never sees
    another session's messages, even in the same project.
  - **Search.** No ⌃R-style reverse-incremental search over history. ArrowUp/ArrowDown only.
  - **Prefix filtering.** ArrowUp with text already in the box walks the full history; it does not
    restrict to entries starting with that text.
  - **Editing history.** Entries are immutable and are never removed once recorded.

## 3. User stories / flows

1. **Recall the last prompt.** User has sent "run the tests" and the turn has finished. Composer is
   empty and focused. User presses ArrowUp → the composer fills with "run the tests", caret at the
   end. User edits it to "run the tests again" and presses Enter → it sends normally, and
   "run the tests again" becomes the newest history entry.
2. **Walk further back.** From the recalled newest entry, each further ArrowUp steps one entry older.
   At the oldest entry, ArrowUp does nothing more — no wrap-around, no bell.
3. **Come back and keep the draft.** User has half-typed "what about the ". ArrowUp recalls the newest
   entry (the half-typed text is set aside). ArrowDown steps forward; pressing ArrowDown once past the
   newest entry restores "what about the " with the caret at the end, and the composer is back in
   normal editing.
4. **Edit a multi-line draft.** Composer holds a three-line draft, caret on line 2. ArrowUp moves the
   caret up to line 1 as usual — no recall. A second ArrowUp, now that the caret is on line 1,
   recalls history.
5. **Slash menu wins.** User types "/re"; the slash-menu popup is open. ArrowUp moves the popup's
   selection, not history. Dismissing the popup (Esc) makes ArrowUp recall again.
6. **Nothing to recall.** Fresh session, no messages sent yet. ArrowUp does nothing (the caret is
   already at position 0, so nothing moves either).

## 4. Functional requirements

**Recording**

- **FR-1** When a message is sent successfully from this session's composer (the `sessionSend` call
  resolves `ok`), its exact text is appended to that session's history as the newest entry.
  - **FR-1a** Text whose first non-whitespace character is `/` is **not** recorded — slash commands
    (typed or run from the slash menu, including `/clear`) stay out of history.
  - **FR-1b** A send that fails is **not** recorded. The existing behavior of restoring the failed
    text into the composer (conversation-view) is unchanged.
  - **FR-1c** If the text is identical to the current newest entry, it is not appended again
    (consecutive duplicates collapse). Non-consecutive duplicates are kept.
  - **FR-1d** History is capped at **100** entries; appending past the cap drops the oldest.

**Recall**

- **FR-2** ArrowUp is intercepted for recall only when **all** of: no slash-menu popup is open; the
  composer has no text selected (`selectionStart === selectionEnd`); the caret is on the **first
  logical line** (the text before the caret contains no `\n`); and the session's history is non-empty.
  Otherwise ArrowUp falls through to the browser's default caret movement.
- **FR-3** The first intercepted ArrowUp enters **browsing**: the composer's current text is saved as
  the *draft*, and the composer is set to the **newest** history entry.
- **FR-4** Each further ArrowUp while browsing moves one entry **older**. At the oldest entry, ArrowUp
  is still intercepted (the caret does not move) but the text does not change.
- **FR-5** ArrowDown is intercepted only while browsing, with no popup open, no selection, and the
  caret on the **last logical line** (the text after the caret contains no `\n`). Otherwise it falls
  through.
- **FR-6** ArrowDown while browsing moves one entry **newer**. Pressing it while on the newest entry
  **exits browsing** and restores the saved draft (which may be the empty string).
- **FR-7** Whenever the composer's text is set by FR-3/FR-4/FR-6, the caret is placed at the **end** of
  the new text and the composer re-runs its auto-grow sizing, so a multi-line entry expands the box
  (and the restored draft shrinks it back).

**Leaving browsing**

- **FR-8** Any edit to the composer (typing, paste, delete) while browsing exits browsing immediately;
  the edited text becomes the composer's live draft. A later ArrowUp starts a fresh walk from the
  newest entry, and that edited draft is what FR-6 restores.
- **FR-9** Sending (Enter or the Send button) exits browsing. So does a `/clear`.
- **FR-10** Browsing state (position + saved draft) is per session and is discarded when the session's
  history is discarded (FR-11).

**Scope & lifetime**

- **FR-11** History is stored in the frontend, in memory, keyed by session id. It survives switching
  to another session and back within one app run; it does **not** survive an app reload/restart.
- **FR-12** Recall never calls the core. No Tauri command or event is added, removed, or changed.
  - **Note (amended during build).** The branch carries **one** unrelated `src-tauri` line as its own
    commit: `use tauri::{Manager, RunEvent}` in `main.rs`. `main.rs:45` calls `get_webview_window`
    inside a `#[cfg(windows)]` block, which needs the `Manager` trait in scope — without it the
    **Windows build does not compile** (E0599), and `ci.yml` runs on `windows-latest`. This is a
    pre-existing breakage on `main`, not something this feature introduced; it is called out here
    because it blocks every cargo-based gate on this branch. It is cherry-pickable on its own.

**Precedence**

- **FR-13** In the composer's `onKeyDown`, the order is: ⌃C interrupt → slash-menu popup keys →
  history recall (FR-2/FR-5) → Enter-to-send. History recall must not preempt any of the first two,
  and must not change the behavior of any key other than ArrowUp / ArrowDown.
- **FR-14** When the composer is disabled (session `done` / `error`), no recall happens — the textarea
  receives no key events.

## 5. API contract

**No contract change.** This feature adds no IPC channel, no event, and no payload type: nothing
crosses the frontend↔core boundary. There is no `contract/message-history.ts`, and no existing file in
`contract/` is edited. `/build` should author no contract for this feature.

The interface below is a **frontend-internal module**, `src/features/conversation/message-history.ts`,
owned by the `frontend` surface. It is pure except for the module-scoped per-session map, which is why
it is spec'd here rather than left to the implementer: the pure half is the unit-test target.

```ts
/** One session's sent-message history: oldest first, newest last. Max 100 (FR-1d). */
export type History = readonly string[];

/** Where the composer is in a walk. `null` = not browsing (FR-3/FR-6). */
export interface Browse {
  /** Index into History of the entry currently shown. */
  index: number;
  /** The composer text set aside when browsing began; restored by FR-6. */
  draft: string;
}

/** FR-1/1a/1c/1d — returns the next history, unchanged when the entry is not recordable. */
export function appendEntry(history: History, text: string): History;

/** FR-1a — true when `text`'s first non-whitespace char is '/'. */
export function isSlashEntry(text: string): boolean;

/** FR-2 — caret is on the first logical line and nothing is selected. */
export function atFirstLine(value: string, selectionStart: number, selectionEnd: number): boolean;

/** FR-5 — caret is on the last logical line and nothing is selected. */
export function atLastLine(value: string, selectionStart: number, selectionEnd: number): boolean;

/**
 * FR-3/FR-4 — one step older. `browse` is the current state (null = not browsing),
 * `current` the composer's live text (saved as the draft on entry).
 * Returns null when there is nothing to do (empty history), so the caller falls through.
 * `changed` is false when the step is a no-op (already at the oldest entry): the caller
 * still calls preventDefault (FR-4 intercepts) but must NOT touch the text or the caret.
 */
export function recallPrev(history: History, browse: Browse | null, current: string):
  { browse: Browse; text: string; changed: boolean } | null;

/**
 * FR-6 — one step newer. Returns `browse: null` + the saved draft when stepping past
 * the newest entry. Returns null when not browsing, so the caller falls through.
 */
export function recallNext(history: History, browse: Browse | null):
  { browse: Browse | null; text: string } | null;

/** FR-11 — the per-session store. Module-scoped Map; no persistence, no reactivity. */
export function getHistory(sessionId: string): History;
export function recordSent(sessionId: string, text: string): void;
```

## 6. Data & state

- **Rust core**: none. Untouched by this feature.
- **Frontend, module-scoped** (`message-history.ts`): `Map<sessionId, History>`. A plain module map,
  **not** a zustand slice — nothing renders from it, so it needs no reactivity, and keeping it out of
  `AppState` keeps the feature inside `src/features/conversation/` per the layout convention. Module
  scope (rather than `useState` in `ConversationView`) is what satisfies FR-11's "survives a session
  switch": `ConversationView` is keyed by `sessionId` and remounts on every switch.
- **Frontend, component state** (`ConversationView`): `browse: Browse | null` — the current walk.
  Component-local is correct here; a remount (session switch) should reset the walk, and FR-10 says so.
- **Derived**: none. The composer's `input` state stays the single source of truth for what is shown;
  recall simply calls `setInput`.
- **Persistence**: none — no `localStorage`, no core, by decision (§2 non-goals).
- **Cleanup**: entries for a closed/deleted session are not evicted. A session id is a uuid and the map
  is bounded per entry (FR-1d), so a long run holds at most a few hundred KB; a reload clears it.

## 7. Edge cases & errors

This feature has no failure modes of its own — no I/O, no async, no error codes. The behaviors below
are the ones an implementer would otherwise have to guess.

| Case | Behavior |
|---|---|
| History empty, ArrowUp pressed | Not intercepted (FR-2). Default caret movement; composer unchanged. |
| At the oldest entry, ArrowUp again | Intercepted and swallowed (`preventDefault`), text unchanged (FR-4). No wrap to newest. |
| Not browsing, ArrowDown pressed | Not intercepted (FR-5). Default caret movement. |
| Draft was empty when browsing began | FR-6 restores the empty string — the composer clears and exits browsing. Correct, not a bug. |
| Recalled entry is multi-line, caret at end | ArrowUp now moves the caret up a line (caret is not on the first logical line), it does not step to an older entry. Second ArrowUp, once on line 1, steps older. |
| Text is soft-wrapped over several visual lines | "First/last line" means **logical** line (`\n`), not visual. On a long wrapped single-line entry the caret is "on the first line" anywhere in it, so ArrowUp recalls instead of moving the caret up a visual row. Accepted: the composer caps at 130px and the alternative needs per-glyph measurement. |
| Selection active in the composer | Never intercepted (FR-2/FR-5) — arrow keys collapse the selection as usual. |
| Slash-menu popup open | Popup keys win (FR-13). History is not consulted, browsing state is untouched. |
| Send fails and the text is restored | Not recorded (FR-1b). Browsing has already exited (FR-9), so the restored text is a plain draft. |
| Same text sent twice in a row | One entry (FR-1c). Sent, then something else, then the same text again → two entries. |
| `/clear` wipes the transcript | History is **not** wiped — it is composer state, not transcript state. `/clear` itself is not recorded (FR-1a). |
| Session switch mid-walk | The walk resets (component remount, FR-10); the history itself survives (FR-11). |

## 8. Design brief

**No design brief, and no new visual component.** This is a behavior-only change to the existing
composer (`Claude Terminal.dc.html:71-116`, input bar): the only rendered difference is the value of
the textarea that already exists, plus the auto-grow height it already recomputes (FR-7). No new
tokens, colors, glyphs, motion, or layout. The `composer-hint` row is deliberately left alone — the
mock's hint strip is a fixed three-item row (⌃C / ⌘K / ⇧⏎) and adding a "↑ history" item would change
a design-owned element for a discoverable-by-reflex binding.

## 9. Acceptance criteria

- [ ] Sending a message, then pressing ArrowUp in an empty composer, fills it with that message, caret
      at the end (FR-1, FR-2, FR-3, FR-7).
- [ ] Repeated ArrowUp walks older; it stops at the oldest and does not wrap (FR-4).
- [ ] Typing a draft, pressing ArrowUp, then ArrowDown past the newest entry restores the draft exactly
      (FR-3, FR-6).
- [ ] With a multi-line draft and the caret on line 2, ArrowUp moves the caret and does not recall; from
      line 1 it recalls (FR-2).
- [ ] While the slash-menu popup is open, ArrowUp/ArrowDown move the popup selection and history is not
      touched (FR-13).
- [x] A `/`-prefixed message (typed or run from the slash menu) never appears in history (FR-1a).
- [ ] A failed send does not appear in history, and its text is still restored to the composer (FR-1b).
- [x] Sending the same text twice in a row yields one history entry (FR-1c).
- [ ] Editing a recalled entry and pressing ArrowUp starts a fresh walk from the newest entry; ArrowDown
      back down restores the edited text (FR-8).
- [ ] Switching to another session and back preserves that session's history; a reload clears it
      (FR-11).
- [x] `git diff` touches no file under `contract/`, and no file under `src-tauri/` **other than the
      one-line `use tauri::Manager` restore** carried as its own commit (see FR-12 note) (FR-12).
- [x] `npx tsc --noEmit` and `npm test` are green, with unit tests covering `appendEntry`,
      `isSlashEntry`, `atFirstLine`, `atLastLine`, `recallPrev`, and `recallNext`.

## Remediation

### cohorte-cycle round 5

### /review round 6 (2026-07-31)

- [x] MEDIUM · `src/features/conversation/ConversationView.tsx:226-234` · spec-violation · FR-4
      requires that at the oldest history entry a repeated ArrowUp leaves "the caret does not move,"
      but `applyRecall`'s same-value shortcut (`el.value === text` branch) unconditionally calls
      `el.setSelectionRange(text.length, text.length)`; because `recallPrev` returns the identical
      text/index when already at the oldest entry (`message-history.ts:64-67`), `setInput(text)` is a
      no-op (same string, no re-render) and this inline branch fires, forcibly moving the caret to the
      end even if the user had repositioned it inside the recalled text before pressing ArrowUp again.
      Fix: in `applyRecall`, skip the `setSelectionRange`/`autoGrow` call when the new text equals the
      text already shown, or have `recallPrev` signal "no-op" so the caller can `preventDefault()`
      without touching the caret at all.
      — fixed: `recallPrev` now returns a `changed: boolean`; the ArrowUp handler
      (`ConversationView.tsx:187-198`) calls `applyRecall` only when `changed` is true, so a repeat
      ArrowUp at the oldest entry still `preventDefault()`s but leaves the caret untouched. New test
      at `message-history.test.ts:164-179`.
