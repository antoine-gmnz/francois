# REVIEW REPORT
feature_id: agent-tab · round 2 · surfaces: frontend + core

Base: merge-base of `main` and `feat/agent-tab` (`7a8e8f8`) — `main` has since advanced with
unrelated commits, so a two-dot diff would have over-scoped the review.

| Severity | Count |
| -------- | ----- |
| CRITICAL | 0     |
| HIGH     | 0     |
| MEDIUM   | 1     |
| LOW      | 3     |

Verdict: **SHIP** (frontend SHIP · core SHIP)

Gates re-run by the lead at merge time: `npx tsc --noEmit` clean · `npm test` 506/506 passing ·
`cargo test` 321 passed, 0 failed, 1 ignored.

## Findings

- **[MEDIUM]** `src/features/agents/agent-tab.ts:14` (and `:83`) · quality · `agentTabId` returns
  plain `string` (not the `` `agent:${string}` `` literal type) and `mainTabAfterClose` returns plain
  `string` (not `MainTab`), forcing five unchecked `as MainTab` / `as typeof mainTab` casts at every
  call site (`src/lib/store.ts:259,268,274,300`, `src/app/App.tsx:404`) instead of the compiler
  proving the value is a valid `MainTab`. A typo in `TAB_PREFIX` or a bad return elsewhere would
  compile silently. → **Fix:** type ``agentTabId(agentId: string): `agent:${string}` `` and change
  `mainTabAfterClose`'s signature to `(current: MainTab, closedIds: string[] | null): MainTab` (it
  already only ever returns `current` or the literal `'session'`), then drop the five
  `as MainTab` / `as typeof mainTab` casts.

- **[LOW]** `src/app/App.tsx:655` · spec-violation (design) · §8 says an agent tab uses "the same
  `tabStyle` as the built-in tabs (11px, `0.14em` letter-spacing, 700, 2px bottom border …)" as its
  baseline (the name segment alone is exempted from letter-spacing/upper-case) — `AgentTabChip`'s
  style sets `fontWeight: 500`, not `700`. → **Fix:** change `fontWeight: 500` to `fontWeight: 700`
  in `AgentTabChip`'s style object.

- **[LOW]** `src/features/agents/AgentView.tsx:216` · spec-violation (design) · §8's "Notice row"
  spec is `· glyph … + text …, font-size: 10.5px, padding: 2px 0`; the row's wrapping `div` has no
  `padding` at all. → **Fix:** add `padding: '2px 0'` to the notice row's outer `div` style in
  `AgentBlockRow`.

- **[LOW]** `src/features/agents/AgentView.tsx:194` · spec-violation (design) · §8's "Empty" state
  spec is `no activity yet …, centered, var(--text-faint)`; the div is rendered as a plain flow child
  of the scroller (`display:flex; flexDirection:column`, no `alignItems`/`justifyContent: center` on
  the scroller and no `textAlign: center` on the div), so it renders top-left rather than centered.
  → **Fix:** either wrap the empty-state branch in a centering container (`flex:1, display:flex,
  alignItems:center, justifyContent:center`) or add `alignItems: 'center', justifyContent: 'center'`
  conditionally to the scroller when `state.blocks.length === 0`.

## Core surface — no findings

Spec conformance verified point-by-point. `push_step` centrally mints the FR-4 notice block so all
four notice sites (dispatch, completion, turn-end, kill) are structurally guaranteed and each has
explicit test evidence (`agents.rs` for three; `turn.rs::fail_session_finalizes_running_agents_before_terminal_status`
for the turn-end site via `finalize_agents`). FR-1/FR-2/FR-3 (full-text assistant blocks,
tool/subagent classification via `is_subagent_tool`, streaming→filled meta via the shared `block_id`
riding on `InnerTool`) match both the unit tests in `agent_transcript.rs` and the integration test
`agents.rs::attributed_line_also_builds_the_agent_tab_transcript`. FR-5 windowing/eviction/`dropped`
counter matches the acceptance criterion exactly (450 in → 400 out, starting `a1:51`, `dropped: 50`).
FR-7 `AGENT_NOT_FOUND` and the command-handler locking pattern are byte-identical to the precedent
`agents_activity`/`activity_of`. FR-8's `AgentEvent::Block` serializes to the exact contract shape
(`type/sessionId/agentId/block`), verified against `contract/agent-tab.ts`; `classify_block`'s
`Tool`/`Subagent`/`Notice` arms serialize field-for-field identically to
`contract/conversation-view.ts`'s `ToolConversationBlock`/`SubagentConversationBlock` and
`contract/agent-tab.ts`'s `AgentNoticeBlock`. FR-6 (nothing persisted) is honored: `persistence.rs`'s
`Notice` arm is exhaustiveness-only dead code since notices only ever live in `agent_blocks`, never
`block_buffer`, and `agent_blocks`/`agent_block_seq`/`agent_blocks_dropped` are correctly
zero-initialized in both `session_create` and `load_persisted`. Module layout follows convention:
shared data-model additions (`InnerTool.block_id`, `AgentEmission::Block`, `BlockKind::Notice`,
`agent_blocks*`) live in `mod.rs`; `agent_transcript.rs` owns its own concern plus its own
`#[cfg(test)] mod tests`; the shared `emitted_blocks` helper was added to `testutil.rs`.

## Notes

Not applicable — `rbac.enabled: false`, and mobile-first is out of scope for this desktop app
(`core` is not a `uses_design: true` surface).

## DoD status at this verdict

Ticked by this review + the green gates above: FR-1, FR-2/FR-3, FR-4, FR-5/FR-20, FR-7, FR-10
(no-duplicate half), FR-11, FR-13, FR-14, FR-17.

**Left open — no `/smoke` ran this cycle**, so the runtime-only flows are unverified:
- clicking a pane [3] card moves focus to main (FR-10's focus half)
- the body auto-scrolls to the newest block but not while scrolled up (FR-18)
- `⏎` in pane [3] still expands the in-place trail and opens no agent tab (§2)
