---
id: session-switch-loader
title: Session switch loader
status: shipped
branch: feat/session-loader
created: 2026-08-26
depends_on: [conversation-view, transcript-scale, transcript-perf, durable-sessions, design-refresh]
reviewed_base: 275abc6fdb8643ba5c554890f7c0118a4defe22f
reviewed_digest: 661b211f337859e7
design_files: ["https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html"]
---

# Session switch loader

## 1. Summary

Switching to a session whose transcript is not already in memory paints a **blank column** for as long
as the fetch takes. `ConversationView` is keyed by `sessionId`, remounts with an empty reducer, awaits
`conversation:getTranscript`, and has no branch for `!hydrated` — so it falls through to mapping zero
items. At ~300ms that reads as a hang, and there is nothing on screen saying the app is working.

This adds the missing third branch: design turn **18a — "Skeleton turns"**. Two static skeleton turns
drawn on the transcript's real geometry, pinned to the bottom so arriving turns replace bars in place;
a single 2px indeterminate hairline under the chrome as the only motion in the pane; and a composer
that says out loud you can start typing while it lands. Frontend-only — no IPC, no contract file, no
Rust.

## 2. Goals & non-goals

**Goals**

- A cold session switch shows transcript-shaped structure instead of a blank column.
- The affordance never fires for a load too short to perceive, and never for a session that has
  nothing to load.
- No new dependency, no shimmer, no layout jump when the real transcript lands.

**Non-goals**

- **Design 18b — the "known facts" card.** The alternative in the same design section (a `#101319`
  card of `SessionMeta` facts, a two-step `fetching → rendering` progress list, and a `large session ·
  12.4K blocks` line past 4s). Refused: the block count it hangs on does not exist in any payload the
  core sends, so it buys a core change for a surface that is on screen for under a second. Recorded
  here so a future spec does not re-litigate it.
- **Agent / workflow tab transcripts.** They have the same blank beat and can adopt this later; the
  mock is drawn as the session pane and this ships there first.
- **DIFF and SHELL tabs.** Their latency is a git probe and a PTY spawn — different shapes, not this
  skeleton.
- **The "earlier blocks" fetch** (`activateEarlier()`). It already has its own row affordance
  (`EarlierBlocksRow`); a second indeterminate bar would compete with it.
- Any change to when the composer is enabled. It is already gated on terminal status, not on
  `hydrated` — this only changes what it *says*.

## 3. User stories / flows

**Cold switch (the case this feature exists for).** The user clicks a session in pane [1] that
`SessionViewHost` is not holding. The pane's chrome (topbar, tab segment, composer) paints
immediately — it needs no transcript. The transcript column stays empty. At **140ms** a 2px hairline
appears under the chrome with a thumb creeping left-to-right, and two skeleton turns fade in pinned to
the bottom of the column. The composer placeholder reads *"restoring transcript — you can start
typing"*; the hint bar's right slot reads *"reading last 200 of the session"*. The user can type and
send during all of this. When the transcript lands, the skeleton and the hairline are replaced by the
real turns at the same bottom-pinned position, the placeholder reverts, and the hint slot clears.

**Warm switch.** The session is one of the `MRU_CAP = 3` sessions `SessionViewHost` holds. It is
already hydrated, so nothing above happens — no skeleton, no hairline, no placeholder change.

**Fast switch.** The transcript lands in under 140ms. Nothing renders but the real turns — the user
never sees a loading state at all.

**New session.** A session that has never run a turn hydrates to empty and then shows the
`WelcomeBlock`. No skeleton at any point: two fake turns would claim a history that does not exist.

**Failed hydration.** Unchanged — `hydrationError` still wins, and the centred error text replaces
everything.

## 4. Functional requirements

**FR-1 — The third branch.** `ConversationView`'s transcript column gains a branch for
`!hydrated && hydrationError === null`, ordered **after** the `hydrationError` branch and **before**
the `hydrated && blocks.length === 0` welcome branch. It renders `<TranscriptSkeleton />` in place of
the items map.

**FR-2 — The 140ms gate.** The skeleton branch renders only once hydration for this session has been
in flight for **≥140ms**. Below that the column renders nothing (today's behaviour). The timer starts
when the hook's hydration effect fires for a `sessionId`, and is cleared when `hydrated` flips, when
`hydrationError` is set, and on unmount. A `sessionId` change restarts it.

**FR-3 — Known-empty suppression.** The skeleton and the hairline are suppressed entirely — at any
elapsed time — when this session's `SessionMeta.contextUsedTokens === 0`, or when no `SessionMeta` for
this session is in the roster. Both mean "the app cannot show that a transcript exists", and the
degrade is to today's blank column, never to fabricated turns.

**FR-4 — Two skeleton turns, fixed.** The skeleton always draws exactly two turns: an older one at
`opacity: .55` and a latest one at full opacity, in that order. It is **not** scaled to the session's
real turn count and no turn count is persisted to make it so. Stated cost: a session with one turn
still gets two bars, and a 400-line turn still gets three body bars — the bars are a rhythm, not a
prediction.

**FR-5 — Bottom-pinned, no jump.** The skeleton stack uses `justify-content: flex-end` in the same
scroll container the real transcript uses, because hydration lands bottom-pinned (`isPinned` starts
`true`). Replacing the skeleton with the real turns must not scroll the container or shift the
composer.

**FR-6 — No shimmer.** Every skeleton bar is a static fill. No `@keyframes` touches the bars, matching
the precedent `cloud-sessions.css` set for the adopt list: a skeleton that moves reads as activity in
the thing it stands for.

**FR-7 — One indeterminate hairline.** A 2px full-width element sits between the chrome and the
transcript column, with a thumb 30% of the track width animated left-to-right on a 1.5s
ease-in-out loop. It mounts and unmounts with the skeleton — same gate (FR-2), same suppression
(FR-3) — and covers **initial hydration only**. It is the only motion in the pane besides the composer
caret.

**FR-8 — Composer placeholder.** While the skeleton is showing, the composer placeholder reads
`restoring transcript — you can start typing`. It reverts to the normal placeholder the moment
`hydrated` flips. The composer's `disabled` state is untouched: typing, pasting, attaching and sending
behave exactly as they do today.

**FR-9 — Hint-bar slot.** While the skeleton is showing, the composer hint bar's right-aligned slot
reads `reading last ${RENDER_WINDOW} of the session`, derived from the existing `RENDER_WINDOW`
constant — never a literal `200`. The slot clears on `hydrated`.

**FR-10 — Unknown meters render `—`.** Any meter this pane renders whose value it cannot resolve while
unhydrated renders an em dash, never `0`. A zero that means "not known yet" is a wrong reading, not a
missing one.

**FR-11 — Error unchanged.** `hydrationError` continues to win over every state above; setting it
tears down the skeleton and the hairline in the same render.

**FR-12 — Held sessions never flash.** A transcript held hidden by `SessionViewHost` stays hydrated,
so returning to it renders no skeleton, no hairline and no placeholder change.

**FR-13 — One reusable delay primitive.** The 140ms gate is implemented as
`src/lib/hooks/useDelayedFlag.ts` — `useDelayedFlag(active: boolean, delayMs: number): boolean` —
rather than an inline timer inside the transcript hook, so the next surface that needs a
below-threshold suppression reuses it. It owns its own cleanup and never leaks a timer across a
`sessionId` change.

## 5. API contract

**No contract file, no IPC channel, no Rust change.** `contract/session-switch-loader.ts` is
deliberately **not** created: this feature adds no payload, no verb and no event. `/cohorte-build`'s
contract step is a no-op for it, and the `core` surface is not dispatched.

Everything it needs already crosses the boundary:

| existing surface | where | what this feature reads |
|---|---|---|
| `francois:conversation:getTranscript` → `TranscriptPage` | `contract/conversation-view.ts` | nothing new — only *whether* it has resolved (`hydrated`) |
| `SessionMeta.contextUsedTokens` | `contract/common.ts` | the known-empty signal (FR-3) |
| `RENDER_WINDOW` | `src/features/conversation/conversation-blocks.ts` | the hint-bar figure (FR-9) |

If a later spec wants 18b, it is that spec that earns a contract change (a block count on
`TranscriptPage`) — not this one.

## 6. Data & state

All frontend, all ephemeral. Nothing is persisted and nothing is added to any store.

- `useDelayedFlag(active, 140)` — one `useState` + one `setTimeout` in
  `src/lib/hooks/useDelayedFlag.ts` (FR-13).
- `useConversationTranscript` exposes one new derived boolean, `showSkeleton`, computed as
  `delayedActive && !hydrated && hydrationError === null && !knownEmpty`. It is derived per render
  from state the hook already holds plus one `useStore` read for `contextUsedTokens` — no new reducer
  action, no new hook state beyond the timer's.
- `TranscriptSkeleton` (`src/features/conversation/TranscriptSkeleton.tsx`) is **pure and stateless**:
  it takes no props and renders fixed markup. Its geometry lives in `conversation.css` under a
  `conv-skel*` block.
- The hairline (`conv-hydrating-bar`) is markup in `ConversationView`, rendered on the same
  `showSkeleton` boolean.

> No new surface is needed — everything lands in `src/features/conversation/` and `src/lib/hooks/`.

## 7. Edge cases & errors

| case | behaviour |
|---|---|
| Hydration resolves in <140ms | Nothing loading-shaped ever renders; the real turns paint directly. |
| Hydration resolves while the skeleton is up | Skeleton + hairline unmount in the same render as the items map appears; container scroll position and composer height must not change (FR-5). |
| `hydrationError` set while the skeleton is up | Skeleton + hairline unmount; the centred error text renders (FR-11). |
| Session has run turns but `contextUsedTokens` is `0` (adopted cloud session, usage never reported) | Suppressed — degrades to today's blank column. Deliberate: the safe direction is showing less, never showing turns that may not exist. |
| Session switched again while the skeleton is up | The outgoing transcript unmounts with its timer; the incoming one starts a fresh 140ms gate. No timer survives the switch (FR-13). |
| Session is held by `SessionViewHost` | Already hydrated — no loading state (FR-12). |
| App cold start hydrating several sessions | Same path per session; only the visible one renders a skeleton, since the hidden held mounts render nothing on screen. |
| `prefers-reduced-motion: reduce` | The hairline thumb stops animating and renders as a static 30% fill. The bars are already static (FR-6). |
| Transcript lands empty on a session whose `contextUsedTokens > 0` | Skeleton is replaced by the `WelcomeBlock` — correct, and the only case where the two-turn rhythm was briefly wrong. |

## 8. Design brief

> full brief: `specs/design/session-switch-loader.md`

Design turn **18a — TRANSCRIPT LOADING**, "The blank beat after a session switch", from
`Francois Redesign.dc.html` (the local mirror at the repo root is stale — it ends at turn 9; the
extracted section is `.design-turn18a.html`, gitignored).

Two skeleton turns on the transcript's real geometry — a `20px 1fr` grid with the literal gutter
glyphs `›` and `⏺`, a header strip (bar · 1px rule · bar), body lines at varying widths, and a
tool rail on the latest turn — stacked bottom-pinned, older turn at `opacity: .55`. Bar fills step
darker with depth, from `--border-emphasis` down. Above them a 2px hairline whose 30%-wide olive
(`--accent`) thumb creeps across a `#131720` track. Below, the composer with the placeholder
*"restoring transcript — you can start typing"* and a blinking `--accent` caret, over a hint bar
reading `⏎ send when ready` · `esc back to previous session` · *"reading last 200 of the session"*.
Every colour is an existing token in `src/styles.css`; no new token, no new glyph, no asset.

## 9. Acceptance criteria

- [x] Switching to a cold session with a slow transcript shows two bottom-pinned skeleton turns and a
      creeping hairline, not a blank column (FR-1, FR-4, FR-5, FR-7).
- [x] A transcript that resolves in <140ms renders no loading state at all (FR-2).
- [x] A session with `contextUsedTokens === 0`, and a session with no `SessionMeta`, render no
      skeleton however long hydration takes (FR-3).
- [x] `grep -r "@keyframes" src/features/conversation/conversation.css` matches nothing that targets a
      `conv-skel` bar; the only new animation is the hairline thumb (FR-6).
- [x] The composer accepts and sends a prompt while the skeleton is up, and its placeholder reverts on
      `hydrated` (FR-8).
- [x] The hint-bar figure changes when `RENDER_WINDOW` changes — it is not a literal (FR-9).
- [x] Switching back to a held session shows no skeleton (FR-12).
- [x] `useDelayedFlag` has unit tests covering: flips true after the delay, never flips when `active`
      goes false first, and clears its timer on unmount and on an `active` identity change (FR-13).
- [x] `showSkeleton` has unit tests for each of its four inputs in isolation.
- [x] Under `prefers-reduced-motion: reduce` the hairline thumb is static (§7).
- [x] `npm run quality` and `npm test` are green; no new file crosses the 1000-line cap.

## Remediation

(Empty until a review returns findings.)

### 2026-08-26 — cohorte-loop round 1

- [x] CRITICAL · specs/reports/session-switch-loader.core.diff:1 · spec-violation · Re-stage specs/reports/session-switch-loader.core.diff as `git diff HEAD` (or the true feat/session-switch-loader branch point) instead of a stale `git diff main`; per spec §5 this surface should produce an empty diff for this feature, so confirm empty and skip/close the core review rather than reviewing shipped, unrelated code. — fixed: re-staged to HEAD; empty as required

### 2026-08-27 — cohorte-loop round 2

- [x] CRITICAL · specs/reports/session-switch-loader.frontend.diff:1 · spec-violation · Re-stage with `git diff HEAD` (or the correct merge-base against main) so the diff contains only session-switch-loader's hunks, then re-run review. — fixed: re-staged with only session-switch-loader files
- [x] CRITICAL · specs/reports/session-switch-loader.core.diff:1 · spec-violation · Re-stage specs/reports/session-switch-loader.core.diff as `git diff HEAD` (or the branch point off main); per spec §5, the correct core diff for this feature is empty — skip/close the core review rather than re-dispatch it. — fixed: re-staged to HEAD; empty as required
