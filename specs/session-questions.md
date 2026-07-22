---
id: session-questions
title: Question cards — answer Claude Code's questions from the SESSION tab
status: shipped
created: 2026-07-22
depends_on: [session-engine, conversation-view, durable-sessions]
---

# Question cards — answer Claude Code's questions from the SESSION tab

## 1. Summary

Claude Code can ask the user structured multiple-choice questions mid-turn via its
`AskUserQuestion` tool. In Francois's headless turns that tool **did not exist** — the CLI strips it
from the toolset in plain `-p` mode, so Claude silently guessed instead of asking, or asked in prose
and ended its turn. This feature turns the capability on and gives it a UI: every session turn now
runs with the CLI's **stdio control channel** enabled (`--input-format stream-json
--permission-prompt-tool stdio`), the turn's user text moves from the `-p` argument to an NDJSON
stdin line, and when Claude asks a question the CLI **parks the turn** and emits a `control_request`
on stdout. The core surfaces it as a new `question` transcript block; the user clicks an answer in
the SESSION tab; the core writes the matching `control_response` to the child's stdin and the parked
turn resumes in-place — same process, no `--resume` round-trip, full context preserved.

All wire shapes were verified empirically against CLI 2.1.217 on 2026-07-22 (see §5.5 — that
appendix is the implementation authority, not any external doc).

## 2. Goals & non-goals

**Goals**

- Enable `AskUserQuestion` in every session turn (native and WSL runtimes) and render each call as
  an interactive card: header chip, question, options with descriptions, multi-select, free-text
  "other" answer.
- Answer in-place over stdin so the turn continues with its context intact; exactly one resolution
  (`answered` or `cancelled`) per question, persisted in the transcript like every other block.
- Preserve pre-feature behavior for everything else the control channel now carries: any
  non-`AskUserQuestion` permission request is **auto-denied immediately** (headless mode already
  auto-denied them; nothing regresses, nothing parks).
- A pending question must survive a tab switch / remount (hydration) and resolve to `cancelled` when
  the turn dies under it (interrupt, error, app quit).

**Non-goals**

- **Interactive permission cards** (allow/deny for `Bash`, `Edit`, …). Same wire channel, separate
  future feature (`permission-cards`); this feature auto-denies them exactly as headless mode did.
- **Plan-mode approval** (`ExitPlanMode` now appears in the headless toolset with the control
  channel on) — auto-denied like any other tool; a future `plan-approval` feature owns it.
- **Dialogs** (`request_user_dialog`) — never emitted: the CLI fails closed unless the host declares
  `supportedDialogKinds` in an `initialize` handshake, which we deliberately do not send.
- **Question timeouts** — the CLI owns auto-continue policy (`askUserQuestionTimeout` in user
  settings, default `never`); the core adds no timer.
- **Dedicated keyboard bindings** for the card. The card is mouse-first; the free-text row provides
  a keyboard path. Focus-model integration beyond ordinary clicks is out of scope.
- **Probe spawns** (`interactive-commands` `/usage` side-spawns, `usage-bar` app probe) are
  unchanged — they never pass the new flags and can never park.

## 3. User stories / flows

1. **Claude asks, user clicks.** During a turn Claude calls `AskUserQuestion` ("Which auth method?"
   — options `JWT` / `Sessions`). The transcript grows a question card; the turn stays `running`
   (spinner, elapsed timer keep going). The user clicks `JWT`. The card collapses to its answered
   state (chosen option highlighted, others gone dim) and Claude's next tokens stream in below —
   same turn, no re-spawn.
2. **Multiple questions in one call.** The card shows 2–4 question sections, each with its own
   header chip and options. Single-select sections take one click each; the card submits once
   every section has an answer (the last click submits — no separate confirm button when all
   sections are then complete).
3. **Multi-select.** A section with `multiSelect: true` renders checkbox-style options; clicks
   toggle. A `answer` affordance on the card submits once every section has ≥ 1 selection.
4. **Free-text "other".** Each section has an `other…` row; clicking it focuses an inline text
   input. Typing a non-empty value and pressing Enter counts as that section's answer (submits the
   card if it is the last incomplete section). Escape empties and collapses the row.
5. **User types instead of clicking.** While a question is pending the composer stays usable; a
   typed message **queues** (existing running-turn semantics, position chip and all) and is sent
   only after the turn — i.e. after the card is answered. The composer placeholder reads
   `answer the question above — typed messages will queue` while a pending card exists.
6. **User interrupts instead.** The existing interrupt kills the child; the pending card flips to
   `cancelled` (inert, dimmed, `— cancelled` note) and stays in the transcript.
7. **Tab switch while pending.** User switches SESSION → DIFF → SESSION. The remounted transcript
   hydrates the card still `pending` and still answerable.
8. **CLI auto-continue / cancellation.** If the CLI cancels a parked question
   (`control_cancel_request`, e.g. a user-configured auto-continue timeout), the card flips to
   `cancelled`; a click that races the cancellation resolves `QUESTION_NOT_PENDING` and the UI
   just shows the cancelled state it already received.
9. **Claude wants to run a tool needing permission** (session in `default` mode, tool not
   allowlisted). Nothing visible happens — the core denies instantly on the control channel and
   Claude adapts, exactly as before this feature.

## 4. Functional requirements

**Spawn & channel**

- **FR-1**: `spawn_claude` adds `--input-format stream-json` and `--permission-prompt-tool stdio`
  to every session turn, pipes stdin, and passes `-p` with **no** positional prompt. The turn's
  user text is written to stdin as one NDJSON `user` line (§5.5 shape) immediately after spawn.
  All existing flags (`--output-format stream-json`, `--include-partial-messages`, `--verbose`,
  `--model`, permission-mode args, `--effort`, `--resume`) are unchanged.
- **FR-2**: the child's stdin handle lives in the turn state for the whole turn and is **closed
  when the turn finishes** (result read, child exit, interrupt, failure) — closing it is what lets
  the CLI exit after its result. It is never closed while a question is pending.
- **FR-3**: identical behavior on the `wsl` runtime (stdin passes through `wsl.exe`).
- **FR-4**: `keep_alive` lines and any still-unrecognized top-level `type` remain silently ignored.
- **FR-5**: `/compact` (session_compact) rides the same stdin path as ordinary text and must keep
  working; the slash-command intercepts of `interactive-commands` are unaffected (they never reach
  `spawn_claude`).

**Inbound control traffic (reader thread)**

- **FR-6**: a `control_request` whose `request.subtype` is `can_use_tool` and `tool_name` is
  `AskUserQuestion`: mint a `blockId`, record a pending entry `{requestId, blockId, input}` keyed
  by `blockId`, buffer + persist a `question` block in state `pending`, and emit
  `question.asked`. Multiple pending questions may coexist (keyed independently); each gets its
  own card.
- **FR-7**: parsing is lenient and verbatim: `questions[].question/header` render as-is (even if
  `header` exceeds the tool's nominal 12 chars), `options[].label/description/preview` verbatim,
  `multiSelect` defaults to `false` when absent. An input with no non-empty `questions` array is
  **auto-denied** (deny message `malformed AskUserQuestion input`) and produces no card.
- **FR-8**: a `can_use_tool` request for **any other tool** is answered immediately with a deny
  `control_response` (§5.5), message
  `Francois declined: interactive permission prompts are not supported yet — adjust the session's permission mode.`
  No event, no card, no state.
- **FR-9**: a `control_request` of any **other subtype** is answered immediately with an error
  `control_response` (§5.5) so the CLI can never park on something we don't render.
- **FR-10**: a `control_cancel_request` whose `request_id` matches a pending question resolves it
  as `cancelled` (FR-13); one that matches nothing is ignored.

**Answering & resolution**

- **FR-11**: `francois:session:answerQuestion` (§5.1) looks up the pending entry by
  `blockId`. Found → write the allow `control_response` (§5.5) whose `updatedInput` is the
  **verbatim original input** plus the `answers` map, resolve the block as `answered` (store
  `answers`), persist, emit `question.resolved`, drop the pending entry — then resolve `ok`.
  Not found (unknown, already resolved, turn over) → `QUESTION_NOT_PENDING`. Empty `answers` →
  `INVALID_INPUT`. Unknown session → `SESSION_NOT_FOUND`.
- **FR-12**: the `answers` values pass through **verbatim** — an option label, free text, or for
  multi-select the selected labels joined with `", "`. The core never validates answers against
  options and never rewrites `questions`.
- **FR-13**: every pending question resolves **exactly once**: `answered` via FR-11 or `cancelled`
  via FR-10 / turn end (result, child death, interrupt, `fail_session`, app exit teardown). On
  `cancelled` the core writes **no** control_response for a dead child, and a best-effort deny for
  a live one (`control_cancel_request` case). Resolution always updates the persisted block and
  emits one `question.resolved`.
- **FR-14**: session status is **not** changed by questions — the turn remains `running` while
  parked (the spinner and elapsed timer are honest: the turn is in flight). Send-while-running
  queueing (`session_send`) is untouched.

**Transcript & hydration**

- **FR-15**: the `question` block (§5.2) carries `isStreaming: true` iff `pending`. Hydration via
  `conversation_get_transcript` returns it in its current state after any remount: `pending` while
  the core still holds the pending entry, its resolved state afterward, exactly one block per
  `blockId` (the durable-sessions upsert-by-blockId rule applies).
- **FR-16**: reducer rules are keyed idempotent upserts like every other block: `question.asked`
  inserts (replay = no-op), `question.resolved` updates state/answers (resolve before insert
  arrives out-of-order → insert resolved).

**Card UI**

- **FR-17**: the card renders every question section in order: header chip, question text, option
  rows (label + description), an `other…` free-text row, checkbox affordance when `multiSelect`.
  A `preview` on the hovered-or-selected option renders beneath the section in a monospace box;
  no option preview → no box.
- **FR-18**: submit semantics: selections accumulate per section; the card submits (one
  `answerQuestion` call) at the moment every section has an answer — which for a single
  single-select section means first click submits. While a submit is in flight further clicks are
  ignored.
- **FR-19**: `answered` state: interactions dead, chosen option(s) accent-highlighted, unchosen
  rows dimmed, free-text answer echoed in the chosen slot. `cancelled` state: interactions dead,
  whole card dimmed, `— cancelled` appended to the header row.
- **FR-20**: while any pending question card exists in the visible session, the composer
  placeholder reads `answer the question above — typed messages will queue`; it reverts when none
  is pending. Composer behavior itself is unchanged (FR-14).
- **FR-21**: a failed `answerQuestion` (`ok: false`) logs to the console and re-enables the card
  **unless** state is already resolved by an event (the §3 flow 8 race) — never an alert, never a
  stuck disabled card.

## 5. API contract

Contract file: `contract/session-questions.ts`. Shared vocabulary imported from
`contract/common.ts`; the block joins the `ConversationBlock` union in
`contract/conversation-view.ts` exactly the way `CommandConversationBlock` does.

### 5.1 Channels

| logical channel | direction | request | success `data` | error codes |
|---|---|---|---|---|
| `francois:session:answerQuestion` | frontend → core (`invoke`) | `AnswerQuestionRequest` | `null` | `SESSION_NOT_FOUND` · `QUESTION_NOT_PENDING` · `INVALID_INPUT` |
| `francois:session:event` | core → frontend (`listen`) | — | two new `SessionEvent` members (§5.3) | — |

Physical binding: `invoke('session_answer_question', { sessionId, blockId, answers })` →
`Promise<Result<null>>`; events ride the existing `francois://session/event` channel.

### 5.2 Types — `contract/session-questions.ts`

```ts
// contract/session-questions.ts — question cards (AskUserQuestion over the
// stdio control channel). Authored from specs/session-questions.md §5.
// Shapes mirror the CLI's AskUserQuestion input verbatim — do not "improve" them.

import type { BlockId, SessionId } from './common';

export interface QuestionOption {
  label: string; // display text, also the canonical answer value
  description: string; // what choosing it means
  preview?: string; // optional monospace preview content
}

export interface SessionQuestion {
  question: string; // full question text — also the key in the answers map
  header: string; // short chip label (nominally ≤ 12 chars; render verbatim)
  options: QuestionOption[]; // 2–4 in practice; render whatever arrives
  multiSelect: boolean; // true → answers joined with ', '
}

export type QuestionState = 'pending' | 'answered' | 'cancelled';

export interface QuestionConversationBlock {
  kind: 'question';
  blockId: BlockId;
  /** true iff state === 'pending' (FR-15). */
  isStreaming: boolean;
  questions: SessionQuestion[];
  state: QuestionState;
  /** Present iff state === 'answered': question text → answer string (verbatim, FR-12). */
  answers?: Record<string, string>;
}

export interface AnswerQuestionRequest {
  sessionId: SessionId;
  blockId: BlockId;
  /** question text → chosen label / free text / ', '-joined multi-select labels. */
  answers: Record<string, string>;
}
```

### 5.3 `contract/common.ts` amendments

Two members join the `SessionEvent` union (emission: FR-6, FR-13):

```ts
  | { type: 'question.asked'; sessionId: SessionId; blockId: BlockId; questions: SessionQuestion[] }
  | { type: 'question.resolved'; sessionId: SessionId; blockId: BlockId; state: 'answered' | 'cancelled'; answers?: Record<string, string> }
```

One value joins `ErrorCode`:

```ts
  | 'QUESTION_NOT_PENDING' // session-questions: answer arrived for a question that is not pending
```

Placement rule: `common.ts` never imports from feature files, and the `SessionEvent` union needs
`SessionQuestion` — so `SessionQuestion` and `QuestionOption` are **declared in `common.ts`**
(shared vocabulary, alongside `UsageMeter`), and `contract/session-questions.ts` re-exports them
(`export type { … } from './common'`) and adds the feature-only types (`QuestionState`,
`QuestionConversationBlock`, `AnswerQuestionRequest`). The §5.2 listing shows the canonical shapes;
only their file placement follows this rule.

### 5.4 Error semantics

| condition | code | message |
|---|---|---|
| unknown session | `SESSION_NOT_FOUND` | `no such session` |
| blockId not pending (unknown / resolved / turn over) | `QUESTION_NOT_PENDING` | `that question is no longer pending` |
| empty `answers` map | `INVALID_INPUT` | `answers is empty` |

The command never resolves `ok` without the control_response having been written to the child's
stdin (a write failure — dead child — resolves `QUESTION_NOT_PENDING` after FR-13 cancels the
question).

### 5.5 Wire shapes (verified against CLI 2.1.217, 2026-07-22 — implementation authority)

Turn input, written to stdin as one line after spawn (FR-1):

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<turn text>"}]}}
```

Question arrival, one stdout NDJSON line; the turn parks until answered:

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Which color do you prefer?","header":"Color","options":[{"label":"Red","description":"The color red"},{"label":"Blue","description":"The color blue"}],"multiSelect":false}]},"tool_use_id":"toolu_…"}}
```

Answer (FR-11) — `updatedInput` = verbatim `input` + `answers`:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<same uuid>","response":{"behavior":"allow","updatedInput":{"questions":[…verbatim…],"answers":{"Which color do you prefer?":"Blue"}}}}}
```

Deny (FR-7 malformed / FR-8 other tools):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<same uuid>","response":{"behavior":"deny","message":"<FR-8 message>"}}}
```

Unsupported subtype (FR-9):

```json
{"type":"control_response","response":{"subtype":"error","request_id":"<same uuid>","error":"unsupported control request"}}
```

Cancellation from the CLI (FR-10):

```json
{"type":"control_cancel_request","request_id":"<uuid of the cancelled request>"}
```

Facts established by probing: without `--permission-prompt-tool stdio` the headless toolset has no
`AskUserQuestion`; with it the init `tools` array gains `AskUserQuestion` (and `EnterPlanMode` /
`ExitPlanMode` — see non-goals); an unanswered request parks the turn indefinitely (no default
timeout) and stdin EOF ends the process.

## 6. Data & state

**Core (Rust, `src-tauri/`)**

- Turn state (`TurnHandle` or sibling): the child stdin writer + a `pending_questions:
  HashMap<BlockId, PendingQuestion { request_id, input: Value }>` per session. Writes to stdin are
  serialized behind one mutex (reader-thread denies vs. command-thread answers).
- The reader thread gains `control_request` / `control_cancel_request` match arms (today they fall
  into `_ => {}`).
- Question blocks persist through the existing durable-sessions transcript append/upsert path;
  pending entries themselves are in-memory only — a dead process has no answerable questions.

**Frontend (`src/`)**

- No new store slice: blocks live in the existing transcript reducer
  (`src/conversation-blocks.ts` gains `questionAsked` / `questionResolved` actions).
- Card-local selection state (per-section picks, free-text values, in-flight flag) is component
  state in a new `src/QuestionCard.tsx`; pure submit/selection logic in `src/question-card.ts`
  so it is vitest-testable.
- `src/api.ts` gains `sessionAnswerQuestion(sessionId, blockId, answers)`.

## 7. Edge cases & errors

| # | situation | behavior |
|---|---|---|
| 1 | Non-`AskUserQuestion` permission ask (any tool, any mode) | Instant deny on the channel (FR-8); invisible in the UI; Claude sees the denial text — pre-feature parity. |
| 2 | Malformed question input | Deny (FR-7); no card; turn continues. |
| 3 | Answer races CLI cancellation | Core resolves `QUESTION_NOT_PENDING`; card already flipped `cancelled` by the event; no user-visible error (FR-21). |
| 4 | Interrupt with a pending question | Child killed → FR-13 cancels; card `cancelled`. |
| 5 | App quits with a pending question | Existing exit teardown kills the child; on next launch the transcript shows the block `cancelled` (its last persisted state per FR-13's teardown, which runs before exit). |
| 6 | Two `AskUserQuestion` calls park concurrently (subagent + main) | Two independent cards; each keyed by its own blockId/request_id (FR-6). |
| 7 | Typed message while pending | Queues (FR-14); composer hint (FR-20); no deadlock: answering the card drains the queue as the turn ends normally. |
| 8 | `question.resolved` replay / out-of-order | Reducer upserts are idempotent; resolve-before-ask inserts the resolved block (FR-16). |
| 9 | stdin write fails (child died between park and answer) | FR-13 cancellation path; command resolves `QUESTION_NOT_PENDING`. |
| 10 | WSL session | Identical; stdin traverses `wsl.exe` (FR-3). |
| 11 | `/compact` after this change | Same stdin framing; must behave as before (FR-5; covered by a manual check in review). |
| 12 | Option with `preview` | Monospace preview box on hover/selection (FR-17); ignored otherwise. |

## 8. Design brief

No question treatment exists in the mock (`Claude Terminal.dc.html`); the card inherits the
command-card visual language from `specs/interactive-commands.md` §8 and the app tokens
(`src/styles.css`). JetBrains Mono throughout.

### Components & states

1. **Question card** (transcript block, full transcript width): bordered container like a command
   card — `background:#12141a; border:1px solid #24262d; border-radius:4px; padding:10px 12px;`
   with an accent left edge while pending: `border-left:2px solid #c8a15a`. Header row:
   `QUESTION` label (`color:#565a63; font-size:9.5px; letter-spacing:.08em;`) + one chip per
   section header (`color:#c8a15a; border:1px solid #3a3325; border-radius:3px; padding:0 6px;
   font-size:9.5px;`). Cancelled: whole card `opacity:0.55`, header row gains `— cancelled`
   (`color:#565a63`).
2. **Question section**: question text `color:#c4c7ce; margin:8px 0 6px;`. One per entry in
   `questions`, stacked with `12px` gaps.
3. **Option row**: `display:flex; gap:8px; padding:4px 8px; border-radius:3px; cursor:pointer;`
   label `color:#dfe2e8;`, description `color:#868a93;`. Hover: `background:#1a1d24`. Selected
   (multi-select or completed single pick): label `color:#c8a15a;` + leading glyph `▸`
   (single-select) / `☑`·`☐` (multi-select, `color:#c8a15a`/`#565a63`). Answered-state chosen row
   keeps the accent; unchosen rows `opacity:0.45`. No looping animation anywhere (the
   `src/styles.css` header rule).
4. **Other row**: `other…` in `color:#565a63; font-style:italic;`; expands on click to an inline
   input (`background:#0f1015; border:1px solid #24262d; color:#dfe2e8; padding:2px 6px;` width
   100%). Enter commits (FR-18), Escape collapses.
5. **Preview box** (FR-17): `background:#0f1015; border:1px solid #24262d; padding:8px;
   white-space:pre; overflow-x:auto; font-size:10.5px; color:#b9bcc4; margin-top:6px;`.
6. **Submit affordance** (only when the last click cannot submit — i.e. multi-select present):
   right-aligned `answer ↵` text button, `color:#c8a15a`, `opacity:0.4` until every section has
   ≥ 1 selection; never shown for pure single-select cards.
7. **Composer placeholder** (FR-20): existing placeholder style, text
   `answer the question above — typed messages will queue`.

### Interactions & motion

- Click option (single-select) → select; if that completes the card, submit (FR-18).
- Click option (multi-select) → toggle; submit via the `answer ↵` affordance.
- In-flight: card `opacity:0.7`, clicks ignored; restored on failure (FR-21).
- **Motion: none** — state changes are instant swaps, consistent with the no-animation rule.

### Responsive

Cards span the transcript column; option descriptions wrap; previews scroll horizontally inside
their box (`overflow-x:auto`), never the transcript.

## 9. Acceptance criteria

- [ ] A session turn's spawn includes `--input-format stream-json --permission-prompt-tool stdio`,
      pipes stdin, passes no positional prompt, and writes the §5.5 user line (FR-1).
- [ ] The stdin handle closes at turn end and never earlier; a parked turn's child outlives an
      arbitrarily long wait (FR-2, no-timeout non-goal).
- [ ] Feeding the reader the §5.5 `control_request` fixture yields exactly one `question.asked`
      with verbatim questions and a buffered+persisted pending block (FR-6, FR-7).
- [ ] A `can_use_tool` fixture for `Bash` yields a deny control_response on stdin, no event, no
      block (FR-8); an unknown-subtype fixture yields the error response (FR-9).
- [ ] `session_answer_question` writes the §5.5 allow response with verbatim `updatedInput` +
      `answers`, resolves the block `answered`, emits one `question.resolved`, and returns ok
      (FR-11, FR-12).
- [ ] Answering twice → second resolves `QUESTION_NOT_PENDING`; empty answers → `INVALID_INPUT`;
      bad session → `SESSION_NOT_FOUND` (§5.4).
- [ ] Turn end / interrupt / `control_cancel_request` with a pending question → block `cancelled`,
      one `question.resolved`, pending entry gone (FR-10, FR-13).
- [ ] Serde round-trips: both new event members and the `question` block serialize to the §5.2/§5.3
      shapes exactly (absent `answers` omitted, not `null`).
- [ ] Reducer: `questionAsked` idempotent insert; `questionResolved` updates in place; resolved
      arriving first inserts resolved (FR-16) — vitest.
- [ ] Submit logic: single single-select submits on first click; multi-question waits for all;
      multi-select joins with `', '`; free text passes verbatim (FR-12, FR-18) — vitest.
- [ ] Hydration after remount shows `pending` while pending and the resolved state after (FR-15).
- [ ] Composer placeholder swaps while a pending card exists and reverts after (FR-20).
- [ ] `cancelled` and `answered` cards are inert; a failed answer re-enables unless already
      resolved (FR-19, FR-21).
- [ ] No `@keyframes`/`animation`/`transition` in the card's CSS (§8 motion rule).

## Remediation

### Round 1 — `/review` 2026-07-23 (verdict SHIP · 0 critical · 0 security · 4 medium · 4 low)

Two review agents (core + frontend) both returned SHIP. All findings are quality/coverage —
non-blocking — and shipped **deferred, tracked** (same disposition as usage-bar Round 1):

- [ ] MEDIUM · `src-tauri/src/session.rs` `session_answer_question` · test-coverage · The §5.4 error
      branches (double-answer → `QUESTION_NOT_PENDING`, empty map → `INVALID_INPUT`, unknown session)
      and the exactly-once `pending_questions.remove()` claim across the four resolution paths have no
      unit test. Extract the claim + error-branch logic into a pure helper over
      `&mut HashMap<BlockId, PendingQuestion>` and test double-claim / empty / unknown.
- [ ] MEDIUM · `src/question-card.ts:66,80` · correctness · `allComplete`/`shouldAutoSubmit` are
      vacuously `true` for an empty `sel` (`[].every` ⇒ true), so a desynced/empty selection could
      auto-submit an empty answer the core accepts verbatim (FR-12). Unreachable today only because
      FR-7 guarantees ≥ 1 question. Make the gate length-aware
      (`questions.length > 0 && sel.length === questions.length && …`).
- [ ] MEDIUM · `src/QuestionCard.tsx:109` · spec-violation · Escape clears the draft but not a
      **committed** multi-select `freeText`, so §3 flow 4 ("Escape empties and collapses") can't
      retract a committed free-text answer. Add `clearFreeText(questions, sel, i)` and call it from
      `onDismiss`.
- [ ] MEDIUM · `src/styles.css` `.qopt-label{flex-shrink:0}` · spec-violation · A long verbatim
      option label (FR-7) overflows the card into the transcript's horizontal scroll (§8 Responsive
      says content scrolls inside its box, never the transcript). Use `min-width:0;
      overflow-wrap:anywhere;` on the label and let `.qopt-desc` absorb the slack.
- [ ] LOW · `src/QuestionCard.tsx:194` · quality · Option rows keyed by `o.label`; duplicate labels
      (FR-7 renders verbatim) collide. Key by index — rows never reorder within a section.
- [ ] LOW · `src/question-card.ts:174` · quality · `composerPlaceholder(status: string)` should take
      `SessionStatus` so a renamed status fails typecheck instead of silently defaulting.
- [ ] LOW · `src-tauri/src/session.rs` `session_compact` · quality · `/compact` now spawns with the
      control channel on and drops stdin immediately; a `control_request` there couldn't be answered
      (EOF ends it, no hang, but the compact result would be lost). Either omit the control flags for
      compact spawns or drain-and-deny. §7 #11 manual check before relying on it.
- [ ] LOW · `src-tauri/src/session.rs` `session_remove`→`resolve_question` · quality · Removal deletes
      the session before the FR-13 drain, so a trailing `question.resolved` is emitted after
      `session.removed` (benign; frontend already discarded the session). Optionally drain
      `pending_questions` inside `session_remove` first, as `kill_all` does.
