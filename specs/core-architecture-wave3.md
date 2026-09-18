---
id: core-architecture-wave3
title: Core architecture — Wave 3 (structure, error typing, spawn facade)
status: frozen
branch: feat/architecture-review
created: 2026-08-24
depends_on: [core-architecture-fixes, session-engine, multi-provider-seam, multi-account, ext-path-resolution]
reviewed_base:
reviewed_digest:
---

# Core architecture — Wave 3 (structure, error typing, spawn facade)

> Continuation of `core-architecture-fixes`, which landed Waves 1 and 2 (FR-1…FR-13) plus one
> named bug from FR-20. This spec carries forward the ten deferred Wave 3 FRs, renumbered, plus
> one new FR settling a deviation that build flagged. Parent FR ids are given in parentheses.
> Line numbers and counts below were **re-verified against this branch after the Wave 1/2 build**.
> Same branch as the parent: Wave 3 builds directly on Wave 1/2 code that has not merged yet.
> Core-only. No UI, no design brief, no new IPC.

## 1. Summary

Wave 3 is the structural wave, and it is the one a single dispatch could not land — the parent
build deferred all ten FRs, each for a defensible reason. This spec keeps them together in one
buildable unit, but **imposes an explicit build order** and makes every FR's acceptance criterion
independently checkable, so a partial landing is *visible* rather than indistinguishable from a
complete one. That is the one thing the parent build could not express.

Four concerns, four chains:

1. **Module map** — 30 glob re-exports hide what crosses each boundary; removing them produces the
   map, which unblocks the lib split and the cycle inversion (FR-1 → FR-2 → FR-3, FR-1 → FR-9).
2. **Error typing** — `AppError.code` is a `String` agreeing by hand with an 82-member TS union
   across a language boundary, with no compiler, no test, no lint (FR-4 → FR-5 → FR-6).
3. **Spawn facade** — 55 bare `Command::new` sites apply the four spawn concerns by convention;
   `ext-path-resolution` already proved convention loses (FR-7 → FR-8).
4. **Cycle inversion + enforcement** — `session↔account` and `session↔shell`, then the ratchet that
   stops both classes returning (FR-9 → FR-10).

Plus **FR-11**, settling the parent's FR-4 deviation in favour of the spec's letter.

**Zero user-visible change** except FR-7's PATH fix (§3.1) and FR-11 closing the last path by
which a session's runtime can desynchronise from its account.

## 2. Goals & non-goals

- **Goals**
  - Produce the module map that does not currently exist anywhere, by replacing 30 globs with
    named re-exports (FR-1).
  - Give the core a library target so its highest-risk code becomes testable and benchmarkable
    (FR-2, FR-3).
  - Make the 82 error codes compiler-checked against the contract union (FR-4, FR-5) and
    standardise fallible signatures on `Result<T, AppError>` (FR-6).
  - Make process spawning a facade rather than a convention (FR-7).
  - Invert the two worst cycles (FR-9).
  - **Ratchet the spawn rule and the cycle rule into `npm run quality`** so neither regresses
    (FR-8, FR-10).
  - Derive `AgentRuntime` at every point of use, not at every point of mutation (FR-11).

- **Non-goals**
  - **Splitting into workspace crates.** Unchanged from the parent: attempted before FR-1 and
    FR-9, the cycles become compile errors needing a rewrite. Revisit once the graph is acyclic.
  - **Introducing `async`/`tokio` in the core.** Thread-per-turn fits the workload.
  - **Paying down `oversized-baseline.json` for its own sake.**
  - **Changing the `ErrorCode` union.** `contract/common.ts` is read-only input to FR-4/FR-5;
    adding, removing or renaming a member is out of scope.
  - Any frontend change. `src/` is untouched.

## 3. Flows

Two observable, the rest are absences.

1. **A `Bash` tool call in the Francois agent loop, on a machine whose binaries live in
   nvm/Homebrew/pnpm.** *Today (after the parent build's partial FR-20):* the one named site is
   fixed, but 55 other spawn sites still resolve PATH by convention, and five files apply no
   `process_util` helper at all. *After FR-7/FR-8:* every spawn in the tree resolves identically,
   and a new bare `Command::new` fails `npm run quality`.
2. **Delete a provider account while a session is live on it.** *Today (after the parent build):*
   correct, because `Engine::clear_account` resyncs the stored field. *After FR-11:* correct
   because nothing reads the stored field for dispatch — the class of bug is closed rather than
   the one instance.
3. **A developer adds a `crate::session::` reference from `account/`.** *Today:* compiles, ships,
   deepens the cycle; Rust does not reject intra-crate cycles and clippy has no lint. *After
   FR-10:* fails the build as a new back-edge.
4. **A developer adds an error code on one side only.** *Today:* the frontend's `switch` silently
   does not handle it. *After FR-5:* the build fails.

## 4. Functional requirements

> **Mandatory build order.** These four chains are independent of each other and may be landed in
> any order, but **within** a chain the sequence is binding:
>
> | chain | order | why |
> |---|---|---|
> | module | FR-1 → FR-2 → FR-3 | FR-2 needs FR-1's named exports; a bin+lib split turns every `pub(crate)` into a cross-crate reference, and there are **87 glob re-exports tree-wide**, not just the 30 in `session/`. FR-3's targets are unlocked by FR-2. |
> | errors | FR-4 → FR-5 → FR-6 | FR-5 checks FR-4's enum; FR-6's `From` impl needs `AppError` to be final. |
> | spawn | FR-7 → FR-8 | FR-8 baselines what FR-7 leaves behind. |
> | cycles | FR-1 → FR-9 → FR-10 | Until the globs are gone nobody can enumerate what crosses each boundary, and any estimate for the inversion is a guess. FR-10 baselines FR-9's result. |
>
> **Land whole FRs, in order, and stop at a clean boundary.** An FR partially applied is worse
> than one not started: the baselines in FR-8/FR-10 record whatever exists when they run, so a
> half-migrated tree bakes its own debt into the ratchet.

### Chain: module map

- **FR-1** *(parent FR-16)* · `session/mod.rs:65-99` · delete the 30 `pub(crate) use <child>::*;`
  glob re-exports and replace them with named `pub(crate) use` lists. Expect the first compile to
  surface a few hundred names; **that list is the module map** and is the deliverable of this FR
  as much as the code change is — commit it as a doc comment at the head of the re-export block,
  grouped by child module. 131 files open with `use super::*` — those may stay, but the parent
  must no longer be a funnel through which every child sees every other child.

- **FR-2** *(parent FR-14)* · Extract `src-tauri/src/lib.rs`. `main.rs` (264 lines) keeps
  `fn main()`, the `.manage()` registrations, the `.setup()` hook and the 124-entry command table;
  everything else moves behind a library target. The module tree does not change — only the crate
  root. **Widening `pub(crate)` → `pub` is expected and must be done by name, never by adding a
  glob**: `main.rs` becomes an external crate relative to `src/`, so every item the command table
  and `.manage()` calls touch needs individually verified visibility. All pre-existing tests must
  still pass with no change to their content.

- **FR-3** *(parent FR-15)* · Add `src-tauri/tests/` and `src-tauri/benches/` targets, unlocked by
  FR-2. Seed each with the case that motivated it: an integration test over turn orchestration,
  and benches for the two paths the parent spec measured (per-delta streaming cost and the boot
  transcript read) — neither of which could be measured before, which is why they regressed
  unnoticed. `tests/` runs in CI; `benches/` runs under `cargo bench` and is not a CI gate.

### Chain: error typing

- **FR-4** *(parent FR-17)* · Define `enum ErrorCode` in Rust with `#[derive(Serialize)]`, one
  variant per member of the `ErrorCode` union in `contract/common.ts:24` (**82 members**, verified).
  Make `AppError.code` (`ipc.rs:12`) that type. Serialization must produce the union's exact
  `SCREAMING_SNAKE` strings. The call sites are `err(…)` / `err_detail(…)` — **579 of them**, of
  which 31 pass a direct string literal today; the remainder reach the code through helpers and
  constants, and enumerating them is part of this FR because nothing currently does.

- **FR-5** *(parent FR-18)* · Add a test asserting the Rust enum's serialized names are **exactly**
  the TS union's members — same set, no extras on either side. Either parse `contract/common.ts`
  in a build script or generate the TS from the Rust; the direction is the implementer's call, the
  requirement is that **one of the two is generated and the other is checked**. The test must fail
  when a variant is added on one side only.

- **FR-6** *(parent FR-19)* · Standardise internal fallible signatures on `Result<T, AppError>`
  (today, verified: `Result<T, String>` ×43, `Result<T, (&'static str, String)>` ×10,
  `Result<T, AppError>` ×8, `Result<T, (String, String)>` ×2). Give `IpcResult`
  (`ipc.rs:19-23`) a `From<Result<T, AppError>>` so command bodies become `.into()` instead of the
  hand-written `match` ladder all 124 currently carry. `IpcResult` stays a non-`Result` untagged
  serde enum — that is deliberate and correct for the wire; only the conversion changes.

### Chain: spawn facade

- **FR-7** *(parent FR-20, remainder)* · Add `process_util::spawn(program, args) -> CommandBuilder`
  applying all four spawn concerns **by construction**: login-shell PATH resolution, window
  suppression on Windows, environment scrubbing, stdio discipline. Migrate the **55** remaining
  bare `Command::new` sites, starting with the files that apply no `process_util` helper at all —
  verified on this branch as `account/codex.rs`, `account/grok.rs`, `project/repo_brief.rs`,
  `session/adapter/claude_code.rs`, `session/adapter/codex/runner.rs`,
  `session/adapter/grok/runner.rs`, `session/adapter/openai/gate.rs`, `session/cloud/auth.rs`,
  `session/models.rs`, `session/usage_probe.rs`, `update/helper.rs`, `usage.rs`. Remove the
  duplicate `no_window` in `session/mod.rs` noted at `process_util.rs:1-3`.
  - `process_util.rs` itself and `session/attachments/testutil.rs` (a test fixture) are exempt.
  - The parent build already fixed `session/adapter/openai/tools.rs`; do not re-fix it, but the
    facade must subsume what it does by hand.

- **FR-8** *(parent FR-21)* · Add a `scripts/quality/conventions.mjs` rule that fails on a bare
  `Command::new` outside `process_util`, ratcheted the way `oversizedFindings` is (existing
  violations recorded in a baseline JSON, new ones fail). Follow the file's existing shape: a pure
  `<rule>Findings(files, baseline)` export wired into `allFindings`, with unit tests alongside.

  > **Surface change (FR-8, FR-10):** these rules live in `scripts/quality/`, which `PIPELINE.md`
  > declares is *not a surface* — no agent owns it, and the parent build's core agent correctly
  > refused them on those grounds. **Resolution: widen the `core` surface's `path` from
  > `src-tauri` to cover `scripts/quality/` as well**, and re-render `.claude/agents/core.md`.
  > The rules being added are Rust-shape rules and only the core agent knows the shapes being
  > checked. `/cohorte-build` §1.5 must reconcile this before dispatching.

### Chain: cycle inversion

- **FR-9** *(parent FR-22)* · Invert the two worst cycles.
  - `session↔account` (**75 refs out, 34 back**, verified) is almost entirely "which config dir /
    which kind" — extract an `AccountSnapshot` value type both domains depend on, instead of
    depending on each other. It must introduce **no new lock edge**: that is why it is a value
    type and not a handle.
  - `session↔shell` is currently "broken" by a crate-root re-export at `main.rs:30`
    (`pub(crate) use shell::dispose_session_shells;`, with the rationale in the comment at `:28`)
    so `session` can call it "without depending on the shell module directly" — that moves the
    import path, not the coupling. Replace it with a `SessionTeardown` trait the shell registry
    implements.

- **FR-10** *(parent FR-23)* · Add a cycle check to `scripts/quality/conventions.mjs`: a scan over
  `crate::<domain>` references that fails the build on a **new** back-edge, ratcheted like FR-8
  with the current edges recorded as the baseline. Without enforcement this regresses within a
  quarter — Rust does not reject intra-crate cycles and clippy has no lint for them. Same surface
  note as FR-8.

### Settling the parent's deviation

- **FR-11** *(new; settles parent FR-4)* · `AgentRuntime` must be derived **at every point of
  use**, not resynced at every point of mutation. The parent build satisfied the acceptance test
  by resyncing `s.agent_runtime` / `s.protocol` inside `Engine::clear_account`; that closes the
  one known instance, not the class. Thread `AppHandle` into `Session::meta()`,
  `Engine::clear_account` and `Engine::clear_project` so each derives via
  `AgentRuntime::from_account_kind(account::kind_of(app, &account_id)).0`, and **remove the
  resync** — a derived value has nothing to resync.
  - This requires a test `AppHandle` fixture: ~15 existing unit tests call these without one, and
    `session/env.rs` documents that the crate wires up no such harness. Adding it is part of this
    FR, in `session/testutil` alongside the existing fixtures.
  - `Session.agent_runtime` (`session/mod.rs:191`) stays as a field so the record round-trips, and
    `persistence.rs` keeps writing and reading `"agentRuntime"` for compatibility. Its doc comment
    must state it is derived, non-authoritative, and must not be read for dispatch.
  - The parent's invariant test and its Grok-account-removal regression must both still pass,
    unchanged.

## 5. API contract

**No contract file.** This feature adds no IPC channel, changes no payload shape, and emits no new
event. `contract/core-architecture-wave3.ts` must **not** be created.

One existing contract surface is read, never written:

- `ErrorCode` (`contract/common.ts:24`, 82 members) — FR-4/FR-5 make the Rust side a
  compile-checked mirror of this union. The union is **read-only input**. If FR-5's parity test
  fails at implementation time, the fix is on the Rust side, never by editing the TS union.

`SessionMeta.agentRuntime` keeps its type, field and emission on `session.meta`; FR-11 changes only
where the value comes from, so a frontend built against today's contract is correct against
tomorrow's. `sessions.json` and the per-session NDJSON transcript keep their current on-disk
shapes.

## 6. Data & state

- **New (type):** Rust `enum ErrorCode`, 82 variants, `#[derive(Serialize)]` (FR-4). Replaces
  `AppError.code: String`.
- **New (type):** `AccountSnapshot` — a plain value type carrying config dir + kind, owned by
  neither domain, depended on by both (FR-9). Carries no handle and introduces no lock edge.
- **New (trait):** `SessionTeardown`, implemented by the shell registry (FR-9).
- **New (facade):** `process_util::spawn` returning a `CommandBuilder` (FR-7).
- **New (baselines):** one for bare `Command::new` sites (FR-8), one for `crate::<domain>` back-edges
  (FR-10), both under `scripts/quality/` and ratcheted the way `oversized-baseline.json` is.
- **Changed (derived):** `Session.agent_runtime` becomes a persisted cache of a value derived at
  use from `account::kind_of`; the parent's resync-at-mutation is removed (FR-11).
- **Unchanged:** the eight managed-state registries and the documented lock hierarchy that makes
  `AccountState`, `UsageState`, `UpdateState` and `ExtensionState` leaves. FR-9 must not disturb it.

## 7. Edge cases & errors

1. **FR-1, a name is re-exported from two children.** The glob hid the collision; the named list
   surfaces it as a compile error. Resolve by qualifying at the use site, never by re-adding a glob.
2. **FR-2, an item is reachable only via a glob.** Widen it by name. If widening would make an
   internal type public, that is the signal the item belongs behind a function, not that the glob
   should stay.
3. **FR-4, a code reaches `err()` through a runtime string.** If any site genuinely cannot name a
   variant at compile time, it is either a missing variant (add it to the Rust enum and let FR-5
   fail until the TS union is reconciled by a *separate* feature) or a bug. It is never a reason
   to keep `code: String`.
4. **FR-5, the union and the enum disagree in CI.** It fails the build. That is the requirement —
   the whole point is that a mismatch stops being invisible.
5. **FR-7, a site needs a spawn concern the facade does not apply.** Extend the builder; do not
   bypass it. A site that bypasses the facade is exactly what FR-8 exists to catch.
6. **FR-8/FR-10, the baseline is regenerated mid-migration.** Baselines record whatever exists when
   they run, so regenerating on a half-migrated tree bakes the debt in. Generate each baseline only
   at the end of its chain, and never as a way to make a failing check pass.
7. **FR-9, `AccountSnapshot` goes stale.** It is a value read at the point of use, not cached state;
   nothing may hold one across a turn boundary. Holding one is the same class of bug as FR-11's.
8. **FR-11, `kind_of` on an unknown account.** `account/mod.rs:373` already falls back to
   `ClaudeCodeOauth` for `default`. That fallback stays load-bearing — a session whose account
   vanished runs as Claude Code, a working state, rather than as a provider whose credentials it
   does not have.

## 8. Design brief

None. Core-only feature, no UI, no design tokens, no mock region. `design_files` is omitted from the
front matter deliberately.

## 9. Acceptance criteria

**Module map**
- [ ] `session/mod.rs` contains zero `use <child>::*;` re-exports, and the named lists are grouped
      by child module under a doc comment (FR-1).
- [ ] `src-tauri/src/lib.rs` exists; `main.rs` holds only `fn main()`, state registration,
      `.setup()` and the command table; no glob was added to make it compile (FR-2).
- [ ] `src-tauri/tests/` runs in CI; `src-tauri/benches/` runs under `cargo bench`, with benches for
      per-delta streaming cost and the boot transcript read (FR-3).

**Error typing**
- [ ] `AppError.code` is a Rust enum with 82 variants; zero error-code string literals remain in the
      Rust source (FR-4).
- [ ] The parity test fails when a variant is added on one side only, and one of the two sides is
      generated (FR-5).
- [ ] Internal fallible signatures are `Result<T, AppError>`; command bodies convert with `.into()`
      rather than a `match` ladder (FR-6).

**Spawn facade**
- [ ] Every `Command::new` outside `process_util` is migrated to `process_util::spawn` or baselined;
      the twelve helper-free files are migrated; the duplicate `no_window` in `session/mod.rs` is
      gone (FR-7).
- [ ] `npm run quality` fails on a newly introduced bare `Command::new` (FR-8).

**Cycles**
- [ ] `main.rs` no longer re-exports `shell::dispose_session_shells`; `session` and `account` share
      `AccountSnapshot` rather than each other; no new lock edge was introduced (FR-9).
- [ ] `npm run quality` fails on a newly introduced `crate::<domain>` back-edge (FR-10).

**Derivation**
- [ ] `Session::meta()`, `Engine::clear_account` and `Engine::clear_project` derive `agent_runtime`
      from `account::kind_of`; the parent build's resync is removed; a test `AppHandle` fixture
      exists in `session/testutil` (FR-11).
- [ ] The parent's registry-wide invariant test and Grok-account-removal regression pass unchanged
      (FR-11).

**Throughout**
- [ ] `npm run quality` green; `cargo test` green; no new entry in `oversized-baseline.json`.
- [ ] Zero user-visible behavioural change other than those in §3.

## 10. Open questions

None. The parent build's two flagged items are settled here: FR-11 requires the derivation the
parent deviated from, and the FR-8/FR-10 surface note widens `core` to own `scripts/quality/`.

## Remediation

(Empty until a review returns findings.)
