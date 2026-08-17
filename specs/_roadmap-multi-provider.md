# Roadmap — the multi-provider arc

> **Not a feature spec.** Underscore-prefixed like `_decisions.md` / `_template.md` so the
> `/cohorte-*` commands never glob it as `specs/<id>.md`. This is the working plan for landing
> `multi-provider-seam` + `multi-provider-endpoint` + `multi-provider-openai`, and for parking
> `capability-registry` until it can be decided against a real second runtime.
>
> Created 2026-08-14, from an architecture review against `multi-provider-agent-architecture.md`.
> Tick the boxes as phases land. When the arc ships, this file goes away.

## State at creation

- Branch `feat/multi-provider`, **3 commits ahead of `origin/main`**, no PR open.
  - `1ec2f0f` loop(multi-provider-seam): fix pass 1 — 66 files, **mixes endpoint scope in**
  - `222fed0` loop(multi-provider-seam): fix pass 2
  - `14895a6` chore(cohorte): Update cohorte pipeline

  *(Superseded by Phase A on 2026-08-14. The three commits above are preserved at the tag
  `backup/pre-phase-a`; the branch now carries four scope-clean commits on the same base,
  `9d47115`.)*
- `multi-provider-seam` — `status: blocked`, built, 2 review rounds. **2 open items:** round-2
  CRITICAL #2 (endpoint scope mixed into `1ec2f0f`) and the 2026-08-14 HIGH (axis split).
- `multi-provider-endpoint` — `status: in-review`, built, 13 findings fixed, **never re-reviewed**.
- `multi-provider-openai` — `status: frozen`, unbuilt, widened 2026-08-14 with FR-23..FR-27.
- `capability-registry` — `status: draft`, 5 open questions.

## Working assumption: one PR for the whole arc

Reversible, but everything below is sequenced on it. The reasoning:

- The seam alone ships **zero user value** — its own §1 says so.
- Endpoint alone ships an account you cannot select (its own FR-14).
- `release.yml` cuts a release on **every** push to `main`, so three PRs means three versions, two
  of which are dead ends.

Under this reading, seam round-2 CRITICAL #2 means *"make the commits legible"*, not *"make separate
branches"* — satisfied by re-committing into clean per-feature commits on the same branch (Phase A).
If we switch to three stacked branches + three releases, Phase A grows and C/D/F triple.

---

## Phase A — clean the history · ~30 min — **DONE 2026-08-14**

**Closes:** seam round-2 CRITICAL #2.

- [x] ~~`git reset --soft origin/main`~~ → `git reset --hard 9d47115` (**the merge-base**, not
      `origin/main`). `origin/main` had moved on to `d2d2d99` (v0.18.14) since this plan was
      written, so resetting onto it would have folded a revert of four unrelated main commits into
      the new history. The branch is still 4 behind `origin/main` — Phase F's `git fetch` step
      handles that.
- [x] Re-commit into four commits, each green:
  - [x] `d958075` `chore(cohorte): update the pipeline core to 2.4.0` — `.claude/`, `CLAUDE.md`,
        `PIPELINE.md`, `specs/_template.md`
  - [x] `3470d1d` `feat(session): the SessionAdapter/TurnControl seam` — seam scope only (49 files)
  - [x] `d2ab6ee` `feat(account): openai-compatible endpoint accounts` — endpoint scope only
        (26 files)
  - [x] `0511040` `docs(specs): freeze multi-provider-openai` — the openai spec + design brief +
        its three `_decisions.md` rows, which belong to neither of the two built features
  - [x] fix-pass content folded into whichever feature owns it (`.gitignore`'s `.cargo-test.log`
        entry → seam; `account_remove`'s `remove_dir_all` logging → endpoint)
- [x] `cargo test` + `npm test` + `npx tsc --noEmit` green **at each commit** — with one
      **pre-existing** exception, see below.

**Verified:** `git diff backup/pre-phase-a HEAD` is empty — the four commits reproduce the old
three-commit tree byte for byte. That tag is the rollback handle; delete it once Phase F has shipped.

**Not green, and not Phase A's doing:** `session::stream::golden_replay_tests::
golden_replay_produces_the_locked_session_event_sequence` fails on this machine. Its first expected
event is `session.commands`, whose list merges the fixture's own `slash_commands` with descriptions
read from the **live** `~/.claude/skills/` directory — so the golden file encodes the capture
machine's installed skills as of 2026-08-12. Updating cohorte to 2.4.0 (which dropped the
`cohorte-loop` skill) is what turned it red.

*Proven, not inferred:* `d2ab6ee`'s tree is byte-identical to the pre-surgery `14895a6`, and
`cargo test` there gives **905 passed / 1 failed** — this test and nothing else. (The seam commit
alone gives 881 / 1; the 24-test delta is the endpoint suite.) It will fail on CI too, where
`~/.claude` does not exist at all, so `main` would go red on merge as things stand.

→ **Phase D input:** either feed the command inventory in as fixture-supplied input, or normalize
the `session.commands` payload out of the golden comparison the way ids already are. FR-18's
forward-lock claim is worth exactly as much as this test's determinism, and right now that is
"as much as one developer's skill directory".

**The catch** (as predicted — the mechanical route worked). Eleven files mixed both scopes, not six:
`contract/common.ts`, `contract/multi-account.ts`, `specs/_decisions.md`,
`specs/refactor-backlog.md`, `src-tauri/src/account/{mod,registry,testutil,login}.rs`,
`src/demo/fixtures.ts`, `src/features/accounts/accounts.test.ts`,
`src/features/projects/projects.test.ts`. Each was restored at full content, edited down to its
seam-only form, committed, then restored again for the endpoint commit.

**Free side effect:** `.cargo-test.log` (round-2 LOW, already untracked as of `222fed0`) stops
existing in history too.

**Still to do before the branch is pushable:** `origin/feat/multi-provider` still points at the old
`14895a6`, so landing this needs a `git push --force-with-lease`. Not done here.

## Phase B — the axis split · ~half a day — **DONE 2026-08-15**

**Closes:** the seam's 2026-08-14 HIGH (and, unplanned, its deferred round-2 LOW — see below).
**Must precede Phase E** — `OpenAiAdapter` is the first consumer of both axes, and building it
against the collapsed enum is what the split exists to prevent.

Implements seam **FR-11a / FR-13a / FR-14a**.

- [x] **contract**
  - [x] `AgentRuntime = 'claude-code' | 'francois'` and `ProviderProtocol = 'anthropic' | 'openai'`
        in `contract/common.ts` — `SessionProvider` **removed**, not aliased
  - [x] `SessionMeta.provider` → `SessionMeta.agentRuntime` + `SessionMeta.protocol`, both required
  - [x] `providerCapabilities` → `runtimeCapabilities`; `ProviderCapability(-ies)` →
        `RuntimeCapability(-ies)` in `contract/multi-provider-seam.ts` (+ its test). Values
        unchanged; `ProviderCapabilities` left unspent for the model-level flag set FR-14's
        "Reserved name" note parks it for.
- [x] **core**
  - [x] `Provider` → `AgentRuntime` in `session/adapter/mod.rs` (`ClaudeCode`, `Francois`), plus the
        new `ProviderProtocol` (`Anthropic`, `Openai`)
  - [x] `from_account_kind` returns the `(runtime, protocol)` pair per FR-13a's table, still over an
        exhaustive `match` on `AccountKind` — a third kind fails to compile rather than defaulting
  - [x] `adapter_for` dispatches on `agentRuntime` **alone**; `protocol` is read inside the runtime
        (it is deliberately not a parameter — that is the whole of FR-14a)
  - [x] `session/persistence.rs`: `parse_agent_runtime_and_protocol` — absent keys ⇒
        `('claude-code','anthropic')`, **and** the legacy `provider` key mapped
        (`'claude-code'`→pair, `'openai-compatible'`→`('francois','openai')`). Save side writes only
        the two new keys; the legacy key is read, never written.
- [x] **frontend** — 13 `SessionMeta` fixture sites carry two fields instead of one (the estimate of
      ~6 was low)

**Watch for.** The four fixtures using `as unknown as SessionMeta` (`sessions/rename.test.ts:20`,
`lib/panelCountsStore.test.ts:11`, `sessions/useSessionFleetSync.test.ts:11`,
`lib/split-by-4.test.ts:55`, deferred in seam round 2) are a **blanket bypass** — they will not fail
to compile when the required fields change, so the split goes silently untested in four places. Fix
them here; you are in the files anyway.

- [x] Done, and the warning paid off: `rename.test.ts`'s fixture was carrying a **stale pre-split
      shape** (`modelId`, `contextMaxTokens`, `createdAt` — none of which exist on the current
      `SessionMeta`), which the cast had been hiding. Two further cast sites the round-2 note never
      listed (`lib/sessionsStore.test.ts:15`, `features/notifications/notifications.test.ts:322,435,452`)
      were mechanical and were fixed too. **No `as unknown as SessionMeta` remains in `src/`.**

**Gate:** a persistence round-trip test proving a `sessions.json` carrying the old `provider` key
loads as the right pair.

- [x] `legacy_provider_key_migrates_to_the_right_pair` (both legacy values + an unrecognised one) and
      `both_keys_absent_defaults_to_claude_code_anthropic`, in `session::persistence::tests`.

**Verified green.** `npx tsc --noEmit` clean · `npm test` 86 files / 1721 passed ·
`cargo test` 908 passed, 3 ignored, **1 failed — the pre-existing golden replay only** (the Phase A
note above: it reads the live `~/.claude/skills/` dir, and the sole divergence in the failure output
is the missing `cohorte-loop` entry). The Phase E canary held: `session/stream/fixtures/
turn.expected.json` is byte-untouched, so no Claude Code session behaviour moved.

**Seam status** moved `blocked` → `in-review`: both of its open items are now closed (Phase A took
round-2 CRITICAL #2, this phase took the 2026-08-14 HIGH). Phase D is its re-review.

## Phase C — endpoint re-review · ~1 hr — **REVIEWED 2026-08-16, verdict SHIP**

Runs parallel to D, but **after B** (B touches `AccountKind`'s mapping). Ran parallel to D as
planned — four reviewers at once (both features × both surfaces), one preflight shared between them.

- [x] `/cohorte-review multi-provider-endpoint` — **SHIP**, blocking 0. 0 CRITICAL · 0 HIGH ·
      2 MEDIUM · 3 LOW. All **11** round-1 remediation items verified landed (6 core, 5 frontend).
      Report: `specs/reports/multi-provider-endpoint.md`.
  - FR-3/FR-15 key boundary holds — only `hasKey`/`baseUrl` cross to the frontend; no key material
    in any store, log, `title`, or error copy.
  - FR-14 holds — both pickers render the endpoint option `disabled`, never filtered out.
- [x] Fix pass — both MEDIUMs closed by `8fb9a2e` *(2026-08-16)*:
  - `EndpointForm.tsx:161-163` — the Base URL error border fired on Save but not on a
    `Test`-triggered `INVALID_INPUT`. Extracted `endpointBaseUrlHasError(saveError, probeError)`,
    both paths + negatives covered.
  - `account/commands.rs:367,436,450` — the three FR-7 `INVALID_INPUT` guards were inline in
    `#[tauri::command]` handlers with no harness. Extracted to `validate_key_clear_conflict`,
    `validate_model_ids_on_add`, `validate_model_ids_on_update` in `endpoint.rs`, a test each.
    Behaviour unchanged (same codes, messages, ordering) — **§9 is now verified by `cargo test`**.
- [x] `status: in-review` → `shipped` — flipped with Phase F on 2026-08-17, along with its freshness
      anchor (`reviewed_base 9d47115`, digest `613128971e423573`). All three specs in the arc carry
      the **same** anchor on purpose: they ship as one PR, so the digest that matters is the one
      covering the final tree, not each feature's own review-time snapshot (the seam's earlier
      `f94d48b5b2e3548a` was stale the moment Phase E landed a line of code).

## Phase D — seam re-review, round 3 · ~1 hr — **REVIEWED 2026-08-16, verdict REVISE**

- [x] `/cohorte-review multi-provider-seam` with A and B landed — **REVISE**, blocking 1.
      1 CRITICAL · 0 HIGH/MEDIUM/LOW. frontend surface came back clean (0 findings).
      Report: `specs/reports/multi-provider-seam.md`.
  - **Everything the phase set out to prove, landed.** FR-14a (`adapter_for` dispatches on
    `AgentRuntime` alone, `protocol` never a parameter), FR-13a (exhaustive `match` on `AccountKind`,
    no wildcard), the persistence migration + both its tests, `runtimeCapabilities()` matching FR-15
    verbatim, both round-2 carry-overs intact, no stale `Provider`/`SessionProvider` anywhere.
  - **The trait boundary is genuinely provider-agnostic** — no `Child`/stdio/NDJSON shape on
    `SessionAdapter`/`TurnControl` signatures. `OpenAiAdapter` should be able to implement them,
    which is the Phase E precondition.
  - **`as unknown as SessionMeta` is gone from `src/` entirely**, with no substitute escape hatch.
    The round-2 backlog item is closed.
- [x] **The one CRITICAL — the golden replay, escalated.** Closed by `6d3c50d` *(2026-08-16)*, via
      the reviewer's option (a): `SessionEnv::discover_commands(&self, cwd) -> Vec<SkillInfo>`, the
      `AppHandle` impl delegating to `discover_skills(cwd)` unchanged, `TestEnv` returning a fixed
      two-entry inventory that never touches disk, and `handle_system_line` calling through the env.
      `turn.expected.json`'s `session.commands` entries regenerated against that fixed inventory;
      **every other event byte-unchanged — the canary held.** The red proved itself during the fix
      (this machine carries a `cohorte-patch` skill the capture machine did not). `cargo test`
      912 passed / 0 failed. Phase A logged it as a known local
      failure; round 3 rules it a **merge blocker**, and it is the seam's own architecture that is
      wrong, not just the fixture. `handle_system_line` (`stream/lines.rs:50`) builds
      `session.commands` from `discover_skills(cwd)` (`session/skills.rs:141`), which reads the live
      `~/.claude/skills`, `~/.claude/plugins/marketplaces` and `~/.claude/settings.json` off
      `dirs::home_dir()` — **never routed through `SessionEnv`, the exact seam FR-6 exists for**. So
      it fails on any machine whose skills differ from the capture machine's and deterministically on
      CI (no `~/.claude` at all) ⇒ `release.yml`'s `gate` job turns `main` red on merge.
      **Reviewer picks option (a) over (b)** of the two Phase A candidates: add
      `SessionEnv::discover_commands(&self, cwd) -> Vec<SkillInfo>`, production impl delegating to
      today's `discover_skills`, `TestEnv`/the golden supplying a fixed list. Option (b)
      (normalize `session.commands` out of the comparison) would drop coverage of one of FR-17's
      seven mandated line kinds and read as a weakened test under FR-19.
- [x] Target: SHIP verdict on the seam + endpoint pair **before any openai code exists** — **met
      2026-08-16.** Endpoint SHIP (round 2), seam SHIP (round 4, 0 findings across both surfaces);
      `specs/multi-provider-seam.md` is `status: shipped` with its freshness anchor filled in
      (`reviewed_base 9d47115`, digest `f94d48b5b2e3548a`). Phase E is unblocked.

## Phase E — build `multi-provider-openai` · multi-day — **DONE 2026-08-17**

27 FRs. Sequenced to front-load risk.

- [x] **1. The gate first, TDD-red-proven.** FR-9..FR-13 — **done**, `openai/gate.rs`, 18 tests, red
      proven first. `evaluate(tool, input, cwd, permission_mode, rules) -> GateDecision` +
      `resolve_in_cwd`. Every listed case covered, plus `bypassPermissions` and the
      unrecognised-mode-is-`default` fail-closed half.
  - **No rule matcher existed anywhere in the core** — Claude Code matches upstream, so one had to be
    written. It is built only on the existing `path_key`/`path_relative_to_cwd`/`split_pattern`
    primitives and pinned by the invariant that matters: *a pattern `generate_pattern` produces for a
    call always matches that same call*, table-tested over all six tools. Without it the loop would
    silently re-ask for what the user already allowed — the exact failure the 2026-08-12 `naming`
    decision exists to prevent. **Ceiling:** it understands `generate_pattern`'s own shapes only (bare
    tool, `Tool(path)`, `Bash(prefix:*)`, `Bash(exact)`), which matches `permission-guardrails` §2's
    stated non-goal; hand-typed arbitrary globs would need a real glob engine.
  - **Interpretation, flagged for review:** FR-12's "`bypassPermissions` skips the gate entirely" is
    read as skipping the *approval step*; FR-13's "confined to the session's `cwd`" carries no mode
    qualifier, so containment runs **before the mode is consulted, in every mode**. Pinned by
    `bypass_permissions_does_not_bypass_cwd_containment`.
  - **One string the spec never pinned:** FR-10's deny message is verbatim, FR-12's plan-mode refusal
    is only "a refusal string". Chose `"Francois: {tool} is not available while this session is in
    plan mode."`, echoing `permission-guardrails` FR-12's own `Francois: …` prefix.
- [x] **2. Lift the `pattern`/`patternLabel` builder** out of `claude_code.rs` into a module both
      adapters call (FR-11) — **already true, no work needed.** `generate_pattern` /
      `label_for_pattern` / `build_ask` are public in `src-tauri/src/permissions/patterns.rs` and
      called from five sites (`session/stdio.rs:181`, `commands/decisions.rs:254`,
      `persistence.rs:1051`, `permissions/rules.rs:125`, `session/events.rs:295`). `claude_code.rs`
      never owned them — it only peeks a *pending* ask's pattern (`peek_permission_pattern:161`).
      FR-11's conditional ("**if** that builder is private to `claude_code.rs`") does not fire, so
      the planned own-commit refactor is a no-op and the golden-replay canary has nothing to prove
      here. `OpenAiAdapter` calls `permissions::build_ask` directly.

**Crate decision taken 2026-08-16, logged in `_decisions.md`.** The core has **no async runtime at
all** — no `tokio`, no `reqwest`; `ureq = "2"` (blocking) is the only HTTP client, used today by the
endpoint probe (`account/endpoint.rs:300`) and the update checker. The Francois loop therefore
streams SSE over blocking `ureq` on a spawned thread, which is the shape `begin_turn` already uses
(`claude_code.rs:323-339` hands stdout to a reader thread). Pulling an async runtime into a
zero-async crate would be a larger change than the feature it serves.
- [x] **3. The loop.** Components and orchestration **done** — shipped in `f48a019`.
  - [x] `openai/wire.rs` (22 tests) — FR-3 request envelope + the six JSON-schema tool declarations,
        FR-4 incremental SSE decode (safe across a chunk boundary mid-line), FR-5 accumulation **by
        `index`** with malformed JSON degrading to an error string, `MAX_ROUND_TRIPS = 50` (FR-6),
        FR-7 context table mirrored + pinned against the contract, §7 error mapping with a test that
        the key never reaches a message. Fixture:
        `openai/fixtures/sse_turn.txt` — interleaved indices, `arguments` split across three chunks,
        a heartbeat line, `[DONE]`; replayed three ways (one push / mid-line split / byte at a time).
  - [x] `openai/tools.rs` (44 tests) — the six executors + an `execute` dispatcher. Containment is
        **not** re-implemented here: the five path tools take an already-resolved `&Path` from
        `gate::resolve_in_cwd`, and `Bash` is FR-13's stated exception.
  - [x] `openai/thread.rs` (10 tests) — FR-16 atomic write reusing `valid_session_id`, FR-17
        corrupt-file degrade to a fresh thread + `session.resumeFailed`, and FR-8's
        `drop_unanswered_tool_calls` as a **pure** pass the loop runs before every write.
  - [x] `openai/runner.rs` — `OpenAiAdapter`/`FrancoisTurnHandle`, the round-trip loop, the
        permission park, `adapter_for` registration + **`UnavailableAdapter` deleted** (FR-1: the
        match stays total *through the real implementation*), FR-19's notice.
    - The park is the one genuinely new mechanism: the Claude path answers over a pipe, so the
      Francois loop instead mirrors `stdio.rs`'s park half (`build_ask` → pending entry →
      `buf_permission` → `append_transcript` → `PermissionAsked` → `refresh_parked_status`, reusing
      `claim_pending` for the exactly-once claim) and blocks the loop thread on a `Condvar` that
      `decide_permission` signals.
    - **Covered by unit tests:** the round-trip cap and context-refusal predicates, unknown-tool and
      malformed-argument → error-string mapping, `ThreadToolCall` reconstruction, request-message
      assembly (skill block prepended, never mutating the persisted array), path resolution, and
      `resolve_models`. **Integration-only** (this crate has no `AppHandle` harness — its documented
      convention): `begin_turn`/`run_loop` itself, the park/wake race, and `interrupt`/`kill`.
- [x] **FR-18's wire gap, closed.** `session_models` took no account, so `models(account_id)` could
      never be reached with an endpoint account and FR-18 could not function. It now takes
      `account_id: Option<String>` (`session/models.rs:394`), derives the runtime from that
      account's `AccountKind` via `AgentRuntime::from_account_kind` and routes through
      `adapter_for(runtime).models(...)`; an omitted or unknown id falls back to
      `(ClaudeCode, DEFAULT_ACCOUNT_ID)`, **byte-identical to the old behaviour**. The decision is a
      pure `resolve_models_target`, unit-tested. `contract/session-engine.ts` gained
      `SessionModelsInput { accountId? }`; every existing call site still passes nothing.
      *(Corrected 2026-08-17: this entry previously said `session_id: Option<String>` resolved off
      the session. It is **account**-scoped — the picker's only mount is the New Session modal,
      which has no session yet. `models.rs:384-393` documents the choice.)*
- [x] **4. Skill injection** (FR-23..FR-27) — `openai/skills.rs`, 8 tests.
      `build_skill_block(env, cwd) -> SkillBlock`, 8_000-char cap (Unicode scalars, not bytes),
      deterministic across turns. **No second filesystem walk and no `SessionEnv` change was needed**
      — Phase D's `discover_commands` (`6d3c50d`) already routed discovery correctly, so the fix that
      unblocked this branch paid for itself here. FR-26 flip landed in
      `contract/multi-provider-seam.ts`, and the seam test's "nothing available on francois yet" case
      was **rewritten to assert the new truth**, not deleted.
- [x] **5. Frontend** — FR-20 disabled-pane treatment via a new `src/lib/runtimeCapability.ts`
      (`sessionCapability`) + a shared `src/ui/CapabilityNotice.tsx`, wired into all four panes, the
      usage bar and the slash menu; FR-22's disabled-endpoint block deleted from `accounts.ts`,
      `AccountField`, `DefaultsSection`, `projects.ts` and `AccountRow` + css. **FR-20's grep gate is
      clean — zero direct `agentRuntime`/`protocol` branches in `src/`.** FR-19 is core-emitted (its
      renderer already existed at `CommandCard.tsx:48`), so it moved to the runner.
  - [x] **FR-21's provider heading — landed, not blocked.** *(Corrected 2026-08-17: this item was
        left open describing a blocker that the FR-18 fix above had already removed. Verified
        implemented end to end.)* `ModelPicker.tsx:74` renders the heading; `ModelField.tsx:11`
        threads it; `NewSessionModal.tsx:92` computes it through
        `modelPickerProviderHeading(accounts, accountId)` (`accounts.ts:164`), which returns the
        selected account's **own display label** — never `agentRuntime`/`protocol`, which FR-20
        forbids. `groupByFamily` (`model-picker.ts:14`) groups *within* an already account-scoped
        catalog, which is why it needs no provider knowledge of its own. Covered by
        `accounts.test.ts:471` (Claude account, endpoint account, built-in default, pre-hydration
        empty) and `model-picker.test.ts:21`.

**Two lead decisions taken during the build, both now pinned by tests.** `Grep` became a real regex
tool (`regex` 1.13.1 added) rather than the literal-substring matcher it was first built as — it
carries Claude Code's name, so a model sends `fn \w+` and silently got zero matches. And `Bash`'s
`timeout` is **seconds**, per FR-14's own wording, diverging deliberately from Claude Code's
millisecond schema; the schema description says so outright and a regression test guards it, because
a revert to milliseconds would look like a fix rather than a 5000× unit error.

**Gate:** the seam's golden replay (`src-tauri/src/session/stream/fixtures/turn.expected.json`)
still passes **untouched**. That is the regression canary for the whole phase — a diff there means
a Claude Code session's behaviour moved.

## Phase F — ship · ~2 hrs — **IN PROGRESS 2026-08-17**

- [x] `git fetch && git branch -f main origin/main` **first** (seam round-2 noted local `main` was 50
      commits stale; a stale base poisons the freshness digest). Already converged — both refs sit at
      `4d7cbbc` (v0.19.0). The branch's merge-base is still `9d47115`, four commits behind, which is
      why every diff in this phase is taken against a merge-base and never against `main` directly.
- [x] `/cohorte-review multi-provider-openai` per touched surface — **round 2, verdict SHIP,
      blocking 0.** Two reviewers in parallel over `fe62665..HEAD` (the same base round 1 used: the
      commit after the shipped seam + endpoint work, so neither is re-reviewed).
      Report: `specs/reports/multi-provider-openai.md`.
  - **core: 0 findings.** All three round-1 core items verified landed, and the second CRITICAL's
    ancestor walk re-checked for the thing that actually mattered — containment did **not** weaken:
    `..` escapes and symlinked ancestors through a not-yet-created nested path still deny, pinned by
    a test each alongside the positive case.
  - **frontend: SHIP with 1 HIGH + 1 MEDIUM**, both round-1 items verified landed (FR-26's install
    gate covers the mouse *and* keyboard paths, since `useSkillsKeyboard` routes through the same
    gated `activate`), and **FR-20's grep gate still clean** — every `agentRuntime`/`protocol` hit
    outside `runtimeCapability.ts` is a fixture assignment or a comment saying not to branch on them.
- [x] **The two non-blocking findings closed anyway**, not parked. The HIGH was a real out-of-order
      race in `useModelCatalog` (a slow endpoint `/models` landing over a newer account's catalog),
      which the backlog is the wrong home for; the MEDIUM was a five-site selector dedup we were
      already in the files for. Both recorded in the spec's `## Remediation` round 2.
- [x] SHIP verdict · DoD ticked (12 of 15). **Three criteria left open on purpose** — the end-to-end
      turn (FR-1/FR-3/FR-4), the interrupted-mid-tool-call thread (FR-8) and quit-and-reopen
      continuity (FR-16). Nothing in the pipeline runs the app against a real endpoint, and each has
      a covered *pure* half but no covered whole; ticking them on unit coverage that doesn't reach
      would be the weakened-test move FR-19 exists to forbid. The spec says so inline.
- [x] All three specs flipped to `status: shipped` with a shared freshness anchor (see Phase C).
- [ ] `/cohorte-ship` — one PR, one release. Needs `git push --force-with-lease`:
      `origin/feat/multi-provider` still points at the pre-Phase-A `14895a6` (Phase A §"Still to do").
- [ ] Delete the `backup/pre-phase-a` tag once the PR is merged — it is Phase A's rollback handle and
      has no purpose after that.

**Green at the ship gate** (2026-08-17): `npx tsc --noEmit` clean · `npm test` 90 files / **1747
passed** · `cargo test` **1034 passed**, 3 ignored, **0 failed**. The golden replay canary passes
untouched, which is the whole-arc regression signal: no Claude Code session behaviour moved.

---

## Optional, cheap, and worth it: `anthropic-compatible` accounts

Seam FR-13a defers a third `AccountKind` — endpoint + key speaking the **Anthropic** dialect,
mapping to `('claude-code', 'anthropic')`, needing `account_env` (`session/spawn.rs:189`, which sets
only `CLAUDE_CONFIG_DIR` today) to emit `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`.

It is small — an account kind, a mapping row, two env vars — and it is **the cell that makes the two
axes load-bearing rather than tidy**. Without it, Phase B is a refactor justified by a hypothetical.
Slots naturally after D.

- [ ] Spec it (`specs/multi-provider-anthropic-endpoint.md` or fold into endpoint as an amendment)
- [ ] Build + review

## Phase G — `capability-registry` · not yet

**Do not start until the openai arc has shipped.** The draft's §10 Q1 — do sessions carry
`enabled_skills`/`enabled_agents`/`enabled_mcp`, or do capabilities stay ambient and cwd-scoped —
changes `SessionMeta`, the new-session modal and `projects` defaults. It should be answered against
a real second runtime, not a predicted one.

When it starts, it is **three** features, not one:

1. registry + discovery normalization (invert `skills.rs` / `mcp.rs` into discovery sources)
2. an MCP client for the `francois` runtime
3. a subagent dispatcher for the `francois` runtime

---

## Critical path

```
A ──▶ B ──▶ D ──▶ E ──▶ F
           ╰──▶ C ──╯
```

The single highest-leverage constraint is **B landing before E starts**. Everything else on this
list is recoverable; that one is not cheaply.
