---
id: multi-provider-endpoint
title: Endpoint accounts
status: shipped
branch: feat/multi-provider
created: 2026-08-12
depends_on: [multi-account, multi-provider-seam, projects]
loop_pass: 2
loop_phase: review
reviewed_base: 9d471154a835f85ac1987132268dbe9b779da95e
reviewed_digest: c213f10c6cf3f94b
design_files: []
---

# Endpoint accounts

## 1. Summary

`multi-provider-seam` gave `Account` a `kind` whose only value is `'claude-code-oauth'`. This feature
makes the second value real: a user can register an **OpenAI-compatible endpoint** — label, base URL,
API key, optional model-list override — as an account, test it, edit it and remove it, through the
Accounts modal they already use. It is the credential half of the multi-provider arc; the runner that
consumes it is `multi-provider-openai`. Because that runner does not exist yet, an endpoint account is
deliberately **listable but not selectable** for a session (FR-14): the alternative is shipping an
account that mints a session which dies on `UnavailableAdapter`'s `INVALID_INPUT`.

## 2. Goals & non-goals

**Goals**

- `Account.kind: 'openai-compatible'` with an `endpoint` payload, creatable from the UI.
- Key at rest in a 0600/ACL-restricted file in the account's config dir; **write-only** across the IPC
  boundary — no payload, event, log or diagnostic ever carries the key back.
- A **test-connection** probe that works on unsaved form values, reporting reachability, auth, and the
  model list the endpoint serves.
- Rename / set-default / remove work on endpoint accounts through the **existing** verbs.
- Endpoint accounts are visibly not-yet-usable for sessions, with a stated reason.

**Non-goals**

- Any adapter, agent loop, tool or turn — `multi-provider-openai`.
- Making a session run on an endpoint account, and therefore the model picker's provider grouping —
  `multi-provider-openai`.
- OS keychain storage. Decided against on 2026-08-12 (`auth`): one file path on three platforms.
- A per-account spend meter or cost display. Flagged in the brainstorm as the likeliest follow-up.
- Any change to the OAuth login flow (`account:add`'s PTY), the built-in `default` row, or
  `usage-bar`.

## 3. User stories / flows

**Add an endpoint.** Accounts modal → **Add endpoint** (a second button beside *Add account*) → a
form: Label, Base URL, API key, Models (optional, comma-separated). → **Test** runs the probe without
saving; the row under the form reports `12 models · reachable` or the failure. → **Save** writes the
row and the key file, closes the form, and the account appears in the list with an `endpoint` label
chip and a dim `sessions not yet available` note.

**Edit.** Click an endpoint row's edit affordance → the same form, prefilled, with the key field
**empty and placeholdered `•••••••• stored`**. Leaving it empty keeps the stored key; typing replaces
it; a **Clear key** action deletes it.

**Remove.** The existing remove path, unchanged from the user's side — the key file goes with the row.

**Try to use it.** In the new-session modal's account picker (and the Projects modal's default-account
picker), the endpoint row renders **disabled** with `Sessions on this provider aren't available yet.`
Keyboard navigation skips it.

## 4. Functional requirements

### Core — model & storage

- **FR-1** `AccountRecord` gains `endpoint: Option<EndpointRecord>` (serde `endpoint`, skipped when
  `None`) holding `base_url: String` and `model_ids: Option<Vec<String>>`. It is present **iff**
  `kind == OpenAiCompatible`; a record violating that invariant on load is dropped from the registry
  with an `eprintln!` (no `log`/`tracing` dependency exists in this crate; `eprintln!` is the
  established idiom elsewhere in `src-tauri`, e.g. `commands.rs:402`), never repaired into a
  half-account.
- **FR-2** The key lives at `<configDir>/endpoint-key`, written `0600` on unix and with an ACL
  granting the current user only on Windows (`fs_util.rs` owns the primitive; it is the same helper
  both platforms call). The file holds the raw key and nothing else — no JSON, no trailing newline.
  Its directory is the account's existing `config_dir` (`<appData>/accounts/<id>`), created by the
  same code path that creates it for an OAuth account.
- **FR-3** The key **never** leaves the core: it is absent from `Account`, from every `AccountEvent`,
  from `AppError.detail`, from `diagnostics.rs` output and from any `log!`. `Account.endpoint.hasKey`
  is derived from the file's existence and is the only signal that crosses. A test asserts the
  serialized `Account` for a keyed endpoint contains no substring of the key.
- **FR-4** Base-URL validation, applied identically on add and update: absolute, scheme `https`, no
  query, no fragment, trailing slashes trimmed. `http` is accepted **only** when the host is a
  loopback literal (`localhost`, `127.0.0.1`, `[::1]`). Anything else is `INVALID_INPUT` with the
  offending rule in the message. The stored value is the normalized one.
- **FR-5** `account_remove` deletes `<configDir>/endpoint-key` along with the row. A failure to
  delete is logged and does **not** fail the removal — a stale key file in a removed account's dir is
  a lesser evil than an unremovable account.

### Core — channels

- **FR-6** `account_add_endpoint` validates (FR-4), mints a uuid id, creates the config dir, writes
  the key when one was supplied, appends the record and returns the **full freshly-read list** (the
  shape every other `account:*` mutation returns). It emits `account.list` on
  `francois://account/event`, like the existing mutations.
- **FR-7** `account_update_endpoint` is a partial update: an absent field is unchanged. `apiKey`
  present replaces the key file; `clearKey: true` deletes it; both present is `INVALID_INPUT`.
  `modelIds: null` clears the override, `modelIds: []` is `INVALID_INPUT` (an empty catalog is never
  what the user meant). Addressing a non-endpoint account is `INVALID_INPUT`, not `ACCOUNT_NOT_FOUND`.
- **FR-8** `account_test_endpoint` issues `GET <baseUrl>/models` with `Authorization: Bearer <key>`
  when a key is in play, a **10 s** timeout, and no retry. It resolves `EndpointProbe` on 2xx.
  Mapping: connect/DNS/TLS/timeout → `ACCOUNT_ENDPOINT_UNREACHABLE`; 401/403 →
  `ACCOUNT_ENDPOINT_UNAUTHORIZED`; any other non-2xx, or a body that is not the expected
  `{ data: [{ id }] }` shape → `ACCOUNT_ENDPOINT_UNREACHABLE` with the status in the message.
- **FR-9** The probe is **stateless**: it takes form values, writes nothing, and never mutates the
  registry. `accountId` present with no `apiKey` means "use that account's stored key" — this is what
  lets Test work on an edit form whose key field is untouched.
- **FR-10** `EndpointProbe.models` maps each `data[].id` to `ModelInfo { id, label }`, `label` = the
  id verbatim (no vendor-specific prettifying in this feature). `contextTokens`/`efforts` are omitted
  — `/models` on the OpenAI dialect does not carry them; `multi-provider-openai` decides what to do
  about context windows.
- **FR-11** `account_rename`, `account_set_default` and `account_remove` are **kind-agnostic** and get
  no endpoint branch. An endpoint account can be the default account.
- **FR-12** Every new command is registered in the invoke handler and returns `Result` — never
  rejects, per PIPELINE §Conventions.

### Frontend

- **FR-13** The Accounts modal grows an **Add endpoint** action and an endpoint form (§8). The form is
  the only new component; the list rows reuse the existing row primitive with an added kind chip.
- **FR-14** Every account picker — the new-session modal's and the Projects modal's default-account
  control — renders an `openai-compatible` row **disabled** with the reason
  `Sessions on this provider aren't available yet.` It is not filtered out (the user must see the
  account they just created) and it is not keyboard-focusable. `multi-provider-openai` deletes this
  requirement.
- **FR-15** The key input is `type="password"`, never prefilled, and its value is not written to any
  store — it lives in component state for the lifetime of the form and is passed straight to `invoke`.
  Placeholder is `•••••••• stored` when `hasKey`, `sk-…` otherwise.
- **FR-16** Test result state is local to the form and cleared on any field edit, so a stale green
  never survives a URL change.

## 5. API contract

Per the 2026-08-04 `api` decision, the `account` domain's payload types live in the `account` domain's
file: **`contract/multi-account.ts` is edited in place.** No new contract file — this feature adds no
pure cross-surface helper.

### `contract/common.ts` — additions to `ErrorCode`

```ts
  | 'ACCOUNT_ENDPOINT_UNREACHABLE' // multi-provider-endpoint: the base URL did not answer a usable /models
  | 'ACCOUNT_ENDPOINT_UNAUTHORIZED' // multi-provider-endpoint: the endpoint rejected the key (401/403)
  | 'ACCOUNT_KEY_WRITE_FAILED' // multi-provider-endpoint: the key file could not be written or removed
```

### `contract/multi-account.ts` — additions

```ts
import type { ModelInfo } from './common'; // added to the existing import

/**
 * The endpoint half of an 'openai-compatible' account. Present on `Account` iff
 * kind === 'openai-compatible'. Carries NO key material: `hasKey` is derived from
 * the key file's existence and is the only thing that crosses the boundary (FR-3).
 */
export interface EndpointConfig {
  /** Normalized: absolute, no trailing slash, https:// except on loopback (FR-4). */
  baseUrl: string;
  hasKey: boolean;
  /** User override of the discovered catalog; absent ⇒ discover from /models. */
  modelIds?: string[];
}
```

`Account` gains:

```ts
  /** multi-provider-endpoint FR-1. Present iff kind === 'openai-compatible'. */
  endpoint?: EndpointConfig;
```

```ts
// francois:account:addEndpoint → invoke('account_add_endpoint')
export interface AccountAddEndpointPayload {
  label: string; // non-empty after trim
  baseUrl: string;
  apiKey?: string; // WRITE-ONLY. Absent ⇒ no key (a loopback server that needs none).
  modelIds?: string[]; // non-empty when present
}
export type AccountAddEndpointResponse = Result<Account[]>;
// errors: 'INVALID_INPUT', 'ACCOUNT_KEY_WRITE_FAILED', 'INTERNAL'

// francois:account:updateEndpoint → invoke('account_update_endpoint')
export interface AccountUpdateEndpointPayload {
  accountId: AccountId;
  label?: string;
  baseUrl?: string;
  apiKey?: string; // present ⇒ replace the stored key
  clearKey?: boolean; // true ⇒ delete it. With apiKey ⇒ INVALID_INPUT (FR-7).
  modelIds?: string[] | null; // null ⇒ clear the override; [] ⇒ INVALID_INPUT
}
export type AccountUpdateEndpointResponse = Result<Account[]>;
// errors: 'ACCOUNT_NOT_FOUND', 'INVALID_INPUT', 'ACCOUNT_KEY_WRITE_FAILED', 'INTERNAL'

// francois:account:testEndpoint → invoke('account_test_endpoint')
export interface AccountTestEndpointPayload {
  baseUrl: string;
  apiKey?: string;
  /** With no apiKey ⇒ probe with this account's STORED key (FR-9). */
  accountId?: AccountId;
}
export interface EndpointProbe {
  models: ModelInfo[]; // id + label only (FR-10)
  modelCount: number;
}
export type AccountTestEndpointResponse = Result<EndpointProbe>;
// errors: 'INVALID_INPUT', 'ACCOUNT_ENDPOINT_UNREACHABLE', 'ACCOUNT_ENDPOINT_UNAUTHORIZED', 'INTERNAL'
```

`AccountEvent` is unchanged in shape — `account.list` carries the widened `Account` automatically.

## 6. Data & state

**Core.** `AccountRecord.endpoint: Option<EndpointRecord>` is new persisted state in `accounts.json`,
additive and absent on every existing record. The key is **not** in `accounts.json` — it is the
sidecar file of FR-2, deliberately outside the JSON so a support request for `accounts.json` never
leaks it. `sanitize_config_dirs` keeps owning `config_dir`, so the key path is always re-derived from
the account id and never read from the persisted value.

**Frontend.** No new store. The accounts state already carries `Account[]`; `endpoint` rides along.
The endpoint form's fields and its probe result are component-local and intentionally not persisted.

## 7. Edge cases & errors

| case | behaviour |
|---|---|
| `http://` on a non-loopback host | `INVALID_INPUT`, "base URL must be https (http is allowed on localhost only)". |
| Base URL already ends in `/v1` | Kept verbatim; the probe requests `<baseUrl>/models`. The form hints `usually ends in /v1`. |
| Endpoint serves `/models` but returns `{data: []}` | Probe **succeeds** with `modelCount: 0`; the form says `reachable · 0 models`. Not an error — the user may be supplying `modelIds` by hand. |
| Key file missing but `hasKey` was true (deleted outside the app) | `hasKey` recomputes to false on the next list. A probe for that account sends no `Authorization`; the endpoint's 401 surfaces as `ACCOUNT_ENDPOINT_UNAUTHORIZED`. |
| Key file unwritable (read-only dir, ACL failure) | `ACCOUNT_KEY_WRITE_FAILED`; on **add**, the half-created row and its dir are rolled back so no keyless endpoint account is left behind. |
| Endpoint account is the default, then removed | Existing `multi-account` FR-9 path, unchanged: default falls back to `default`, sessions reassign. |
| Record with `kind: 'openai-compatible'` and no `endpoint` (hand-edited JSON) | Dropped on load with a `warn!` (FR-1). |
| Probe while offline | `ACCOUNT_ENDPOINT_UNREACHABLE` after the 10 s timeout; the Test button shows a spinner for at most that long. |

## 8. Design brief

New UI: the **endpoint form** inside the Accounts modal, the **kind chip** on an account row, and the
**disabled account-picker row**. No new screen, no vendor colour, no second species of account row —
provider is metadata, not identity (Iris's line in the brainstorm). Acid stays the one live thing per
view; the kind chip is neutral, the disabled reason is dim.

> full brief: `specs/design/multi-provider-endpoint.md`

## 9. Acceptance criteria

- [ ] An endpoint account can be added, tested, edited, renamed, set default and removed entirely from
      the Accounts modal (FR-6/FR-7/FR-11/FR-13).
- [ ] The key file is `0600`/user-only-ACL, contains exactly the key, and its path is derived from the
      account id, not from persisted JSON (FR-2).
- [ ] A serde test asserts a keyed endpoint account's serialized `Account` contains no fragment of the
      key, and that `AppError.detail` and diagnostics output do not either (FR-3).
- [ ] Base-URL validation accepts `https://api.openai.com/v1` and `http://localhost:11434/v1`, rejects
      `http://example.com/v1`, and normalizes a trailing slash away (FR-4).
- [ ] `account_test_endpoint` maps unreachable / 401 / non-2xx to the three documented codes against a
      stub server, and writes nothing to the registry (FR-8/FR-9).
- [ ] Test works on an edit form with an untouched key field, using the stored key (FR-9).
- [ ] `apiKey` + `clearKey` together, and `modelIds: []`, are both `INVALID_INPUT` (FR-7).
- [ ] Removing an endpoint account deletes its key file; a delete failure does not block removal (FR-5).
- [ ] Both account pickers render the endpoint row disabled with the stated reason and skip it on
      keyboard nav (FR-14).
- [ ] An `accounts.json` from the previous release loads unchanged, with no `endpoint` key anywhere
      (FR-1).
- [ ] `npm test`, `npx tsc --noEmit`, `cargo test` all green.

## Remediation

### 2026-08-12 — review round 1 (REVISE, 13 findings)

- 2026-08-12 — 13 findings, all fixed (1 CRITICAL, 4 HIGH, 4 MEDIUM, 4 LOW). **Core (6):** stub-server probe mapping tests, atomic Windows key write in `fs_util.rs`, full-`Account`/`AppError` key-leak tests, empty-`apiKey` filter on update, logged config-dir delete failure, `kind` check on `account_test_endpoint`'s `accountId` fallback. **Frontend (5):** `INVALID_INPUT` error border on Base URL, action row reordered to Test·Save·Cancel, result-line truncation, anchored `STATUS_IN_MESSAGE` regex, `accounts.css` self-import. **Lead-resolved as spec corrections rather than code changes (2):** FR-1 now says `eprintln!` not `warn!` (no `log`/`tracing` dependency exists in the crate), and design brief §Accessibility now documents the native `<option disabled title>` + visible-reason-in-label mechanism instead of `aria-disabled`. Full report: `specs/reports/multi-provider-endpoint.md`.

Out of scope (deferred by reviewer, not re-dispatched): `src/features/accounts/AccountRow.tsx:1-33` missing `accounts.css` self-import — pre-existing before this diff, not introduced or touched by this feature's hunks.

### 2026-08-16 — review round 2 (SHIP, 5 findings, 0 blocking)

Roadmap Phase C. Verdict **SHIP** — 0 CRITICAL, 0 HIGH, 2 MEDIUM, 3 LOW. All 11 round-1 remediation
items verified landed (6 core, 5 frontend). The FR-3/FR-15 key boundary holds (only `hasKey` /
`baseUrl` cross to the frontend; no key material in any store, log, `title`, or error copy) and FR-14
holds in both pickers. Full report: `specs/reports/multi-provider-endpoint.md`. The 2 MEDIUMs below
are being fixed by choice, not because they block; the 3 LOWs are parked in
`specs/refactor-backlog.md` under `## deferred:multi-provider-endpoint`.

- [x] MEDIUM · `src/features/accounts/EndpointForm.tsx:161-163` · spec-violation · Base URL only gets `acc-endpoint-input--error` when `saveError?.code === 'INVALID_INPUT'`; a `Test`-triggered `INVALID_INPUT` (a valid `account_test_endpoint` error per the contract) sets the result line but never highlights the field, so design brief §2's "Validation error" state fires on Save but not on Test. → **Fix:** widen the condition to `saveError?.code === 'INVALID_INPUT' || (probe.kind === 'error' && probe.error.code === 'INVALID_INPUT')`, and add a test covering the Test-path border. — **fixed 2026-08-16.** Extracted the decision into a pure `endpointBaseUrlHasError(saveError, probeError)` helper in `accounts.ts` (the JSX now just calls it), covered by a new `accounts.test.ts` case ("highlights Base URL on an INVALID_INPUT from either Save or Test") asserting the border fires for a Test-path `INVALID_INPUT`, a Save-path one, neither, and a non-`INVALID_INPUT` error on either path.
- [x] MEDIUM · `src-tauri/src/account/commands.rs:367,436,450` · quality · The three FR-7 `INVALID_INPUT` guards (`apiKey`+`clearKey` together; `modelIds: []` on add; `modelIds` empty on update) sit inline in `#[tauri::command(async)]` handlers, which this crate has no harness to unit-test — unlike every other FR-4/FR-7 rule, each of which was extracted to a pure function in `endpoint.rs` and is directly tested. Acceptance criterion §9 ("`apiKey` + `clearKey` together, and `modelIds: []`, are both `INVALID_INPUT`") is therefore unverified by `cargo test`. → **Fix:** extract the three checks into pure functions in `endpoint.rs` (e.g. `validate_endpoint_update(api_key, clear_key, model_ids) -> Result<(), (&'static str, &'static str)>` plus an add-side empty-`modelIds` check), unit-test them in `model_ids_update_from`'s style, and have `commands.rs` call them. — **fixed 2026-08-16.** Extracted `validate_key_clear_conflict(api_key: &Option<String>, clear_key: bool)`, `validate_model_ids_on_add(model_ids: &Option<Vec<String>>)` and `validate_model_ids_on_update(model_ids: &ModelIdsUpdate)` into `endpoint.rs`, each returning `Result<(), (&'static str, &'static str)>` matching `apply_update_endpoint`'s own (code, message) convention; `commands.rs`'s `account_add_endpoint`/`account_update_endpoint` now call them via the same `Err((code, msg)) => return err(code, msg)` shape already used for `apply_update_endpoint`, with identical error codes/messages and the same ordering relative to the other validations. §9 is now covered by `endpoint.rs`'s `key_clear_conflict_is_rejected_only_when_both_are_set`, `model_ids_on_add_rejects_an_empty_array_but_allows_absent_or_populated` and `model_ids_on_update_rejects_an_empty_set_but_allows_unset_clear_and_populated`.
