---
id: codex-model-catalog
title: Codex model catalogue and reasoning efforts
status: in-review
branch: feat/codex-model-catalog
created: 2026-09-17
depends_on: [multi-provider-codex, session-settings-sheet]
reviewed_base: 4b02ee93865ef9d3f65084d74a0f87922afe8fc9
reviewed_digest: 659e354d8a9a2767
design_files: []
---

# Codex model catalogue and reasoning efforts

## 1. Summary

Query the selected Codex account's CLI catalogue instead of treating `models_cache.json` or four hard-coded models as authoritative. Show every picker-visible model returned by that runtime and its supported efforts, including `ultra`; preserve those selections through creation, updates, persistence and subsequent turns. This is delivery 01 of [provider-capability-parity](provider-capability-parity.md), independently shippable before interactive session transport changes.

The user delegated sequencing and routine spec decisions on 2026-09-17. This spec freezes that bounded first delivery; sibling drafts are not implementation instructions.

## 2. Goals & non-goals

- Goals: account-correct discovery, complete pagination, runtime defaults, useful errors/refresh, honest cached state, model-specific Codex effort validation, all existing selectors consuming the same catalogue.
- Non-goals: replacing `codex exec` for turns, controlling agents, changing other engines' catalogue sources, service-tier selection, enabling hidden models, inferring model entitlement or context limits. Those belong to linked programme tickets.
- An App Server catalogue can itself use upstream/local fallback data. “Returned by Codex” never means a paid/live entitlement check; no inference request is made to discover models.

## 3. User stories / flows

1. Open New Session, choose a Codex account: clear the previous account's options, load its catalogue, preserve a still-valid selection or select the runtime default, then choose an advertised effort. Keyboard and mouse use the existing picker/chips.
2. Open the run chip, session settings, palette model action or project's model defaults: query the relevant account, never the global Claude catalogue for a Codex account. Project defaults use their selected account or the existing default-account resolution.
3. Activate **Refresh models**: keep same-account rows while refreshing; success reconciles the draft only. Failure shows an error or labelled cached rows and a retry. Account switches discard old rows immediately.
4. Set `ultra` on a model advertising it, start a turn, restart François and resume: the effort is preserved and reaches Codex unchanged. An unsupported explicit effort is rejected before any session/project mutation.

## 4. Functional requirements

### Core — discovery and lifecycle

- **FR-1** Own the probe under `src-tauri/src/session/adapter/codex/`; use the existing process facade, login-shell PATH and account-kind environment isolation. Resolve the account from the registry at request time. Omitted account means the reserved `default`; an explicit empty/unknown id is an error, never a Claude fallback.
- **FR-2** For Codex, spawn `codex app-server --listen stdio://` with the account's `CODEX_HOME`; use that directory as cwd, not a project repository. Never change login, runtime config, enabled plugins or account selection. Send only initialize, initialized and model/list, using §5's protocol. No thread creation, tools, prompts or inference.
- **FR-3** Fetch pages until `nextCursor: null`, `limit: 100`, `includeHidden: false`. Also discard rows explicitly marked hidden. Deduplicate by execution model id, preserving first-seen order. Never merge hard-coded models or the vendor cache file into a successful result. An empty successful catalogue is authoritative and clears a prior cache.
- **FR-4** Map `model` to `ModelInfo.id`, `displayName` to label (empty label falls back to id), non-empty description to brief, supported reasoning efforts to efforts. Preserve their order after exact-value deduplication. Map `defaultReasoningEffort` only if present in efforts. No global effort allowlist on this path. Do not invent `contextTokens`: this protocol's catalogue has no such field.
- **FR-5** Default model is the first visible unique row marked `isDefault`, otherwise the first visible row, otherwise null. An unknown JSON field is ignored. Malformed required fields invalidate the whole fetch; do not cache a truncated/partially parsed list. §5 defines field validation and bounds.
- **FR-6** One in-flight probe per account/cache key; concurrent refreshes join it. Probe deadline is 10 seconds including process launch and all pages; cleanup then has at most 1 second before force-kill and reap. Enforce 2 MiB per line, 8 MiB total stdout, 32 pages and 1,000 unique visible rows; crossing a bound fails, never returns a plausible incomplete list. Drain stderr without retaining raw output; errors returned to the UI are fixed/sanitized messages. Always reap the child on success/error/cancellation/app exit.
- **FR-7** Cache only fully validated successful responses in memory, including an empty one. Fresh for 60 seconds; stale fallback for at most 24 hours on probe failure. Key: account id, canonical config directory, executable identity (path + file metadata), auth/config file fingerprints. Missing files are a distinct fingerprint. A detected change invalidates the entry and any older in-flight response. `refresh:true` bypasses age freshness, not identity checks. No new disk cache.
- **FR-8** No cache crosses logout, sign-in, account deletion, auth/config change or CLI replacement. Recheck account and key before publishing. Missing credentials returns `ACCOUNT_NOT_AUTHENTICATED` without cache fallback; deleted account returns `ACCOUNT_NOT_FOUND`. Transient failures may use a same-key stale entry with the error in `warning`. Never read/copy auth contents into payloads, logs or transcripts; fingerprints remain internal.
- **FR-9** Keep other adapters' catalogue contents and discovery behavior in this delivery. Wrap them in §5's shared envelope as `legacy-adapter` / `unverified`, with no freshness assertion. Remove all Codex callers of the four-model fallback and vendor-cache parser as a source of selectable models, including model-validation call sites. Future programme lots replace the other catalogue sources.

### Core — efforts, validation and state

- **FR-10** For Codex session creation, switchModel, switchEffort, updateSettings and project-default changes touching model/effort/account, resolve the effective account and selected model, then validate any explicit effort against that row's `efforts`. Use the same catalogue service/cache. Creation with no effective model uses `defaultModelId`; null default yields `INVALID_INPUT`. Null/omitted/blank effort clears to runtime default wherever the existing endpoint allows clearing; patch omission still means unchanged. Reject malformed or unsupported explicit values with `INVALID_INPUT`, without side effects.
- **FR-11** Model/effort changes apply from the next turn. On changing a Codex model, preserve an existing effort if supported; otherwise clear it to runtime default in the same atomic mutation. An explicitly supplied incompatible effort rejects the whole mutation. Never silently select another model on a persisted session or project because discovery changed.
- **FR-12** Preserve syntactically valid effort strings through durable-session loading and project-default round trips; defer membership checking until a user changes the relevant setting. Restoring/running an existing session does not require a fresh catalogue fetch. Do not broaden other runtimes' accepted mutation values to every Codex effort. Pass valid Codex effort strings in the existing fresh/resume argv; no shell interpolation. Existing absent-effort behavior remains omission, not an explicit default string.
- **FR-13** Validate before spawning a worktree/session or writing project defaults. Perform probe I/O outside session/registry locks; after it returns, recheck target account/model/session revision and either validate the current effective state or return `INVALID_INPUT` with a retry message. Preserve existing terminal-session errors and atomic patch semantics. Successful session mutations emit their existing single `session.meta`; catalogue queries emit no session events.

### Frontend

- **FR-14** Adapt every `sessionModels` consumer to the envelope. One account-keyed helper owns loading, cancellation, error and refresh state, including run chip, palette, project defaults and both modes of session settings. A response for an old account/request cannot overwrite the current catalogue or draft.
- **FR-15** Draft model reconciliation: preserve the current id if listed, else the advertised default, else first row, else empty. If the form's account is unchanged and the user has edited the model since a refresh began, reconcile that latest choice, not a stale snapshot. Session/project persisted settings change only on their existing explicit save/select action.
- **FR-16** Display effort choices verbatim from the chosen row, plus **Model default**; show defaultEffort as a hint if known. Never union efforts from other models, truncate at a fixed chip count, or coerce `ultra` to `max`. Clear incompatible draft efforts when changing the draft model. A previously persisted unavailable model/effort remains labelled as the current value, without creating a selectable invented catalogue row.
- **FR-17** Initial load has a static status after 150 ms, errors have **Retry**, empty success says **No models available**, and degraded success says **Using cached models** plus **Refresh models**. Cached rows remain selectable within FR-7's bound. No rows from another account remain visible/selectable. A failed refresh preserves the current session and any same-account draft. Create/change-model actions require a valid listed model; unrelated settings remain editable. An unchanged unavailable persisted value does not enter the patch.
- **FR-18** No new screen: compose the existing ModelPicker, ChipGroup, modal/run-chip and error primitives. Exact layout and copy are in the design brief. No design-service link is required for this in-place form refinement; the brief governs it, matching the existing small-control-change convention.

## 5. API contract

### Canonical frontend ↔ core contract (update in place)

No `contract/codex-model-catalog.ts` duplicate of the session domain. Amend `contract/session-engine.ts`, `contract/common.ts` and the affected existing mutation contracts. `AppError`, `AccountId`, `AgentRuntime`, `ModelInfo`, `Result` and `SessionMeta` remain imported/shared vocabulary.

```ts
// contract/session-engine.ts; imports from './common'
export interface SessionModelsInput {
  accountId?: AccountId; // omitted -> 'default'; explicit blank -> INVALID_INPUT
  refresh?: boolean;    // omitted -> false; other types -> INVALID_INPUT
}
export interface ModelCatalog {
  accountId: AccountId;
  agentRuntime: AgentRuntime;
  models: ModelInfo[];
  defaultModelId: string | null;
  source: 'codex-app-server' | 'memory-cache' | 'legacy-adapter';
  freshness: 'fresh' | 'stale' | 'unverified';
  fetchedAt: number | null; // epoch ms, successful core probe time
  warning: AppError | null;
}
export type SessionModelsResponse = Result<ModelCatalog>;
export type ModelCatalogFailureReason =
  | 'timeout' | 'protocol' | 'unsupported-cli' | 'runtime' | 'limit';
export interface ModelCatalogFailureDetail { reason: ModelCatalogFailureReason }
```

- Extend `ModelInfo` in `common.ts` with `defaultEffort?: string`; change `efforts` documentation to runtime/model-advertised strings. Existing fields/types are unchanged. `defaultEffort` is absent for unknown/legacy rows.
- Add `MODEL_CATALOG_UNAVAILABLE` to shared `ErrorCode` and its Rust mirror; `detail` is `ModelCatalogFailureDetail`. Required because the shared `Result`/`AppError` union carries this failure through multiple existing domains.
- `francois:session:models` → `invoke('session_models', input)` → `Promise<SessionModelsResponse>`, local desktop user, no roles. Account ids are trimmed; reserved `default` is valid. No event emitted/consumed by discovery itself.
- Envelope invariants: fresh probe = codex-app-server/fresh/timestamp/null warning; TTL hit = memory-cache/fresh/original timestamp/null; fallback = memory-cache/stale/original timestamp/error; legacy = legacy-adapter/unverified/null/null. Legacy defaultModelId is its first row id or null. An empty Codex list is successful, default null.
- Query failures: `INVALID_INPUT` malformed request; `ACCOUNT_NOT_FOUND` unknown/deleted explicit account; `ACCOUNT_NOT_AUTHENTICATED` missing account credentials; `SPAWN_FAILED` unavailable/unlaunchable CLI; `MODEL_CATALOG_UNAVAILABLE` timeout, malformed protocol, unsupported method/CLI, runtime error or resource bound; `INTERNAL` unexpected core failure. No stale fallback for input/account/auth errors. Underlying adapter failures for legacy paths retain existing behavior.

### Affected existing mutations (no new transport/channels)

| Logical channel → Tauri command | Input / success type (existing owner) | Additions to validation / errors |
| --- | --- | --- |
| `francois:session:create` → `session_create` | `SessionCreateInput` + existing optional `accountId: AccountId`; `Result<SessionMeta>` (`session-engine.ts`) | FR-10 before worktree/session side effects; catalogue failures above. Declare accountId on the canonical input if still missing there. |
| `francois:session:switchModel` → `session_switch_model` | `SessionSwitchModelInput`; `Result<SessionMeta>` | Codex model membership and FR-11; catalogue failures above. |
| `francois:session:switchEffort` → `session_switch_effort` | `SessionSwitchEffortInput`; `Result<SessionMeta>` | Model-specific membership, clear without fetch; catalogue failures above for non-empty changes. |
| `francois:session:updateSettings` → `session_update_settings` | `SessionUpdateSettingsRequest`; `Result<SessionMeta>` (`session-settings-sheet.ts`) | Validate effective Codex model+effort together; catalogue failures above. |
| `francois:project:create/update` → `project_create/project_update` | `ProjectCreateRequest` / `ProjectUpdateRequest` → `ProjectCreateResponse` / `ProjectUpdateResponse` (`Result<ProjectMeta>`), in `projects.ts`; `ProjectDefaults` in `common.ts` | Validate effective Codex defaults when model/effort/account changes; same catalogue failures. Existing defaults with no model and no explicit effort need no lookup. |

All existing input fields and errors remain (including `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, project/worktree/profile errors and atomic validation failures). No new required fields on mutations. Clear-only effort mutations and edits to unrelated fields do not probe. Explicit effort without an effective model uses the catalogue default; null default rejects with `INVALID_INPUT`. Consumers continue listening to existing `SessionEvent` member `session.meta`; no union member is added.

### Codex process protocol (internal Rust types, no IPC copy)

Verified against generated schema and no-inference probes of Codex 0.154.0, including `experimentalApi:false` and the exact required row projection below. Freeze only the subset consumed here; no new minimum-version assertion from a version string alone. Capability comes from successful method negotiation. No experimental opt-in is required for model/list. Source: [official App Server documentation](https://learn.chatgpt.com/docs/app-server); [initial evidence](reports/evidence/provider-capability-parity/codex-0.154.0-probe.json).

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"francois","version":"<app version>"},"capabilities":{"experimentalApi":false}}}
{"method":"initialized"}
{"id":2,"method":"model/list","params":{"cursor":null,"limit":100,"includeHidden":false}}
```

Wait for initialize's result before initialized; correlate every result by id, increment page request ids. JSON lines on stdio, no `jsonrpc` member required. Unknown notifications are ignored within the byte/deadline bounds. Unexpected server requests receive JSON-RPC method-not-found (-32601), never execution or approval. Matching error -32601 yields unsupported-cli; other matching errors yield runtime, with fixed safe copy. Do not parse human stderr as protocol.

Required response projection (`CodexModelListPage` / `CodexCatalogRow`, internal Rust structs; nullable fields follow the schema):

```ts
// Wire illustration only, not a second canonical frontend contract.
type CodexModelListPage = { data: CodexCatalogRow[]; nextCursor: string | null };
type CodexCatalogRow = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  isDefault: boolean;
};
```

`model` and `id`: non-empty, at most 256 Unicode scalar values, no control characters; values are passed as argv elements, never shell text. Efforts: `^[a-z][a-z0-9_-]{0,31}$`; no more than 32 entries before dedupe. Display strings must be strings, at most 16 KiB each, sanitized before IPC. Cursor: non-empty string ≤4 KiB or null; a repeated cursor fails protocol. Required missing/wrong-typed fields fail protocol; unknown fields are ignored. A default effort not in the supported list is omitted, not invented. No arbitrary fixed model-name allowlist.

## 6. Data & state

- Core owns catalogue probe/cache, account isolation and all validation. Cache is bounded to existing accounts, each at most FR-6 limits, cleared on process exit and identity invalidation. It stores no credentials and is not a second vendor catalogue writer.
- Frontend owns account-keyed presentation state and editable drafts. Catalogue refresh never writes sessions/projects. In-flight callers coalesce at the core; unmount/account-switch prevents stale UI writes without killing a probe another view uses.
- Preserve saved effort strings with syntactic validation independently of a network response. Account removal and persisted-session behavior otherwise follow existing contracts.
- `ModelInfo.contextTokens` is optional: absence stays unknown. Never set a guessed context capacity from model names in this feature.

## 7. Edge cases & errors

| Case | Required behavior |
| --- | --- |
| Fresh account, no vendor cache | Probe account App Server; no hard-coded fallback. |
| Offline / malformed protocol / unsupported CLI | Stale same-key cache + warning if eligible, otherwise error + Retry; expose CLI update hint only for unsupported-cli/spawn failure. |
| Empty successful catalogue | No models available; replace previous cached list; no guessed rows. |
| Account A slow, user selects B | A never overwrites B; deleted account/key-changed response is discarded. |
| CLI/config/auth changes during probe | Discard response; one retry with new key within a new normal request, not an automatic unbounded retry. |
| Model removed or effort set shrinks | Preserve saved values; label unavailable, require a supported selection only when explicitly changing those fields. |
| Probe dies or stalls | Resolve within deadline, kill/reap child, never leave loading or spinner indefinitely. |
| New advertised effort | Accept if well formed and supported by selected Codex model; persist/pass through without broadening another runtime's gate. |
| API-only/other runtime account | Existing source retained, response marked unverified, no Codex process launched. |

## 8. Design brief

Existing model fields gain refresh/error/cached/empty states and fully dynamic effort choices, keeping current UI chrome and keyboard behavior. English product copy. No new screen.

> full brief: specs/design/codex-model-catalog.md

## 9. Acceptance criteria

- [x] Multi-page fake App Server returns all visible models, stable order, deduped ids and the default; hidden rows never appear (FR-2–5).
- [x] A model id unknown at build time and `ultra` survive catalogue → create/update → persistence reload → fresh/resume argv (FR-4,10–12).
- [x] All model consumers use the selected/effective account; A/B race and two simultaneous consumers are covered (FR-7,14–16).
- [x] Timeout, crash, missing CLI, malformed/oversized/repeated-cursor responses, unknown fields and empty success have deterministic results; every child is reaped (FR-3,5–8).
- [x] TTL/refresh/stale-age boundaries and invalidation on auth/config/account/executable change are tested; no stale credentials/account result is rendered (FR-7–8).
- [x] Invalid explicit effort/model or mixed settings patch leaves state/worktrees unchanged; unsupported inherited effort clears only as part of an explicit model change (FR-10–13).
- [x] A restored session can continue with its saved model/effort while catalogue refresh fails; unrelated settings can still be changed (FR-12,17).
- [x] Other runtime catalogue contents/behavior do not change, all consumers compile with the new envelope, and no Codex selector uses the old four-model fallback (FR-9,14).
- [ ] Human check with one authenticated Codex account compares all picker-visible `model/list` pages with François; demonstrate Refresh, cached/empty/error states and keyboard selection. No inference needed for catalogue comparison.
- [x] Frontend targeted logic tests, `npx tsc --noEmit`, `npm test -- --reporter=dot`, Rust unit/protocol tests and `cargo test --quiet`, plus required project quality checks, pass before review. Tests use an injectable fake CLI/temporary directories, not personal accounts.

## Remediation

### Round 1 — 2026-09-17

- 2026-09-17 — 6 findings, all fixed

### Round 2 — 2026-09-17

- 2026-09-17 — 2 findings, all fixed
