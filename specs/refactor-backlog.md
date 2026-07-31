# Refactor backlog

Deferred, non-blocking findings parked at a SHIP verdict. Each entry is tagged
`deferred:<feature-id>` and carries its own `file:line` · severity · concrete fix, so it can be
picked up by `/refactor` without re-reading the original review report.

## deferred:session-attachments

Parked at the `/review` SHIP verdict (2026-07-30). None are CRITICAL/HIGH or security. The one
MEDIUM finding from that review (missing `is_absolute()` guard in `ingest_path`) was **not** deferred
— it is being fixed in the same cycle.

- **[LOW]** `src-tauri/src/session/attachments/paths.rs:59` (`attachment_kind_for_name`) /
  `contract/session-attachments.ts:136` · quality · a clipboard paste whose mime maps to an extension
  outside the FR-5 allowlist (e.g. `image/bmp` → `.bmp` via `extension_for_mime`) is classified
  `kind: "file"` even though FR-6 treats it as a pasted screenshot, so it never gets an asset-scope
  thumbnail grant (`asset_scope.rs` filters on `kind == "image"`). → **Fix:** either drop
  `bmp`/similar from `extension_for_mime`'s fallback set (normalize unknown mimes straight to `png`)
  or extend the FR-5 image-extension list in both the contract and `paths.rs` to include them,
  keeping the two in sync.

- **[LOW]** `src/features/conversation/attachments.ts:1024-1028` (`refusalLine`) · quality · the
  `ATTACHMENT_TOO_LARGE` single-failure branch computes `size` via a ternary on `bytes === undefined`
  and then immediately re-branches on the same condition to pick the return string, duplicating the
  check. → **Fix:** collapse to one branch (`return bytes === undefined ? … : …`) and drop the
  intermediate `size` variable.

## deferred:agent-tab

Parked at the round-2 `/review` SHIP verdict (2026-07-29). None are CRITICAL/HIGH or security.

- **[MEDIUM]** `src/features/agents/agent-tab.ts:14` (and `:83`) · quality · `agentTabId` returns
  plain `string` (not the `` `agent:${string}` `` literal type) and `mainTabAfterClose` returns plain
  `string` (not `MainTab`), forcing five unchecked `as MainTab` / `as typeof mainTab` casts at every
  call site (`src/lib/store.ts:259,268,274,300`, `src/app/App.tsx:404`) instead of the compiler
  proving the value is a valid `MainTab`. A typo in `TAB_PREFIX` or a bad return elsewhere would
  compile silently. → **Fix:** type ``agentTabId(agentId: string): `agent:${string}` `` and change
  `mainTabAfterClose`'s signature to `(current: MainTab, closedIds: string[] | null): MainTab` (it
  already only ever returns `current` or the literal `'session'`), then drop the five
  `as MainTab` / `as typeof mainTab` casts.

- **[LOW]** `src/app/App.tsx:655` · spec-violation (design) · `specs/agent-tab.md` §8 says an agent
  tab uses "the same `tabStyle` as the built-in tabs (11px, `0.14em` letter-spacing, 700, 2px bottom
  border …)" as its baseline (the name segment alone is exempted from letter-spacing/upper-case) —
  `AgentTabChip`'s style sets `fontWeight: 500`, not `700`. → **Fix:** change `fontWeight: 500` to
  `fontWeight: 700` in `AgentTabChip`'s style object.

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

## deferred:session-worktree

_(un-parked 2026-07-30 — both findings moved back to `specs/session-worktree.md` § Remediation round 7
and run through `/fix`; see that spec for current status.)_

## deferred:test-flake — store tests near the vitest default timeout

_(parked 2026-07-30 during `/fix session-attachments` round 5. **Not caused by that feature** — it
touches none of the modules involved. Recorded here rather than as a Remediation item so it does not
re-trigger that feature's fix loop.)_

- **[LOW]** `src/lib/projectsStore.test.ts`, `src/lib/overviewStore.test.ts`, `src/lib/theme.test.ts`
  · quality (flake) · the "empty storage" defaults tests each pay a cold `resetModules` + dynamic
  import transform cost and land close to vitest's 5000 ms default `testTimeout` (observed 4072 ms,
  4106 ms, 1704 ms). Under machine load one can cross it, so the suite fails intermittently with no
  code change. Observed twice on 2026-07-30 (once 1/921, once 2/921) and **not reproduced in 5
  consecutive clean runs** either side, which is what makes it a flake rather than a regression — and
  also what makes it dangerous: it will surface as a red CI run on an unrelated PR.
  → **Fix:** give those tests an explicit generous `testTimeout`, or warm the dynamic import once in
  a `beforeAll` so the transform cost is not inside the timed assertion.

## deferred:session-attachments — SHIP-round leftovers (review round 7)

_(un-parked 2026-07-30 — all three findings moved back to `specs/session-attachments.md`
§ Remediation round 8 and run through `/fix`; see that spec for current status.)_
