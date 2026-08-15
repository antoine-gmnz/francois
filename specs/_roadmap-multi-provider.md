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

## Phase C — endpoint re-review · ~1 hr

Runs parallel to D, but **after B** (B touches `AccountKind`'s mapping).

- [ ] `/cohorte-review multi-provider-endpoint`
- [ ] Fix pass if it returns findings
- [ ] `status: frozen` → SHIP-ready

## Phase D — seam re-review, round 3 · ~1 hr

- [ ] `/cohorte-review multi-provider-seam` with A and B landed
- [ ] Target: SHIP verdict on the seam + endpoint pair **before any openai code exists**

## Phase E — build `multi-provider-openai` · multi-day

27 FRs. Sequenced to front-load risk.

- [ ] **1. The gate first, TDD-red-proven.** FR-9..FR-13 is the spec's own highest-severity
      requirement. Write the tests before the loop exists and *prove they fail*: an unmatched tool
      asks; a `deny` rule never executes; `plan` refuses `Write`/`Edit`/`Bash`; `acceptEdits`
      auto-allows only `Write`/`Edit`; a `cwd` escape is refused **before** any card.
- [ ] **2. Lift the `pattern`/`patternLabel` builder** out of `claude_code.rs` into a module both
      adapters call (FR-11). Own commit — this touches seam code, and the golden replay test is
      what proves it moved no behaviour.
- [ ] **3. The loop** — SSE parse (FR-4), tool-call accumulation **by `index`** (FR-5), the 50-round
      cap (FR-6), context refusal (FR-7), interrupt consistency (FR-8), thread persistence
      (FR-16/FR-17).
- [ ] **4. Skill injection** (FR-23..FR-27) reusing `session/skills.rs`'s discovery — **no second
      filesystem walk**. Flip `skills` to `available: true` for the `francois` runtime.
- [ ] **5. Frontend** — disabled-pane treatment (FR-20), model picker grouping (FR-21), first-turn
      notice (FR-19), and **delete** `multi-provider-endpoint` FR-14 (FR-22).

**Gate:** the seam's golden replay (`src-tauri/src/session/stream/fixtures/turn.expected.json`)
still passes **untouched**. That is the regression canary for the whole phase — a diff there means
a Claude Code session's behaviour moved.

## Phase F — ship · ~2 hrs

- [ ] `/cohorte-review` per touched surface
- [ ] SHIP verdict
- [ ] `/cohorte-ship` — one PR, one release
- [ ] `git fetch && git branch -f main origin/main` first (seam round-2 noted local `main` was 50
      commits stale; a stale base poisons the freshness digest)

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
