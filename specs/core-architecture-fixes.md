---
id: core-architecture-fixes
title: Core architecture remediation
status: frozen
branch: feat/architecture-review
created: 2026-08-24
depends_on: [session-engine, transcript-scale, transcript-perf, multi-provider-seam, multi-account, diff-view, extensions, ext-path-resolution]
reviewed_base:
reviewed_digest:
---

# Core architecture remediation

> Source: `ARCHITECTURE-REVIEW-CORE.md` (static review of `src-tauri/`, commit `a3bb11c`).
> All twelve findings re-verified against this branch before freeze; line numbers below are
> **this branch's**, not the review's.
> Core-only. No UI, no design brief, no new IPC.

## 1. Summary

The Rust core carries four hot-path defects (a global registry lock held across filesystem
writes, an O(n²) UTF-16 recount per streamed token, an O(n²) unbounded-input trim on the boot
path, and a derived provider field that desynchronises when an account is deleted), four
unbounded-growth or resilience gaps (transcript files, per-agent indices, mutex poisoning,
main-thread commands), and a structural problem: `session/` is 61.5% of the core and sits in a
six-way dependency cycle that no tool can see, because Rust permits intra-crate cycles and the
quality gate measures file size instead. This feature fixes all of it, in three independently
shippable waves, and adds the enforcement that stops each class from returning.

**Zero user-visible change** except that things stop stalling and one impossible state becomes
unreachable.

## 2. Goals & non-goals

- **Goals**
  - Remove the four hot-path defects (FR-1 … FR-5).
  - Bound every unbounded dimension: transcript files on disk, per-agent indices in RAM, boot
    cost (FR-8 … FR-11).
  - Make a panic on a background thread survivable (FR-12, FR-13).
  - Give the core a library target so its highest-risk code becomes testable and benchmarkable
    (FR-14, FR-15).
  - Replace the 30 glob re-exports with named ones — producing the module map that does not
    currently exist anywhere — and invert the two worst cycles (FR-16, FR-22).
  - Make error codes compiler-checked against the contract union (FR-17 … FR-19).
  - Make process spawning a facade rather than a convention (FR-20, FR-21).
  - **Ratchet each structural rule into `npm run quality`** so it cannot regress (FR-21, FR-23).

- **Non-goals**
  - **Splitting into workspace crates.** Correct destination, wrong step. Attempted before
    FR-16 and FR-22 the cycles become compile errors that need a rewrite to resolve. Revisit
    once the graph is acyclic.
  - **Introducing `async`/`tokio` in the core.** Thread-per-turn fits the workload; the
    blocking-body-on-`async`-command pattern is a sound adaptation.
  - **Paying down `oversized-baseline.json` for its own sake.** 15 files over 1,000 lines is a
    symptom of the coupling, not the disease.
  - Any frontend change. `src/` is untouched; `contract/common.ts` is *read* by FR-18, never
    edited.

## 3. Flows

The only observable flows are absences.

1. **Persist under load.** 12 sessions open, one streaming. A `persist()` fires on a lifecycle
   event while the app-data dir sits on OneDrive and `fs::rename` takes 300 ms. *Today:* every
   session stalls for that window — streaming stops, commands queue. *After FR-1:* nothing
   stalls; only concurrent writers serialise.
2. **Long response.** The assistant streams a 100 KB code block, ~25,000 deltas. *Today:* the
   response visibly decelerates as it lengthens. *After FR-2:* constant per-delta cost.
3. **Boot with history.** A session with 50,000 persisted blocks. *Today:* the window is
   unpainted for tens of seconds while the whole file is read and quadratically trimmed on the
   main thread. *After FR-3/FR-8/FR-9:* the window paints immediately; transcripts fill in
   behind it.
4. **Delete a provider account.** User removes a Grok account with a live session on it.
   *Today:* the session keeps `agent_runtime = Grok` while its account becomes `default`
   (Claude), so the next turn spawns `grok` against the Claude config dir and fails to
   authenticate, unrecoverably from the UI. *After FR-4:* the session's runtime follows its
   account; the next turn runs as Claude Code.
5. **Panic on a reader thread.** A malformed frame panics one provider's reader while it holds
   `Engine.sessions`. *Today:* the mutex is poisoned and the next of 69 unwrapping sites kills
   the app — every session in the fleet. *After FR-12:* the panicking turn dies; the fleet
   lives.

## 4. Functional requirements

> Grouped by wave. Waves are independently shippable and should ship in order; **FR-16 must
> land before FR-22** — until the globs are gone nobody can enumerate what crosses each
> boundary, and any estimate for the inversion is a guess.

### Wave 1 — hot-path defects (all local, all testable against the existing suite)

- **FR-1** · `session/persistence.rs:257` · `persist()` must not hold `Engine.sessions` across
  filesystem I/O. Scope the guard so serialization ends before the write: bind the `Vec<Value>`
  from a block that drops the `MutexGuard`, then run `serde_json::to_vec_pretty` +
  `fs::write(&tmp)` + `fs::rename(&tmp, &path)` (`:338`) with no session lock held.
  `PERSIST_LOCK` (`:255`) still serialises writers — that is the invariant that needs holding,
  and it stays.

- **FR-2** · `session/stream/blocks.rs:228` · the streamed UTF-16 offset must be tracked
  incrementally, not re-derived. Add `text_utf16: &mut HashMap<String, usize>` alongside the
  existing `text_accum` at **every** site that already takes it (`handle_stream_event`,
  `handle_content_block_start`, `handle_content_block_delta`, `handle_text_delta`, and the
  `parse_stream` local at `stream/mod.rs:99`), keyed identically and inserted `0` on the same
  line `start_text_block` (`blocks.rs:70`) inserts the empty `String` — so the two maps have
  literally the same key lifecycle. In `handle_text_delta`: read the entry as `offset`, then
  add `text.encode_utf16().count()` (the **chunk**, O(chunk)) before pushing. The emitted
  `offset` is identical by construction.
  - Do **not** add the map to `ParseOutcome` — nothing downstream of the loop reads it.
  - `#[allow(clippy::too_many_arguments)]` is already on `parse_stream`; the added parameter
    needs no new exception.

- **FR-3** · `session/transcript_cap.rs:32` · `trim_transcript` must evict in O(n), not O(n²).
  Replace the `blocks.remove(0)` loop with a single `blocks.drain(0..k)` where `k` is the
  number of leading settled blocks to drop. The stop-at-the-oldest-unsettled rule documented on
  the function is **unchanged** — compute `k` by scanning forward from index 0 while
  `!blocks[k].streaming` and `blocks.len() - k > cap`. The `bool` return keeps its exact
  meaning (`true` iff anything was evicted).

- **FR-4** · `AgentRuntime` must be **derived at every point of use** from the session's account
  kind, never read from the stored field. Concretely:
  - `session/turn.rs:166` — replace `.with_session(session_id, |s| s.agent_runtime)` with a
    lookup of the session's `account_id`, then
    `AgentRuntime::from_account_kind(account::kind_of(app, &account_id)).0`. This is the one
    site that feeds `adapter_for`, and therefore the one that decides which CLI spawns.
  - `session/mod.rs:704` (`meta()`) — same derivation, so `SessionMeta.agentRuntime` reported to
    the frontend is always the truth.
  - `session/persistence.rs:280` — keep writing `"agentRuntime"` (frontends and older builds
    read it), but it is now a **cache of a derived value**, not a source of truth.
  - `session/persistence.rs:696` — keep reading it into the field for compatibility; the field
    becomes read-only legacy input that nothing authoritative consults.
  - `Session.agent_runtime` (`session/mod.rs:191`) stays as a field so the record round-trips;
    add a doc comment stating it is derived, non-authoritative, and must not be read for
    dispatch. No `provider_protocol` is stored on `Session` today — if one is ever added, the
    same rule binds it.

- **FR-5** · Add the invariant as a test: for every session in a loaded registry,
  `s.agent_runtime == AgentRuntime::from_account_kind(kind_of(s.account_id)).0`. Include a
  regression case that reproduces flow #4 exactly — a session on a Grok account, the account
  removed via `Engine::clear_account` (`session/mod.rs:1105`), and an assertion that the next
  dispatch resolves `ClaudeCode`, not `Grok`.

- **FR-6** · Add `(async)` to the seven remaining synchronous `#[tauri::command]`s:
  `account_add_codex`, `account_add_grok`, `account_codex_login`, `account_grok_login`,
  `account_install_cli` (`account/commands.rs:627,647,705,752,802`), `app_dnd_state`
  (`dnd.rs:30`), `workflows_list`. The rationale is the one already documented at
  `diff/commands.rs:48-56` and applies unchanged to a process spawn (10–100 ms on Windows) and
  to an OS state-file read. Where a `State<'_, _>` parameter blocks the change, use the
  `app.state::<T>()` pattern `diff/commands.rs` already uses and explains.

- **FR-7** · `diff/git.rs:177` · `REPO_CACHE` must be evicted with its siblings. Remove the
  session's cwd key in `unwatch_session` (`diff/watch.rs:200-209`), where `GIT_LOCKS`,
  `RECOMPUTES` and `WATCHERS` are already cleaned up. This also fixes the staleness: a repo
  moved or re-initialised no longer keeps its old answer until restart.

### Wave 2 — capacity and boot

- **FR-8** · `session/persistence.rs:245` · `read_transcript` must do bounded work regardless of
  file size. Replace `fs::read_to_string` with a tail read: seek to `len - K` bytes, discard the
  first (partial) line, parse forward. `K` is a named constant sized so the tail reliably
  contains ≥ `TRANSCRIPT_BUFFER_CAP` blocks; a file shorter than `K` is read whole. Parsing
  stays `parse_transcript` — only the input is bounded.

- **FR-9** · `main.rs:103` · hydration must not block the first paint. Split `load_persisted` in
  two: metadata (`sessions.json` only — cheap, bounded, keeps its current position in `.setup()`
  and its documented ordering constraints relative to projects and accounts) and transcripts
  (moved to a background thread that emits `session.meta` as each session's buffer lands). The
  per-session loop must **not** hold `Engine.sessions` across transcript reads — take the lock
  per session, not around the loop (`persistence.rs:640`).

- **FR-10** · The transcript file needs a retention policy. `append_transcript`
  (`persistence.rs:93`) only ever appends, so the RAM bound (400 blocks) has no disk counterpart
  and cost grows monotonically for the life of every retained session. Compact each session's
  transcript to its last N blocks on clean shutdown, N a named constant ≥ the tail-read window
  of FR-8. Compaction is temp+rename, best-effort, and never runs on a session that is mid-turn.

- **FR-11** · Bound the **agent dimension** the way the block dimension already is. The thirteen
  per-agent/workflow maps on `Session` (`session/mod.rs:539-591`) have exactly one removal site
  in the whole tree; worst case is ~3.2 MB retained per completed subagent (`AGENT_BLOCK_CAP`
  400 × 8,000 chars), so a 50-agent workflow holds ~160 MB for agents that finished hours ago.
  Keep full state for the N most recent agents (`agent_order` already gives first-seen ordering)
  and evict older **completed** agents' `agent_blocks`, `agent_steps` and `agent_inner_tools`
  down to their `AgentInfo` summary row, which is what the roster renders. **Never evict a
  running agent** — same rule as `trim_transcript`'s stop-at-the-oldest-unsettled.

- **FR-12** · Make `Engine.sessions` poison-tolerant. Today 255 `.lock().unwrap()` sites exist,
  69 on `Engine.sessions`, only 2 tolerate poisoning, and `[profile.release]` does not set
  `panic = "abort"` — so a panic on any of ~46 background threads poisons the mutex permanently
  and the next unwrapping site kills the app. `Engine::with_session_mut` / `with_session`
  (`session/mod.rs:1016-1034`) already exist and are documented as the standard shape: make
  **their** acquisition recover via `unwrap_or_else(|p| p.into_inner())`. This is safe here
  specifically because the state behind the lock is a `HashMap` of plain data, not an
  invariant-carrying type — say so in the doc comment.

- **FR-13** · Route the remaining direct `Engine.sessions` lock sites through the FR-12 helpers
  wherever they fit the single-session, nothing-else-while-locked shape the helpers document.
  Sites that genuinely do not fit (iterate every session, take a second lock, emit, spawn) stay
  direct — but each must then use the same poison-tolerant acquisition. No
  `.sessions.lock().unwrap()` may remain.

### Wave 3 — structure

- **FR-14** · Extract `src-tauri/src/lib.rs`. `main.rs` keeps `fn main()`, the `.manage()`
  registrations, the `.setup()` hook and the 124-entry command table; everything else moves
  behind a library target. The module tree does not change — only the crate root. All 1,475
  existing tests must still pass with no change to their content.

- **FR-15** · Add `src-tauri/tests/` and `src-tauri/benches/` targets, unlocked by FR-14. Seed
  each with the case that motivated it: an integration test over turn orchestration, and benches
  for the two paths measured in this spec (FR-2's per-delta cost and FR-8's boot read) — neither
  of which could be measured before, which is why they regressed unnoticed.

- **FR-16** · `session/mod.rs:65-99` · delete the 30 `pub(crate) use <child>::*;` glob re-exports
  and replace them with named `pub(crate) use` lists. Expect the first compile to surface a few
  hundred names; **that list is the module map** and is the deliverable of this FR as much as the
  code change is. 131 files open with `use super::*` — those may stay, but the parent must no
  longer be a funnel through which every child sees every other child.

- **FR-17** · Define `enum ErrorCode` in Rust with `#[derive(Serialize)]`, one variant per member
  of the `ErrorCode` union in `contract/common.ts:24`. Make `AppError.code` that type. The 49
  string literals currently spread through the Rust source become 49 compile-checked variants.

- **FR-18** · Add a test asserting the Rust enum's serialized names are **exactly** the TS
  union's members. Either parse `contract/common.ts` in a build script or generate the TS from
  the Rust — the direction is the implementer's call, the requirement is that one of the two is
  generated and the other is checked. Today the 49 codes agree by hand across a language boundary
  with no compiler, no test and no lint; a typo produces a code the frontend's `switch` does not
  handle and nothing fails.

- **FR-19** · Standardise internal fallible signatures on `Result<T, AppError>` (today:
  `Result<T, String>` ×43, `Result<T, (&'static str, String)>` ×10, `Result<T, AppError>` ×8,
  `Result<T, (String, String)>` ×2). Give `IpcResult` (`ipc.rs:19-23`) a
  `From<Result<T, AppError>>` so command bodies become `.into()` instead of the hand-written
  `match` ladder all 124 currently carry. `IpcResult` stays a non-`Result` untagged serde enum —
  that is deliberate and correct for the wire; only the conversion changes.

- **FR-20** · Add `process_util::spawn(program, args) -> CommandBuilder` applying all four spawn
  concerns **by construction**: login-shell PATH resolution, window suppression on Windows,
  environment scrubbing, stdio discipline. Migrate the 58 `Command::new` sites, starting with the
  five files that today apply no `process_util` helper at all (`project/repo_brief.rs`,
  `session/adapter/openai/gate.rs`, `session/cloud/auth.rs`, `session/models.rs`,
  `update/helper.rs`) and with `session/adapter/openai/tools.rs:424-433` — the Francois-owned
  agent loop's `Bash` tool, which calls `no_window` but not `login_shell_path_env`, so a tool
  call carrying Claude Code's own name resolves binaries against a different PATH depending on
  runtime. That is precisely the bug `ext-path-resolution` was written to fix, reintroduced
  elsewhere. Remove the duplicate `no_window` in `session/mod.rs` noted at `process_util.rs:1-3`.

- **FR-21** · Add a `scripts/quality/conventions.mjs` rule that fails on a bare `Command::new`
  outside `process_util`, ratcheted the same way `oversized-baseline.json` is (existing
  violations recorded, new ones fail).

- **FR-22** · Invert the two worst cycles. `session↔account` (70 refs out, 30 back) is almost
  entirely "which config dir / which kind" — extract an `AccountSnapshot` value type both domains
  depend on, instead of depending on each other. `session↔shell` is currently "broken" by a
  crate-root re-export at `main.rs:29` (`shell::dispose_session_shells`) so `session` can call it
  "without depending on the shell module directly" — that moves the import path, not the
  coupling. Replace it with a `SessionTeardown` trait the shell registry implements.

- **FR-23** · Add a cycle check to `scripts/quality/conventions.mjs`: a scan over
  `crate::<domain>` references that fails the build on a **new** back-edge, ratcheted like FR-21
  with the current edges recorded as the baseline. Without enforcement this regresses within a
  quarter — Rust does not reject intra-crate cycles and clippy has no lint for them.

> **Surface note (FR-21, FR-23):** the quality-gate rules live in `scripts/quality/`, which
> `PIPELINE.md` declares is *not a surface* — no agent owns it. Assign both to the **core** agent:
> the rules they add are Rust-shape rules and only the core agent knows the shapes being checked.

## 5. API contract

**No contract file.** This feature adds no IPC channel, changes no payload shape, and emits no
new event. `contract/core-architecture-fixes.ts` must **not** be created.

Two existing contract surfaces are touched in value, not in shape:

- `SessionMeta.agentRuntime` (`contract/common.ts`) — same type, same field, same emission on
  `session.meta`. FR-4 changes only *where the value comes from*: derived from the session's
  account kind rather than read from the persisted record. A frontend built against today's
  contract is correct against tomorrow's.
- `ErrorCode` (`contract/common.ts:24`, 82 members) — FR-17/FR-18 make the Rust side a
  compile-checked mirror of this union. The union itself is **read-only input** to this feature;
  adding, removing or renaming a member is out of scope. If FR-18's parity test fails at
  implementation time, the fix is on the Rust side, never by editing the TS union.

`sessions.json` and the per-session NDJSON transcript keep their current on-disk shapes. FR-10
changes how much of a transcript is retained, never the line format; a transcript written by
today's build must load in tomorrow's, and the `"agentRuntime"` key keeps being written (FR-4) so
a downgrade does not lose it.

## 6. Data & state

- **New (in-memory, transient):** `text_utf16: HashMap<String, usize>` in `parse_stream`'s frame
  — per-block UTF-16 length, same key lifecycle as `text_accum`, dropped with the turn.
- **New (constants):** the FR-8 tail-read window `K`, the FR-10 compaction bound `N`, and the
  FR-11 retained-agent count. All named constants with a comment giving the reason and the
  relationship to `TRANSCRIPT_BUFFER_CAP` (400) / `AGENT_BLOCK_CAP` (400) / `AGENT_TRAIL_CAP`
  (200), matching the codebase's existing convention for caps.
- **Changed (derived):** `Session.agent_runtime` stops being authoritative state and becomes a
  persisted cache of a value derived from `account::kind_of`. `provider_protocol` is not stored
  today and must not become stored.
- **Changed (evicted):** `agent_blocks` / `agent_steps` / `agent_inner_tools` for completed
  agents beyond the N most recent (FR-11); the session's `REPO_CACHE` entry at unwatch (FR-7);
  the on-disk transcript tail at clean shutdown (FR-10).
- **Unchanged:** the eight managed-state registries and the documented lock hierarchy that makes
  `AccountState`, `UsageState`, `UpdateState` and `ExtensionState` leaves. FR-22 must not disturb
  it — `AccountSnapshot` is a value type precisely so it introduces no new lock edge.

## 7. Edge cases & errors

1. **FR-1, a write fails after the guard drops.** Unchanged behaviour: the existing
   `is_ok()`/`is_err()` handling at `persistence.rs:338` stays. Serialising from a snapshot means
   the written state may be marginally staler than "at rename time" — that was already true and
   is the point of the atomic rename.
2. **FR-2, a block id absent from the offset map.** Only reachable if a delta arrives without its
   `content_block_start`. Treat a missing entry as `0`, exactly as `text_accum`'s `or_default()`
   does today — the two maps must fail the same way.
3. **FR-3, buffer stays over cap.** Expected and documented: when block 0 is unsettled, nothing
   is evicted and the buffer is allowed to exceed `cap`. `drain` must reproduce this, not "fix"
   it.
4. **FR-4, `kind_of` on an unknown account.** `account/mod.rs:373` already falls back to
   `ClaudeCodeOauth` for `default`. That fallback is now load-bearing — a session whose account
   vanished runs as Claude Code, which is a working state, rather than as a provider whose
   credentials it does not have.
5. **FR-8, a truncated or corrupt tail.** Discard the leading partial line; a line that fails to
   parse is skipped, as `parse_transcript` already does. A transcript smaller than `K` is read
   whole. Never surface an error — a transcript is a convenience, not a correctness input.
6. **FR-9, hydration races a user action.** A session interacted with before its transcript lands
   must not lose the buffer: hydration merges into the session under the lock and must not
   overwrite blocks arriving from a live turn. If a session starts a turn before its transcript
   lands, hydration for that session is abandoned rather than merged.
7. **FR-10, compaction interrupted.** temp+rename means an interrupted compaction leaves the
   original intact. Never compact a session that is mid-turn.
8. **FR-11, an evicted agent's tab is open.** Eviction is capped at *completed* agents, but a
   closed-then-reopened tab may find only the summary row. Render what exists; the pane must
   degrade to the `AgentInfo` row rather than to an error.
9. **FR-12, a genuinely poisoned invariant.** Recovering from poisoning is correct **only**
   because the guarded value is a plain `HashMap`. Any future field on `Engine` carrying an
   invariant across the lock invalidates this and must not reuse the helper.
10. **FR-18, parity test fails in CI.** It fails the build. That is the requirement — the whole
    point is that a mismatch stops being invisible.

## 8. Design brief

None. Core-only feature, no UI, no design tokens, no mock region. `design_files` is omitted from
the front matter deliberately.

## 9. Acceptance criteria

**Wave 1**
- [ ] No `MutexGuard` on `Engine.sessions` is live across `fs::write`/`fs::rename` in `persist()`;
      `PERSIST_LOCK` still serialises writers (FR-1).
- [ ] `handle_text_delta` contains no `accum.encode_utf16()`; a bench shows per-delta cost flat in
      accumulated length, and emitted `offset` values are byte-identical to the old implementation
      over a captured fixture (FR-2).
- [ ] `transcript_cap.rs` contains no `remove(0)`; existing tests pass unchanged, including the
      stop-at-unsettled and over-cap cases (FR-3).
- [ ] `adapter_for` is never reached with a runtime read from `Session.agent_runtime` (FR-4).
- [ ] A test removes a Grok account under a live session and asserts the next dispatch resolves
      `ClaudeCode`; the registry-wide invariant test passes (FR-5).
- [ ] All seven commands are `#[tauri::command(async)]`; no `#[tauri::command]` without `(async)`
      remains in the tree (FR-6).
- [ ] `unwatch_session` removes the cwd's `REPO_CACHE` entry (FR-7).

**Wave 2**
- [ ] `read_transcript` reads a bounded tail; a 500 MB synthetic transcript loads in bounded time
      and yields the last `TRANSCRIPT_BUFFER_CAP` blocks (FR-8).
- [ ] `.setup()` performs no transcript read; the window paints before transcripts land, and each
      arrival emits `session.meta` (FR-9).
- [ ] A clean shutdown compacts transcripts to N blocks; an interrupted compaction leaves the
      original readable (FR-10).
- [ ] After a 50-agent workflow completes, per-agent block/step state is retained for the N most
      recent only, and no running agent is ever evicted (FR-11).
- [ ] `with_session` / `with_session_mut` recover from poisoning; no `.sessions.lock().unwrap()`
      remains anywhere in the tree (FR-12, FR-13).
- [ ] A test panics a thread while holding `Engine.sessions` and asserts subsequent access still
      succeeds (FR-12).

**Wave 3**
- [ ] `src-tauri/src/lib.rs` exists; `main.rs` holds only `fn main()`, state registration,
      `.setup()` and the command table; all pre-existing tests pass unchanged (FR-14).
- [ ] `src-tauri/tests/` and `src-tauri/benches/` exist and run in CI / under `cargo bench`
      respectively (FR-15).
- [ ] `session/mod.rs` contains zero `use <child>::*;` re-exports (FR-16).
- [ ] `AppError.code` is a Rust enum; zero error-code string literals remain in the Rust source
      (FR-17).
- [ ] The parity test fails when a variant is added on one side only (FR-18).
- [ ] Internal fallible signatures are `Result<T, AppError>`; command bodies convert with
      `.into()` rather than a `match` ladder (FR-19).
- [ ] Every `Command::new` outside `process_util` is gone or baselined; the `Bash` tool in the
      Francois agent loop resolves PATH identically to every other runtime (FR-20, FR-21).
- [ ] `main.rs` no longer re-exports `shell::dispose_session_shells`; `session` and `account`
      share `AccountSnapshot` rather than each other (FR-22).
- [ ] `npm run quality` fails on a newly introduced `crate::<domain>` back-edge (FR-23).

**Throughout**
- [ ] `npm run quality` green; `cargo test` green; no new entry in `oversized-baseline.json`.
- [ ] Zero user-visible behavioural change other than those in §3.

## Remediation

(Empty until a review returns findings.)
