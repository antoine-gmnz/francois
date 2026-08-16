---
id: multi-provider-seam
title: Session adapter seam
status: shipped
branch: feat/multi-provider
created: 2026-08-12
depends_on: [session-engine, multi-account, durable-sessions, permission-guardrails]
loop_pass: 4
loop_phase: review
reviewed_base: 9d471154a835f85ac1987132268dbe9b779da95e
reviewed_digest: f94d48b5b2e3548a
---

# Session adapter seam

## 1. Summary

Francois runs exactly one thing: `claude -p --output-format stream-json`, spawned by
`session::turn::begin_turn`, read by `session::stream::run_reader`, controlled over the CLI's stdio
control channel. This feature puts a **`SessionAdapter` trait** between the session engine and that
binary, with the current behaviour as its single implementation, so a second runner (an
OpenAI-compatible endpoint, `multi-provider-openai`) can be added without touching the engine, the
commands, or any pane. It ships **zero new user-visible behaviour**: the only outward change is two
discriminator fields (`SessionMeta.provider`, `Account.kind`) whose value is constant today, and a
pure capability table nothing consumes yet. Its whole value is that nothing changed — so the proof
that nothing changed (§4, FR-17..FR-19) is the deliverable, not a formality.

> **What that proof is, precisely** (amended 2026-08-12, review round 2 — see FR-18): the full
> pre-existing test suite green with **no test deleted or weakened** (FR-19), plus a golden replay
> of a real `claude` capture (FR-17/FR-18) that locks the parse path's event sequence going
> forward, plus review. It is **not** a pre/post golden diff — the state that would have generated
> one (after FR-5 + FR-6, before FR-1..FR-4) is not reachable, for the reason recorded under FR-18.

## 2. Goals & non-goals

**Goals**

- A `SessionAdapter` trait covering **the whole runner contract**: turn start, the live control
  channel (interrupt, question answers, permission decisions), pending-state introspection, and the
  provider's model catalog. Not just the stream — the control channel is where the CLI-shape leaks.
- `ClaudeCodeAdapter` as the only implementation, behaviour-identical to today.
- `provider` / `kind` discriminators in the contract, and a pure `providerCapabilities()` table.
- Evidence the refactor is a no-op: a recorded stream fixture replayed to an asserted event list.

**Non-goals**

- Any OpenAI/HTTP code, agent loop, tool execution, or permission gate — `multi-provider-openai`.
- Any new UI, any pane behaviour change, any new IPC channel. If a pane renders differently after
  this feature, that is a bug.
- Endpoint account fields (`baseUrl`, key handling, model override) and the Accounts "add endpoint"
  path — `multi-provider-openai`. Only `Account.kind` lands here.
- Consuming `providerCapabilities()`. The table is defined and tested; the panes that will read it
  are disabled in `multi-provider-openai`, alongside the sessions that make them matter.

## 3. User stories / flows

None. No flow changes. The user-observable acceptance is that **every existing flow behaves exactly
as before** — send a turn, stream a reply, approve a gated tool, answer a question, interrupt,
switch model, quit and resume, run a subagent, open an agent tab.

## 4. Functional requirements

### Core — the trait

- **FR-1** `src-tauri/src/session/adapter/mod.rs` defines `SessionAdapter: Send + Sync`:
  - `fn provider(&self) -> Provider`
  - `fn preflight(&self, app: &AppHandle, ctx: &TurnContext) -> Result<(), AppError>` — refuse a
    turn before any I/O.
  - `fn begin_turn(&self, app: &AppHandle, ctx: TurnContext) -> Result<Box<dyn TurnControl>, AppError>`
    — owns spawning/connecting and starting the reader thread.
  - `fn models(&self, app: &AppHandle, account_id: &str) -> Vec<ModelInfo>`
  - `TurnContext` carries what `begin_turn` reads off the session today: `session_id`, `block_id`,
    `text`, `mode: TurnMode`, `cwd`, `model_id`, `effort`, `permission_mode`, `runtime`,
    `worktree_distro`, `account_id`, `allow_git`, and the resume anchor.
- **FR-2** `TurnControl: Send + Sync` replaces direct field access on `TurnHandle`:
  - `fn interrupt(&self)` · `fn kill(&self)`
  - `fn answer_question(&self, request_id: &str, answers: &Value) -> bool`
  - `fn decide_permission(&self, request_id: &str, decision: PermissionDecision) -> bool`
  - `fn pending_counts(&self) -> PendingCounts { questions: usize, permissions: usize }`
  - Both `answer_*`/`decide_*` return `false` when the id is not pending — the callers' existing
    `QUESTION_NOT_PENDING` / `PERMISSION_NOT_PENDING` errors are derived from that, unchanged.
  - `Session.current` becomes `Option<Arc<dyn TurnControl>>`. The concrete `TurnHandle`
    (child / stdin / pending maps) moves into the Claude adapter and is `pub(crate)` to it only.
  - **Amended 2026-08-12 (review round 1, lead sign-off).** Originally frozen as
    `Box<dyn TurnControl>`. `Arc` is required, not preferred: the control commands clone the
    handle out from under the sessions lock *before* the blocking control-channel write, because
    holding that lock across the write would stall the reader thread that has to drain the
    response. `Box<dyn Trait>` cannot provide the `Clone` that requires. No other FR changes.
  - **Amended 2026-08-12 (review round 2, lead sign-off).** Two further shipped deviations from the
    frozen sketch above, both load-bearing:
    - `answer_question`/`decide_permission` return **`ControlAck`** (`NotPending` · `Applied` ·
      `ChannelClosed`), not `bool`. The bare `bool` collapses two states the pre-refactor code kept
      apart: "never pending" (no event owed at all) and "was pending, but the control channel died
      between park and decision" (a `cancelled` resolution is still owed). Both still surface the
      same `QUESTION_NOT_PENDING` / `PERMISSION_NOT_PENDING` error to the caller, so the outward
      contract in the two bullets above is unchanged — the richer variant only lets the caller do
      the cleanup the pre-refactor code did. Collapsing it to `bool` would be the behavioural
      change FR-19 forbids.
    - The trait carries an unlisted **`drain_pending`**, which the pre-refactor code performed by
      reaching directly into `TurnHandle`'s pending maps at turn teardown. FR-2's whole purpose is
      that no command touches those maps, so the teardown path needs a trait method for it.
    Neither is a new capability — both are pre-existing behaviour that had to become trait-visible
    once direct field access went away.
- **FR-3** `src-tauri/src/session/adapter/claude_code.rs` holds `ClaudeCodeAdapter`, wrapping
  today's `spawn.rs`, `stdio.rs` and `stream/` with **no behavioural change**: same argv, same env,
  same resume/`ResumeRetry` logic, same control-channel protocol, same `allow_git` auto-approval,
  same post-result close policy.
- **FR-4** `adapter_for(provider: Provider) -> &'static dyn SessionAdapter`. `Provider` is a Rust
  enum mirroring the contract's `SessionProvider`; `Provider::OpenAiCompatible` resolves to a stub
  that returns `INVALID_INPUT` ("provider not available in this build") — unreachable in this
  feature, since no account can carry that kind yet.
- **FR-5** `run_reader` takes a source that implements `std::io::BufRead` instead of taking the
  `Child` and pulling `stdout` off it. The adapter owns the process and hands the reader its stdout.
- **FR-6** Event emission goes through a sink the tests can capture, rather than calling
  `AppHandle::emit` directly: `emit(app, ev)` keeps its signature for every existing call site, but
  the parse path takes an `&dyn SessionEnv` (production: the Tauri handle; tests: a `Vec` collector).
  This is what makes FR-18 possible at all — `AppHandle` cannot be constructed in a unit test.
  - **Amended 2026-08-12 (review round 1, lead sign-off).** Originally frozen as `&dyn EventSink`,
    naming emission only. The shipped trait is `SessionEnv` (`src-tauri/src/session/env.rs`) and is
    a deliberate **superset**: `emit_session`/`emit_agent`/`emit_workflow_detail` plus `engine()`,
    `persist()`, `append_transcript()` and `note_file_diff()`. The parse path already called all
    four through the live `AppHandle`, so an emission-only sink would not have removed the
    `AppHandle` requirement and FR-18 would still be impossible — the name follows the real
    boundary ("what the parse path needs from its environment"), not just one verb of it.
    Per FR-19 this shape change is called out in the PR body.
- **FR-7** The `ACCOUNT_NOT_AUTHENTICATED` preflight currently inline in `begin_turn`
  (`turn.rs:271-287`) moves into `ClaudeCodeAdapter::preflight`. Same error code, same
  `mark_auth_failed` side effect, same message.
- **FR-8** `session_interrupt`, `session_answer_question` and `permissions_decide` reach the turn
  **only** through `TurnControl`. No command may name a `Child`, a `ChildStdin`, or a pending map.
- **FR-9** `refresh_parked_status` derives `awaiting_approval` / `awaiting_input` from
  `TurnControl::pending_counts()`, keeping the existing precedence (approval outranks question) and
  the existing never-latched semantics. It must not know which adapter it is talking to.
- **FR-10** `session_models` routes through `adapter_for(...).models(...)`. For `claude-code` that
  is today's `models.rs` path verbatim (live `/v1/models` fetch, static fallback).
  - **Amended 2026-08-12 (review round 1, lead sign-off).** Originally written as
    `adapter_for(session.provider)`, which this channel cannot satisfy: the `session_models` IPC
    payload carries **no session or account id at all**, so there is no session to read a
    `provider` off. The call resolves `adapter_for(Provider::ClaudeCode)` unconditionally. This is
    a pre-existing gap this feature neither worsens nor closes — closing it needs a new field on
    an existing channel, which §2 rules out ("no new IPC channel"). Per-session model routing
    lands with `multi-provider-openai`, the first feature for which two providers can coexist and
    the distinction becomes observable.

### Contract — discriminators

- **FR-11** `SessionMeta.provider: SessionProvider` (required). Set at `session_create` and **never
  re-derived** thereafter. Persisted; a stored record with no `provider` key loads as
  `'claude-code'`, so every existing session on disk is unaffected.
- **FR-12** `Account.kind: AccountKind` (required). The built-in `default` account and every
  registered login are `'claude-code-oauth'`; a stored record with no `kind` key loads as that.
- **FR-13** A session's provider is **derived from its account's kind** at creation —
  `SessionCreateInput` gains no field and the new-session modal gains no control. Mapping:
  `'claude-code-oauth' → 'claude-code'`, `'openai-compatible' → 'openai-compatible'`. An
  `accountId` that no longer resolves falls back to `default`, hence to `'claude-code'` (the
  existing multi-account FR-10 path, unchanged).

> **Amended 2026-08-14 (architecture review, lead sign-off) — FR-11/FR-13 split into two axes.**
> See FR-11a/FR-13a below. The text above is kept verbatim as the record of what was frozen and
> built; where the two disagree, FR-11a/FR-13a win.

- **FR-11a** `SessionProvider` collapsed **two orthogonal things** into one enum: *who owns the
  agent loop* and *which wire dialect the endpoint speaks*. They separate:

  ```ts
  /** Who owns the agent loop. Renames SessionProvider; same discriminator, honest name. */
  export type AgentRuntime = 'claude-code' | 'francois';

  /** Which wire dialect the session's endpoint speaks. New axis. */
  export type ProviderProtocol = 'anthropic' | 'openai';
  ```

  `SessionMeta.provider` is replaced by **`agentRuntime: AgentRuntime`** and
  **`protocol: ProviderProtocol`**, both required, both set at `session_create` and never
  re-derived. A persisted record with neither key loads as `('claude-code', 'anthropic')`; a record
  carrying the superseded `provider` key maps `'claude-code' → ('claude-code', 'anthropic')` and
  `'openai-compatible' → ('francois', 'openai')`, so no session written by an intermediate build is
  orphaned.

  **Not `runtime`.** `SessionMeta.runtime: ClaudeRuntime` is already taken by `wsl-filesystem` and
  means native-vs-WSL. `agentRuntime` is the free name, and `'francois'` for the second member is
  the vocabulary the journal and `FRANCOIS_TOOLS` already use — not `'native'`, which the *other*
  `runtime` field spends on the opposite meaning.

  **Why now rather than later.** The collapsed enum cannot name a cell that is real today: the
  Claude Code CLI honours `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`, so
  `agentRuntime: 'claude-code'` against a third-party Anthropic-dialect endpoint is a working
  configuration with no value in `SessionProvider`. (`spawn.rs:189`'s `account_env` sets only
  `CLAUDE_CONFIG_DIR` today, so there is nowhere to put the override either — that half is
  deferred, see FR-13a.) The cost of the split is a contract reshape while nothing is merged to
  `main`; the cost of deferring it is the same reshape plus a migration over every persisted
  session, and a third enum member that is a lie on the day it lands (journal, 2026-08-12 `naming`).

- **FR-13a** Both axes derive from the account's kind at creation. Mapping, exhaustive over
  `AccountKind`:

  | `AccountKind` | `agentRuntime` | `protocol` |
  |---|---|---|
  | `claude-code-oauth` | `claude-code` | `anthropic` |
  | `openai-compatible` | `francois` | `openai` |

  An `accountId` that no longer resolves falls back to `default`, hence to
  `('claude-code', 'anthropic')` — the existing multi-account FR-10 path, unchanged.

  **Deferred, and what the split exists for:** a third kind `'anthropic-compatible'` (endpoint +
  key, Anthropic dialect) maps to `('claude-code', 'anthropic')` and needs `account_env` to emit
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`. That is its own feature, not this amendment — but it
  is the cell that makes the two axes load-bearing rather than tidy, and the mapping table is
  written so adding it is a row, not a redesign.

- **FR-14a** `adapter_for` dispatches on **`agentRuntime` alone** — the runtime is who owns the
  loop, which is exactly what picks an adapter. `protocol` is read *inside* the `francois` runtime
  to pick the wire codec, and is not an adapter-dispatch key. The Rust `Provider` enum
  (`session/adapter/mod.rs`) becomes `AgentRuntime` with the same two members renamed
  (`ClaudeCode`, `Francois`), and `Provider::from_account_kind` becomes
  `AgentRuntime::from_account_kind` returning the pair.

### Contract — capability table

- **FR-14** `contract/multi-provider-seam.ts` exports a pure
  `providerCapabilities(provider: SessionProvider): ProviderCapabilities` — no IPC, no new channel,
  same idiom as `isBusyStatus` in `contract/fleet-board.ts`. Each entry is
  `{ available: boolean; reason?: string }`; `reason` is present **iff** `available` is false, is a
  single user-facing sentence, and is what a disabled pane renders.
  - **Amended 2026-08-14 (architecture review, lead sign-off).** Under FR-11a the table keys on
    the **runtime**, not the protocol: `mcp`, `subagents`, `skills`, `workflows`,
    `interactiveCommands` and `compaction` are properties of *who owns the loop*, and a
    `francois`-runtime session has the same gaps whichever dialect it speaks. The export becomes
    `runtimeCapabilities(runtime: AgentRuntime): RuntimeCapabilities`, with
    `ProviderCapability`/`ProviderCapabilities` renamed `RuntimeCapability`/`RuntimeCapabilities`.
    The two entries that are genuinely vendor-shaped rather than runtime-shaped — `remoteControl`
    and `usageBar` — stay in this table anyway: both are false for every non-Anthropic
    configuration, and splitting one table into two to express that would cost more than it says.
    Values are unchanged; this is a rename plus the FR-15 rewording.
  - **Reserved name.** The doc this amendment came from uses `ProviderCapabilities` for a
    *model*-level flag set (`streaming`, `vision`, `reasoning`, `parallel_tool_calls`,
    `structured_output`, `parallel_tool_calls`). That is a different concept from this table, which
    is product-level pane availability. The rename above frees `ProviderCapabilities` for the
    model-level meaning when a feature needs it — do not spend the name on anything else.
- **FR-15** The table, exhaustive over `ProviderCapability`:

  | capability | `claude-code` | `openai-compatible` |
  |---|---|---|
  | `mcp` | true | false — "MCP servers aren't available on this provider yet." |
  | `subagents` | true | false — "Subagents aren't available on this provider yet." |
  | `skills` | true | false — "Skills aren't available on this provider yet." |
  | `workflows` | true | false — "Workflows aren't available on this provider yet." |
  | `interactiveCommands` | true | false — "Slash commands aren't available on this provider yet." |
  | `remoteControl` | true | false — "Remote Control is an Anthropic service." |
  | `usageBar` | true | false — "This provider bills per token, not against a plan." |
  | `compaction` | true | false — "Compaction isn't available on this provider yet." |

  Adding a `ProviderCapability` member without a value for **both** providers must not compile
  (`Record<ProviderCapability, CapabilityState>`, no index signature).

  - **Amended 2026-08-14 (architecture review, lead sign-off).** Three reasons were reworded:
    `skills`, `workflows` and `interactiveCommands` read "X is a Claude Code feature", which states
    a **permanent property of the runner** where the truth is a **current gap**. They now take the
    "aren't available on this provider yet" form the other three gaps already use. `remoteControl`
    and `usageBar` keep their wording deliberately — those two name Anthropic *services*, and there
    is nothing to port. No `available` value changes; this is wording only, and no test asserts the
    strings. The distinction matters because interoperable capabilities are the point of the arc
    (`specs/capability-registry.md`): a reason line that says a capability *is* a Claude Code
    feature writes the gap into the architecture, and the next agent reads it as settled.
- **FR-16** **No frontend consumer.** No component, store, or selector calls
  `providerCapabilities()` in this feature. The frontend's only change is carrying the two new
  fields through the types it already passes around.

### Proof it is a no-op

- **FR-17** A raw NDJSON stream fixture is captured from a **real** `claude` session **before any
  code in this feature changes**, and checked in at
  `src-tauri/src/session/stream/fixtures/turn.ndjson`. It must exercise, in one turn: assistant
  text deltas, a tool call with its `tool_result`, a subagent dispatch with an inner line carrying
  `parent_tool_use_id`, a `can_use_tool` permission request, an `AskUserQuestion`, a
  `system/init`, and the final `result`. Secrets, absolute home paths and account identifiers are
  scrubbed; the scrub is textual and must not change the line count or the event sequence.
- **FR-18** A golden test replays that fixture through the parse path (FR-5's `BufRead` source,
  FR-6's capturing sink) and asserts the **serialized `SessionEvent` sequence** — ordered, complete,
  field-for-field — against a checked-in expected list. The expected list is **hand-reviewed against
  the fixture** before it is committed; from that commit on it is a lock, and any diff it produces
  is a regression until proven otherwise.
  - **Amended 2026-08-12 (review round 2, lead sign-off — option (b) of the round-2 HIGH).**
    Originally frozen as "generated once at the earliest point it can run (i.e. after FR-5 + FR-6,
    before FR-1..FR-4)", so that replaying it against post-extraction code would prove the
    extraction a no-op **by construction**. That ordering is **not achievable**, and the reason is
    FR-6's own amendment above: the parse path needs `engine()`, `persist()`, `append_transcript()`
    and `note_file_diff()` from its environment, not just emission, so an FR-5+FR-6-only state
    still requires a live `AppHandle` and the golden test still cannot run there. The generating
    point the original text names does not exist. Option (a) — reconstructing the witness in a
    scratch worktree — would have to reconstruct that impossible state, so it cannot produce a
    diff either.
    **What the artefact therefore claims, and no more:** the expected list is a forward lock on the
    parse path's behaviour, generated against post-extraction code and hand-reviewed line-by-line
    against a real 103-line `claude` 2.1.228 capture (FR-17). The no-op claim in §1 rests on the
    full pre-existing test suite staying green with nothing deleted or weakened (FR-19), plus
    review — **not** on a pre/post golden diff. The clause asserting a proof this artefact does not
    deliver is struck rather than left standing.
- **FR-19** `npm test`, `npx tsc --noEmit` and `cargo test` are green, with no test deleted or
  weakened to accommodate the refactor. A test that must move follows its code (PIPELINE
  §Code layout); a test that must *change shape* is called out in the PR body with its reason.

## 5. API contract

**No new IPC channel, no new command, no new event.** Three existing contract files are edited in
place (per the 2026-08-04 `api` decision: a domain's payload types live in that domain's file).

### `contract/common.ts` — additions

```ts
/**
 * Which runner drives a session. Names the RUNNER, not the vendor: 'claude-code' is
 * the Claude Code CLI harness, 'openai-compatible' is Francois's own agent loop over
 * an OpenAI-dialect endpoint. A future Anthropic-API-through-our-own-loop path would
 * be a third member, which a vendor-shaped name could not express.
 */
export type SessionProvider = 'claude-code' | 'openai-compatible';
```

`SessionMeta` gains, as a **required** field:

```ts
  /**
   * The runner this session's turns go through (multi-provider-seam FR-11).
   * DERIVED from the session's account kind at creation and never re-derived.
   * A persisted record without it loads as 'claude-code'.
   */
  provider: SessionProvider;
```

**Amended 2026-08-14 (FR-11a/FR-13a/FR-14a).** `SessionProvider` and `SessionMeta.provider` above
are **superseded**. What `contract/common.ts` carries instead:

```ts
/**
 * Who owns the agent loop. Renames SessionProvider — same two members, honest
 * name: 'claude-code' is the Claude Code CLI harness driving its own loop,
 * 'francois' is our loop in the Rust core. It answers "who decides what happens
 * next", NOT "which vendor's API" — that is `ProviderProtocol` plus the session's
 * account, which together name the wire and the credential.
 *
 * NOT called `runtime`: SessionMeta.runtime is taken by wsl-filesystem and means
 * native-vs-WSL. NOT called 'native' for the second member, for the same reason.
 */
export type AgentRuntime = 'claude-code' | 'francois';

/**
 * Which wire dialect the session's endpoint speaks. Orthogonal to AgentRuntime:
 * the Claude Code CLI honours ANTHROPIC_BASE_URL, so ('claude-code','anthropic')
 * against a third-party endpoint is a real cell — one a single collapsed enum
 * could not name. Vendor IDENTITY is neither of these two; it is the session's
 * account and its endpoint baseUrl.
 */
export type ProviderProtocol = 'anthropic' | 'openai';
```

`SessionMeta` gains both, as **required** fields:

```ts
  /**
   * multi-provider-seam FR-11a. DERIVED from the account's kind at creation and
   * never re-derived. Absent ⇒ 'claude-code'; a record carrying the superseded
   * `provider` key maps 'claude-code' → 'claude-code', 'openai-compatible' → 'francois'.
   */
  agentRuntime: AgentRuntime;
  /** multi-provider-seam FR-11a. Absent ⇒ 'anthropic'; superseded `provider: 'openai-compatible'` ⇒ 'openai'. */
  protocol: ProviderProtocol;
```

### `contract/multi-account.ts` — additions

```ts
/**
 * What kind of credential an account is. 'claude-code-oauth' is an interactive
 * Claude Code login with its own config dir (the only kind today);
 * 'openai-compatible' is an endpoint + key, added by multi-provider-openai.
 */
export type AccountKind = 'claude-code-oauth' | 'openai-compatible';
```

`Account` gains, as a **required** field:

```ts
  /** multi-provider-seam FR-12. A persisted record without it loads as 'claude-code-oauth'. */
  kind: AccountKind;
```

No `account:*` channel changes shape: `AccountListResponse`, `AccountRenameResponse`,
`AccountSetDefaultResponse`, `AccountRemoveData.accounts` and `AccountEvent`'s `account.list` /
`account.login.done` all carry the widened `Account` automatically.

### `contract/multi-provider-seam.ts` — new file

```ts
// contract/multi-provider-seam.ts — the provider capability table.
// Pure, no IPC. Authored from specs/multi-provider-seam.md §5.

import type { SessionProvider } from './common';

export type ProviderCapability =
  | 'mcp'
  | 'subagents'
  | 'skills'
  | 'workflows'
  | 'interactiveCommands'
  | 'remoteControl'
  | 'usageBar'
  | 'compaction';

/** `reason` is present iff `available` is false; it is what a disabled pane renders. */
export interface CapabilityState {
  available: boolean;
  reason?: string;
}

/** Exhaustive over ProviderCapability — a new member without both values must not compile. */
export type ProviderCapabilities = Record<ProviderCapability, CapabilityState>;

export function providerCapabilities(provider: SessionProvider): ProviderCapabilities;
```

Values are exactly FR-15's table. No error codes are added to `ErrorCode`.

## 6. Data & state

**Core.** `Session.provider: Provider` — a new persisted field, written at creation, read on load
with `'claude-code'` as the absent-key default (`persistence.rs`, same shape as the existing
`accountId` fallback). `Session.current` changes type from `Option<TurnHandle>` to
`Option<Box<dyn TurnControl>>`; `TurnHandle` itself moves into `adapter/claude_code.rs` unchanged in
content. No other session state moves, is added, or is removed. `Account.kind` is a new persisted
field in the account registry with the same absent-key default treatment.

**Frontend.** No new store, no new selector, no new state. `SessionMeta.provider` and
`Account.kind` flow through the existing `sessionsStore` / accounts state as opaque carried fields.

**Persistence.** Both new fields are additive and forward-compatible in both directions: an older
build reading a newer `sessions.json` ignores the unknown key; a newer build reading an older one
applies the default. No migration step and no version bump.

## 7. Edge cases & errors

| case | behaviour |
|---|---|
| Persisted session with no `provider` | loads as `'claude-code'`. No warning, no event. |
| Persisted account with no `kind` | loads as `'claude-code-oauth'`. |
| Session's `accountId` no longer resolves | falls back to `default` → `'claude-code'` (existing multi-account FR-10 path). |
| `adapter_for(OpenAiCompatible)` reached | `INVALID_INPUT`, "provider not available in this build". Unreachable today; exists so the match is total rather than a `panic!`. |
| Turn command arrives with no live turn | unchanged: `SESSION_NOT_RUNNING` / the existing `*_NOT_PENDING` codes, now derived from `TurnControl`'s `false` return. |
| Golden replay diverges from the expected list | a failing test. It is never updated to match new output without the diff being explained in the PR body. |

## 8. Design brief

**No UI.** This feature renders nothing and changes no pixel. No design brief; `design_files` is
omitted from the front-matter deliberately.

## 9. Acceptance criteria

- [x] `SessionAdapter` and `TurnControl` exist per FR-1/FR-2; `ClaudeCodeAdapter` is the only real
      implementation (FR-3).
- [x] No file under `src-tauri/src/session/commands/` names `Child`, `ChildStdin`, or a pending
      map **on the turn-control path** — `session_interrupt`, `session_answer_question` and
      `permissions_decide` reach the turn only through `TurnControl` (FR-8).
      **Exempt (amended 2026-08-12, review round 1, lead sign-off):** `session_compact`'s
      synchronous side-spawn in `commands/turn.rs`. It is not a turn — it runs a one-shot `claude`
      process to observe post-compaction context usage, never registers as `Session.current`, and
      has no interrupt, no pending maps and nothing to control. Routing it through `SessionAdapter`
      would mean inventing a "run a one-shot side command" adapter method that FR-1's trait
      deliberately does not have. FR-8's own text was always scoped to the three control commands;
      this checkbox overreached past it. The carve-out is documented in `session/adapter/mod.rs`.
- [x] `run_reader` accepts a `BufRead` source and emits through a `SessionEnv` (FR-5/FR-6).
- [x] `session_models` and the auth preflight go through the adapter (FR-7/FR-10).
- [x] `contract/common.ts` and `contract/multi-account.ts` carry the two required discriminators;
      `contract/multi-provider-seam.ts` exports the capability table (FR-11/FR-12/FR-14).
- [x] A vitest case asserts `providerCapabilities()` is exhaustive for both providers and that every
      `available: false` entry has a non-empty `reason` (FR-15).
- [x] No frontend component, store or selector references `providerCapabilities` (FR-16) — grep is
      the check.
- [x] `turn.ndjson` is committed and covers all seven line kinds listed in FR-17.
- [x] The golden replay test passes and its expected list was hand-reviewed before the trait
      extraction commit (FR-18).
- [x] A `sessions.json` and an account registry written by the previous release load with correct
      defaults and no error (FR-11/FR-12).
- [x] `npm test`, `npx tsc --noEmit`, `cargo test` all green with no test deleted or weakened
      (FR-19).

## Remediation

### 2026-08-12 — review round 1 (REVISE · 2 CRITICAL, 4 MEDIUM, 2 LOW)

- [x] CRITICAL · `src-tauri/src/session/stream/mod.rs:352` + `src-tauri/src/session/stream/fixtures/turn.ndjson` · spec-violation · FR-17 requires the golden fixture to be captured from a **real** `claude` session; the code's own doc comment admits it is a hand-built "synthetic-but-realistic transcript built to the exact NDJSON shapes this parser already round-trips elsewhere in this module's own tests". A fixture shaped by the parser's own known behaviour cannot catch what a real transcript's edge cases would — which defeats the "proof it's a no-op" purpose §1 calls this feature's whole deliverable. → Capture a real `claude -p --output-format stream-json --include-partial-messages` transcript exercising all seven FR-17 line kinds, scrub it per FR-17, regenerate `turn.ndjson`, and hand-review `turn.expected.json` against that real capture. — fixed: replaced by a **real** capture — 103 raw stdout lines from live `claude` 2.1.228 (2026-08-12), production argv, captured in a scratch dir outside the repo; scrubbed textually (paths prefix-rewritten preserving backslash escaping so a path split across two `input_json_delta` chunks still concatenates correctly, thread id → fixed uuid, thinking `signature` → `SCRUBBED`), same 103 lines / same order / same per-line structure verified before commit, zero identifier leaks. `turn.expected.json` (31 events) regenerated through the real `parse_stream` and hand-reviewed; doc comment rewritten to state provenance, flags, prompt and scrub rules. The capture carries kinds no hand-built fixture would have included — `hook_started`/`hook_response`, `system/status`, `thinking_tokens`, thinking blocks with signature deltas, the `task_*` lifecycle, `rate_limit_event` — which was the point. Two tests strengthened: the subagent-leak test re-anchored to the real inner lines, and a new `the_fixture_covers_all_seven_fr_17_line_kinds` asserts coverage rather than trusting it (motivated by a real near-miss — the first capture raised no permission request at all, because the CLI auto-approves bash it classifies read-only; only a mutating `mkdir build` fires one). `cargo test` 901 passed / 0 failed.

- [ ] CRITICAL · `src-tauri/src/account/mod.rs:35`, `src-tauri/src/account/commands.rs:349`, `contract/multi-account.ts`, `contract/common.ts:61` · spec-violation · **Lead-owned — ship-time staging, not a code change.** The working tree mixes `multi-provider-endpoint` into this feature's diff, which §2 Non-goals assign elsewhere ("Only `Account.kind` lands here" / "No error codes are added to `ErrorCode`"). → Stage the endpoint hunks (`commands.rs` FR-6..FR-10 block, `mod.rs`'s `mod endpoint`/`AccountEndpoint`/`EndpointRecord`, `registry.rs`'s `account_record_invariant_holds`, `testutil.rs`'s `endpoint_record_fixture`, `fs_util.rs`'s `write_user_only_file`, the 3 `ACCOUNT_ENDPOINT_*`/`ACCOUNT_KEY_WRITE_FAILED` codes, `EndpointConfig`/`AccountAddEndpointPayload` in `contract/multi-account.ts`, the whole frontend endpoint UI, plus untracked `src-tauri/src/account/endpoint.rs` and `src/features/accounts/EndpointForm.tsx`) into their own commit at `/cohorte-ship`, and land `multi-provider-endpoint`'s re-review verdict first. **Correction to the finding:** it states `multi-provider-endpoint` "has never been through its own review loop" — that reads a stale `loop_pass: 0` front matter. The artifacts show it was built (`build.json` 14:37), reviewed REVISE with 13 findings (`verdict.json` 15:02) and fixed on both surfaces (`fix.json` 15:28); it is awaiting a re-review, which is the normal post-fix state. Nothing is committed yet on this branch (all 44 files are working-tree), so no code needs removing — only separating at commit time. — **SUPERSEDED by round 2 CRITICAL #2 (still open, tracked there): this item's own premise expired.** Commit `1ec2f0f` committed the endpoint scope into the branch, so the approved "stage it at ship time" remedy no longer applies as written — separating it now means rewriting `1ec2f0f`. Do not action this line; action the round-2 one.

- [x] MEDIUM · `src-tauri/src/session/mod.rs:443` · spec-violation · FR-2 froze `Session.current` as `Option<Box<dyn TurnControl>>`; the implementation ships `Arc<dyn TurnControl>`, an undisclosed deviation. → Lead sign-off + amend FR-2. — fixed: FR-2 amended (spec §3) to `Arc<dyn TurnControl>` with the "clone out from under the sessions lock before the blocking control-channel write; `Box` cannot `Clone`" rationale recorded. Code unchanged — the implementation was right, the frozen text was wrong.

- [x] MEDIUM · `src-tauri/src/session/commands/turn.rs:214` · spec-violation · The acceptance criterion "No file under `src-tauri/src/session/commands/` names `Child`…" is unmet: `session_compact` still calls `spawn_claude`/`child_stdout_lines` and does `child.stdin.take()` on a raw `std::process::Child`. → Either route the side-spawn through `SessionAdapter`, or narrow the acceptance checklist to exempt it. — fixed: acceptance checkbox narrowed (spec §9) to exempt `session_compact`'s synchronous side-spawn, with the reasoning that it is not a turn (never `Session.current`, no interrupt, no pending maps) and that FR-8's own text was always scoped to the three control commands — the checkbox had overreached past the FR it cites. Code unchanged.

- [x] MEDIUM · `src/features/sessions/roster-groups.test.ts:12-26` · quality · The `session()` fixture helper builds a `SessionMeta` without the new required `provider` field and hides the gap behind `as SessionMeta`, while every sibling fixture helper in this diff got `provider: 'claude-code'`. → Add `provider: 'claude-code',` to the returned object (after `accountId: 'default',`). — fixed: `roster-groups.test.ts:12-27` — `provider: 'claude-code',` added after `accountId`, and the `as SessionMeta` cast **removed** (it proved not load-bearing; the literal is now structurally complete, so the fixture is compiler-checked again and will fail loudly on the next required contract field — which was the finding's actual point).

- [x] MEDIUM · `src/features/conversation/welcome.test.ts:10-24` · quality · Same gap: the `session()` helper omits `provider` and leans on `as SessionMeta` to compile. → Add `provider: 'claude-code',` to the returned object. — fixed: `welcome.test.ts:10-25` — same treatment, `provider` added and the cast removed. `npx tsc --noEmit` clean, `npm test` 1720 passing.

- [x] LOW · `src-tauri/src/session/models.rs:391` · spec-violation · FR-10 says `session_models` "routes through `adapter_for(session.provider)`"; the implementation always passes `Provider::ClaudeCode` because the `session_models` payload carries no session or account id. → Amend FR-10 to state the limitation. — fixed: FR-10 amended (spec §3) to `adapter_for(...)` with the "payload carries no session id, so there is no session to read a provider off" limitation recorded, and per-session routing deferred to `multi-provider-openai` where two providers first coexist. Code unchanged.

- [x] HIGH · `src-tauri/src/session/stream/fixtures/turn.expected.json` · spec-violation · **Surfaced during round 1 remediation, not in the original report; lead decision required.** FR-18 requires the expected list to be "generated once at the earliest point it can run (i.e. after FR-5 + FR-6, before FR-1..FR-4)", so that replaying it against post-extraction code proves the trait extraction is a behavioural no-op **by construction**. That ordering was never realised: the whole feature is a single uncommitted working-tree change (`git log origin/main..HEAD` is empty), so no FR-5+FR-6-only state ever existed to generate at, and the list was in fact generated against current post-FR-1..FR-4 code. What is committed therefore locks the parse path's behaviour **going forward against a real transcript** (genuinely valuable, and now much stronger than it was) but does **not** demonstrate pre/post equality — which is precisely what §1 calls this feature's whole deliverable. → Choose one: **(a)** reconstruct an independent witness — a scratch worktree at `origin/main`, apply only the mechanically-separable FR-5 (`run_reader` takes `BufRead`) + FR-6 (`SessionEnv`/`TestEnv`) changes, generate the expected list there and diff it against the committed one; a clean diff restores the by-construction proof. **(b)** amend FR-18 and §1 to state plainly that the no-op claim rests on the existing test suite plus review, not on a pre/post golden diff, and drop the "generated before the trait extraction" clause as unachieved. Do **not** leave FR-18 asserting a proof the artefact does not deliver. — fixed 2026-08-12 (round 2, lead sign-off): **option (b) chosen**, and (a) ruled out on evidence rather than on cost. FR-6's own round-1 amendment already establishes why: the parse path needs `engine()`/`persist()`/`append_transcript()`/`note_file_diff()` from its environment, not emission alone, so an FR-5+FR-6-only tree still requires a live `AppHandle` and the golden test still cannot run there. The generating point FR-18 named never existed and cannot be reconstructed — a scratch worktree would have to reconstruct that same impossible state, so (a) yields no diff either. FR-18 amended (spec §4) to state what the artefact actually is (a forward lock on the parse path, hand-reviewed against the real FR-17 capture) and §1 amended to state what the no-op claim rests on (FR-19's untouched suite + the golden replay + review, **not** a pre/post golden diff). The overreaching clause is struck rather than left standing.

- [x] LOW · `src-tauri/src/session/env.rs:23` · quality · FR-6 specifies `&dyn EventSink`; the shipped abstraction is the broader `&dyn SessionEnv` (adds `engine()`, `persist()`, `append_transcript()`, `note_file_diff()`), and FR-19 requires a shape-changed interface to be called out in the PR body. → Confirm the PR note, or rename to the spec's vocabulary. — fixed: FR-6 amended (spec §3) to `&dyn SessionEnv`, recording why the superset is load-bearing rather than incidental (the parse path already called all four through the live `AppHandle`, so an emission-only sink would not have removed the `AppHandle` requirement and FR-18 stays impossible), plus the §9 checkbox; flagged for the PR body per FR-19. Code unchanged.

### 2026-08-12 — review round 2 (BLOCK · 2 CRITICAL, 1 HIGH, 2 MEDIUM, 1 LOW)

> **Diff base corrected.** Local `main` (`8c6f1c2`) is 50 commits stale (v0.18.0 → v0.18.13, PRs
> #58–#77); the review used `origin/main` (`9d47115`). The true delta is **one commit**, `1ec2f0f`,
> 66 files. Run `git fetch && git branch -f main origin/main` before `/cohorte-ship`, or its
> freshness digest hashes 50 commits of unrelated history.
>
> Round-2 MEDIUM #1 is recorded below as **two lines** — its spec half and its code half have
> different owners (lead vs `core`), and one line would have hidden the open half behind a tick.

- [x] CRITICAL · `src-tauri/src/session/commands/decisions.rs:73,121` · security · `pending_permission_pattern` (new in this diff) peeks the ask pattern from `Session.block_buffer` instead of the adapter's live pending-permissions map the pre-refactor code peeked; `buf_permission_resolve` (`session/mod.rs:773`) only flips `card["state"]` on resolve and never clears `card["ask"]`, so the pattern stays discoverable forever. `permissions_decide` with `remember: true` for a block_id that is no longer pending (already allowed/denied/cancelled, anywhere in session history) therefore still finds a pattern and calls `crate::permissions::write_rule(...)`, persisting an "always allow/deny" rule to `settings.json` **before** the subsequent `control.decide_permission` fails with `ControlAck::NotPending`. Pre-refactor this returned `PERMISSION_NOT_PENDING` and wrote nothing — this bypasses the must-be-pending authorization gate `permission-guardrails` exists to enforce, and violates FR-19's no-behavioural-change mandate. → **Fix:** return the pattern only when the matched block's own `card["state"] == "pending"` (or peek through `TurnControl`'s live pending state instead of the transcript buffer), plus a regression test asserting a second `permissions_decide(remember: true)` on a resolved block_id does not invoke `write_rule`. — fixed: the buffer peek is **deleted** (`grep block_buffer src-tauri/src/session/commands/decisions.rs` now matches nothing) and the gate reads the **live turn** again. `PendingPermission` carries its `pattern` (`session/mod.rs:317`, populated `stdio.rs:183`) — the field the seam refactor dropped, which is what pushed the lookup into the transcript in the first place; `TurnControl` gains `pending_permission_pattern(id)` (`adapter/mod.rs:153`, impl `claude_code.rs:157,208`) as a peek that claims nothing, so it stays independent of the exactly-once claim; and `permissions_decide`'s rule-first half is extracted into `remember_rule(engine, control, …)` (`decisions.rs:75,83`) so the must-be-pending authorization is unit-testable without an `AppHandle`. The agent chose the live-pending-state option over gating on `card["state"] == "pending"` — the card only flips once `resolve_permission` lands, so a claimed-but-not-yet-resolved ask (e.g. `control_cancel_request`) would still have read as pending; `a_still_pending_looking_card_with_no_live_ask_authorizes_nothing` pins that difference. 5 new tests, and the red was **proven not assumed**: restoring the buffer peek makes the two regression tests fail with the rule actually written to disk. `cargo test` 906 passed / 0 failed.

- [ ] CRITICAL · `src-tauri/src/account/endpoint.rs` (whole new file), `src-tauri/src/account/commands.rs:44-293`, `src-tauri/src/account/mod.rs:1114-1209`, `src-tauri/src/fs_util.rs:44-137`, `src-tauri/src/main.rs:1576-1578`, `contract/common.ts:61-63`, `contract/multi-account.ts`, `src/features/accounts/EndpointForm.tsx`, `AccountRow.tsx`, `AccountsModal.tsx`, `accounts.ts`, `accounts.css`, `src/features/projects/DefaultsSection.tsx`, `projects.ts`, `src/features/sessions/AccountField.tsx`, `src/demo/fixtures.ts` · spec-violation · **Lead-owned — git history surgery, NOT a code change; awaiting the human's go-ahead.** Round-1 CRITICAL #2 unresolved and its remedy expired: the whole `multi-provider-endpoint` FR-1..FR-10 surface is mixed into this feature's diff, which §2 Non-goals explicitly disclaims ("Only `Account.kind` lands here" / "No error codes are added to `ErrorCode`"). It is now **committed** in `1ec2f0f`, so the approved "separate it at commit time" remedy no longer applies — separating it means rewriting `1ec2f0f` (reset + re-stage, or interactive rebase). → **Fix:** split `1ec2f0f` so the endpoint hunks land in their own commit, and land `multi-provider-endpoint`'s own re-review verdict first. This diff must not merge as-is under the `multi-provider-seam` spec. *(Merged from core CRITICAL #2 + frontend HIGH — same finding, both surfaces.)* — **history half fixed 2026-08-14** (roadmap Phase A): the branch was reset to its merge-base `9d47115` and re-committed as four scope-clean commits — `d958075` cohorte pipeline, `3470d1d` **seam only**, `d2ab6ee` **endpoint only**, `0511040` the `multi-provider-openai` spec (which belonged to neither). The eleven files that mixed both scopes (`contract/common.ts`, `contract/multi-account.ts`, `specs/_decisions.md`, `specs/refactor-backlog.md`, `src-tauri/src/account/{mod,registry,testutil,login}.rs`, `src/demo/fixtures.ts`, `accounts.test.ts`, `projects.test.ts`) were each written down to their seam-only form for `3470d1d` and restored for `d2ab6ee`; `git diff backup/pre-phase-a HEAD` is empty, so the split reproduces the old tree byte for byte. `npx tsc --noEmit` and `npm test` are green at both feature commits (1699 then 1720). The finding's **second half — "land `multi-provider-endpoint`'s own re-review verdict first" — is still open**, and is roadmap Phase C.

- [x] HIGH · `src-tauri/src/session/stream/fixtures/turn.expected.json` + spec §4 FR-18 · spec-violation · Round-1 HIGH still open, no option chosen. FR-18/§1 claim the expected list was "generated once at the earliest point it can run (after FR-5+FR-6, before FR-1..FR-4)" so the trait extraction is proven a no-op **by construction**. No such intermediate state ever existed — the feature is one commit — so the list was generated against fully-refactored code. It locks future behaviour against a real transcript (valuable) but does not demonstrate pre/post equality, which §1 calls this feature's whole deliverable. → **Fix:** either (a) reconstruct an independent witness, or (b) amend FR-18/§1 to state the no-op claim rests on the test suite plus review. — fixed: **option (b)**, ruled in on evidence, not on cost — see the round-1 HIGH line above for the full reasoning (FR-6's amendment makes (a)'s generating point unreachable, so (a) yields no diff either). FR-18 and §1 amended.

- [x] MEDIUM · `src-tauri/src/session/adapter/mod.rs:121` · quality · The `ControlAck` doc comment references a `ControlAck::is_pending()` helper that **does not exist anywhere in the codebase** (`grep -rn "is_pending" src-tauri/src/` matches only this comment and an unrelated test name in `status.rs:179`). A doc comment that tells the next reader to call a method they cannot call is worse than no comment. → **Fix:** either add the `is_pending()` helper the comment promises (`matches!(self, Applied | ChannelClosed)`, with a unit test) or rewrite that clause to describe what callers actually do. Pick whichever matches the real call sites in `session/commands/`. — fixed: the clause was **rewritten**, not backfilled with a helper — neither real call site wants `is_pending()` (both match all three variants and act differently on `ChannelClosed`, which additionally resolves the card `cancelled`), so adding it would have created a second unused promise. The comment now states what the call sites actually do. `is_pending` appears nowhere in `src-tauri/src/`. Bonus: the `francois:permissions:decide` doc block was moved back onto `permissions_decide` — the previous pass had orphaned it onto the helper inserted beneath it.

- [x] MEDIUM · spec §4 FR-2 · spec-violation · `TurnControl::answer_question`/`decide_permission` ship the 3-variant `ControlAck` instead of frozen FR-2's `bool`, and the trait gains an unlisted `drain_pending` — neither had an "Amended … lead sign-off" entry, unlike the Box→Arc deviation. — fixed: FR-2 amended (spec §4) with lead sign-off recording both. `ControlAck` is load-bearing — `bool` collapses "never pending" into "was pending, channel died between park and decision", and the second still owes a `cancelled` resolution the pre-refactor code delivered; both still surface the same `*_NOT_PENDING` error, so the outward contract is unchanged and collapsing it would be the behavioural change FR-19 forbids. `drain_pending` is the teardown path's replacement for the direct reach into `TurnHandle`'s pending maps that FR-2 exists to remove. Neither is a new capability. Code unchanged.

- [x] MEDIUM · `contract/multi-account.ts:102` · quality (serde-drift risk) · `AccountUpdateEndpointPayload.modelIds?: string[] | null` needs three distinct states (omitted / `null` / array) but a plain `Option<Vec<String>>` Rust mirror cannot distinguish omitted from null, risking a silent override-clear on any partial update. → **Fix:** mirror with the double-`Option` pattern, or record that every caller makes the ambiguous state unreachable. — **verified, not a defect; no code change.** The mirror is not a plain `Option<Vec<String>>`: `src-tauri/src/account/endpoint.rs:171` defines a three-state `ModelIdsUpdate { Unset, Clear, Set(Vec<String>) }`, and `model_ids_update_from` (`endpoint.rs:185-193`) maps absent → `Unset`, `Value::Null` → `Clear`, array → `Set`, driven by a hand-written `CommandArg` impl (`commands.rs:20-29`) precisely because Tauri's automatic derive would collapse the two. `apply_update_endpoint` (`endpoint.rs:232-234`) then leaves `model_ids` untouched on `Unset` and clears only on `Clear`, with unit coverage at `endpoint.rs:531,538`. The finding's own escape hatch ("record that the ambiguous state is unreachable") is satisfied by construction. *(Also note: `AccountUpdateEndpointPayload` is `multi-provider-endpoint`'s contract, not this feature's §5 — it rides on the scope split above.)*

- [x] LOW · `.cargo-test.log:1` (new file) · quality · A raw local `cargo test` run log was committed — Windows junction messages and temp paths embedding the developer's real Windows username (`C:\Users\gnzan\...`), not covered by `.gitignore`, reporting a stale count ("898 passed") that contradicts the spec's own remediation note ("901 passed"). → **Fix:** `git rm .cargo-test.log` and add it to `.gitignore`.

### 2026-08-14 — architecture review (lead-initiated, not a review round)

Compared against an external architecture doc for the multi-provider arc
(`multi-provider-agent-architecture.md`). Two amendments landed above (FR-11a/FR-13a/FR-14a, the
runtime/protocol split; FR-15's rewording) and one new draft spec was opened
(`specs/capability-registry.md`). The rewording is already applied to
`contract/multi-provider-seam.ts`. The split is **spec-only so far** — one open item:

- [x] HIGH · `contract/common.ts`, `contract/multi-provider-seam.ts`, `src-tauri/src/session/adapter/mod.rs`, `src-tauri/src/session/persistence.rs`, `src-tauri/src/session/mod.rs`, plus every `SessionMeta` fixture · spec-violation · The shipped code implements the **superseded** FR-11/FR-13/FR-14: one `SessionProvider` discriminator, `SessionMeta.provider`, `Provider`/`adapter_for`, `providerCapabilities`. FR-11a/FR-13a/FR-14a replace that with `agentRuntime` + `protocol`, `AgentRuntime::from_account_kind` returning the pair, dispatch on `agentRuntime` alone, and `runtimeCapabilities`. → **Fix:** one build pass across both surfaces implementing FR-11a/FR-13a/FR-14a, including the persistence fallbacks (absent ⇒ `('claude-code','anthropic')`; superseded `provider` key mapped per FR-11a) and the `RuntimeCapability`/`RuntimeCapabilities` rename. Do this **before** `multi-provider-openai` is dispatched — that feature's `OpenAiAdapter` is the first consumer of both axes, and building it against the collapsed enum is what the amendment exists to avoid. — **fixed 2026-08-15 (roadmap Phase B), both surfaces.** Contract: `SessionProvider` removed for `AgentRuntime` (`'claude-code' | 'francois'`) + `ProviderProtocol` (`'anthropic' | 'openai'`); `SessionMeta.provider` → required `agentRuntime` + `protocol`; `providerCapabilities`/`ProviderCapability(-ies)` → `runtimeCapabilities`/`RuntimeCapability(-ies)`, keyed on `AgentRuntime`, values unchanged. Core: the enum split, `AgentRuntime::from_account_kind` returning the pair over an exhaustive `match` on `AccountKind`, `SessionAdapter::provider()` → `agent_runtime()`, and `adapter_for` dispatching on the runtime **alone** (FR-14a — `protocol` is deliberately not a parameter; the `francois` runtime reads it to pick its wire codec). Persistence gained `parse_agent_runtime_and_protocol`: the new pair when both keys parse, else the legacy `provider` string mapped (`'claude-code'` ⇒ `(ClaudeCode, Anthropic)`, `'openai-compatible'` ⇒ `(Francois, Openai)`), else the default pair; the save side writes only the two new keys. Covered by `both_keys_absent_defaults_to_claude_code_anthropic` and `legacy_provider_key_migrates_to_the_right_pair` (the phase gate), plus serde-shape, `from_account_kind`-exhaustiveness and `adapter_for_dispatches_by_runtime`. Regression canary held: `src-tauri/src/session/stream/fixtures/turn.expected.json` is byte-untouched.

- [x] LOW · `src/features/sessions/rename.test.ts:20`, `src/lib/panelCountsStore.test.ts:11`, `src/features/sessions/useSessionFleetSync.test.ts:11`, `src/lib/split-by-4.test.ts:55` · quality · these pre-existing `SessionMeta` fixtures use `as unknown as SessionMeta` (a full bypass), so they compiled without every required field before this diff and will keep silently missing future required fields including `provider`. → Replace the blanket bypass casts with fully-populated fixture builders. Untouched by this diff; the pattern predates the feature. — **fixed 2026-08-15 (roadmap Phase B).** Deferred at round 2, closed here because the axis split is exactly the change those casts would have hidden: a blanket cast does not fail to compile when a required field changes, so the split would have gone silently untested in four places. All four rewritten as fully-typed literals — `rename.test.ts`'s was carrying a stale pre-split shape (`modelId`, `contextMaxTokens`, `createdAt`, none of which exist on the current `SessionMeta`), which is the concrete proof of the finding. Two further sites the round-2 note did not list (`src/lib/sessionsStore.test.ts:15`, `src/features/notifications/notifications.test.ts:322,435,452`) were mechanical and were fixed too, so no `as unknown as SessionMeta` remains in `src/`.

### 2026-08-16 — review round 3 (REVISE, 1 finding)

Roadmap Phase D, with A and B landed. Frontend surface returned **clean** (0 findings): no
`as unknown as SessionMeta` remains in `src/` and no substitute escape hatch replaced it; every
fixture carries both axes. FR-14a, FR-13a, the persistence migration + both its tests,
`runtimeCapabilities()` vs FR-15, and both round-2 carry-overs all verified intact. The
`SessionAdapter`/`TurnControl` signatures carry no `Child`/stdio/NDJSON shape — the boundary is
genuinely provider-agnostic, which is the Phase E precondition. Full report:
`specs/reports/multi-provider-seam.md`.

- [x] CRITICAL · `src-tauri/src/session/stream/lines.rs:50` (`handle_system_line`), exercised by `src-tauri/src/session/stream/mod.rs:474` `golden_replay_produces_the_locked_session_event_sequence` · spec-violation · The `session.commands` event the golden locks is built by `merge_commands(&help_entries(), &discover_skills(cwd), &names)`, and `discover_skills` (`src-tauri/src/session/skills.rs:141`) reads the **live** `~/.claude/skills`, `~/.claude/plugins/marketplaces` and `~/.claude/settings.json` off `dirs::home_dir()` — never routed through `SessionEnv`, the exact seam FR-6 exists for. The golden therefore diverges on any machine whose skills differ from the capture machine's and fails deterministically on CI (no `~/.claude` there at all), so `release.yml`'s `gate` job turns `main` red on merge. Breaches FR-19's "cargo test … green" criterion and makes FR-18's forward lock unreliable for this event. → **Fix (option (a), chosen over (b)):** add an injectable command-inventory hook to `SessionEnv` — `fn discover_commands(&self, cwd: &str) -> Vec<SkillInfo>` — with the production impl delegating to today's `discover_skills(cwd)` and `TestEnv`/the golden test supplying a fixed list matching the fixture's own `slash_commands` merge input; `handle_system_line` calls `env.discover_commands(cwd)` rather than the free function. Option (b) (normalize `session.commands` out of the golden comparison the way ids already are) is **rejected**: it would drop coverage of one of FR-17's seven mandated line kinds and read as a weakened test under FR-19. — **fixed 2026-08-16.** Added `SessionEnv::discover_commands(&self, cwd: &str) -> Vec<SkillInfo>` (`src-tauri/src/session/env.rs`): the `AppHandle` impl delegates unchanged to `discover_skills(cwd)`; `TestEnv`'s impl ignores `cwd` and returns a fixed two-entry `fixed_command_inventory()` (`seam-fixture-skill-one`/`-two`, `installed: true`, `scope: "user"`) instead of touching disk. `handle_system_line` (`lines.rs:50`) now calls `env.discover_commands(cwd)` in place of the free function. Proven red-then-green: with the trait wired but `lines.rs` still calling `discover_skills` directly, the golden test failed — and its failure output showed this exact dev machine has an extra locally-installed skill (`cohorte-patch`) the original capture machine didn't, the live-machine divergence the finding describes, caught live. Flipping `lines.rs` to `env.discover_commands(cwd)` turned it green. `fixtures/turn.expected.json`'s `session.commands` entry was regenerated to match the fixed inventory (the two `seam-fixture-skill-*` entries replace the 13 `cohorte-*` skill entries that came off the capture machine's disk; the `cohorte-*` names still appear as `source: "cli"` entries afterward — the real captured `slash_commands` array in `turn.ndjson` reports them independent of any disk scan, unaffected by this fix); every other event in the fixture is byte-identical. `cd src-tauri && cargo test --quiet`: 912 passed / 0 failed / 3 ignored.

### 2026-08-16 — review round 4 (SHIP, 0 findings)

Both touched surfaces (core, frontend + shared `contract/` remainder) reviewed in full — round 3's
CRITICAL disqualified the small-diff fast path. Core: round 3's `SessionEnv::discover_commands` fix
holds, the golden replay is machine-independent, and every FR-1..FR-14a requirement re-verified
intact against the amended spec, including round 2's `pending_permission_pattern` fix. Frontend:
still zero `as unknown as SessionMeta` casts, `runtimeCapabilities()` exhaustive by construction with
matching test coverage, FR-16 grep-clean, `contract/multi-account.ts`'s endpoint additions confirmed
non-regressive to `Account`'s seam-owned fields. `npm test`, `npx tsc --noEmit`, `cargo test` (912
passed) all green. Full report: `specs/reports/multi-provider-seam.md`.
