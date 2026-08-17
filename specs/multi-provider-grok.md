---
id: multi-provider-grok
title: xAI / Grok integration — a fourth agent runtime
status: frozen
branch: feat/x-ai-integration
created: 2026-08-17
depends_on: [multi-provider-seam, multi-account, multi-provider-codex, durable-sessions, session-engine, conversation-view, projects]
reviewed_base:
reviewed_digest:
design_files: []
---

# xAI / Grok integration — a fourth agent runtime

## 1. Summary

A fourth `AgentRuntime`: xAI's **Grok Build** CLI (`grok`, npm `@xai-official/grok`) driving its own
agent loop over `grok -p --output-format streaming-json`, with `grok-cli` accounts authenticated by
`grok login` into a per-account `GROK_HOME`, and Francois' `permissionMode` mapped onto Grok's
sandbox profiles. Structurally this is `multi-provider-codex` again — a vendor CLI, a relocatable
config home, a non-interactive turn, sandbox-as-enforcement — and it deliberately reuses that
feature's shapes rather than inventing parallel ones.

Two things make it *not* a copy. Grok's `streaming-json` is **ACP-shaped** (JSON-RPC `session/update`
notifications), which carries real **text deltas** and **structured tool calls** that
`codex exec --json` does not have — so a Grok turn streams where a Codex turn appears at once. And
the **xAI API needs no code at all**: `providers.ts` already carries the `xai` preset pointing at
`https://api.x.ai/v1`, which is an OpenAI-compatible `/chat/completions` surface, so the shipped
`multi-provider-endpoint` + Francois-loop path already drives it (§2 Non-goals).

## 2. Goals & non-goals

**Goals**

- `AgentRuntime::Grok` — a fourth member, and `GrokAdapter: SessionAdapter` behind it.
- `AccountKind::GrokCli` — an account authenticated by `grok login` inside its **own** `GROK_HOME`,
  exactly mirroring how `codex-cli` accounts own a `CODEX_HOME`. Several xAI accounts side by side.
- A turn: `grok -p --output-format streaming-json` with the prompt on stdin and the session pinned by
  `-s <sessionId>`, so a follow-up turn is the *same argv* and there is no anchor to lose (FR-8).
- Event translation from ACP `sessionUpdate` variants into the transcript blocks the view already
  knows — **including live assistant text**, which this runtime gets for free (FR-14).
- Francois' `permissionMode` mapped onto Grok's **sandbox profile**, pinned per invocation so the
  user's own `config.toml` cannot silently widen it.
- A model catalog read from Grok's own `config.toml`, with a static fallback (FR-23).
- The disabled-pane treatment for everything this runtime does not carry, with **honest per-runtime
  wording** — a Grok CLI session bills against a SuperGrok / X Premium+ plan, so neither `codex`'s
  nor `francois`' existing `usageBar` reason is true here.
- On Windows, where Grok's sandbox does not exist, the session **runs** and says so once (FR-25).

**Non-goals**

- **The xAI API.** Already covered, with no new code: add an `openai-compatible` endpoint account with
  base URL `https://api.x.ai/v1` and a key, and the Francois loop drives `grok-4.6` / `grok-4.6-mini`
  today. `providers.ts`' `xai` entry already carries that `apiBaseUrl`, `hosts: ['api.x.ai']` and the
  `XA` tile. Hardening that path is `xai-endpoint-hardening`, not this feature.
- **Approval cards.** `grok -p` is non-interactive: stdin carries the prompt and then closes, so there
  is no channel to park an ask on, and ACP's `session/request_permission` is a *request* needing a
  reply nobody can give. Enforcement is the **sandbox** `permissionMode` selects (FR-9); the same
  trade, and the same `permissions: { available: false }`, as `codex`.
- **Full ACP over `grok agent stdio`.** Could carry real permission round-trips, but is a brand-new
  protocol layer with no precedent here. The upgrade path — see §10.
- **`agent_thought_chunk` / reasoning blocks.** `BlockKind` has no thinking member, and rendering a
  thought as an `Assistant` block would misattribute it. Parsed and dropped, as `codex` drops
  `reasoning`.
- **Skills, MCP, subagents, workflows, slash commands, compaction, remote control.** Grok has its own
  MCP client (`[mcp_servers]` in `config.toml`) and its own commands, but Francois' panes read
  *Claude Code's* control surfaces; inverting them into runtime-agnostic discovery is
  `capability-registry`. All `available: false` here, worded as current gaps.
- **Grok's interactive TUI, `grok inspect`, enterprise `managed_config.toml` / `requirements.toml`,
  `auth_provider_command`, and the `--device-auth` flow beyond spawning `grok login`.** Out of scope.
- **Custom sandbox profiles** (`sandbox.toml`, `[profiles.*]`). The five built-ins are the whole
  vocabulary this feature maps onto.

## 3. User stories / flows

**Install the CLI.** Accounts modal → the xAI provider → the CLI card already shipped on this branch
reads *"grok is not installed"* with `npm i -g @xai-official/grok` and an **Install grok** button.
After this feature, that card's follow-on is a real sign-in rather than a "coming soon" note.

**Add a Grok account.** Accounts modal → Add → the kind picker now offers *Grok CLI* alongside
*Claude*, *Codex CLI* and *OpenAI-compatible endpoint*. Choose it, give it a label, Save. The row
appears with a **Sign in** action, because a fresh `GROK_HOME` has no `auth.json`. Clicking it runs
`grok login` against that account's config dir; the row flips to signed-in when `auth.json` lands.

**Start a session on it.** New Session modal → the account picker lists the Grok account **enabled**.
Selecting it repopulates the model picker from Grok's catalog under that account's label. Create,
type a message, send.

**The turn.** The composer clears, the session goes `running`. Grok's reply **types itself in** as
`agent_message_chunk` deltas arrive. Each tool it runs appears as a card that goes live on `tool_call`
and completes in place on `tool_call_update`. The diff badge updates when it edits files. The turn
ends on the `session/prompt` response and the context meter fills from the reported usage.

**The next turn** is the same argv with the same `-s <sessionId>`, so Grok still has the whole
conversation. Quit Francois, reopen: the transcript is there (durable-sessions) and the session id is
persisted, so the next message continues rather than starting over.

**On Windows**, identical except for a one-time sandbox notice (FR-27). **The panes** — Agents, MCP,
Skills, Workflows — render the disabled notice with their reason, and the usage bar hides (FR-26).

## 4. Functional requirements

### The axes

- **FR-1** `AgentRuntime` gains a fourth member, `grok` (`AgentRuntime::Grok`). `contract/common.ts`
  and `src-tauri/src/session/adapter/mod.rs` move together. Every `match` on `AgentRuntime` in the
  core stays **exhaustive with no wildcard arm** — a fifth runtime must fail to compile, not default.
- **FR-2** `AccountKind` gains `grok-cli` (`AccountKind::GrokCli`). `AgentRuntime::from_account_kind`
  maps it to `(Grok, Openai)` and stays exhaustive. xAI's API is an OpenAI `/chat/completions`
  dialect, so `Openai` is the honest protocol value even though the vendor is neither.
- **FR-3** `adapter_for(AgentRuntime::Grok)` returns `GrokAdapter`. Dispatch remains on
  `agentRuntime` **alone** (seam FR-14a) — `protocol` is not a parameter.
- **FR-4** Persistence: `session/persistence.rs` round-trips `agentRuntime: "grok"`. A record whose
  keys are absent still loads `('claude-code','anthropic')`; no legacy value maps to `grok`.

### Verification before parsing

- **FR-11** **Build step 1, before any parser is written.** §5's wire format is derived from xAI's
  published docs and the ACP standard, **not** from a live capture — `grok` was not installed when
  this spec was frozen. The implementer must first run one real turn
  (`grok -p "list the files here" --output-format streaming-json`), commit the raw NDJSON as
  `src-tauri/src/session/adapter/grok/fixtures/exec_turn.jsonl`, and **reconcile §5 against it**,
  reporting any divergence as a spec finding rather than silently coding to what was found. Three
  specific things to confirm, each of which changes argv or the parser:
  1. that `-s <id>` accepts a **foreign** (Francois-minted) session id on a fresh turn and resumes it
     on the next — the whole of FR-8 rests on this;
  2. whether `--cwd` is accepted on every invocation, or whether the child's working directory is the
     only reliable route (the trap `codex exec resume` set, where the fresh and resuming forms take
     different flag sets and only the follow-up turn breaks);
  3. the exact `sessionUpdate` variant names and whether usage/stop-reason arrive on the
     `session/prompt` **response** or as a notification.
  `codex/args.rs`' header comment is the precedent: both argv shapes were verified live because the
  difference was documented nowhere but `--help`.

### The transport

- **FR-5** A turn spawns:

  ```
  grok -p --output-format streaming-json
       --session-id <francois session id>
       --model <model_id>
       --sandbox <profile>
       --always-approve
       --no-auto-update
  ```

  with the session's `cwd` as the child's **working directory**, the prompt **written to stdin and
  stdin then closed**, stdout piped, stderr null. No positional prompt: it keeps multi-line text,
  quotes and shell metacharacters out of argv entirely — the same reasoning `claude -p` and
  `codex exec` already follow.
- **FR-6** `--always-approve` is on **every** invocation. It is the analogue of Codex's
  `approval_policy="never"`: the transport cannot answer a prompt, so nothing may block waiting for
  one. The sandbox (FR-9) is the whole of the enforcement.
- **FR-7** `--no-auto-update` is on every invocation — xAI documents it for headless/CI use, and a
  background self-update mutating the binary mid-turn is a failure mode with no useful diagnosis.
- **FR-8** **Session continuity is the argv, not a captured anchor.** Francois passes its own
  `SessionId` as `--session-id` on the first turn and every turn after, which per xAI's docs
  "create[s] or resume[s] a named headless session". `Session.claude_session_id` stores it for
  parity with the other runtimes. If FR-11(1) shows Grok rejects a foreign id, fall back to the Codex
  shape: capture Grok's own id from the first turn and pass `--resume <id>` afterwards.
- **FR-9** `permissionMode` → Grok sandbox profile, pinned per invocation:

  | `permissionMode` | `--sandbox` |
  |---|---|
  | `default`, `plan` | `read-only` |
  | `acceptEdits` | `workspace` |
  | `bypassPermissions` | `off` |
  | anything else | `read-only` (**fail closed**) |

  `plan` is `read-only` because read-only *is* what plan mode means operationally, and it is enforced
  by the OS rather than by asking the model nicely. `devbox` (a container profile) and `strict` (adds
  child-network restrictions no `permissionMode` expresses) are unused — naming them here is how a
  reader knows they were considered.
- **FR-10** `GrokTurnHandle` owns the `Child` and an `interrupted` flag — and, like
  `CodexTurnHandle` and unlike `TurnHandle`, **no pending maps and no stdin writer**, because neither
  exists on this transport.
- **FR-12** A stdout line that is not valid JSON, carries no `method`, or carries a `method` /
  `sessionUpdate` this version does not know, is **ignored rather than fatal**. Grok prints
  human-readable preamble on some paths and will add variants between releases; a turn must never die
  on output it does not recognise.

### Event translation

- **FR-13** `session/update` notifications translate to the `SessionEvent` members the transcript
  already renders. Nothing Grok-shaped crosses the IPC boundary.
- **FR-14** `agent_message_chunk` appends to the live assistant block as a **delta**, so text streams.
  This is the one place this runtime is *better* than `codex`, and it must not be flattened into a
  whole-message write for symmetry's sake.
- **FR-15** `tool_call` opens a tool card and `tool_call_update` completes it **in place**, addressed
  by `toolCallId`. ACP's `kind` (`read` / `edit` / `execute` / `search` / `fetch` / …) selects which
  card the view draws; an unknown `kind` renders as a generic tool card rather than being dropped.
  Per the standing naming decision, a card's displayed name uses **Claude Code's tool vocabulary**
  (`Read`/`Write`/`Edit`/`Grep`/`Glob`/`Bash`) so permission rules stay one vocabulary.
- **FR-16** The context meter fills from the turn's reported token usage. Cached input counts toward
  the window; a reasoning-token count that is a *subset* of output tokens is not added twice (the
  `CodexUsage` lesson). If FR-11(3) finds no usage is reported at all, the meter stays empty rather
  than being estimated — a wrong number is worse than none.
- **FR-17** The turn ends on the `session/prompt` response. A `stopReason` of `refusal` or an error
  response ends the turn as **errored** with the message surfaced; `cancelled` after a user brake
  ends it as interrupted, not failed.
- **FR-18** `agent_thought_chunk` and `plan` are parsed and dropped (§2). Dropping must be explicit
  in code, not a fall-through, so the follow-up that renders them has an obvious seam.

### Accounts

- **FR-19** A `grok-cli` account's `configDir` is exported to every `grok` invocation as
  **`GROK_HOME`** — the same trade `CODEX_HOME` and `CLAUDE_CONFIG_DIR` already make. Grok copies its
  config into `$GROK_HOME/config.toml` and writes credentials to `$GROK_HOME/auth.json`.
- **FR-20** `francois:account:addGrok` creates the account and its config dir. Label only: a Grok
  account has no URL and no key, just a `GROK_HOME` that `grok login` fills in afterwards.
- **FR-21** `francois:account:grokLogin` spawns `grok login` against that account's `GROK_HOME` and
  resolves as soon as it is spawned. The browser round-trip happens out of band and the refreshed
  list arrives on `account.list` once `auth.json` lands — no PTY and no `loginId`, mirroring
  `account:codexLogin` exactly.
- **FR-22** `Account.signedIn` is derived on every list from `auth.json`'s existence in the account's
  `GROK_HOME`, never persisted. Its doc comment widens from *iff `codex-cli`* to *iff `codex-cli` or
  `grok-cli`*. It stays distinct from `authFailedAt`: a freshly added account has no credential and
  no failure yet, and must read as "sign in first" rather than as healthy.
- **FR-23** A turn on an account with no `auth.json` fails with `ACCOUNT_NOT_AUTHENTICATED` before
  spawning, and the transcript says which account to sign in.
- **FR-24** A turn whose `grok` binary is not on PATH fails with `SPAWN_FAILED` and a message naming
  the install command — the CLI is per-machine, so this is a machine problem, not an account problem.

### Models

- **FR-25** `GrokAdapter::models` reads `$GROK_HOME/config.toml`: `[models] default` picks the
  default and each `[model."<id>"]` section contributes an entry (`name` → label when present, else
  the id). When the file is absent, unreadable or declares no models, fall back to a static catalog
  (`grok-4.6`, `grok-4.6-mini`, `grok-build-0.1`). Never empty: an empty model picker is a dead end,
  and the fallback is the documented xAI catalog rather than a guess.

### Capabilities & UI

- **FR-26** `CAPABILITIES` gains a `grok` row, exhaustive over `RuntimeCapability`. `permissions`,
  `mcp`, `subagents`, `skills`, `skillsInstall`, `workflows`, `interactiveCommands`, `compaction` and
  `remoteControl` are `available: false`, each with a reason worded as a **current gap** ("not yet")
  rather than as settled architecture. `usageBar` is `false` with a reason true for *this* runtime — a
  Grok CLI session bills against a SuperGrok / X Premium+ plan Francois cannot probe, which is
  neither `francois`' "bills per token, not against a plan" nor `codex`' ChatGPT wording.
- **FR-27** **Windows.** Grok's sandbox is Landlock (Linux) and Seatbelt (macOS); there is no Windows
  implementation. A Grok session on Windows still runs, and its first turn emits **one** in-transcript
  notice that OS sandboxing is unavailable here so the mode's guarantee is the model's cooperation.
  Once per session, not per turn. `--sandbox` is still passed: a future Grok that supports Windows
  then works with no change, and an unknown profile is Grok's error to report, not ours to pre-empt.
- **FR-28** `providers.ts`: the `xai` entry's `cliLogin` flips from `null` to `'grok'`, which is what
  moves the provider from "install only" to a real sign-in route. `cliTool: 'grok'`, `apiBaseUrl`,
  `hosts` and `monogram` are unchanged. `cli_tools.rs`' header comment — which currently says `grok`
  is listed *without* a `grok-cli` `AccountKind` behind it — must be updated in the same commit, or
  it becomes a lie the next reader trusts.

## 5. API contract

`contract/multi-provider-grok.ts` holds **only** the Grok wire format. The account verbs go into
`contract/multi-account.ts` **in place** — that domain's contract file already owns
`francois:account:*`, and per the standing decision a re-keyed domain is never split across a second
file.

> **PROVISIONAL** — derived from xAI's published docs (`docs.x.ai/build/cli/headless-scripting`,
> `/build/settings`, `/build/features/{permissions,sandbox}`) and the Agent Client Protocol standard.
> **Not live-verified.** FR-11 requires reconciliation against a captured turn before the parser is
> written; treat every optional field below as "the docs did not say", not as defensive padding.

```ts
import type { AgentRuntime } from './common';

/** contract/common.ts — WIDENED, not redefined here. */
// export type AgentRuntime = 'claude-code' | 'francois' | 'codex' | 'grok';

/** contract/multi-account.ts — WIDENED. */
// export type AccountKind = 'claude-code-oauth' | 'openai-compatible' | 'codex-cli' | 'grok-cli';
// Account.signedIn — doc comment widens to: present iff kind is 'codex-cli' | 'grok-cli'.

/** contract/multi-provider-seam.ts — CAPABILITIES gains a 'grok' row (FR-26).
 *  RuntimeCapability is unchanged: 'permissions' already exists. */

// ---------------------------------------------------------------- account verbs
// These live in contract/multi-account.ts, beside AccountAddCodexPayload.

// francois:account:addGrok → invoke('account_add_grok')          (FR-20)
export interface AccountAddGrokPayload {
  label: string; // non-empty after trim
}
export type AccountAddGrokResponse = Result<Account[]>;
// errors: 'INVALID_INPUT', 'INTERNAL'

// francois:account:grokLogin → invoke('account_grok_login')      (FR-21)
export interface AccountGrokLoginPayload {
  accountId: AccountId;
}
export type AccountGrokLoginResponse = Result<void>;
// errors: 'INVALID_INPUT', 'SPAWN_FAILED', 'INTERNAL'

// ---------------------------------------------------------------- the wire
// Core-internal by construction: mirrored by serde enums in
// src-tauri/src/session/adapter/grok/wire.rs and translated there into the
// SessionEvent members the transcript already renders (FR-13). No frontend
// imports these; they live in contract/ because this is the file a reader checks
// that serde mirror against.

/**
 * One stdout line of `--output-format streaming-json`: a JSON-RPC 2.0 message.
 * FR-12 — an unknown `method`, a missing `method`, or a non-JSON line is IGNORED.
 */
export type GrokLine =
  | { jsonrpc: '2.0'; method: 'session/update'; params: GrokUpdateParams }
  /** The turn's terminal response. `id` correlates with the prompt request. */
  | { jsonrpc: '2.0'; id: number | string; result?: GrokPromptResult; error?: GrokRpcError }
  /** Forward compatibility: a method this version does not know. */
  | { jsonrpc: '2.0'; method: string; params?: unknown };

export interface GrokUpdateParams {
  sessionId?: string;
  update: GrokSessionUpdate;
}

export interface GrokRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** FR-17. `stopReason` is ACP's enum; anything else ends the turn cleanly. */
export interface GrokPromptResult {
  stopReason?: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
  usage?: GrokUsage;
}

/**
 * FR-16. Field names are the least-certain part of this contract — ACP does not
 * standardise usage reporting, so FR-11(3) must confirm them. No usage ⇒ the
 * context meter stays empty rather than estimated.
 */
export interface GrokUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

/**
 * The ACP SessionUpdate union, discriminated on `sessionUpdate`.
 * FR-14: `agent_message_chunk` is a DELTA — append, never replace.
 * FR-18: `agent_thought_chunk` and `plan` are parsed and dropped.
 */
export type GrokSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: GrokContent }
  | { sessionUpdate: 'agent_thought_chunk'; content: GrokContent }
  | { sessionUpdate: 'user_message_chunk'; content: GrokContent }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title?: string; kind?: GrokToolKind;
      status?: GrokToolStatus; rawInput?: unknown }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status?: GrokToolStatus;
      title?: string; content?: GrokToolContent[]; rawOutput?: unknown }
  | { sessionUpdate: 'plan'; entries?: unknown[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands?: unknown[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId?: string }
  /** Forward compatibility (FR-12). */
  | { sessionUpdate: string };

/** ACP content block. Only `text` is rendered in v1. */
export interface GrokContent {
  type: 'text' | string;
  text?: string;
}

/** A tool call's output. `content` members carry the text a card's body shows. */
export interface GrokToolContent {
  type: 'content' | 'diff' | string;
  content?: GrokContent;
  path?: string;
  oldText?: string | null;
  newText?: string;
}

/** FR-15: selects the card the view draws. Unknown ⇒ generic tool card. */
export type GrokToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search'
  | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type GrokToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * FR-9: `permissionMode` → Grok's sandbox profile. Grok's own vocabulary; the
 * mapping lives in the core (`grok/args.rs`) because argv construction is
 * core-shaped, and is mirrored here so the contract names every value that can
 * reach the CLI. `devbox` and `strict` are declared but unmapped — see FR-9.
 *
 * No 'ask' member on purpose: this transport is non-interactive and the core
 * pins `--always-approve` on every invocation (FR-6).
 */
export type GrokSandbox = 'off' | 'workspace' | 'devbox' | 'read-only' | 'strict';
```

**Existing channels, unchanged in shape and widened in value:** `francois:session:create` accepts an
`accountId` naming a `grok-cli` account; `francois:session:models` routes to `GrokAdapter::models`;
`francois:account:add` is **not** widened (a Grok account is added by `addGrok`, mirroring Codex);
`francois:account:list` returns rows with `kind: 'grok-cli'` and a derived `signedIn`;
`francois:session:event` carries the same `SessionEvent` members it always has. **New error codes:
none** — `ACCOUNT_NOT_AUTHENTICATED`, `SPAWN_FAILED`, `INVALID_INPUT` and `INTERNAL` all exist.

## 6. Data & state

**Core.** `Session.agent_runtime` may now hold `Grok`; `Session.claude_session_id` holds the id
passed as `--session-id` (FR-8). New module `src-tauri/src/session/adapter/grok/` mirroring
`codex/`: `mod.rs` (the adapter + the shared model), `args.rs` (argv + the sandbox mapping, pure),
`wire.rs` (the serde mirror of §5), `runner.rs` (spawn + the reader thread), `models.rs` (the
`config.toml` catalog + fallback), `fixtures/exec_turn.jsonl` (FR-11). `GrokTurnHandle` per FR-10.
A per-session `sandbox_notice_emitted: bool` backs FR-27's once-per-session guarantee.

**Accounts.** `AccountKind::GrokCli` persists in the existing accounts JSON in the app data dir; the
account's `configDir` doubles as its `GROK_HOME` (FR-19). `signedIn` is derived, never stored.

**Frontend.** No new store. The kind picker gains a *Grok CLI* option; `providers.ts`' `xai` entry
gains `cliLogin: 'grok'` (FR-28). Derived state only: the disabled-pane reasons come from
`CAPABILITIES['grok']`.

**No new persistence format**, and no adapter-owned thread file — unlike the Francois loop, Grok owns
its own conversation state inside `$GROK_HOME`, which is exactly why FR-8 works.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| `grok` not on PATH | Turn fails `SPAWN_FAILED`, message names `npm i -g @xai-official/grok` (FR-24). The CLI card in the Accounts modal already reports the same state. |
| No `auth.json` in `GROK_HOME` | Turn fails `ACCOUNT_NOT_AUTHENTICATED` **before** spawning; transcript names the account (FR-23). |
| `grok login` never completes | Nothing breaks: `signedIn` stays false, the row keeps its **Sign in** action. No timeout — the browser round-trip is out of band. |
| Credentials expire mid-turn | Grok exits non-zero; turn errors with its stderr-free message, `authFailedAt` is stamped, the row shows the failure. |
| Non-JSON / unknown line on stdout | Ignored (FR-12). Never fatal. |
| Unknown `sessionUpdate` variant | Ignored. An unknown tool `kind` renders a generic card (FR-15). |
| No usage reported | Context meter stays empty, not estimated (FR-16). |
| `stopReason: 'refusal'` | Turn ends **errored**, message surfaced (FR-17). |
| User brakes the turn | `Child` killed, `interrupted` set; a `cancelled` stop reason ends it interrupted, not failed (FR-17). |
| Windows | Session runs; one in-transcript sandbox notice per session (FR-27). |
| `config.toml` absent or model-less | Static fallback catalog; never an empty picker (FR-25). |
| Grok rejects a foreign `--session-id` | FR-11(1) catches it at build time; fall back to capture-and-`--resume` (FR-8). |
| A fifth runtime is added later | Every `AgentRuntime` match is exhaustive with no wildcard — it fails to compile rather than silently defaulting (FR-1). |

## 8. Design brief

No new design surface. This feature adds one option to the Accounts modal's existing kind picker, one
row state (**Sign in**, already drawn for `codex-cli`), and reuses the disabled-pane treatment and the
CLI install card that shipped on this branch. `design_files: []` stays empty for the same reason
`multi-provider-codex`, `collapse-right-column` and `workflow-details` do: an addition inside existing
modal chrome does not warrant fresh Claude Design mockups.

> full brief: `specs/design/multi-provider-grok.md`

## 9. Acceptance criteria

- [ ] A real `grok -p --output-format streaming-json` turn is captured to
      `grok/fixtures/exec_turn.jsonl` and §5 reconciled against it, with divergences reported (FR-11).
- [ ] `AgentRuntime` has four members; every core `match` on it is exhaustive with no wildcard arm,
      proven by a compile-time test (FR-1).
- [ ] `AccountKind::GrokCli` maps to `(Grok, Openai)`; `adapter_for(Grok)` returns `GrokAdapter`
      (FR-2, FR-3).
- [ ] A session on a `grok-cli` account persists and reloads as `grok` after quit/reopen (FR-4).
- [ ] `args.rs` unit tests pin the argv for a fresh and a follow-up turn, and the full
      `permissionMode` → sandbox table including the fail-closed default (FR-5, FR-9).
- [ ] `--always-approve` and `--no-auto-update` appear on every invocation (FR-6, FR-7).
- [ ] Replaying the fixture produces streaming assistant text, and a tool card that goes live and then
      completes in place addressed by `toolCallId` (FR-13, FR-14, FR-15).
- [ ] A malformed line, an unknown `method` and an unknown `sessionUpdate` in the fixture are all
      ignored without ending the turn (FR-12).
- [ ] `agent_thought_chunk` and `plan` produce no transcript block (FR-18).
- [ ] Adding a Grok account creates its config dir; the row shows **Sign in**; `grok login` is spawned
      with `GROK_HOME` set to that dir (FR-19, FR-20, FR-21).
- [ ] `signedIn` flips true when `auth.json` appears and is absent on non-CLI kinds (FR-22).
- [ ] A turn on an unauthenticated account fails `ACCOUNT_NOT_AUTHENTICATED` without spawning (FR-23).
- [ ] `models` reads a `config.toml` catalog, and falls back to the static list when it is absent —
      never empty (FR-25).
- [ ] `CAPABILITIES['grok']` is exhaustive; the four right-column panes render their reason and the
      usage bar hides, with wording specific to a SuperGrok / X Premium+ plan (FR-26).
- [ ] On Windows a Grok session runs and emits exactly one sandbox notice per session (FR-27).
- [ ] `providers.ts`' `xai` entry has `cliLogin: 'grok'`, and `cli_tools.rs`' header comment no longer
      claims no `grok-cli` `AccountKind` exists (FR-28).
- [ ] `npx tsc --noEmit`, `npm test` and `cargo test` are green.

## 10. Open questions (deliberately deferred)

- **Full ACP over `grok agent stdio`.** The transport that would make real approval cards possible —
  `session/request_permission` is a request, so a client that answers it gets the gate this feature
  declines (§2). Worth revisiting once a second ACP-speaking CLI exists; one vendor is not a pattern.
- **`agent_thought_chunk` as a real block.** Blocked on `BlockKind` gaining a thinking member — a
  `conversation-view` change three runtimes would use (Codex has the identical gap).
- **Grok's MCP client and its commands.** Discoverable via `[mcp_servers]` in `config.toml`, but
  wiring them into Francois' panes is `capability-registry`.
- **`--allow` / `--deny` pattern rules.** A per-invocation rule surface that might translate
  `permission-guardrails`' rules onto Grok with no interactive channel — possibly the cheaper half of
  the approval-card question above. Unexplored.
- **The xAI API path.** Whether `xai-endpoint-hardening` deserves a spec depends on how the shipped
  endpoint account actually behaves against `api.x.ai/v1` — verify before speccing.

## Remediation

(Empty until a review returns findings.)
