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

## deferred:self-update

Parked at the `/review` SHIP verdict (2026-07-31, round 2). Both are LOW, neither is security-typed,
and both are in the core surface. Recorded here rather than as `## Remediation` items in
`specs/self-update.md` so they do not re-trigger that feature's fix loop.

- **[LOW]** `src-tauri/src/update/check.rs:122` · quality · `fetch_release_notes(&latest)` fires the
  GitHub request with the raw, unvalidated registry `latest` string before `check_from_parts`
  (line 123) validates it is a parseable version triple, so a malformed or hostile registry response
  spends a network round-trip building a URL from unsanitized data before format validation.
  → **Fix:** call `is_newer`/`version_key` (or move the `check_from_parts` validation) before
  `fetch_release_notes`, skipping the notes fetch entirely when `latest` does not parse.

- **[LOW]** `src-tauri/src/update/commands.rs:101,107` · quality · the LOCK ORDER comment above
  line 105 states "the engine is read FIRST", but `state.begin_apply()` (an update-state touch) runs
  at line 101, before `engine.running_count()` at line 107. Harmless in practice — `begin_apply` is a
  bare atomic CAS, not a held lock — but the comment misdescribes the actual order and will mislead
  the next reader auditing for deadlock.
  → **Fix:** reword the comment to note `begin_apply` is a lock-free CAS and does not count as
  "touching" `UpdateState`'s mutex, or reorder the two calls to literally match the comment.

## deferred:notifications

Parked at the `/review` SHIP verdict (2026-08-01). Neither is CRITICAL/HIGH or security.

- **[MEDIUM]** `src/features/notifications/notifications.ts:142-149` (`handleNotificationAction`) ·
  spec-violation · calls `setActiveSessionId(sessionId)` for any non-null `extra.sessionId` /
  `lastNotifiedSessionId` without checking the session still exists, contradicting spec §7's row
  "Session removed right after a fire → … window is raised, selection unchanged (FR-13)"; no test
  covers this row. → **Fix:** before calling `setActiveSessionId`/`setFocusedPane`/`setMainTab`,
  verify `useStore.getState().sessions.some(s => s.id === sessionId)` and skip selection (still call
  `focusFrancois()`) when it doesn't; add a unit test seeding a `lastNotifiedSessionId`/
  `extra.sessionId` absent from `sessions` and asserting `activeSessionId` is unchanged.

- **[LOW]** `src/features/notifications/NotifyMutedChip.tsx:14` · quality · design brief §1 specifies
  "One `<span>`, inline" for the muted chip but the component renders a `<button>` (harmless — follows
  the `AccountChip` precedent and is more accessible, but diverges from the frozen design doc's
  literal element choice). → **Fix:** either update `specs/design/notifications.md` §1 to say
  `<button>` (matching `AccountChip`'s established status-bar-chip pattern) or note the deliberate
  deviation in a comment.

## deferred:open-in-vscode

Parked at the `/review` SHIP verdict (2026-08-04). Both are LOW, quality-only, non-security.

- **[LOW]** `src-tauri/src/editor/mod.rs:364-377` · quality · `cached_or_probe` holds the cache
  `Mutex` guard for the entire synchronous `probe()` call (a filesystem walk across every `PATH`
  dir × `PATHEXT` ext × 4 editors), unlike the `wsl.rs` `WSL_UNC_ROOTS`/`WSL_HOMES` pattern it says
  it mirrors, which releases the lock before the impure probe and only reacquires it to write the
  result. → **Fix:** drop the guard before calling `probe()`, then reacquire to write
  `*guard = Some(...)` on success, matching `wsl_unc_root`'s discipline so concurrent probes don't
  serialize on filesystem I/O.

- **[LOW]** `src-tauri/src/editor/mod.rs:485-496` · quality · `session_open_in_editor`'s
  `SESSION_NOT_FOUND` branch (when `engine.cwd_of` returns `None`) has no test coverage — the
  module's own comment explains `editor`'s tests can't build a `Session` because
  `session::testutil::test_engine_with` is private to the `session` module tree, but sibling modules
  like `session/worktree/tests.rs` cover the identical branch by splitting an
  `_impl(engine: &Engine, ...)` inside `session`'s own tree. → **Fix:** either move the
  `SESSION_NOT_FOUND` check + a thin `open_in_editor_command_impl(engine: &Engine, ...)` into
  `session/` (where `test_engine_with` is reachable) so it's pinned by a test, or export a minimal
  test-only `Engine` builder the `editor` module can use.

## deferred:multiple-shells

Parked at the `/review` REVISE verdict (round 1, 2026-08-04). None are CRITICAL/HIGH or security.

- [ ] LOW · src-tauri/src/shell/mod.rs:275-277 · quality · `at_cap` check-then-act with no lock held across spawn+insert lets two racing `shell_create` calls momentarily exceed the FR-2 6-shell cap; hold the registry lock across the check and the insert · deferred:multiple-shells
- [ ] LOW · src-tauri/src/shell/mod.rs:492 · quality · doc comment claims a wsl-filesystem runtime-switch call site exists for `dispose_session_shells`, but only `session::session_remove` calls it; correct the comment or add the missing call site · deferred:multiple-shells
- [ ] LOW · src-tauri/src/shell/mod.rs:146 · quality · `PtyHandles` fields marked `pub(crate)` though only accessed from `shell::commands` and `shell` itself; drop `pub(crate)`, rely on child-module access like `Shared` does · deferred:multiple-shells
- [ ] LOW · src/features/shell/shellStore.ts:15-30 · quality · `shells`/`activeShellId`/`unread` records have no cleanup on session removal, leaking entries for the app's lifetime (pre-existing leak in the state this replaced); clear the three records for a `sessionId` on session removal · deferred:multiple-shells

### SHIP-round leftovers (review round 3, 2026-08-04)

Parked at the `/cohorte-review` SHIP verdict. All LOW, quality-only, non-security — never open
`## Remediation` items.

- [ ] LOW · src-tauri/src/shell/commands.rs:258-311 · quality · `shell_ensure`'s three branches each rebuild an identical `ShellEnsureData` block; extract a private `build_ensure_data(reg, session_id, shell_id)` helper and call it from all three sites · deferred:multiple-shells
- [ ] LOW · src-tauri/src/shell/mod.rs:1012 · rule · file is 1012 lines, past the ~1000-line ceiling in PIPELINE.md §Code layout; move the `Registry` impl block and its tests into a child module `shell/registry.rs`, leaving `mod.rs` the shared data model + `dispose_session_shells`/`kill_all_shells` · deferred:multiple-shells
- [ ] LOW · src/features/shell/ShellStrip.tsx:105 · quality · the inline-rename `<input>` has no `maxLength`, so typing past 40 chars is accepted then silently truncated by the core on commit (FR-4), producing a visible shrink after `⏎`; add `maxLength={40}` · deferred:multiple-shells
- [ ] LOW · src/features/sessions/useSessionFleetSync.ts:74 · test-coverage · the `useShellStore.getState().removeSession(id)` call site (FR-9) is never asserted — only `removeSession` in isolation is; extend a session-removal test to assert the roster/active-id/unread records are empty after `onRemoved` · deferred:multiple-shells
- [ ] LOW · src/demo/demo.ts:211 · quality · `case 'session_remove': return ok(null)` never drops the session from `sessions[]` nor purges `demoShells[sessionId]`, so the demo fixture does not mirror FR-9's cleanup (pre-existing, README-capture fixture only) · deferred:multiple-shells

## deferred:split-session

Parked at the `/cohorte-review` SHIP verdict (2026-08-05, round 2). Neither is CRITICAL/HIGH or security.

- [ ] MEDIUM · src/features/notifications/notifications.ts:157 · quality · `handleNotificationAction` calls `setActiveSessionId(sessionId)` directly instead of routing through the focused-side pattern every other session-assignment entry point uses, so a notification click while split lands the session in an inert unfocused left pane (or swaps panes without moving `focusedSide`); use `if (splitSessionId !== null && focusedSide === 'right') openInRightPane(sessionId); else { setActiveSessionId(sessionId); setFocusedSide('left') }` and add a split-mode test · deferred:split-session
- [ ] LOW · src/features/usage/LayoutToggle.tsx:1 · rule · the split-session titlebar entry point (FR-9/FR-10) lives under the unrelated `usage` feature folder, against PIPELINE.md §Code layout; move it to `src/app/` beside `SplitPane.tsx`/`RightRail.tsx` along with the `.layout-toggle`/`.titlebar-divider` rules from `usage.css` · deferred:split-session

## deferred:webview-hardening

Logged per spec §2/§6 non-goal (explicit — not a review finding). Not fixed here; a 34-file diff
would swallow the fonts/CSP commit pair this feature exists to ship.

- **[LOW]** 84 inline `style={{}}` occurrences across 34 files in `src/features/**` and `src/app/`
  · `PIPELINE.md` §Code layout violation ("Styling is per-feature CSS + classNames, never inline
  `style={{}}`") · this is also the reason `specs/webview-hardening.md`'s CSP (`app.security.csp`)
  keeps `style-src 'unsafe-inline'` rather than the tighter `style-src-elem`/`style-src-attr` split —
  see that spec's FR-9. → **Fix:** migrate each inline `style` object to a `<feature>.css` BEM-lite
  class per `PIPELINE.md` §Code layout, file by file; once none remain, `style-src-attr 'none'`
  becomes viable and `webview-hardening`'s CSP can be revisited.

## deferred:cloud-sessions

Parked at the `/cohorte-review` SHIP verdict (2026-08-11, round 2). Both LOW, quality-only, non-security.

- [ ] LOW · src-tauri/src/session/cloud/auth.rs:81 · quality · resolve Bedrock/Vertex/base-URL env through the account-scoped mechanism `account_env` uses, once accounts carry provider config · deferred:cloud-sessions
- [ ] LOW · src-tauri/src/session/cloud/api.rs:1-1028 · rule · file is 1028 lines, over the ~1000-line cap in PIPELINE.md §Code layout; split the ref-normalizer/repo-matching pure helpers (normalize_cloud_ref, remote_slug, repo_matches, timestamp parsing) plus their tests into a sibling module (cloud/refs.rs), leaving api.rs the HTTP calls and response mapping · deferred:cloud-sessions
- [ ] LOW · src/features/cloud-sessions/AdoptCloudSessionModal.tsx:146-149 · quality · pick() sets ref/resolved but never updates cursor, so ArrowDown/ArrowUp right after a mouse pick restarts navigation from index 0/-1 instead of the clicked row; thread the row index into onPick (or list.sessions.findIndex) and setCursor to it inside pick · deferred:cloud-sessions

## deferred:extensions

- [ ] LOW · src-tauri/src/session/status.rs, src-tauri/src/session/stream/lines.rs · quality · pure `cargo fmt` reflow unrelated to extensions rode along in this diff — split it into its own formatting commit · deferred:extensions
- [ ] LOW · src-tauri/tauri.conf.json · quality · CSP/devCsp block appears in the extensions diff but belongs to the already-shipped webview-hardening feature (c0337ff) — no action unless it drifted · deferred:extensions
- [ ] MEDIUM · src-tauri/src/extensions/commands.rs:725,742 · quality · `extensions_probe`/`extensions_launch` hardcode `"cohorte"` as the owning extension for the FR-46 action — have `registry::action` return the owning `ExtensionDefinition` and derive the enabled-check from it · deferred:extensions
- [ ] LOW · src-tauri/src/extensions/commands.rs:624,679 · quality · `EXT_PANEL_NOT_FOUND` covers three distinct causes with no discriminator — add `detail: { reason }` to the two stream-shape refusals · deferred:extensions
- [ ] LOW · src/features/extensions/ExtensionView.tsx:741 · quality · a failed `extensions_set_enabled` is swallowed by `.catch(() => {})`, so a failed disable looks successful — surface the `AppError` inline · deferred:extensions
- [ ] LOW · src/features/extensions/DashboardAction.tsx:464-478 · spec-violation · FR-47 `occupied` state keeps the button label "Launch dashboard" and relegates the required occupied copy to a sibling note — swap the button's own label when `state === 'occupied'` or record the alternate reading · deferred:extensions
- [ ] LOW · src/features/palette/paletteCommands.ts:3218-3233 · convention · `manage-extensions` palette command uses Unicode glyph `▤` instead of a lucide-react icon, matching ~25 other glyph entries in the registry — resolve as part of the deferred registry-wide glyph→icon migration decision · deferred:extensions
- [ ] MEDIUM · src-tauri/src/extensions/provider.rs:2437 · quality · `run_capped` collapses every `cmd.spawn()` failure to `ProviderError::Missing` ("not found on PATH"), misnaming permission-denied and resource-exhaustion causes on the high-traffic panel/predicate path — thread the real `io::Error` out and mirror `commands.rs::spawn_error`'s `NotFound`-vs-other branching (FR-49) · deferred:extensions
- [ ] MEDIUM · src-tauri/src/extensions/stream.rs:329,341 · quality · `follow_file` `read_to_string`s the whole unread tail with no byte cap before truncating to `EXT_LOG_MAX_LINES`, so only the emitted line count is bounded, not the allocation — seek to `len.saturating_sub(EXT_LOG_MAX_BYTES)` before reading (or use a bounded ring) to match provider stdout's 4 MiB cap (FR-22) · deferred:extensions

## deferred:extension-install

- [x] MEDIUM · src/features/extensions/ExtSectionError.tsx:23 · security · Apply `sanitizeForDisplay` (or `formatArgv`-style token wrapping) to `errorCommand`'s return value in `extensions.ts` or at the render site — the core's resolved argv is rendered raw · deferred:extension-install
- [x] CRITICAL · src/features/extensions/ExtensionsModal.tsx:76 · security · Apply `sanitizeForDisplay` to the modal's top-level `{error.message}` (toggle/redetect failures) — rendered raw, same hazard class as the consent-dialog error · deferred:extension-install
- [ ] LOW · src-tauri/src/extensions/registry.rs:1037 · quality · `scan_dir` uses `e.path().is_dir()` which follows symlinks; use `symlink_metadata` to skip (or explicitly document) top-level symlinks under `~/.francois/extensions/` · deferred:extension-install
- [ ] LOW · src/features/extensions/ExtensionsModal.tsx:73 · quality · `extConsentDialogId` is never reset on the outer modal's `onClose`; call `closeExtConsentDialog()` alongside `setOpen(false)` (or add a test pinning the current CSS-layering-dependent behavior) · deferred:extension-install

## deferred:session-profiles

- [ ] LOW · src-tauri/src/session/commands/lifecycle.rs:313 · quality · `PROFILE_NOT_FOUND` uses the literal `"no such profile"` instead of `crate::profiles::NOT_FOUND_MSG` — reuse the constant like project/account do · deferred:session-profiles
- [ ] LOW · src-tauri/src/profiles/mod.rs:36-38 · quality · `MAX_PROFILE_NAME`/`MAX_SYSTEM_PROMPT`/`MAX_EXTRA_ARGS_RAW` are hand-duplicated from `contract/session-profiles.ts` with nothing asserting they stay in sync — add a unit test pinning the Rust constants to the contract's values · deferred:session-profiles
- [ ] LOW · src/features/profiles/profiles.ts:96-99 · quality · exported `ProfileOptionSource` is dead code, duplicating the actually-used identical interface at `src/features/projects/projects.ts:317-320` — delete it, or have `projects.ts` import it · deferred:session-profiles
- [ ] MEDIUM · src-tauri/src/session/persistence.rs:653-830 · quality · No unit test round-trips `systemPrompt`/`extraArgs`/`profile` through `persist`→`parse_session_record` (FR-19), only implicit coverage via unrelated pre-feature-record tests — add a test building a record with these fields set (and one with them omitted) asserting round-trip/default behavior, mirroring the worktree round-trip test · deferred:session-profiles
- [ ] LOW · src/features/profiles/profiles.ts:75 · quality · `flagAdvisoryTokens` classifies via `t.startsWith('-')`, misreading a plain value beginning with `-` (e.g. a negative-number arg) as a flag needing the FR-10 advisory — track advisory tokens by index-following-a-flag instead of value shape · deferred:session-profiles

## deferred:multi-provider-endpoint

- [ ] LOW · src/features/accounts/AccountRow.tsx:1-33 · quality · add `import './accounts.css';` so the component imports the stylesheet whose classes it renders · deferred:multi-provider-endpoint
- [ ] LOW · src/features/accounts/accounts.ts:171 · quality · endpointErrorLine's empty-message fallback is hardcoded to 'could not save' even when rendering a Test failure; use a context-neutral fallback or thread a context: 'test' | 'save' param · deferred:multi-provider-endpoint
- [ ] LOW · src-tauri/src/account/commands.rs:264-292 · quality · narrow TOCTOU in account_update_endpoint — the key-file write and the registry-record lookup take the account lock separately, so a concurrent account_remove between them can recreate a just-deleted config dir with an orphaned key file; hold one lock across both halves or re-assert the record after the write and roll the key file back · deferred:multi-provider-endpoint
- [ ] LOW · src-tauri/src/account/endpoint.rs:432-436 · quality · read_key maps a non-UTF8 key file to "no key" via .ok(), masking externally-corrupted key material as a clean absence; distinguish NotFound from a decode/IO failure and surface the latter as an AppError · deferred:multi-provider-endpoint

## deferred:multi-provider-seam

- [x] LOW · src/features/sessions/rename.test.ts:20, src/lib/panelCountsStore.test.ts:11, src/features/sessions/useSessionFleetSync.test.ts:11, src/lib/split-by-4.test.ts:55 · quality · replace the blanket `as unknown as SessionMeta` bypass casts with fully-populated fixture builders so future required contract fields fail loudly instead of silently · deferred:multi-provider-seam — DONE in the axis-split commit (66c1ce5); review round 3 verified zero `as unknown as SessionMeta` remain in src/ and no substitute escape hatch replaced them
- [ ] LOW · src-tauri/src/session/mod.rs:1174 · complexity · exceeds the PIPELINE §Code layout ~1000-line guidance; split by concern (hive off SessionMeta/persistence-adjacent types), moving each type's tests with it · deferred:multi-provider-seam
- [ ] LOW · src/features/**/*.test.ts, src/lib/*.test.ts (~15 files) · quality · ~15 hand-maintained SessionMeta/Account fixture builders duplicate the same field list; extract one shared makeSessionMeta(overrides?: Partial<SessionMeta>) (and makeAccount) into a test-utils module and have each spec's local helper delegate to it · deferred:multi-provider-seam

## deferred:multi-provider-openai

- [x] LOW · src-tauri/src/session/adapter/openai/runner.rs · complexity · 1033 lines, over PIPELINE.md §Code layout's ~1000-line ceiling — split the pure decision + block-emission helpers into a sibling `blocks.rs` · **CLOSED 2026-08-17**: all 9 named helpers moved with the 12 tests covering them; `runner.rs` 1033 → 825, `blocks.rs` 298. Siblings, so the 9 needed `pub(super)`. Call sites are qualified `super::blocks::…` because the bare name collided with the unrelated pre-existing `session::blocks` that `runner.rs` already glob-imports (a real E0659, not a style nit) · deferred:multi-provider-openai
- [x] LOW · src-tauri/src/session/adapter/openai/skills.rs (`excludes_slash_command_entries`) · quality · FR-27's "excludes every kind: 'command' entry" was proven by a standalone manual `.filter()` assertion, so removing the real filter would not have failed the test · **CLOSED 2026-08-17**: rewritten over a `FixedEnv` returning one `command` + one `skill`, asserting on `build_skill_block`'s own output. Proven the way the defect demanded — the filter was commented out, the test went red, the filter was restored, the test went green · deferred:multi-provider-openai
- [x] LOW · src/ui/CapabilityNotice.tsx:20 / src/styles.css:1402 · quality · the design brief (specs/design/multi-provider-openai.md:97) specified wrap-to-two-lines then middle-truncate; the implementation end-clips via `-webkit-line-clamp: 2` with the full text on `title` · **CLOSED 2026-08-17 by amending the brief, not the code** — middle truncation at the *rendered* two-line boundary depends on the pane's live pixel width (resizable window, draggable dividers), so it needs DOM measurement this project cannot test (`environment: 'node'`, no DOM renderer), and the `middleTruncate` character-count route would be wrong at every width but one. Rationale recorded in the brief's §Resize behaviour · deferred:multi-provider-openai

## deferred:multi-provider-grok

Parked at the `/cohorte-review` SHIP verdict (2026-08-17). None are CRITICAL/HIGH or security.

- [ ] MEDIUM · specs/multi-provider-grok.md FR-25 · spec-violation · fallback model catalog text (`grok-4.6`, `grok-4.6-mini`, `grok-build-0.1`) doesn't match the live-verified list `models.rs` actually implements (`grok-4.6`, `grok-4.5`); amend FR-25's parenthetical to match · deferred:multi-provider-grok
- [ ] MEDIUM · src-tauri/src/session/mod.rs:629, src-tauri/src/session/adapter/grok/runner.rs:379-393 · test-coverage · FR-27's once-per-session Windows sandbox notice has no test — add a unit test on `claim_grok_sandbox_notice()`'s true-once/false-after behavior plus a `#[cfg(windows)]` test on `begin_turn` if feasible · deferred:multi-provider-grok
- [ ] MEDIUM · src/features/accounts/CliToolCard.tsx:1, src/features/accounts/cliTools.ts:1 · complexity · this diff builds a generic vendor-CLI probe/install subsystem (all 3 providers) that no grok FR asks for and that §3's own text claims already shipped — split it into its own spec/PR attributed to multi-account, or amend this spec to claim it · deferred:multi-provider-grok
- [ ] LOW · src-tauri/src/session/persistence.rs:834-852 · test-coverage · no persistence round-trip test pins `agentRuntime: "grok"` reloading as `AgentRuntime::Grok` (FR-4); add a grok/openai pair to `agent_runtime_and_protocol_round_trip_through_a_persisted_record` (codex/openai pair also missing) · deferred:multi-provider-grok
- [ ] LOW · contract/multi-provider-seam.ts:457 · spec-violation · FR-26 asks every disabled capability read as a "current gap"; `grok.remoteControl`'s reason reads as settled architecture instead — reword to "not yet" framing or except `remoteControl` in FR-26 explicitly · deferred:multi-provider-grok
- [ ] LOW · src/features/accounts/AccountsModal.tsx:61 · quality · `installs` typed `Record<string, CliInstallState>` though every site keys by `CliToolId`; type it `Record<CliToolId, CliInstallState>` · deferred:multi-provider-grok
- [ ] LOW · src/lib/api.ts:1666, src/features/accounts/accounts.test.ts:1043 · test-coverage · `accountCliTools`/`accountInstallCli` have no `invokeMock` test unlike every other new wrapper in this diff; add the two missing cases · deferred:multi-provider-grok

## deferred:ext-path-resolution

Logged per spec §2 non-goal (explicit — not a review finding). Marion's unresolved panel caveat: if
filtering relative PATH entries is right for extension spawns, it is right everywhere.

- [ ] MEDIUM · src-tauri/src/process_util.rs (`login_shell_path_env`) · security · the eight `claude` spawn sites take the login shell's PATH unfiltered, so an empty or relative entry (`.`, `node_modules/.bin`, the field a `PATH=$PATH:` leaves) is searched — same exposure `ext-path-resolution` FR-5 closed on the extensions side, deliberately not generalized inside that patch because it would change eight working call sites. → **Fix:** move the empty/non-absolute filter into `login_shell_path_env` itself, drop the extension-side copy, and re-run the `claude`-spawn battery · deferred:ext-path-resolution

## deferred:project-groups

- [ ] MEDIUM · src-tauri/src/project/registry.rs:522 · complexity · `load_from` and `load_groups_from` each read `projects.json` off disk independently; add a single `load_document(path) -> (Vec<Project>, Vec<ProjectGroup>)` that reads the bytes once and calls `parse_registry`/`parse_groups` on the same buffer · deferred:project-groups

## deferred:diff-navigator — SHIP-round leftovers (review round 2)

- [ ] LOW · src/features/diff/DiffTree.tsx:85 · quality · the `role="tree"` container carries `aria-activedescendant` but has no `tabIndex`, so it is never focusable — either make it focusable or drop the decorative ARIA · deferred:diff-navigator

## deferred:resizable-sidebar — SHIP-round leftovers (review round 1)

- [ ] MEDIUM · src/app/RosterDivider.tsx:66-85 · quality · Base the arrow-key nudge on the stored `rosterWidth` intent (pass it alongside `renderedWidth`) instead of the clamped `renderedWidth`, so a nudge under a clamped viewport/regime cannot overwrite a wider stored width; clamp only for the `aria-valuenow` readout. · deferred:resizable-sidebar
- [ ] LOW · src/lib/hooks/usePaneDrag.ts · quality · Add `usePaneDrag.test.ts` covering measure/onDrag/dragging-flag transitions once a DOM component testing framework is wired for this repo. · deferred:resizable-sidebar

## frontend
- [ ] LOW · src/app/app.css:963-969 · quality · pane header ⋯ button is opacity:0 until .split-pane:hover/:focus-within — add :focus-visible on the button itself as a redundant reveal trigger · deferred:unbound-panes
- [ ] MEDIUM · src/lib/layoutStore.ts:1012-1013,1169-1174 · quality · closePane disposes the dropped shell then unsplitPatch re-disposes s.extraPanes — pass the filtered pane list into unsplitPatch (or skip the early dispose when keep.length===1) · deferred:unbound-panes

## core
- [ ] LOW · src-tauri/src/shell/commands.rs:536 · quality · section comment for project-owner target resolution sits above mod tests instead of above struct OwnerTarget — move or drop it · deferred:unbound-panes
- [ ] LOW · src-tauri/src/shell/commands.rs:447-454 · complexity · shell_restart re-implements the is_wsl_unc_path runtime branch already in project_owner_target — extract a shared runtime_of_root helper · deferred:unbound-panes

## deferred:session-permission-mode

- [ ] LOW · src/features/permissions/PermissionModeBadge.tsx:183 · quality · append `— click to change` to the badge `title` template so the tooltip matches design brief §8 · deferred:session-permission-mode
- [ ] LOW · src-tauri/src/session/commands/lifecycle.rs:512 · complexity · derive `parse_permission_mode` from `spawn.rs`'s `valid_permission_mode` so a 5th PermissionMode member is a one-place change · deferred:session-permission-mode

## deferred:app-shell

- [ ] MEDIUM · contract/app-shell.ts · quality · author the file specs/app-shell.md §5 requires (`AppShellState`, `PaneId`, `MainTab`, `KEY_BINDINGS`, `PANE_FOCUS_LABELS`, `STATUS_BAR_HINTS`) or retire that §9 acceptance line — the frontend imports `MainTab` from `src/lib/store` instead · deferred:app-shell
- [ ] LOW · src/features/permissions/PermissionModeBadge.tsx:183 · obsolete · the `deferred:session-permission-mode` tooltip item above is dead — the file was deleted by design 11c's run chip; strike it · deferred:app-shell
- [ ] LOW · src/features/sessions/StateRosterBody.tsx:161 · quality · add role="button" aria-expanded + Enter/Space handling to StateHeading · deferred:roster-group-tier

## deferred:roster-group-tier — SHIP-round leftovers (review round 1)

- [ ] LOW · src/features/sessions/useRowCursorClamp.ts · quality · these hunks belong to the already-committed roster-cursor-anchor commit and are unrelated to any FR in specs/roster-group-tier.md — exclude from this feature's staged diff going forward · deferred:roster-group-tier

## deferred:transcript-perf

- [ ] LOW · src-tauri/src/session/stream/blocks.rs:228 · complexity · `accum.encode_utf16().count()` recomputes the UTF-16 length of the whole accumulated block text on every delta (O(block length) per delta, outside the lock this feature amortized) — track a running UTF-16 counter alongside `accum` in `text_accum` and increment it by the chunk length instead of recounting the prefix · deferred:transcript-perf
- [ ] LOW · src/features/conversation/ConversationView.tsx:172 · complexity · `ComposerPane` is not memoized, so every transcript-driven `state.blocks` change (each rAF-coalesced delta flush, `assistant.done`, tool events) re-renders the whole composer subtree — wrap its export in `React.memo`; its props are already reference-stable · deferred:transcript-perf
- [ ] LOW · src-tauri/src/session/blocks.rs:29 · quality · FR-21 removed the `queued` field from `classify_block`'s User-block JSON but no unit test asserts the resulting shape — add `classify_block_user_has_no_queued_field` mirroring `classify_block_assistant_uses_new_palette` · deferred:transcript-perf
