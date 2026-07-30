# Refactor plan — Francois

Cleanup pass before the next feature wave. Derived from a six-agent audit of `src/`,
`src-tauri/src/`, and `src/styles.css` (2026-07-29).

---

## STATUS (updated 2026-07-30, round 2) — read before resuming

All four gates are green: `cargo check --all-targets` (no warnings), `cargo test` **349**,
`npx tsc --noEmit`, `npm test` **699**.

**Round 2 — Phase 4c + Phase 5 complete, Phase 6 leftovers complete except the lock dedup**

Nine agents, file-disjoint. Component decomposition (§6c), all §7 dispatch tables, and the
`stream.rs` / `remote.rs` function splits landed:

| file | before | after |
|---|---|---|
| `ProjectsModal.tsx` | 644 | 206 |
| `McpPanel.tsx` | 637 | 394 |
| `App.tsx` | 572 | 234 |
| `DiffView.tsx` | 563 | 223 |
| `Sidebar.tsx` | 556 | 177 |
| `AgentsPanel.tsx` | 510 | 235 |
| `SkillsPanel.tsx` | 419 | 272 |
| `ConversationView.tsx` | 409 | 235 |

- `session/stream.rs` (806) → `stream/{mod,lines,blocks,tool_results}.rs`; `run_reader` and
  `handle_stream_event` are orchestrators over one named handler per arm.
- `session/remote.rs` (888) → `remote/{mod,start}.rs`; `remote_start` is an orchestrator over
  `spawn_host_process` + three named thread helpers. Lock scope unchanged (§9 item 2).
- The six dormant `sessions/` modules are wired into `Sidebar.tsx` at last. **Two had drifted
  from Sidebar's live code and would have shipped regressions**: `SessionListBody` had lost the
  `truncate` class on the name span, and `SessionContextMenu` had dropped its
  `onClick={e => e.stopPropagation()}` — without which a click on "Remove session" bubbles to the
  window-level outside-click listener in the same dispatch and instantly re-closes the menu.

**⚠ Still open — `Engine::with_session_mut` adoption is HALF DONE**

The helper and its read-only sibling `with_session` exist in `session/mod.rs:626-648` with tests,
and **~41 of the ~78 call sites** are converted (`mod`, `mcp`, `turn`, `stdio`, `agents`,
`skills`, `usage_probe`, `slash`, `commands/{lifecycle,decisions,queries}`). The agent doing the
sweep was interrupted; the tree is green and coherent, but these remain raw:

- `commands/turn.rs` (9), `stream/{lines,blocks,tool_results,mod}.rs` (9), `interactive.rs` (3),
  `commands/lifecycle.rs` (3), `agents.rs` (3), `models.rs` (1), `agent_transcript.rs` (1),
  `commands/queries.rs` (1) — **not yet reviewed**, finish these.
- `persistence.rs` (6) and `mod.rs`'s `kill_all` — **deliberately skipped, leave them.** Per §9
  they hold the lock across disk I/O / take nested locks; converting them would change lock
  scope, which is a behaviour decision, not cleanup.

`BufBlock::new()` (§8) was not reached either.

**Done (round 1)**

- **Phase 2 (§4) — complete.** 12 agents, one per feature folder, each with its own
  `src/features/<feature>/<feature>.css` (plus `src/app/app.css`). **All 17 `const C`/`T`/`M`
  objects are gone** and inline styles went **573 → 70**. The 70 survivors are itemised per file
  in the agents' handoffs and are dynamic (status-driven colors, percentage widths, computed
  `gridTemplateColumns`, per-level markdown sizing, scroll-window padding) or the documented
  `ShellTerminal` `getComputedStyle` exception. `MarkdownView` (11) and `DiffView` (9) keep the
  most, legitimately. Style factories (`badgeStyle`, `btn`/`createBtn`, `cell()`, `inputStyle`,
  `hintColor`, `scopeBadge`) are all deleted, and the four imperative
  `e.currentTarget.style.… = …` hover mutations are now CSS `:hover`.

- **Phase 0/1/3/4a/4b (frontend foundations)** — `src/ui/` (11 primitives + tests),
  `src/lib/hooks/` (5 hooks + tests), the store split into 8 slices, `styles.css` token
  scales + utility classes, `path.ts` / `merge-sorted.ts` / `guarded-action.ts`.
  `REFACTOR-CONVENTIONS.md` is the briefing doc for the migration agents — it is
  authoritative over this file for per-file rules, including a "known gaps" list of
  places the primitives deliberately do NOT fit.
- **Phase 6 (Rust), partially** — `main.rs` 670 → 123 lines (`shell/`, `window.rs`,
  `diagnostics.rs`); `session/commands.rs` → `commands/{lifecycle,turn,decisions,queries}.rs`;
  `session/spawn.rs`; `session/usage_probe.rs` (probe lifecycle out of `interactive.rs`,
  which drops 1031 → 848); `no_window` hoisted to `process_util.rs`; `tools.rs` two parallel
  matches → one `TOOLS` table; `require_git_ok()` in `diff/commands.rs`; `fs_util.rs` with the
  shared `unique_temp_path()`; `stream.rs`'s `u8` block tag → `BlockKind` enum.

**Corrections to this plan, found while executing it**

- **§7's `ConversationView` entry says "dispatch table" and that is right, but not for the reason
  given.** The original `route(e)` switch was **not** exhaustive — it deliberately ignored
  `session.removed` / `agent.update` / `agent.step` / `mcp.update`, which other panels own via
  their own subscriptions, through a `default: break`. A `switch` with a `never` default cannot
  express that, and a `switch` with `default: break` keeps silently swallowing genuinely new
  event types. The `Record<SessionEvent['type'], handler>` forces an explicit entry (a shared
  `ignoreEvent` no-op where that is the decision) per union member, so a new `SessionEvent`
  variant fails to compile until someone decides about it.
- **The `CommandCard` / `conversation-blocks` merge could not be a physical merge.** Relocating
  both switches into one file would either put JSX in `conversation-blocks.ts` (breaking the
  pure-logic contract its tests rely on) or create a circular import. Instead
  `conversation-blocks.ts` owns the canonical `CARD_KIND_COMMAND` enumeration and
  `CommandCard.tsx`'s render table is typed
  `Record<Exclude<keyof typeof CARD_KIND_COMMAND, 'notice'>, …>` — drift is now a compile error
  in both directions with no cycle.
- **The naming pass in §7 is a heuristic, not a rewrite rule.** Three agents correctly refused
  parts of it: `s` in `McpPanel` is an `McpServerInfo` (→ `server`, not `session`); `f` in
  `ProjectsModal` is a `DefaultFieldDef` (→ `field`, not `file`); and in `agent-tab.ts`'s
  `mergeAgentBlock` / `agent-trail.ts`'s `mergeStep` the outer parameter is *already* `block` /
  `step`, so renaming the inner `(b) =>` would shadow it and make the comparison
  `block.blockId === block.blockId` — always true, silently breaking insert-or-replace. The
  pervasive `useStore((s) => s.foo)` selector `s` is the store state and was left alone
  everywhere (101 uses across 17 files).

- §8 says the two atomic-write implementations should be collapsed to one. **Do not.** They
  conflict on purpose: `permissions/settings.rs` copies the target's permissions onto the temp
  file (settings.json carries secrets under `env` and must not become 0644), while
  `project/standards.rs` explicitly refuses to on Windows (a read-only CLAUDE.md would make its
  temp file undeletable, breaking the FR-15 remove-on-failure cleanup). Only the temp-path
  generation was shared out, into `fs_util.rs`; its module doc records the reasoning.
- **§5's `<Modal>` replacement table is too optimistic.** `Modal` encodes `NewSessionModal`'s
  specific visuals, so three of the five call sites cannot adopt it without a visual change, and
  each agent independently reached that conclusion: its `width` prop is typed `number` and cannot
  express `PermissionsModal`'s `min(720px, 92vw)` or `ProjectsModal`'s `min(860px, 94vw)` (the
  latter has a live `@media (max-width: 740px)` rule that only makes sense with the clamp); it has
  no `maxHeight` slot (both need one, and `ProjectsModal` documents why `maxHeight` not `height` is
  load-bearing for its empty state); and `.modal-panel`/`.modal-backdrop` differ from those call
  sites in border token, radius, shadow, and backdrop alpha. `PaletteView` additionally can't use
  it because the palette dismisses on `onMouseDown` where `Modal` uses `onClick`. **Adopted by
  `AgentsPanel` + `SkillsPanel` only.** Unifying the rest is a design decision, not cleanup.
- **`Modal` gained an optional `className`** on the backdrop. `SkillsPanel`'s dialogs were the one
  modal at `zIndex: 50` (every other was 20); `.modal-backdrop` fixes 20, which would have stacked
  them *below* the sidebar context menu (30) and the mcp/remote/model-picker popovers (40). They
  now pass `.skills-modal-backdrop` to restore 50. Any future `Modal` adopter should check its
  original z-index against those popovers.
- **Two Phase 1 utilities don't match their intended call sites.** `.form-error`'s comment
  (`styles.css:791`) names `ConversationView`'s send-error banner, but that element is `6px 10px`
  and `.form-error` is `8px 10px`; and `.list-row--hovered` is `--bg-elevated` while `SkillsPanel`
  and `ProjectSwitcher` rows hover to `--bg-panel`/`--bg-hover`. In every case the agent kept the
  original value and overrode locally. These are 2px/one-token visual decisions — resolve them
  deliberately, not as a side effect.
- **`EmptyPane` fits fewer places than §5 claims.** It is `flex: 1` with no `flex-direction`,
  `gap`, or `height`, so it does not fit `OverviewView`'s `EmptyState` (needs a gapped full-height
  column) or `DiffView`'s placeholder (sits in a non-flex `overflow:auto` parent, where `flex: 1`
  is inert and the pane would collapse to zero height). Adopted by `App.tsx` ×4 and `Sidebar` ×3.
- **Phase 1/4b left six files imported nowhere**: `SessionListBody.tsx`, `SessionContextMenu.tsx`,
  `FilterInput.tsx`, `useRowCursorClamp.ts`, `useSessionFleetSync.ts`, `useSidebarKeyboard.ts`.
  They were extracted but never wired into `Sidebar.tsx`; the Phase 4c sidebar decomposition is
  what consumes them. `sidebar.css` is deliberately written against the class names those dormant
  files already assume, so wiring them in is a pure JSX swap with no CSS follow-up. Until then
  `tsc` and the test suite cover them only incidentally.
- §8 says `diff_commit`'s git-error mapping repeats 5×. It is **3**. The other two must not use
  `require_git_ok`: `diff --cached --quiet` treats exit 0 as the error case (nothing staged,
  FR-11) and `rev-parse HEAD` tolerates failure.

**Scope**: structural cleanup only — leverage React components, kill css-in-js, break up large
functions, replace if/else-if and stringly-typed dispatch with tables, fix cryptic naming.
No behaviour changes. Bugs and concurrency findings are recorded in §9 but are **not** part of
this plan.

---

## 0. The headline numbers

| Metric | Value |
|---|---|
| Inline `style={{…}}` objects | **573** across 21 of 25 `.tsx` files |
| `styles.css` | 669 lines, covering only 5 features |
| Duplicate local token-alias objects (`const C = {…}`) | **16** files |
| Features with zero tests | `diff`, `mcp`, `sessions`, `shell`, `skills` |
| Orphan store-slice test files (no source file) | 5 |
| Largest React component body | `NewSessionModal` ~484 lines |
| Largest Rust fn | `stream.rs::run_reader` ~340 lines |
| Rust lock-boilerplate repetitions | ~78 |

Two root causes explain most of the frontend mess:

1. **The `const C` pattern.** 16 files each declare a private object aliasing CSS custom
   properties (`const C = { accent: 'var(--accent)', dim: 'var(--text-dim)', … }`). It exists
   only so components can write `style={{ color: C.dim }}`. It makes inline styling the path of
   least resistance and CSS classes the path of most resistance. Everything downstream follows
   from it.
2. **`styles.css` has colour tokens only.** No `--space-*`, `--radius-*`, `--font-size-*`, or
   shadow tokens. So spacing and typography are magic numbers (`9.5px`, `10.5px`, `12.5px`,
   `4px`) repeated across hundreds of inline objects, with no CSS-side alternative to reach for.

Fix those two and the 573 inline styles become mechanically removable. Fix them *last* and every
component gets rewritten twice.

---

## 1. Sequencing

Three tracks that can run in parallel; within a track, order matters.

```
Track A (frontend styling)   0 ──► 2 ──► 3 ──► 5
Track B (frontend logic)     0 ──► 4 ──► 5
Track C (rust core)          6 ──► 7
```

Phase 0 gates Tracks A and B. Track C is independent and can start immediately.

---

## 2. Phase 0 — Safety net (do this first)

Five features have **no tests at all** — and they are exactly the ones with the largest
components: `diff` (612 lines), `mcp` (739), `sessions` (669 + 573), `shell` (232), `skills`
(477). Refactoring them blind is the main risk in this plan.

- Add characterisation tests for the pure logic in each: `DiffView`'s summary coalescing/echo
  suppression (`DiffView.tsx:66-140`), `McpPanel`'s attach-request building
  (`McpPanel.tsx:496-544`), `Sidebar`'s session-event reduction (`Sidebar.tsx:162-214`),
  `SkillsPanel`'s filter + selection clamping (`SkillsPanel.tsx:94-102`).
- Note this is easier *after* extraction, which is circular. Resolve it by extracting the pure
  function first with a mechanical, reviewable move, then testing it, then refactoring freely.

**Exit criteria**: every feature directory has at least one test file; `npm test` green.

---

## 3. Phase 1 — Design tokens (Track A foundation)

In `src/styles.css`:

- Add the missing token scales: `--space-*`, `--radius-*`, `--font-size-*`, `--shadow-*`.
  Derive the values from what the code already uses — the repeated `9.5/10.5/11/12/12.5px`
  font sizes and `3px/4px` radii — rather than inventing a new scale.
- Add utility classes for the patterns the audit found duplicated across files:
  `.truncate` (repeated ~10×, worst in `OverviewView.tsx:266,314-316,379-384,449-452`),
  `.list-row` + `.list-row--selected` (the `selected ? raised : hover ? elevated : transparent`
  ternary at `AgentsPanel.tsx:369`, `OverviewView.tsx:370`, `SkillsPanel.tsx:272`),
  `.status-dot` + `.status-dot--pulsing` (5 sites), `.form-error` (4 sites), `.badge-pill`,
  `.empty-pane` (4 sites in `App.tsx` alone), `.chip` / `.chip--selected`, `.btn` / `.btn--primary`.
- Consolidate the byte-identical `.qcard-*` / `.pcard-*` blocks (`styles.css:283-295` vs
  `416-428`) into a shared `.card-*` base. The comment at `styles.css:397` already admits the
  duplication.

`src/features/permissions/permission-card.ts:89-90` (`cardClass`) is the existing good pattern —
a small typed class-string builder, already unit-tested. Extend that rather than adding a `clsx`
dependency; the audit found only 8 className ternaries, all single-condition.

---

## 4. Phase 2 — Delete the `const C` layer, migrate static styles

Per file, in this order (largest first, so the pattern is established on the hardest cases):
`App.tsx` (57 inline styles), `McpPanel.tsx` (51), `OverviewView.tsx` (48), `SkillsPanel.tsx`
(46), `AgentsPanel.tsx` (41), `CommandCard.tsx` (40), `Sidebar.tsx` (38), `ProjectsModal.tsx`
(38), `DiffView.tsx` (34), then the remaining 12 files.

For each: delete the local `const C` / `T` / `M` object, replace static `style={{…}}` with
classes referencing `var(--…)` directly.

- **~85-90% of the 573 are static** — pure layout (`display:flex`, `padding`, `gap`, `border`,
  literal `fontSize`) that never depends on props or state. These all become classes.
- **~55 are genuinely dynamic** and stay inline: percentage widths (`CommandCard.tsx:103`,
  `UsageBar.tsx:36`), grid columns from pane toggles (`App.tsx:325`), status-driven colours
  (`McpPanel.tsx:237,364`). Standardise these behind small typed helpers (the existing
  `tabStyle` at `App.tsx:302` and `cardClass` are the models) rather than ad-hoc ternaries.
- **One legitimate exception**: `ShellTerminal.tsx:19-40` resolves the xterm canvas theme via
  `getComputedStyle` because xterm cannot consume `var()`. Already well-commented. Leave it.
- Also kill the style-factory functions, which are css-in-js wearing a hat:
  `NewSessionModal.tsx:546-573` (`btn`/`createBtn`), `SkillsPanel.tsx:19-31` (`badgeStyle`),
  `McpPanel.tsx:40-52,713-738`, `ProjectsModal.tsx:63-88,597-599`.
- And the imperative hover mutations (`e.currentTarget.style.color = …`) at
  `AgentsPanel.tsx:412-413` and `ConversationView.tsx:412-413` → CSS `:hover`.

**Exit criteria**: zero `const C` objects; `grep -c "style={{" src` under ~60, all justified.

---

## 5. Phase 3 — Shared UI primitives

There is no shared UI layer today — `src/` has only `app/`, `features/`, `lib/`. Add
`src/ui/` for cross-feature primitives. Each of these is currently reimplemented 3-5×:

| Component | Replaces |
|---|---|
| `<Modal>` / `<ModalShell>` | `AgentsPanel.tsx:588-611`, `NewSessionModal.tsx:274-297`, `SkillsPanel.tsx:297-311` |
| `<StatusDot>` | `App.tsx:491,663`, `Sidebar.tsx:625`, `McpPanel.tsx:231,364`, `AgentsPanel.tsx:376`, `OverviewView.tsx:373` |
| `<PanelHeader>` | `AgentsPanel.tsx:271-285`, `SkillsPanel.tsx:166-180` (near byte-identical) |
| `<ListRow>` | `PaletteView.tsx:238-257`, `ProjectSwitcher.tsx:238-272`, `SkillsPanel.tsx:272`, `OverviewView.tsx:370` |
| `<HintBar>` (footer) | `AgentsPanel.tsx:634-641`, `SkillsPanel.tsx:313-323` |
| `<Chip>` / `<ChipGroup>` | `NewSessionModal.tsx:388-407,415-435,445-458,469-491` (4× in one file) |
| `<BadgePill>` | `App.tsx:385-391`, `Sidebar.tsx:660-664` |
| `<EmptyPane>` | `App.tsx:440-452,457-460,469-472,513-515` |

---

## 6. Phase 4 — Hooks and component decomposition (Track B)

### 6a. Shared hooks — `src/lib/hooks/`

| Hook | Replaces |
|---|---|
| `useHydratedSubscription(sessionId, subscribe, fetchInitial)` | The identical mounted-flag + event-buffer + hydrated-flag + unlisten shape at `ConversationView.tsx:67-177`, `AgentsPanel.tsx:91-162`, `DiffView.tsx:143-171`, `SkillsPanel.tsx:68-92`. **~300 duplicated lines.** Highest-value single extraction. |
| `useMounted()` | Same guard under 4 different names: `mounted` (`App.tsx:162`), `alive` (`ProjectsModal.tsx:112`), `mounted` (`McpPanel.tsx:83`), `cancelled`/`live` (`Sidebar.tsx:160`, `App.tsx:141`) |
| `useDismiss({ onEscape, onOutsideClick })` | 6 divergent implementations: `ProjectsModal.tsx:216-226`, `McpPanel.tsx:317-323,466-487`, `Sidebar.tsx:339-351`, `ProjectSwitcher.tsx:58-73`, `RemoteControlBadge.tsx:61-71`, `ModelPicker.tsx:80-97` |
| `useElapsedClock(running)` | `App.tsx:185-190`, `AgentsPanel.tsx:79-88`, `AgentView.tsx:100-104`, `OverviewView.tsx:88-93` |
| `useTimedError()` / `useResolvedRef(state)` | `PermissionCard.tsx:30-48`, `QuestionCard.tsx:26-35`, `CommandCard.tsx:160-166` |
| `runGuardedAction(fn, {…})` | The identical in-flight/clear-error/try/catch/race-guard shape at `permission-card.ts:118-133`, `question-card.ts:147-160`, `conversation-blocks.ts:369-387` |
| `mergeSorted<T>(list, item, keyOf)` | `agent-tab.ts:141-154` and `agent-trail.ts:148-159` — same algorithm, two implementations |

Also: `ShellTerminal.tsx:24-26` redefines the `ipc<T>` wrapper byte-identically to
`api.ts:25-27` — import it instead. And `abbreviate()` is duplicated verbatim in `App.tsx:46-52`
and `Sidebar.tsx:28-33` → move to `src/lib/path.ts`.

### 6b. Store slice split — `src/lib/store.ts` (368 lines)

One zustand store holding 10 independent concerns. **The tests for the split already exist**:
`src/lib/` contains `agentTabStore.test.ts`, `overviewStore.test.ts`, `projectsStore.test.ts`,
`remoteStore.test.ts`, `theme.test.ts` — five test files named after slices that have no source
file. They all drive the monolith today. Split into slice creators combined via zustand's slice
pattern, one file per existing test name, plus `sessionsStore.ts`, `layoutStore.ts`,
`usageStore.ts`. Low risk, high readability win.

### 6c. Per-component decomposition

Ranked by size of the win:

- **`NewSessionModal.tsx`** — 484-line component body, the largest. Extract
  `useNewSessionForm()` (state at `:67-134`), `useModelCatalog()` (`:95-115`),
  `useProjectDefaults()` (`:144-175`), `useDirectoryPicker()` (`:188-206`); split the JSX into
  `ProjectField` / `DirectoryField` / `NameField` / `ModelField` + `<ChipGroup>` ×4.
- **`ConversationView.tsx`** — the 110-line hydration effect at `:67-177` containing a
  **21-branch** `route(e)` switch on `SessionEvent['type']`. Move the switch into
  `conversation-blocks.ts` as a pure `applySessionEvent(dispatch, setters, event)` (it already
  hosts the reducer), wrap the rest in `useConversationTranscript(sessionId)`. Extract
  `<Composer>` (`:421-488`), `<ResumeFailBanner>`, `<JumpToLatestChip>`.
- **`ProjectsModal.tsx`** — extract `useProjectRegistry()` (12 useState at `:93-111` + 3 effects)
  and `useProjectMutations()` (`:234-345`, ~112 lines of logic in the component body); split the
  172-line `{selected && (…)}` block into `IdentitySection` / `DefaultsSection` /
  `StandardsSection` / `RemoveControl`. Collapse the 4 parallel error states (`:106-109`) into
  one `Record<Section, string|null>`.
- **`App.tsx`** — extract `MainTabStrip`, `MainPaneBody`, `ShellTabView`, `StatusBar`,
  `EmptyPaneMessage`; hooks `useAppIdentity`, `useAppShortcuts`, `useDiffBadge`.
- **`McpPanel.tsx`** — `AttachOverlay` (`:441-666`, 225 lines) is the single largest function;
  extract `useAttachFlow()` and split into `RegistryStep` / `ParamsStep`. Move `submit()`'s
  request-building (`:496-544`) into a pure `mcp.ts` helper (mirrors the existing `projects.ts`
  pattern).
- **`Sidebar.tsx`**, **`AgentsPanel.tsx`**, **`DiffView.tsx`**, **`SkillsPanel.tsx`** — same
  shape: extract the feed hook, the keyboard-nav hook, and the list-body component.

`OverviewView.tsx` and `markdown.ts` are already well-factored — leave them alone beyond the
CSS migration. `DiffView.tsx:22-27,356-362` (`KIND`/`STATUS` lookup maps) and
`OverviewView.tsx:50-64` (`TONE_COLOR`) are the pattern the rest of the codebase should copy.

---

## 7. Phase 5 — Dispatch tables and naming

Replace if/else-if chains and ternary ladders with lookup maps:

| Site | Branches | Replacement |
|---|---|---|
| `ConversationView.tsx:74-144` | 21 | `Record<SessionEvent['type'], handler>` |
| `Sidebar.tsx:162-214` | 6 | `switch` on the tagged union (for exhaustiveness) or dispatch table |
| `App.tsx:220-264` | 12 | `Record<string, () => void>` keyed on `e.key` |
| `App.tsx:434-516` | 5 | `Record<MainTab, renderer>` |
| `CommandCard.tsx:76-91` | 6 | `Record<kind, body>` — and merge with the parallel switch in `conversation-blocks.ts:47-63`, which duplicates the same discriminant knowledge |
| `AgentsPanel.tsx:224-252` | 5 | key-action lookup |
| `McpPanel.tsx:31-38` | 3 | unify with the adjacent `scopeColor` Record into one `SCOPE_META` |

Naming pass (mechanical, no structural risk — do it last): `C` → `COLORS` (or gone entirely
after Phase 2); `s`/`x` → `session`; `a` → `agent`; `f` → `file`; `g` → `group`; `b` → `block`;
`u` → `unsub`; `ae` → `activeEl`; `h`/`l` → `hunk`/`line`. Leave `e` for DOM events. Do rename
caught errors to `err` in the files that mix both — `AgentView.tsx` has `(e: SessionEvent)` at
`:51` and `(e: unknown)` at `:82`.

---

## 8. Phase 6 — Rust core (Track C, independent)

Raw line counts mislead here: `agents.rs` is 1445 lines but only 726 are code; `standards.rs`
(957) and `registry.rs` (917) are ~55% tests. Per the convention, **do not split test-heavy
files**. The real targets are:

- **`main.rs`** (670 lines, only ~36 tests — the actual offender). It contains an entire
  undeclared shell-terminal domain (`:33-434`), Windows DWM caption tinting (`:486-535`), and a
  panic-log installer (`:453-478`). Split into `shell/{mod,spawn,commands}.rs`, `window.rs`,
  `diagnostics.rs`, leaving ~100-150 lines of genuine bootstrap. `shell_ensure` (`:198-351`,
  154 lines) breaks into `open_session_pty` / `spawn_shell_child` / `spawn_reader_thread` —
  which also flattens the 6-level nesting at `:287-326`.
- **`session/commands.rs`** — 803 code lines / 83 test, owns four concerns. Split into
  `commands/{lifecycle,turn,decisions}.rs`. `session_create` (`:78-227`, 149 lines) →
  `validate_create_input` + `probe_claude_binary` + a `Session::new()` constructor.
- **`session/stream.rs`** — `run_reader` (`:22-364`, ~340 lines, 9-arm string match) and
  `handle_stream_event` (`:437-670`, ~233 lines, 3-level nested string matches). Extract one
  handler per arm; replace the magic-number tagged tuple `HashMap<u64, (String, u8, String)>`
  at `:44-51` (`kind: 0=text 1=tool`) with a proper enum.
- **`session/remote.rs`** — `remote_start` (`:195-466`, 274 lines) → orchestrator + three
  named thread-spawn helpers.
- **`session/interactive.rs`** — 660 code lines mixing slash grammar, card builders, and probe
  lifecycle; move the probe lifecycle (`:481-667`) to its own file.
- **`session/mod.rs`** — should own only the shared data model per the convention, but carries
  process-spawn/env plumbing (`:87-197`, `:782-797`). Move to `turn.rs` or a new `spawn.rs`.
- **Dedup**: `Engine::with_session_mut(id, |s| …)` helper collapses **~78** repetitions of
  `app.state::<Engine>(); engine.sessions.lock().unwrap();`. `BufBlock::new()` constructor
  removes 10+ near-identical struct literals (`mod.rs:472-651`, `persistence.rs:130-223`).
  `no_window()` is duplicated verbatim in `wsl.rs:15-21`, `diff/git.rs:11-17`,
  `session/mod.rs:182-187` → hoist. Atomic-write is implemented twice
  (`standards.rs:335-359` vs `permissions/settings.rs:66-128`) → keep one. `diff_commit`'s
  git-error mapping repeats 5× (`diff/commands.rs:82-193`) → `require_git_ok()` helper.
- **`tools.rs:35-63` and `:92-160`** — two structurally parallel string matches over tool names,
  maintained in lockstep with no compiler help. One table keyed by tool name.

`remote_discovery.rs`'s ANSI scanner is inherent to its domain and exhaustively tested — leave
it. The `claude_invocation` centralisation in `mod.rs`/`turn.rs` is a positive pattern.

---

## 9. Out of scope — found but not part of this plan

The audit surfaced concurrency issues that are **behaviour bugs, not cleanup**. Flagging them
here so they aren't lost; they need their own decision and probably their own spec.

1. **`persistence.rs:251-291`** — `persist()` holds `engine.sessions.lock()` across JSON
   serialisation *and* synchronous disk I/O (`:284-289`). Called from reader threads and several
   commands, so every other in-flight command stalls for the duration of a disk write. This
   contradicts the discipline the code documents for itself at `commands.rs:402-404`. Fix: clone
   the snapshot under the lock, drop, then serialise and write.
2. **`remote.rs:202-463`** — `remote_start` holds the entire `RemoteRegistry` mutex across PTY
   creation, a blocking process spawn, and three thread spawns. Every other session's
   `remote_start`/`remote_stop`/`remote_get` blocks behind it.
3. **`.lock().unwrap()` at 100+ sites** — one panicking holder in a per-turn or per-remote-host
   thread poisons `Engine.sessions` for the rest of the process. Worth a project-wide decision:
   recover-on-poison helper, or accept and crash.
4. `mod.rs:721-763` `kill_all` takes nested locks under the sessions lock — bounded to app exit,
   but a lock-ordering hazard if `TurnHandle`'s locks are ever taken in another order.

---

## 10. Verification

Each phase must end green on: `npx tsc --noEmit`, `npm test`, `cd src-tauri && cargo test`,
`cargo check`. No phase lands with a red gate — the point of Phase 0 is that these gates
actually mean something for the five untested features.
