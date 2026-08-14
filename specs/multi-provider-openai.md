---
id: multi-provider-openai
title: OpenAI-compatible sessions
status: frozen
branch: feat/multi-provider
created: 2026-08-12
depends_on: [multi-provider-seam, multi-provider-endpoint, permission-guardrails, durable-sessions, conversation-view]
loop_pass: 0
loop_phase:
reviewed_base:
reviewed_digest:
design_files: []
---

# OpenAI-compatible sessions

## 1. Summary

The runner half of the multi-provider arc. `multi-provider-seam` built the `SessionAdapter` trait and
`multi-provider-endpoint` made endpoint credentials real; this feature fills in `OpenAiAdapter` — a
**Rust-native agent loop** over `POST /v1/chat/completions` with SSE streaming — so a session on an
endpoint account streams a reply, calls file and shell tools, and gates every one of those calls
behind the approval card the user already knows. No sidecar, no bundled Node runtime. The panes that
cannot work off Claude Code (`mcp`, `subagents`, `skills`, `workflows`, `interactiveCommands`,
`remoteControl`, `usageBar`, `compaction`) finally read the capability table the seam shipped and say
why they are off, rather than rendering empty.

**We become the permission gate.** On a Claude session the gate is Claude Code's and Francois renders
its cards; here nothing executes without *our* approval step. That is the highest-severity
correctness requirement in this feature and it is specified fail-closed throughout (FR-9..FR-13).

## 2. Goals & non-goals

**Goals**

- `OpenAiAdapter: SessionAdapter` — streaming chat, the tool loop, interrupt, model catalog.
- Six tools carrying **Claude Code's tool names verbatim** (`Read` `Write` `Edit` `Grep` `Glob`
  `Bash`), executed through the modules the core already owns.
- Every tool call evaluated against the user's `permission-guardrails` rules and, when not allowed,
  parked on the **existing** `permission.asked` / `permissions_decide` path.
- Adapter-owned conversation persistence, so these sessions survive quit/reopen like any other.
- Context tracked against a real number, with the turn refused at the limit.
- The disabled-pane treatment, driven by `providerCapabilities()`.

**Non-goals**

- The Responses API, and any per-vendor branch. v1 speaks **Chat Completions + SSE**; a vendor is
  supported by dialect, not by name. **Tested vendor: OpenAI.** Others are expected to work and carry
  no guarantee.
- MCP, subagents, skills, workflows, slash commands, remote control, usage bar, compaction — all
  already `available: false` in the seam's table. This feature *renders* that, it does not change it.
- A token/cost meter. The accepted v1 gap; the likeliest immediate follow-up.
- Cross-provider model switching. Switching within a provider works; crossing offers nothing here
  (FR-21).
- Any change to `SessionEvent`, `francois:session:*`, or the permission channels — the seam exists so
  this feature needs none.

## 3. User stories / flows

**Run a turn.** New session on an endpoint account (the block from `multi-provider-endpoint` FR-14 is
lifted) → the SESSION tab is the SESSION tab. First turn opens with one dim notice line (FR-19), then
assistant text streams in exactly as on a Claude session.

**A gated tool.** The model asks for `Bash(npm test)` → the same approval card renders → *Allow once*
runs it and the result goes back to the model → the loop continues → *Deny* returns a refusal to the
model, which carries on without the tool.

**A pane that cannot work.** Pane [3] on this session reads `Subagents aren't available on this
provider yet.` — one dim line where the list would be, not an empty box.

**Resume.** Quit mid-thread, reopen → the transcript is there and the next turn continues the same
conversation, because the message array was persisted alongside it.

## 4. Functional requirements

### Core — the loop

- **FR-1** `src-tauri/src/session/adapter/openai.rs` holds `OpenAiAdapter`, replacing
  `UnavailableAdapter` in `adapter_for(Provider::OpenAiCompatible)`. `UnavailableAdapter` is deleted,
  not kept — the match stays total through the real implementation.
- **FR-2** `preflight` resolves the session's account and fails before any I/O with: unknown account
  or `kind != OpenAiCompatible` → `INVALID_INPUT`; no `endpoint` → `INVALID_INPUT`. A missing key is
  **not** a preflight failure (loopback servers need none) — it surfaces as the endpoint's own 401.
- **FR-3** A turn issues `POST <baseUrl>/chat/completions`, `Content-Type: application/json`,
  `Authorization: Bearer <key>` when a key exists, body `{ model, messages, tools, stream: true,
  stream_options: { include_usage: true } }`. The key is read from the key file per request and never
  held in session state (`multi-provider-endpoint` FR-3).
- **FR-4** The SSE reader parses `data: ` lines, treats `[DONE]` as end-of-response, and ignores
  comment/heartbeat lines. `choices[0].delta.content` → `assistant.delta` with the same `offset`
  discipline the Claude path uses. `finish_reason: 'stop'` → `assistant.done` with the block's
  complete text.
- **FR-5** `delta.tool_calls[]` fragments are accumulated **by `index`**, not by arrival order:
  `id` and `function.name` arrive once, `function.arguments` arrives in fragments that are
  concatenated. A `finish_reason: 'tool_calls'` runs every accumulated call, appends one
  `role: 'tool'` message per call (keyed by `tool_call_id`), and issues the next request. Malformed
  accumulated JSON is not a crash: the tool result is an error string handed back to the model.
- **FR-6** The loop is capped at **50** request/response round-trips per turn. Hitting the cap ends
  the turn with `PROVIDER_REQUEST_FAILED` and a message naming the cap — a runaway loop must not be
  able to spend money indefinitely.
- **FR-7** `usage.prompt_tokens` from the final chunk drives `context.usage`; `contextLimitTokens`
  comes from `OPENAI_CONTEXT_FALLBACK` (§5), matched on model-id prefix, defaulting to 128_000. When
  `prompt_tokens` would exceed the limit the turn is **refused before the request** with
  `PROVIDER_CONTEXT_EXCEEDED` and a message telling the user to start a new session.
- **FR-8** `interrupt` aborts the in-flight request, stops the loop before the next round-trip,
  resolves every pending ask `cancelled`, and leaves the persisted message array **consistent** — a
  tool call with no matching `role: 'tool'` message is dropped rather than persisted, since the API
  rejects that shape on the next request.

### Core — the gate

- **FR-9** Every tool call is evaluated **before execution** against the rules
  `permission-guardrails` already resolves for the session. Resolution is reused **as-is**, with no
  endpoint special case: an endpoint account's config dir carries no mirrored `~/.claude`, so its
  global tier starts empty and every tool asks until the user allows it. Rules do not cross
  credentials. *(This deliberately overrides the brainstorm's line 26 — see §7.)*
- **FR-10** Effects: `allow` → execute, no card. `deny` → **do not execute**; return
  `"Permission denied by a Francois rule."` to the model as the tool result. `ask`, and **anything
  unmatched**, → park on a card. Fail-closed is the whole contract: no default-allow path exists for
  any tool, including `Read`.
- **FR-11** A parked call emits `permission.asked` with a `PermissionAsk` built by the **same**
  `pattern`/`patternLabel` builder the Claude path uses. If that builder is private to
  `claude_code.rs` it moves up to a module both adapters call — it is never copied. `allowAlways` /
  `denyAlways` write a rule through the existing settings writer, unchanged.
- **FR-12** `SessionMeta.permissionMode` is honoured: `bypassPermissions` skips the gate entirely;
  `acceptEdits` auto-allows `Write`/`Edit` only; `plan` refuses `Write`/`Edit`/`Bash` with a refusal
  string to the model and no card; `default` is FR-10. An unrecognized mode is treated as `default`.
- **FR-13** Tool execution is confined to the session's `cwd`: `Read`/`Write`/`Edit`/`Grep`/`Glob`
  resolve their path argument, reject anything escaping `cwd` after canonicalization (symlinks
  included), and reject the escape **before** the card is shown, so a card can never approve a path
  the tool would then refuse. `Bash` runs with `cwd` as its working directory.
- **FR-14** The six tools reuse what the core owns — `fs_util.rs` for read/write/edit,
  `process_util.rs` for `Bash` — and reimplement nothing. `Bash` has a 120 s default timeout, honours
  a `timeout` argument up to 600 s, and its output is truncated to 30_000 characters before it goes
  back to the model.
- **FR-15** `Edit` fails the call (error string to the model, no partial write) when `old_string` is
  absent from the file or matches more than once without `replace_all: true` — the same contract
  Claude Code's Edit carries, so a rule and a habit both transfer.

### Core — state

- **FR-16** The message array persists to `<appData>/threads/<sessionId>.json`, written atomically
  (temp + rename) after every turn, with the same id sanitization `transcript_path` uses. It holds
  the wire messages (`system`/`user`/`assistant` incl. `tool_calls`/`tool`), not the render blocks.
- **FR-17** On resume the array is read back and replayed as the request's `messages`. An unreadable
  or malformed file is **not** fatal: the core starts a fresh thread, keeps the rendered transcript,
  and emits the existing `session.resumeFailed` event — the same degrade `--resume` rejection already
  takes.
- **FR-18** `models(account_id)` fetches `GET <baseUrl>/models` and returns `ModelInfo` with
  `contextTokens` filled from `OPENAI_CONTEXT_FALLBACK`. An account's `endpoint.modelIds` override
  replaces the fetch entirely. A failed fetch with no override returns an empty list — never the
  Anthropic catalog, which would offer models this endpoint cannot serve. A 401 marks the account
  auth-failed through the existing `mark_auth_failed` path.

### Frontend

- **FR-19** The first turn of an `openai-compatible` session emits, once, a `command.output` carrying
  `{ kind: 'notice', text: … }`: *"Francois runs its own agent loop on this provider — tool use and
  formatting differ from Claude Code."* Once per session, before the first assistant delta, persisted
  with the transcript. (Journal, 2026-08-12 `ui`.)
- **FR-20** Panes [3]–[6], the usage bar, and the slash menu read
  `providerCapabilities(session.provider)` and, when `available: false`, render the pane's normal
  frame with the `reason` as a single dim line in place of its content. No pane is hidden, none
  renders empty, and no component branches on `provider` directly — the table is the only source.
- **FR-21** The model picker groups by provider with a neutral heading and lists only the models of
  the session's own provider as switchable. No vendor colour, no second species of session card;
  provider is metadata, not identity.
- **FR-22** `multi-provider-endpoint` FR-14 is **deleted**: endpoint rows in both account pickers
  become fully selectable, with no reason line and normal keyboard nav.

## 5. API contract

**No new IPC channel, no new command, no new event, and no addition to `SessionEvent`** — that is what
the seam was for. Two contract files are touched.

### `contract/common.ts` — additions to `ErrorCode`

```ts
  | 'PROVIDER_REQUEST_FAILED' // multi-provider-openai: the endpoint errored, or the tool loop hit its cap
  | 'PROVIDER_CONTEXT_EXCEEDED' // multi-provider-openai: the next request would exceed the model's window
```

### `contract/multi-provider-openai.ts` — new file

Pure, no IPC — same idiom as `providerCapabilities` and `MODEL_CATALOG_FALLBACK`.

```ts
// contract/multi-provider-openai.ts — the Francois-loop tool vocabulary and the
// context-window fallback table. Pure, no IPC.
// Authored from specs/multi-provider-openai.md §5.

/**
 * The tools the Francois agent loop exposes. These are Claude Code's tool names
 * VERBATIM and deliberately so: permission rules are one vocabulary, so a rule
 * written as `Bash(npm test:*)` from a Claude session reads identically here and
 * the rules editor never renders a second dialect.
 */
export type FrancoisToolName = 'Read' | 'Write' | 'Edit' | 'Grep' | 'Glob' | 'Bash';

export const FRANCOIS_TOOLS: readonly FrancoisToolName[] = [
  'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash',
] as const;

/**
 * Context windows by model-id prefix, longest prefix wins. /v1/models in the
 * OpenAI dialect carries no window, so this is the only source; real usage comes
 * from each response's `usage.prompt_tokens` (FR-7), which keeps the meter honest
 * even when the limit is a guess.
 */
export const OPENAI_CONTEXT_FALLBACK: ReadonlyArray<{ prefix: string; contextTokens: number }> = [
  { prefix: 'gpt-5', contextTokens: 400_000 },
  { prefix: 'gpt-4.1', contextTokens: 1_047_576 },
  { prefix: 'gpt-4o', contextTokens: 128_000 },
  { prefix: 'o3', contextTokens: 200_000 },
  { prefix: 'o4', contextTokens: 200_000 },
];

/** Applied when no prefix matches. */
export const OPENAI_CONTEXT_DEFAULT = 128_000;

export function contextTokensFor(modelId: string): number;
```

Rust mirrors `FRANCOIS_TOOLS` as the tool-name enum whose `Display` is exactly these strings; a test
asserts the two lists match, so a tool renamed on one side fails on the other.

## 6. Data & state

**Core.** One new persisted artifact: `<appData>/threads/<sessionId>.json` (FR-16), owned by the
adapter and written by it alone. It is deliberately **not** merged into the durable-sessions
transcript: the transcript is a render model (blocks the UI draws), the thread file is a wire model
(messages the API accepts), and collapsing them would make every future adapter's wire format the
UI's problem. Removing a session deletes both. No change to `sessions.json`, to `Session`'s fields,
or to the account registry.

**Frontend.** No new store, no new selector. `providerCapabilities()` gains its first consumers
(FR-20); every one of them reads `session.provider`, which `SessionMeta` has carried since the seam.

## 7. Edge cases & errors

| case | behaviour |
|---|---|
| Endpoint returns 401 mid-turn | Turn ends `ACCOUNT_NOT_AUTHENTICATED`, account marked auth-failed (existing path). The key is not in the message. |
| Endpoint returns 429 / 5xx | `PROVIDER_REQUEST_FAILED` with the status and the endpoint's own message body, truncated to 500 chars. No retry in v1. |
| SSE stream cut mid-block | The partial `assistant.done` closes with the text received; the turn ends `PROVIDER_REQUEST_FAILED`. The thread file is not written (FR-8's consistency rule). |
| Model emits a tool name outside `FRANCOIS_TOOLS` | Error string back to the model (`unknown tool`), no card, no execution, loop continues. |
| Tool path escapes `cwd` | Error string back to the model, **no card shown** (FR-13). |
| User denies, model retries the same call | Asked again. A `denyOnce` is not remembered; `denyAlways` writes a rule and the retry is auto-denied by FR-10. |
| `bypassPermissions` on an endpoint session | Gate skipped entirely (FR-12) — the same escape hatch, and the same blast radius, the mode already means. |
| Rules granted on a Claude session | Do **not** apply (FR-9). This overrides the brainstorm's line 26: an endpoint account's empty global tier is the safe default, and consent for one vendor's model is not consent for another's. The rules editor works normally on these sessions, so the user grants what they want once. |
| Quit with a turn in flight | Existing `kill_all` teardown; pending asks resolve `cancelled`; the thread file keeps the last consistent state, so resume replays a valid array. |
| Thread file corrupt on resume | Fresh thread + `session.resumeFailed` (FR-17). Never a failure to open the session. |
| Context exceeded | `PROVIDER_CONTEXT_EXCEEDED` before the request. No compaction — `compaction` is `available: false` in the table. |

## 8. Design brief

New UI is small and entirely inside existing chrome: the **disabled-pane treatment** (one dim reason
line inside the pane's normal frame), the **provider grouping** in the model picker, and the
**first-turn notice** (the existing dim `notice` card). No vendor colour, no new screen.

> full brief: `specs/design/multi-provider-openai.md`

## 9. Acceptance criteria

- [ ] A session on an OpenAI endpoint account streams a reply, calls tools, and completes a turn;
      `UnavailableAdapter` is gone (FR-1/FR-3/FR-4).
- [ ] Tool-call deltas accumulated out of order, and split mid-`arguments`, reconstruct correctly
      against a recorded SSE fixture (FR-5).
- [ ] **Gate tests, the feature's highest-severity requirement:** an unmatched tool asks; a `deny`
      rule never executes; `plan` refuses `Write`/`Edit`/`Bash`; `acceptEdits` auto-allows only
      `Write`/`Edit`; a path escaping `cwd` is refused before any card (FR-9/FR-10/FR-12/FR-13).
- [ ] No default-allow path exists for any of the six tools — grep plus a test that every
      `FrancoisToolName` with no matching rule produces a card (FR-10).
- [ ] `PermissionAsk.pattern` for the same `Bash` command is byte-identical between the Claude path
      and the Francois loop (FR-11).
- [ ] The loop cap ends the turn at 50 round-trips with `PROVIDER_REQUEST_FAILED` (FR-6).
- [ ] A turn interrupted mid-tool-call leaves a thread file the endpoint accepts on the next request
      (FR-8).
- [ ] Quit and reopen mid-thread continues the same conversation; a corrupted thread file yields a
      fresh thread plus `session.resumeFailed`, never a failure to open (FR-16/FR-17).
- [ ] `contextTokensFor` matches longest-prefix and falls back to 128k; a turn over the window is
      refused before the request (FR-7).
- [ ] Every capability with `available: false` renders its `reason` in the pane's frame, and no
      component branches on `provider` outside the table (FR-20) — grep is the check.
- [ ] `FRANCOIS_TOOLS` and the Rust tool enum are asserted equal (§5).
- [ ] A Claude Code session's behaviour is byte-identical to before — the seam's golden replay test
      (`multi-provider-seam` FR-18) still passes untouched.
- [ ] `npm test`, `npx tsc --noEmit`, `cargo test` all green.

## Remediation

(Empty until a review returns findings.)
