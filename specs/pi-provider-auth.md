---
id: pi-provider-auth
title: Pi provider authentication and credential profiles
status: in-review
branch: feat/pi-provider-auth
created: 2026-09-18
depends_on: [pi-runtime-boundary, pi-runtime-distribution, pi-rpc-sessions]
reviewed_base:
reviewed_digest:
design_files: []
---

# Pi provider authentication and credential profiles

## 1. Summary

Add Pi accounts as references to Pi-owned credential/configuration directories. Provider
login and secret storage stay in Pi tooling; François tracks configuration and observed
availability. See [provider/auth source audit](research/pi-integration-audit.md).

## 2. Goals & non-goals

- Goals: provider OAuth/API-key/local configuration, separate credential profiles,
  per-session pinning, clear missing-auth/outage states and nonsecret metadata.
- Non-goals: minting/refreshing Pi OAuth tokens in Rust, copying Claude/Codex credentials,
  a new keychain, claiming that a present auth file proves successful authentication.

## 3. User stories / flows

Accounts → Add Pi account → choose a name and Pi configuration directory → explicitly
trust that local configuration for Pi execution → save. Open Pi setup in an embedded
PTY to run its native `/login` or configure keys through its documented tooling. Close
setup and Refresh models. Create a session pinned to that account. Removing the account
leaves sessions readable; continuing work requires a new session with an available account.

## 4. Functional requirements

- FR-1: Add `AccountKind='pi'`. A Pi account is a display name plus canonical absolute
  `PI_CODING_AGENT_DIR`, native/WSL environment and distro. Same directory/environment
  cannot be registered twice. Existing Pi default is an explicit reference to `~/.pi/agent`,
  not a silent replacement for François's existing default Claude account.
- FR-2: Pi is the only writer of auth.json and OAuth refresh state. François stores no
  raw keys in accounts.json, session metadata, profiles, logs or RPC responses.
- FR-3: Do not implement a nonexistent login RPC. Reuse the login PTY infrastructure to
  launch the certified Pi interactive binary with the chosen directory from a neutral
  app-owned setup cwd and extensions disabled. Native Pi `/login` and `/logout` own flows.
  PTY bytes are transient UI data, never captured in diagnostics/transcripts or persisted.
- FR-4: Registering/discovering a directory executes nothing until user trust is recorded.
  Explain that its provider configuration can contain executable credential helpers.
  Trust is tied to the account/configuration fingerprint; changed executable configuration
  requires reconfirmation. Token refresh alone does not invalidate consent.
- FR-5: Resolve environment from the selected account. Clear Claude/Codex/Grok config
  overrides. MVP Pi accounts default to no inherited provider credentials; an explicit
  `inheritEnvironmentCredentials` choice is snapshotted and labelled. When enabled, UI
  states it may override/augment file credentials according to Pi's own resolution rules.
  Do not claim that two directories isolate inherited global keys.
- FR-6: Pin account ID, config directory, environment policy and execution environment at
  session creation. Model switches do not switch credentials. Removing/changing an account
  never silently reassigns an existing Pi session to another directory or vendor account.
- FR-7: Provider status is `configured` if available models are reported, `failed` after
  an observed auth error, otherwise `unknown`; a successful model request marks `verified`
  for that provider/time only. A local model may be configured without an API key; no
  blanket key requirement or fake OAuth state.
- FR-8: Disconnect/Remove unregisters François metadata; it does not revoke provider
  credentials. Offer “Open Pi setup to log out” as a distinct explicit action. If removal
  would affect a running session, reject with ACCOUNT_IN_USE until it is stopped.
- FR-9: Configuration snapshots and probes are per account; no shared cache can mix
  providers/models across accounts. Run probes with the same launch policy as sessions.

## 5. API contract

Amend existing `contract/multi-account.ts` and `contract/session-engine.ts`; keep existing
account list and mutation domain, not a parallel credential registry.

```ts
// AccountKind gains 'pi'. Add to existing Account:
interface PiAccountConfig {
  configDir: string;
  runtime: ClaudeRuntime;
  distro?: string;
  inheritEnvironmentCredentials: boolean;
  trusted: boolean;
}
interface PiAccountCreateInput {
  kind: 'pi';
  label: string; // trimmed 1..60 chars
  configDir: string; // existing absolute directory, canonicalized in core
  runtime: ClaudeRuntime;
  distro?: string;
  inheritEnvironmentCredentials: boolean;
  trustConfiguration: boolean; // explicit user action; false saves disabled
}
interface PiProviderAuthObservation {
  providerId: string;
  state: 'unknown' | 'configured' | 'verified' | 'failed';
  checkedAt: number;
  message?: string;
}
interface PiSetupInput { accountId: AccountId }
interface PiRefreshAuthInput { accountId: AccountId }
```

`Account.pi?: PiAccountConfig` is required iff kind=pi. `Account.configDir` remains the
canonical directory field; `PiAccountConfig.configDir` is omitted when attached to Account
(use `Omit<PiAccountConfig,'configDir'>`) to avoid storing the same value twice.
Add `francois:account:addPi` → `account_add_pi(req:PiAccountCreateInput)` → `Result<Account[]>`.
Add `francois:account:trustPi` → `account_trust_pi(req:{accountId:AccountId; trustConfiguration:boolean})`
→ `Result<Account[]>`; it fingerprints current executable configuration and may only run
while this account has no connected sessions or setup PTY. Reject otherwise with ACCOUNT_IN_USE.
Reuse existing list/remove envelopes and `account.list` event. Add logical
`francois:account:piSetup` → `account_pi_setup(req)` returning `Result<AccountLoginStarted>`, and
`francois:account:piRefresh` → `account_pi_refresh(req)` returning
`Result<PiProviderAuthObservation[]>`. PTY input/resize/close and login data/done/failure
events reuse the existing login contract; closing setup never implies auth succeeded.
Extend AccountRemoveData with `blockedSessions: SessionId[]`; Pi removal returns affected
IDs there and an empty reassignedSessions. Legacy removal behaviour stays unchanged.

Errors: existing ACCOUNT_NOT_FOUND, INVALID_INPUT, INTERNAL, SPAWN_FAILED, PTY_ERROR plus ACCOUNT_IN_USE,
ACCOUNT_CONFIG_UNTRUSTED, ACCOUNT_CONFIG_CHANGED, RUNTIME_UNAVAILABLE,
RUNTIME_INCOMPATIBLE, RUNTIME_TIMEOUT, RUNTIME_PROTOCOL_ERROR.
Provider-auth failure observed later uses PROVIDER_AUTH_FAILED, not a login-return success.

Close the existing contract drift in `SessionCreateInput`: declare optional `accountId`
and `projectId` already accepted by the Rust command. For Pi, `accountId` must explicitly
resolve to a Pi account; task 07 supplies the exact provider/model pair. Runtime is derived
from the account kind. Frontend auth is local desktop access; core revalidates every path.

## 6. Data & state

Extend account registry JSON with kind=pi and Pi nonsecret fields. Store fingerprint of
executable configuration inputs, not credential values. Exact fingerprint inputs are the
provider helper/config files used by the certified Pi release; record them in its fixture
manifest. If they cannot be enumerated reliably, configuration remains untrusted for MVP.
Do not mirror `~/.claude` into this directory. Secrets remain governed by Pi/provider tooling.

Expected files: `account/{mod,registry,commands,login,cli_tools}.rs`, new `account/pi.rs`,
`session/commands/lifecycle.rs`, `src/features/accounts/`, accounts store, existing API wrappers.

## 7. Edge cases & errors

Expired token: Pi refreshes; failure becomes provider auth error. Revoked token with a
cached model catalog is not “verified.” Provider outage is not auth failure unless structured
evidence distinguishes it. Missing directory marks account unavailable. No provider-specific
credential bytes are ever returned by a read endpoint. Setup failures keep account metadata.

## 8. Design brief

Add Pi account tile/detail/configuration controls to existing Accounts modal and reuse login PTY.
> full brief: specs/design/pi-provider-auth.md

## 9. Acceptance criteria

- [ ] Two directories for the same provider produce independently pinned sessions (FR-1/6/9).
- [ ] OAuth and API-key setup use Pi tooling; local configured provider requires no forced key (FR-2/3/7).
- [ ] Configuration discovery executes nothing before consent; changed helpers invalidate it (FR-4).
- [ ] Environment credential inheritance is explicit and tested for cross-account leakage (FR-5).
- [ ] Removing a Pi account never resumes a session through default Claude credentials (FR-6/8).
- [ ] No secret sentinel occurs in François registry/session/log/returned JSON fixtures (FR-2).
- [ ] Registry, command, PTY lifecycle and frontend state tests pass; real auth smoke is opt-in.

## Remediation

### 2026-09-19 — round 1 (/cohorte-review)

- 2026-09-19 — 8 findings, all fixed (FR-5 live RPC-spawn wiring deferred to when `connect_runtime` gets a caller; trust-toggle race narrowed via post-write re-check + rollback)

### 2026-09-19 — round 2 (/cohorte-review, verdict REVISE — core REVISE · frontend SHIP)

- 2026-09-19 — 9 findings, all fixed (no-inherit Pi env now built on `process_util::scrub_env`; distro-aware duplicate check; `ACCOUNT_CONFIG_CHANGED` on drift; Pi remove post-write recheck + rollback; shared `useLoginPty` hook; `.acc-pill--attn`). Deferred: `probe_provider_auth` empty observations (FR-7), same root cause as the FR-5 RPC-wiring deferral.
