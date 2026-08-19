---
id: multi-provider-codex
title: Codex CLI sessions
status: frozen
branch: feat/multi-provider
created: 2026-08-17
depends_on: [multi-provider-seam, multi-account, durable-sessions, session-engine, conversation-view, projects]
reviewed_base:
reviewed_digest:
design_files: []
---

# Codex CLI sessions

## 1. Summary

A third agent runtime: **OpenAI's `codex` CLI**, driven the same way Francois already drives
`claude` — spawn a non-interactive process per turn, read its JSONL event stream, translate it into
the transcript the conversation view already renders, and resume the same thread on the next turn.

`multi-provider-openai` reached OpenAI models by *being* the agent loop (a Rust-native
`/chat/completions` loop against an endpoint + API key). This feature reaches them by **delegating
the loop to a CLI that already has one**, which buys three things that adapter cannot have: OpenAI's
own harness (its prompt, its tool set, its sandbox, its `AGENTS.md` handling), its OS-level sandbox,
and — the headline — **ChatGPT subscription auth**. A user with a ChatGPT Plus/Pro plan gets OpenAI
models in Francois with no API key at all.

**This is the cell that makes the seam's two axes load-bearing.** `multi-provider-seam` split
`SessionProvider` into `AgentRuntime` × `ProviderProtocol` and the roadmap noted the split was
"a refactor justified by a hypothetical" until a second runtime speaking an already-used dialect
arrived. `('codex', 'openai')` is that cell: same protocol as `('francois', 'openai')`, different
loop owner. A collapsed enum could not name it.

## 2. Goals & non-goals

**Goals**

- `AgentRuntime::Codex` — a third member, and `CodexAdapter: SessionAdapter` behind it.
- `AccountKind::CodexCli` — an account authenticated by `codex login` inside its **own**
  `CODEX_HOME`, exactly mirroring how `claude-code-oauth` accounts own a `CLAUDE_CONFIG_DIR`.
  Several ChatGPT accounts side by side, same as several Anthropic ones.
- A turn: `codex exec --json` with the prompt on stdin; a follow-up turn:
  `codex exec resume --json <thread_id>`. Thread continuity across quit/reopen for free.
- Event translation: `agent_message`, `command_execution`, `file_change`, `mcp_tool_call`,
  `web_search` and `todo_list` items become the transcript blocks the view already knows.
- Francois' `permissionMode` mapped onto Codex's **sandbox policy**, pinned per invocation so the
  user's own `~/.codex/config.toml` cannot silently widen it.
- A real model catalog, read from Codex's own `models_cache.json`.
- The disabled-pane treatment for everything this runtime does not carry, with **honest per-runtime
  wording** — a Codex session bills against a ChatGPT plan, so `usageBar`'s existing `francois`
  reason ("bills per token, not against a plan") would be a lie here.

**Non-goals**

- **Approval cards.** `codex exec` is non-interactive: stdin carries the prompt and then closes, so
  there is no control channel to park an ask on. Permission enforcement is the **sandbox**, chosen
  per turn from `permissionMode` (FR-9). `permission-guardrails`' rules do not apply, and the
  Permissions pane says so. Changing this means driving `codex app-server`, which is an experimental
  surface — see §10.
- **Streaming assistant text.** Verified against 0.147.0: `agent_message` arrives whole in one
  `item.completed`; there are no text deltas in `codex exec --json`. Tool activity *is* live
  (`command_execution` emits `item.started` before `item.completed`), so a turn is never silent —
  but a reply appears at once rather than typing itself in. FR-6 handles a future delta stream
  without a rewrite; it does not invent one.
- **`reasoning` items.** The core has no thinking block kind (`BlockKind` has no such member), and
  rendering a reasoning summary as an `Assistant` block would misattribute it. Dropped in v1;
  the first follow-up.
- **Skills, MCP, subagents, workflows, slash commands, compaction, remote control.** Codex has its
  own skills (`~/.codex/skills`) and its own MCP client (`codex mcp`) — but Francois' panes read
  *Claude Code's* control surfaces, and inverting them into runtime-agnostic discovery is
  `capability-registry`, not this feature. All `available: false` here, worded as current gaps.
- **Codex's interactive TUI, `codex cloud`, `codex review`.** Out of scope.

## 3. User stories / flows

**Add a Codex account.** Accounts modal → Add → the kind picker now offers *Codex CLI* alongside
*Claude* and *OpenAI-compatible endpoint*. Choose it, give it a label, Save. The row appears with a
**Sign in** action, because a fresh `CODEX_HOME` has no `auth.json`. Clicking it runs
`codex login` against that account's config dir; the row flips to signed-in when `auth.json` lands.

**Start a session on it.** New Session modal → the account picker lists the Codex account
**enabled** (unlike endpoint accounts, which FR-14 of `multi-provider-endpoint` deliberately leaves
disabled). Selecting it repopulates the model picker from Codex's catalog under that account's own
label. Create, type a message, send.

**The turn.** The composer clears, the session goes `running`. Codex's commentary lands as assistant
blocks; each shell command it runs appears as a `Bash` tool card that goes live on `item.started` and
completes with its exit code and output tail. The diff badge updates when it edits files. The turn
ends on `turn.completed` and the context meter fills from the reported usage.

**The next turn** continues the same Codex thread — the adapter resumes off the `thread_id` it stored
at `thread.started`, so Codex still has the whole conversation. Quit Francois, reopen: the transcript
is there (durable-sessions) and so is the thread anchor, so the next message continues rather than
starting over.

**The panes.** Agents, MCP, Skills and Workflows render the disabled notice with their reason. The
usage bar hides. The slash menu says slash commands aren't available on this provider yet.

## 4. Functional requirements

### The axes

- **FR-1** `AgentRuntime` gains a third member, `codex` (`AgentRuntime::Codex`). `contract/common.ts`
  and `src-tauri/src/session/adapter/mod.rs` move together. Every `match` on `AgentRuntime` in the
  core stays **exhaustive with no wildcard arm** — a fourth runtime must fail to compile, not
  default.
- **FR-2** `AccountKind` gains `codex-cli` (`AccountKind::CodexCli`).
  `AgentRuntime::from_account_kind` maps it to `(Codex, Openai)` and stays exhaustive.
- **FR-3** `adapter_for(AgentRuntime::Codex)` returns `CodexAdapter`. Dispatch remains on
  `agentRuntime` **alone** (seam FR-14a) — `protocol` is not a parameter.
- **FR-4** Persistence: `session/persistence.rs` round-trips `agentRuntime: "codex"`. A record whose
  keys are absent still loads `('claude-code','anthropic')`, and the legacy `provider` migration is
  unchanged — `codex` is new, so no legacy value maps to it.

### The transport

- **FR-5** A **fresh** turn spawns:

  ```
  codex exec --json --skip-git-repo-check
             -c approval_policy="never"
             -s <sandbox>
             -m <model_id>
             [-c model_reasoning_effort="<effort>"]
  ```

  with the session's `cwd` as the child's working directory, the **prompt written to stdin and stdin
  then closed**, stdout piped, stderr null. No positional prompt: Codex reads instructions from stdin
  when none is given, which keeps multi-line text, quotes and shell metacharacters out of argv
  entirely — the same reasoning `claude -p` with no positional prompt already follows.

- **FR-5a** *(added 2026-08-17, from a live failure.)* Every spawn of the CLI — the turn and
  `codex login` alike — goes through **`codex_program()`**, never the bare string `codex`.

  `claude` installs as a native binary, so `Command::new("claude")` resolves everywhere. **`codex`
  normally installs via npm, which on Windows ships shims and no `.exe`**: `codex`, `codex.cmd`,
  `codex.ps1`. Rust's `Command` resolves a bare name on Windows by appending `.exe` **only**, so
  `Command::new("codex")` returns `NotFound` on a machine where `codex --version` works in every
  terminal — and the user is told to install what they already have. Verified directly: bare
  `codex` → `NotFound`; `codex.cmd` and a full path to either shim or exe → runs.

  `codex_program()` therefore searches `PATH` for `codex.exe`, then `codex.cmd`, then `codex.bat`,
  and returns the **full path** of the first hit; it falls back to the bare name so a genuinely
  absent CLI still yields `NotFound` and the install message is then true. Non-Windows keeps the
  bare name. Memoized, so the login spawn and the turn spawn can never resolve differently.

  Both spawn sites also set `PATH` from the login shell (`claude_path_env`), for the same reason
  every `claude` spawn does: a GUI app launched from Finder/Dock inherits launchd's minimal PATH,
  not the shell's, so an npm-installed `codex` would otherwise be invisible on macOS too.

- **FR-6** A **resuming** turn spawns `codex exec resume --json <thread_id> …` with the same prompt
  handling. `codex exec resume` accepts **neither `-C/--cd` nor `-s/--sandbox`** (verified against
  0.147.0), so the cwd comes from the child process and the sandbox from
  `-c sandbox_mode="<sandbox>"`, which is what `-s` is sugar for. Both forms are verified against a
  live run; the argv builder is pure and unit-tested for each.

- **FR-7** `approval_policy` and the sandbox are passed **on every invocation**, never inherited.
  The user's `~/.codex/config.toml` is otherwise loaded normally (their model providers, their
  `AGENTS.md`, their MCP servers are theirs) — but the two settings that decide what Codex may do to
  the filesystem are Francois' to state, not to discover.

- **FR-8** `thread.started` carries the `thread_id`. The adapter stores it as the session's resume
  anchor (the existing `Session.claude_session_id` field, whose name is Claude-shaped but whose role
  is generic; renaming it is out of scope and would touch every runtime). If a resume fails, the
  turn re-runs fresh exactly as `session-engine` FR-9 already specifies for Claude.

### Permissions

- **FR-9** `permissionMode` maps to a sandbox policy, total over the four modes:

  | `permissionMode`     | Codex sandbox        |
  |----------------------|----------------------|
  | `default`            | `read-only`          |
  | `plan`               | `read-only`          |
  | `acceptEdits`        | `workspace-write`    |
  | `bypassPermissions`  | `danger-full-access` |

  An unrecognised mode maps to `read-only` — **fail closed**, the same half `multi-provider-openai`'s
  gate pins.

- **FR-10** No permission or question cards are ever created on a Codex session.
  `TurnControl::answer_question` and `decide_permission` return `ControlAck::NotPending`,
  `pending_counts` returns zeros, `drain_pending` returns two empty vectors, and
  `pending_permission_pattern` returns `None`. A Codex session therefore never parks, and
  `refresh_parked_status` derives "not waiting" without a special case.

- **FR-11** The Permissions surface reports this rather than silently doing nothing: `permissions` is
  a new `RuntimeCapability` (see FR-16) so the rules editor and the approval-mode control can render
  the standard disabled notice on a Codex session.

### Event translation

- **FR-12** The reader parses **one JSON object per line** off stdout and ignores any line that is
  not valid JSON or carries no `type` (Codex prints human-readable preamble on some paths). A
  malformed line never ends a turn.

- **FR-13** Event → transcript, total over the vocabulary verified in 0.147.0
  (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`,
  `item.updated`, `item.completed`, `error`):

  | Codex event | Francois effect |
  |---|---|
  | `thread.started` | store `thread_id` as the resume anchor (FR-8) |
  | `turn.started` | nothing — the turn is already open on our side |
  | `item.started` / `item.updated` with a tool-shaped item | open (or update) that item's tool block |
  | `item.completed` with `agent_message` | finalize an assistant block carrying `text` |
  | `item.completed` with a tool-shaped item | complete that item's tool block with its result meta |
  | `item.*` with `reasoning` | ignored (§2 non-goal) |
  | `turn.completed` | apply `usage` to the context meter, then `finish_turn` ok |
  | `turn.failed` | error block from `error.message`, then `finish_turn` err |
  | `error` | same as `turn.failed` |
  | anything else | ignored, and never fatal |

- **FR-14** Item → tool block, keyed by `item.id` so `started` and `completed` address the same block:

  | Codex item type | tool name | summary | completion meta |
  |---|---|---|---|
  | `command_execution` | `Bash` | the command | exit code + tail of `aggregated_output` |
  | `file_change` | `Edit` | the changed paths | the change count |
  | `mcp_tool_call` | `mcp__<server>__<tool>` | the tool name | `status` |
  | `web_search` | `WebSearch` | the query | — |
  | `todo_list` | `TodoWrite` | item count | — |

  `file_change` completing triggers the same `diff::on_tool_done` recompute a Claude `Edit`/`Write`
  does, so the diff badge and DIFF tab stay live.

- **FR-15** `turn.completed.usage` fills the context meter:
  `input_tokens + cached_input_tokens + output_tokens` used, against the selected model's context
  window from the catalog (FR-17). A turn that reports no usage leaves the meter untouched.

### Capabilities

- **FR-16** `runtimeCapabilities()` gains a `codex` row, and `RuntimeCapability` gains a
  **`permissions`** member (FR-11) — which means the existing `claude-code` and `francois` rows must
  both gain it too, since `RuntimeCapabilities` is an exhaustive `Record`. `claude-code`:
  `available: true`. `francois`: `available: true` (that adapter *is* the gate —
  `multi-provider-openai` FR-9..FR-13). `codex`: `false`, because the sandbox replaces the cards.

  The `codex` row, with reasons worded per runtime rather than copied:

  | capability | available | reason |
  |---|---|---|
  | `mcp` | false | "MCP servers aren't available on this provider yet." |
  | `subagents` | false | "Subagents aren't available on this provider yet." |
  | `skills` | false | "Skills aren't available on this provider yet." |
  | `skillsInstall` | false | "Installing skills isn't available on this provider yet." |
  | `workflows` | false | "Workflows aren't available on this provider yet." |
  | `interactiveCommands` | false | "Slash commands aren't available on this provider yet." |
  | `permissions` | false | "Codex enforces permissions with its own sandbox." |
  | `remoteControl` | false | "Remote Control is an Anthropic service." |
  | `usageBar` | false | "Plan limits aren't available on this provider yet." |
  | `compaction` | false | "Compaction isn't available on this provider yet." |

  `usageBar`'s reason is deliberately **not** `francois`' "bills per token, not against a plan": a
  Codex session on a ChatGPT plan bills against exactly such a plan. It is a gap, not a property.

- **FR-17** `CodexAdapter::models` reads `<CODEX_HOME>/models_cache.json` and maps each entry —
  `slug` → `id`, `display_name` → `label`, `description` → `brief`,
  `supported_reasoning_levels[].effort` → `efforts` — filtered to the effort vocabulary the core
  already accepts. A missing, unreadable or malformed cache falls back to a **static built-in list**
  so the picker is never empty. No network call: the cache is Codex's own, refreshed by Codex.

### Accounts

- **FR-18** A `codex-cli` account owns a config dir under the same root the mirror already uses,
  and that dir is exported as **`CODEX_HOME`** for every turn on that account.
  `session/spawn.rs`'s `account_env` gains this: it currently emits `CLAUDE_CONFIG_DIR`
  unconditionally, and must instead emit the variable the session's **runtime** needs. Under WSL the
  new variable rides `WSLENV` the same way (`CODEX_HOME/up`), through the same merge helper.
- **FR-19** No mirror of `~/.claude` for a Codex account — that step is Claude-specific
  (`account/mirror.rs`). A Codex account starts with an **empty** config dir; `codex login` fills it.
- **FR-20** Auth state is derived, not persisted: a `codex-cli` account is signed in iff
  `<configDir>/auth.json` exists. This mirrors `identity_file_exists` for Claude accounts, and is
  what `CodexAdapter::preflight` checks — returning `ACCOUNT_NOT_AUTHENTICATED` with the same code
  and the same `mark_auth_failed` side effect the Claude adapter uses, with copy naming Codex.
- **FR-21** `codex-cli` accounts are **session-selectable** — the New Session modal and the project
  defaults picker render them enabled, which needs no new code: `accountFieldOptions`
  (`src/features/accounts/accounts.ts:325`) already maps every account unconditionally.
  *(Corrected 2026-08-17 during the build: this FR originally claimed the contrast was with endpoint
  accounts, which `multi-provider-endpoint` FR-14 left disabled. `multi-provider-openai` FR-22
  deleted that block once an adapter existed, so **no** account kind is disabled today and there is
  no contrast to draw. The requirement stands; the reasoning behind it was out of date.)*
- **FR-21a** A `codex-cli` account carries `signedIn: boolean` on the wire, present iff
  `kind === 'codex-cli'` and **derived** from `auth.json`'s existence on every list (FR-20) — exactly
  the shape and exactly the reasoning of `EndpointConfig.hasKey`. Without it a freshly added Codex
  account would look healthy until its first turn failed, because `accountNeedsLogin` reads
  `authFailedAt`, which is only ever set *by* a failure.
- **FR-22** Removing a Codex account reassigns its sessions exactly as removing any other account
  does, and deletes its config dir — the existing `account_remove` path, no new branch beyond the
  kind check.

### Frontend

- **FR-23** No component may branch on `agentRuntime` or `protocol` directly. Everything reads
  `runtimeCapabilities()` through the existing `sessionCapability` helper
  (`src/lib/runtimeCapability.ts`). This is `multi-provider-openai` FR-20's grep gate, extended to
  the new runtime and the new capability: `grep -rn "agentRuntime\|protocol" src/` outside
  `runtimeCapability.ts` must return only fixtures, type imports and comments.
- **FR-24** The Accounts modal's add form offers the three kinds. A Codex account's form is a
  **label only** — no base URL, no key, nothing to validate beyond a non-empty label.
- **FR-25** The account row for a `codex-cli` account shows a **Sign in / Re-login** action that runs
  `codex login` in that account's `CODEX_HOME`, reusing the existing login-action slot the Claude
  rows already have.
- **FR-25a** *(added 2026-08-17, from a live failure.)* The `codex login` child is spawned with
  **`Stdio::null()` on stdout and stderr** — never `piped()` — and its handle is **owned by the
  poller**, not dropped at the call site.

  `codex login` starts a local OAuth server and announces it on stdout
  (`Starting local login server on http://localhost:1455`). Spawned with piped streams that nothing
  reads, the first such write hits a closed read end and the process **panics and dies within a
  second** (exit 101, reproduced directly). The browser flow then completes on OpenAI's side and
  redirects to `http://localhost:1455/auth/callback?code=…` with nothing listening — so the failure
  lands *after* the user has already signed in, which is the most confusing possible place for it.
  `null` discards the output without ever blocking or breaking, which is what the original
  "keep codex's output out of Francois' stdout" intent actually required.

  Owning the child also reaps it (dropping a `std::process::Child` does not wait) and lets the poll
  stop the moment the process exits rather than running the full five minutes.

  **The poll checks `auth.json` before liveness**, and that order is load-bearing: `codex login`
  exits as soon as it has written the credential, so success routinely presents as "credential
  present AND process gone" in one tick. Liveness-first would classify a successful login as a
  failure. Pinned by `poll_step`'s five cases.

## 5. API contract

`contract/multi-provider-codex.ts` — this feature adds **no new IPC channel**. It widens three
existing unions and one table; the file exists to hold the wire types of the Codex event stream,
which the core parses and no frontend ever sees.

```ts
import type { AgentRuntime } from './common';

/** contract/common.ts — WIDENED, not redefined here. */
// export type AgentRuntime = 'claude-code' | 'francois' | 'codex';

/** contract/multi-account.ts — WIDENED. */
// export type AccountKind = 'claude-code-oauth' | 'openai-compatible' | 'codex-cli';

/** contract/multi-provider-seam.ts — RuntimeCapability gains 'permissions';
 *  CAPABILITIES gains a 'codex' row (FR-16). */

/** The `codex exec --json` event stream (FR-12/FR-13). Core-internal: mirrored by
 *  serde enums in src-tauri/src/session/adapter/codex/wire.rs. Verified against
 *  codex-cli 0.147.0. */
export type CodexEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: CodexUsage }
  | { type: 'turn.failed'; error?: { message?: string } }
  | { type: 'item.started'; item: CodexItem }
  | { type: 'item.updated'; item: CodexItem }
  | { type: 'item.completed'; item: CodexItem }
  | { type: 'error'; message?: string };

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/** `id` addresses the block across started → completed (FR-14). Unknown `type`
 *  values are ignored rather than rejected — Codex adds item kinds between
 *  releases and none of them may break a turn. */
export type CodexItem =
  | { id: string; type: 'agent_message'; text?: string }
  | { id: string; type: 'reasoning'; text?: string }
  | {
      id: string;
      type: 'command_execution';
      command?: string;
      aggregated_output?: string;
      exit_code?: number | null;
      status?: string;
    }
  | { id: string; type: 'file_change'; changes?: CodexFileChange[]; status?: string }
  | { id: string; type: 'mcp_tool_call'; server?: string; tool?: string; status?: string }
  | { id: string; type: 'web_search'; query?: string }
  | { id: string; type: 'todo_list'; items?: unknown[] };

export interface CodexFileChange {
  path: string;
  kind?: 'add' | 'delete' | 'update';
}
```

**Existing channels, unchanged in shape and widened in value:** `francois:session:create` accepts an
`accountId` naming a `codex-cli` account; `francois:session:models` (`SessionModelsInput.accountId`,
added by `multi-provider-openai`'s FR-18 fix) routes to `CodexAdapter::models`;
`francois:account:add` accepts `kind: 'codex-cli'`; `francois:session:event` carries the same
`SessionEvent` members it always has. **New error codes: none.**

## 6. Data & state

**Core.** `Session.agent_runtime: AgentRuntime` may now hold `Codex`; `Session.claude_session_id`
holds Codex's `thread_id` for such a session (FR-8). `CodexTurnHandle` owns the `Child` and an
`interrupted` flag — and, unlike `TurnHandle`, **no pending maps and no stdin writer**, because
neither exists on this transport (FR-10).

**Persistence.** `sessions.json` gains no key: `agentRuntime` already rides it and now takes a third
value. `accounts.json` gains no key: `kind` takes a third value and `endpoint` stays absent for
Codex records, which `account_record_invariant_holds` must accept.

**Codex-owned state, which Francois does not manage.** The thread itself lives in
`<CODEX_HOME>/sessions/**` as Codex's rollout files, and auth in `<CODEX_HOME>/auth.json`. Francois
stores only the `thread_id` pointer. Deleting a Codex account's config dir therefore deletes its
threads — same trade the Claude accounts already make.

**Frontend.** No new store. `runtimeCapability.ts` gains no API — its `sessionCapability(meta, cap)`
already takes the runtime off the meta.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| `codex` not on PATH | `SPAWN_FAILED`, message naming the CLI and how to install it (`npm i -g @openai/codex`). |
| **`codex` installed as an npm shim (Windows)** | Resolved by `codex_program()` before any spawn — see FR-5a. This is NOT the row above, and must never surface as it. |
| **`codex login` dies before the OAuth callback** | Cannot happen through piped-stdio starvation any more (FR-25a). If the process exits without writing `auth.json` for any other reason, the poll stops and the row keeps reading *Sign in* — the truth. No error card: the browser already showed the user whatever went wrong on its side. |
| Account has no `auth.json` | `preflight` → `ACCOUNT_NOT_AUTHENTICATED`, `mark_auth_failed`, row shows Sign in (FR-20). |
| Resume rejected (thread gone, e.g. account dir deleted) | Clear the anchor and re-run the turn fresh — `session-engine` FR-9's existing `ResumeRetry`, no new path. |
| `turn.failed` / `error` event | Error block with the message, turn ends failed. The message is rendered verbatim; Codex does not put credentials in it, and Francois adds none. |
| Malformed / non-JSON stdout line | Ignored (FR-12). A turn never dies on unparseable output. |
| Child exits with no `turn.completed` | Turn ends failed with the exit status — the same "reader saw EOF first" path the Claude reader already has. |
| `interrupt` / stop | Kill the child. Codex has no interrupt protocol over this transport, and stdin is closed. Blocks already emitted stay. |
| Unknown item `type` or event `type` | Ignored, never fatal (FR-13's last row) — Codex ships new item kinds between releases. |
| `models_cache.json` missing or malformed | Static fallback list (FR-17). |
| A Codex session opened while the app has no Codex account | Unreachable: sessions are created against an account, and account removal reassigns (FR-22). |

## 8. Design brief

No new screens. Three deltas against the existing surfaces:

- **Accounts modal — kind picker.** A third option, *Codex CLI*, with the sublabel "Sign in with your
  ChatGPT account". Selecting it collapses the form to a single Label field (FR-24). Same
  `ChipGroup`/`ListRow` primitives as the existing two; no new component.
- **Account row.** A Codex row carries the same status dot and the same login-action slot the Claude
  rows use, labelled *Sign in* when `auth.json` is absent and *Re-login* when present (FR-25). The
  endpoint rows' base-URL subtitle is replaced by the account's own label alone.
- **Disabled panes.** Already built: `CapabilityNotice` renders whatever reason the table gives, so
  the four panes, the usage bar, the slash menu and — new — the permissions surface need only be
  wired to the `permissions` capability. Accent stays off these; a disabled pane is never the live
  thing (Design System v2's one-acid-per-view rule).

## 9. Acceptance criteria

- [ ] `AgentRuntime` has three members in both the contract and the core, and every core `match` on
      it is exhaustive with no wildcard.
- [ ] `AccountKind::CodexCli` maps to `(Codex, Openai)` and `adapter_for(Codex)` returns
      `CodexAdapter`.
- [ ] A `sessions.json` carrying `agentRuntime: "codex"` round-trips; absent keys still default to
      `('claude-code','anthropic')`.
- [ ] The fresh-turn argv and the resume argv are each pinned by a unit test, including that resume
      carries `-c sandbox_mode=` and **no** `-s`/`-C`.
- [ ] All four permission modes and an unrecognised one map per FR-9, fail-closed.
- [ ] A recorded event stream (fixture, captured from a real run) replays into the expected block
      sequence — assistant text, a live-then-completed `Bash` card, and a context meter from `usage`.
- [ ] A malformed line mid-stream is ignored and the turn still completes.
- [ ] `runtimeCapabilities('codex')` matches FR-16's table verbatim, and `permissions` is present on
      all three rows.
- [ ] `CodexAdapter::models` maps a real `models_cache.json` and falls back when it is absent.
- [ ] `account_env` emits `CODEX_HOME` for a Codex account and `CLAUDE_CONFIG_DIR` for a Claude one,
      each riding `WSLENV` correctly under WSL.
- [ ] A Codex account is selectable in the New Session modal; an endpoint account still is not.
- [ ] `grep -rn "agentRuntime\|protocol" src/` outside `runtimeCapability.ts` returns only fixtures,
      type imports and comments (FR-23).
- [ ] **The golden replay canary** (`src-tauri/src/session/stream/fixtures/turn.expected.json`)
      passes **untouched** — no Claude Code behaviour moved.
- [ ] End-to-end against a real ChatGPT-authenticated `codex`: a turn streams, a second turn resumes
      the same thread, and quit-and-reopen continues it. *(Manual — nothing in the pipeline runs the
      app against a real CLI. Recorded honestly rather than ticked on unit coverage, per
      `multi-provider-openai` §DoD's precedent.)*

## 10. Open questions (deliberately deferred)

1. **`codex app-server` for real approval cards.** It can call back for approvals, which would give
   full `permission-guardrails` parity instead of FR-9's sandbox mapping. It is marked experimental
   in 0.147.0. Revisit when it stabilises; FR-9 is the honest interim and says so in the UI (FR-11).
2. **Reasoning items.** Needs a `BlockKind::Thinking` and a renderer — worth doing for Claude too,
   which is why it is not smuggled in here.
3. **Skills and MCP.** Codex genuinely has both. Making them work means `capability-registry`'s
   inversion, not a Codex-shaped special case. This feature's `false` rows are the evidence that
   inversion is worth doing.

## Remediation

(Empty until a review returns findings.)
