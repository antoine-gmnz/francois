---
id: pi-models-metrics
title: Pi model selection, context and cost
status: frozen
branch: feat/pi-models-metrics
created: 2026-09-18
depends_on: [pi-provider-auth, pi-transcript-events]
reviewed_base:
reviewed_digest:
design_files: []
---

# Pi model selection, context and cost

## 1. Summary

Show Pi's available provider/model pairs, switch a connected session's model at an idle
boundary, and display context/usage/cost with explicit unknown states. Sources:
[RPC/model/provider audit](research/pi-integration-audit.md).

## 2. Goals & non-goals

- Goals: provider-grouped discovery, local/custom models, favorites/recents, unavailable
  selections, accurate context versus cumulative usage, and graceful missing metrics.
- Non-goals: hardcoded catalogue of all advertised Pi providers, asserting auth validity
  from catalog presence, subscription quota parity, or a visual redesign.

## 3. User stories / flows

Choose a Pi account in New Session → load its models grouped by provider → choose a model.
After setup or a models.json edit, Refresh. Search and use keyboard arrows/Enter in the
existing picker. In an idle session select another provider/model within the same account.
During a run the picker explains “Available when this run finishes.” Unknown metrics show
an em dash, with the reason in the details, rather than zero usage or a full/empty false bar.

## 4. Functional requirements

- FR-1: Ask Pi `get_available_models`; identity is `(providerId, modelId)` and display name
  is separate. The available snapshot is not a full registry of unauthenticated providers.
  An empty list says “No models available for this Pi account” with Open setup/Refresh.
- FR-2: Cache by account/config fingerprint/environment, 60 s TTL. Refresh uses a short-lived
  no-session RPC probe under the same launch policy, then closes it. Stale cached models
  stay labelled stale and are not sufficient to authorize a new submission.
- FR-3: Retain unavailable saved/default/favorite selections as disabled entries with
  their exact identity; never silently replace with Sonnet or a similarly named model.
  Favorites/recents are UI preferences, not provider credentials or model availability.
- FR-4: New Pi session creation requires an exact pair from a fresh available snapshot.
  `modelId` alone is invalid for Pi. Project default model uses the same pair; profile
  does not acquire a competing model field.
- FR-5: Accept model/effort changes only when settled and no dispatch/compaction is pending.
  Send set_model, then read back state/available thinking levels before publishing metadata.
  Failure preserves the previous selection. Cross-provider switching keeps account/config
  pinning and conversation identity; Pi owns provider-compatible history conversion.
- FR-6: Use reported reasoning levels; do not hardcode Claude's effort subset or silently
  accept a clamped Pi value. Clear incompatible effort after model change and report the
  actual read-back value. A requested unsupported level returns INVALID_INPUT.
- FR-7: Read get_session_stats after settled runs/compaction and explicit refresh, at most
  once/second. Track totals separately from current context. Unknown context after compaction
  is null; never display the sum of historical input tokens as current context occupancy.
- FR-8: Cost is an estimate if Pi supplies pricing-derived values. Zero pricing does not
  establish free execution. Missing/untrusted pricing produces unknown cost. No account
  plan-limit meter appears for Pi unless a future verified quota capability provides one.
- FR-9: Network/auth/catalog errors retain previous display metadata as stale. No automatic
  resend or provider fallback on timeout, rate limit, removed model, or network loss.

## 5. API contract

Shared types belong in `common.ts`; amend existing `ModelInfo` by optional `runtimeModel`
and `descriptor: RuntimeModelDescriptor` (required on Pi catalogue rows). Feature-specific
catalog envelope is in `contract/pi-models-metrics.ts`.

```ts
interface RuntimeModelDescriptor {
  ref: RuntimeModelRef;
  displayName: string;
  input: ('text' | 'image')[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoning: boolean;
  authState: 'unknown' | 'configured' | 'verified' | 'failed';
  availability: 'available' | 'unavailable';
  unavailableReason?: string;
}
interface RuntimeModelCatalog {
  accountId: AccountId;
  models: RuntimeModelDescriptor[];
  checkedAt: number;
  stale: boolean;
}
interface RuntimeMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contextBasis: 'reported' | 'estimated' | 'unknown';
  costUsd: number | null;
  costBasis: 'estimated' | 'unknown';
  measuredAt: number;
  stale: boolean;
}
interface RuntimeModelsInput { accountId: AccountId; refresh?: boolean }
interface RuntimeMetricsInput { sessionId: SessionId; refresh?: boolean }
```

All non-null counters are finite nonnegative numbers; windows are positive safe integers.
Malformed required model IDs fail the probe; unknown optional fields remain private.
Add `metrics?: RuntimeMetrics` to SessionMeta. Extend `RuntimeEventPayload` with
`{kind:'model.changed'; model:RuntimeModelDescriptor; effort?:string}` and
`{kind:'metrics'; metrics:RuntimeMetrics}`.

| Logical / physical command | Input → Result data | Errors |
|---|---|---|
| francois:runtime:models / runtime_models | RuntimeModelsInput → RuntimeModelCatalog | ACCOUNT_NOT_FOUND, ACCOUNT_CONFIG_UNTRUSTED, ACCOUNT_CONFIG_CHANGED, RUNTIME_UNAVAILABLE, RUNTIME_INCOMPATIBLE, RUNTIME_TIMEOUT, RUNTIME_PROTOCOL_ERROR, INTERNAL |
| francois:session:metrics / session_metrics | RuntimeMetricsInput → RuntimeMetrics | SESSION_NOT_FOUND, RUNTIME_UNSUPPORTED, RUNTIME_EXITED, RUNTIME_TIMEOUT, RUNTIME_PROTOCOL_ERROR |
| existing francois:session:switchModel / session_switch_model | amended SessionSwitchModelInput → SessionMeta | SESSION_NOT_FOUND, SESSION_BUSY, INVALID_INPUT, MODEL_UNAVAILABLE, PROVIDER_AUTH_FAILED, RUNTIME_UNAVAILABLE, RUNTIME_TIMEOUT, RUNTIME_PROTOCOL_ERROR |

Amend `SessionCreateInput`, `SessionSwitchModelInput` and `ProjectDefaults` in their
own existing contracts with optional `runtimeModel: RuntimeModelRef`. For Pi this is
required and `modelId` is omitted; for existing runtimes current modelId semantics remain.
Reject both fields supplied together. Switch effort reuses existing command; Pi adds
SESSION_BUSY/RUNTIME_UNSUPPORTED and verifies actual accepted value.
Legacy `session_models` may project descriptors to ModelInfo for existing consumers;
Pi picker uses runtime_models to preserve stale/availability information.

## 6. Data & state

Provider/model selection and most recent metrics persist in session metadata, marked stale
after restart until refreshed. Favorites/recents keyed by accountId + provider/model pair
live in UI preferences; project defaults own default selection. No global Pi model registry
is recreated in François. Remove the use of Claude context fallback for Pi.

Expected files: `session/models.rs`, `adapter/pi/models.rs`, `session/commands/queries.rs`,
`session/commands/lifecycle.rs`, `src/features/sessions/{ModelPicker,ModelField,useModelCatalog}`,
session run chip, fleet/sidebar/overview metric selectors, typed API wrappers.

## 7. Edge cases & errors

Same model ID under two providers: distinct rows. Unreachable Ollama endpoint: provider
error, not missing OAuth. Catalog without pricing: unknown cost. After compaction Pi may
return null context tokens/percent: preserve null until trustworthy usage arrives.
A request timeout leaves actual model uncertain; read state before allowing another send.
Read-back failure keeps session unavailable for sending rather than guessing which model won.

## 8. Design brief

Provider grouping/search/favorites in current picker; concise context/cost detail with provenance.
> full brief: specs/design/pi-models-metrics.md

## 9. Acceptance criteria

- [ ] Two providers with identical IDs remain distinct; empty/stale catalog states are honest.
- [ ] Saved removed models remain visible and unavailable; no Claude fallback (FR-3).
- [ ] Failed switch preserves old metadata; successful switch reads back model/effort (FR-5–6).
- [ ] Context differs correctly from cumulative totals; null after compaction stays unknown.
- [ ] Missing/zero-price metadata never fabricates a monetary or plan-limit claim (FR-8).
- [ ] Core descriptor/mapping tests, picker/store tests and two-provider/local-provider smoke pass.

## Remediation

(Empty.)
