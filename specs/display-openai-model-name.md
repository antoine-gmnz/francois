---
id: display-openai-model-name
title: The session's model name and context window come from its own runtime
status: shipped
branch: feat/display-openai-model-name
created: 2026-09-16
depends_on: [multi-provider-seam, multi-provider-endpoint, multi-provider-openai, multi-provider-codex, durable-sessions, session-engine]
reviewed_base:
reviewed_digest:
---

# The session's model name and context window come from its own runtime

## 1. Summary

A session's displayed model label and context window are both resolved through `MODEL_CACHE` — a
process-global catalog fetched from Anthropic's `GET /v1/models` and nothing else. For a session on
any other runtime the lookup misses, and both values fall back to an Anthropic-shaped guess:
`label_for` → `humanize`, which strips `claude-` and capitalizes the first dash-segment, so `gpt-4o`
renders as **`Gpt`** and `gpt-5.1-codex` also renders as **`Gpt`**; `context_limit` returns the 200K
placeholder, so a 400K-window model shows a context bar against 200K. The adapters already know both
values — `OpenAiAdapter::models` returns the endpoint's own catalog (label = id verbatim,
`contextTokens` from `wire::context_tokens_for`) and `CodexAdapter::models` returns Codex's
`display_name` and `context_window` — but nothing between `session_models` and `Session::meta` ever
asks them. This feature makes both values **resolved from the session's own runtime at creation and
persisted on the session**, so `meta()` reads them instead of guessing.

## 2. Goals & non-goals

- **Goals**
  - A session's `model.label` is the label its own runtime's catalog gives that id.
  - A session's `context_limit_tokens` is that runtime's real window for that id.
  - Both survive a quit/reopen, a removed account, and an offline launch.
  - No Anthropic-shaped guess is ever applied to a non-Anthropic model id.
  - No change on Claude Code sessions — the same labels and windows as today, byte for byte.

- **Non-goals**
  - The `/model` interactive card's catalog. `runtimeCapabilities().interactiveCommands` is
    `available: false` for `francois`, `codex` and `grok`, so `model_catalog_snapshot` is
    structurally unreachable on a non-Claude session. Stays in `interactive-commands`.
  - `familyOf` in `src/features/sessions/model-picker.ts` grouping endpoint models one-per-group
    (it splits the label on a space and endpoint labels have none). A picker-grouping cosmetic,
    pre-existing, and not about a session's model name.
  - Any new vendor context-window table. `wire::context_tokens_for` is the one that exists; this
    feature routes to it and does not extend it.
  - Frontend work of any kind — see FR-13.

## 3. User stories / flows

1. **Endpoint session.** I create a session on an `openai-compatible` account, picking `gpt-4o` from
   the New Session picker (which already shows `gpt-4o`). The topbar run chip, the roster row, the
   OVERVIEW card and the welcome header all read **`gpt-4o`** — not `Gpt`. The context bar reads
   against that model's real window.
2. **Codex session.** I create a session on a `codex-cli` account, picking **`GPT-5.1-Codex`**. Every
   surface reads `GPT-5.1-Codex`, with Codex's own `context_window`.
3. **Quit and reopen.** Both sessions reload with the same labels and windows, with no network call
   and no `CODEX_HOME` read on the load path.
4. **The account is removed.** The session's account falls back to `default` (multi-account FR-9).
   The model label does **not** change to an Anthropic guess — it still reads `gpt-4o`.
5. **Claude Code session.** Nothing I can observe changes: `opus` still reads `Opus 4.8` once the
   catalog warms, and the window still corrects itself from 200K to 1M when the fetch lands.

## 4. Functional requirements

**The stored pair**

- **FR-1** `Session` gains `model_label: String`, persisted in `sessions.json` as `modelLabel`.
  `context_limit_tokens` becomes persisted too, as `contextLimitTokens` (it is currently re-derived
  on every load).
- **FR-2** `Session::meta` builds `model` from `self.model_id` + `self.model_label` and
  `context_limit_tokens` from `self.context_limit_tokens`. It performs **no catalog lookup** — the
  `label_for(&self.model_id)` call at `src-tauri/src/session/mod.rs:938` is removed. `meta()` is
  built on every emitted event; it must stay allocation-cheap and must never touch disk or network.

**The resolver**

- **FR-3** One new function in `session/models.rs`:
  `resolve_model_display(app, account_id, model_id) -> (String /*label*/, u64 /*context limit*/)`.
  It derives the runtime from the account's kind (`AgentRuntime::from_account_kind`), calls
  `adapter_for(runtime).models(app, account_id)`, and returns the matching row's `label` and
  `context_tokens`. It is called only at the cold moments in FR-6/FR-7/FR-10 — never from `meta()`,
  never from an event path.
- **FR-4** A miss (empty catalog, id absent from it, unresolvable account, failed probe) falls back
  to FR-5. A miss is never an error and never blocks session creation.
- **FR-5** The fallback is **id-shaped, not account-shaped** — it must be correct without knowing
  the account, because FR-14's removed-account case has no account to ask:
  - `fallback_label(id)`: exact-id hit in `MODEL_CACHE` → its label. Else, if the id is
    Anthropic-shaped (starts with `claude-`, or is one of the CLI tier aliases
    `opus`/`sonnet`/`haiku`/`fable`) → `humanize(id)`, today's behavior. **Else the id verbatim.**
  - `fallback_context(id)`: Anthropic-shaped → `resolve_context_tokens(id)`. Else
    `wire::context_tokens_for(id)`. A `None` from either yields `DEFAULT_CONTEXT_LIMIT` as a
    display placeholder that `loaded_context` must not treat as a ceiling (FR-12).
  - `humanize` is therefore never applied to a non-Anthropic id. This is the whole bug.

**Where it is called**

- **FR-6** Creation resolves via FR-3 and stores both values:
  `session/commands/lifecycle.rs:372` (`session_create`) and `session/cloud/adopt.rs:398`
  (cloud adoption).
- **FR-7** Every model change re-resolves via FR-3 and rewrites both stored values:
  `session/commands/lifecycle.rs:525` and `:935`. A model change that lands a new label must emit
  `session.meta` — today's emissions already cover this; the values they carry become the new ones.
- **FR-8** Load (`session/persistence.rs`) reads `modelLabel` and `contextLimitTokens` when present.
  It calls **no adapter** — the load path must not probe a network or read `CODEX_HOME`.
- **FR-9** A record written before this feature has neither field. Load falls back to FR-5, which
  for an endpoint account is already the adapter's exact answer (label = id verbatim, per
  multi-provider-endpoint FR-10) and for Codex is the slug rather than the display name. FR-10
  corrects the remainder.
- **FR-10** The existing `reconcile_context_limits` background pass is **generalized to all
  runtimes and to the label as well**. After `warm_model_cache`, one pass resolves each distinct
  `(account_id, model_id)` pair in the live map via FR-3 — one adapter call per pair, not per
  session — and emits a corrected `session.meta` for each session whose label or limit moved. This
  is what makes FR-9's degraded Codex label self-heal without paying for it at load. It keeps
  today's shape: a background thread, emit-only-if-moved.
- **FR-11** No path may overwrite a resolved non-Anthropic limit with the Anthropic placeholder.
  Concretely: the reconcile pass of FR-10 must not call the bare `context_limit(&s.model_id)` it
  calls today, which returns 200K for every non-Claude id and would stomp a correct window on every
  launch.
- **FR-12** `loaded_context`'s existing rule is preserved verbatim: a window is a ceiling only when
  it is REAL, so a placeholder limit must arrive as `None` and must not clamp `context_used_tokens`.
  A non-Claude session that has used 300K must not reload as 200K/200K.

**Blast radius**

- **FR-13** **No contract change and no frontend change.** `SessionMeta.model` is already
  `ModelInfo` with a `label`, and all seven render sites (`run-chip.ts`, `StateRosterBody.tsx`,
  `OverviewView.tsx`, `WelcomeBlock.tsx`, `TopbarOverflow.tsx`, `SessionSettingsSheet.tsx`,
  `CommandCard.tsx`) already read `session.model.label`. `modelLabel`/`contextLimitTokens` are
  `sessions.json` keys, which are core-internal and not part of the contract. A diff that touches
  `contract/` or `src/` for this feature is out of scope.
- **FR-14** Removing the account a session runs on must not change its model label. The persisted
  label (FR-1) is what makes this hold, and FR-5's id-shaped fallback is what makes it hold even for
  a pre-FR-1 record whose account is also gone.

## 5. API contract

**No contract file.** This feature adds no IPC verb, no event, and no payload field. `contract/` is
untouched, and `/cohorte-build` authors nothing there.

The two payload fields whose **values** this feature corrects already exist in
`contract/common.ts` and keep their declared types:

```ts
interface SessionMeta {
  model: ModelInfo;            // .label is what this feature fixes
  contextLimitTokens: number;  // the real window, not the 200K placeholder
  // …unchanged
}
```

The two new keys are `sessions.json` record fields, core-internal, both optional on read:

```jsonc
{ "modelId": "gpt-4o", "modelLabel": "gpt-4o", "contextLimitTokens": 128000 }
```

## 6. Data & state

- **Core, owned by `Session`**: `model_label: String` alongside the existing `model_id`.
  `context_limit_tokens` is unchanged in type and gains persistence.
- **Persistence**: `sessions.json`, both keys optional on read (FR-9), always written on save.
- **Derived**: nothing. The point of the feature is that these two values stop being derived on a
  hot path from a catalog that does not cover them.
- **Unchanged**: `MODEL_CACHE` stays Anthropic-only and keeps its disk mirror, its warm-up and its
  `refreshed_cache` rule. It is no longer consulted for a non-Anthropic id.
- **Frontend**: no new state.

## 7. Edge cases & errors

| case | behavior |
|---|---|
| adapter catalog empty (endpoint probe failed, no `modelIds` override) | FR-5 fallback → id verbatim. Session is created. No error surfaced; the account's own auth-failed marking (multi-provider-openai FR-18) already reports a 401. |
| `models_cache.json` absent (fresh `CODEX_HOME`) | `CodexAdapter::models` already returns its own fallback catalog; a hit there is used, a miss falls back per FR-5. |
| id present in the adapter catalog with no `context_tokens` | label is used; limit falls back per FR-5, arriving as a placeholder so FR-12 does not clamp. |
| account removed after creation | FR-14 — persisted label and limit are unchanged. |
| pre-FR-1 record on disk | FR-9 fallback at load, corrected by FR-10's background pass. |
| offline launch | FR-8 makes load network-free; FR-10's pass fails its probe and leaves the persisted values alone. |
| endpoint probe is slow at creation | `session_create` is already a cold path that probes the binary (lifecycle FR-9); one `models()` call joins it. A failure falls back per FR-4 rather than failing creation. |
| two sessions, same account, same model | FR-10 resolves the pair once, not per session. |

## 8. Design brief

**None — no UI change.** Every affected surface already renders `session.model.label` and the
context bar already renders `contextLimitTokens`; this feature only corrects the values behind them.
No new component, no token, no state, no layout. `design_files` is omitted from the front-matter
deliberately, and `/cohorte-build` must not dispatch a design gate.

## 9. Acceptance criteria

- [ ] A session created on an `openai-compatible` account with `gpt-4o` reads `gpt-4o` in the run
      chip, the roster row, the OVERVIEW card and the welcome header — never `Gpt`. (FR-1..FR-6)
- [ ] A session created on a `codex-cli` account reads Codex's `display_name`. (FR-3, FR-6)
- [ ] Both survive quit/reopen with no network call and no `CODEX_HOME` read during load. (FR-8)
- [ ] Removing the account leaves the label unchanged. (FR-14)
- [ ] A `sessions.json` record with no `modelLabel`/`contextLimitTokens` loads without error, and a
      Codex session's label self-corrects to the display name after the background pass. (FR-9, FR-10)
- [ ] `Session::meta` contains no call into the model catalog. (FR-2)
- [ ] A non-Claude session whose window is 400K shows a context bar against 400K, and one that has
      used 300K does not reload as 200K/200K. (FR-11, FR-12)
- [ ] `humanize` is never reached with a non-Anthropic id — unit-tested with `gpt-4o`,
      `gpt-5.1-codex`, `o3-mini`, `grok-4`. (FR-5)
- [ ] Claude Code sessions are unchanged: `opus` → `Opus 4.8` once warm, and the 200K→1M correction
      still lands. (Goals)
- [ ] `git diff` touches neither `contract/` nor `src/`. (FR-13)
- [ ] `cd src-tauri && cargo test` green; `npm test` and `npx tsc --noEmit` unchanged.

## Remediation

(Empty until a review returns findings.)
