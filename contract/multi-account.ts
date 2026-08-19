// contract/multi-account.ts — multi-account (several Anthropic accounts).
// Authored from specs/multi-account.md §5. Imports shared vocabulary from
// common.ts; never redefines it.
//
// Physical Tauri binding: `francois:account:<verb>` → `invoke('account_<verb>')`;
// `francois:account:event` → `listen('francois://account/event')`.

import type { AppError, AccountId, ModelInfo, Result, SessionId } from './common';

// AccountId lives in common.ts (SessionMeta.accountId / ProjectDefaults.accountId need it
// and common.ts never imports from feature files) — re-exported here for import-site parity.
export type { AccountId } from './common';
export const DEFAULT_ACCOUNT_ID: AccountId = 'default';

/**
 * What kind of credential an account is. 'claude-code-oauth' is an interactive
 * Claude Code login with its own config dir; 'openai-compatible' is an endpoint +
 * key, added by multi-provider-openai; 'codex-cli' is an interactive `codex login`
 * with its own CODEX_HOME, added by multi-provider-codex (FR-2); 'grok-cli' is an
 * interactive `grok login` with its own GROK_HOME, added by multi-provider-grok
 * (FR-2).
 *
 * The three interactive kinds are structurally the same trade — a per-account
 * config dir the vendor's own CLI fills in — and differ only in which CLI and
 * which env var (CLAUDE_CONFIG_DIR vs CODEX_HOME vs GROK_HOME, see
 * multi-provider-codex FR-18 / multi-provider-grok FR-19).
 */
export type AccountKind = 'claude-code-oauth' | 'openai-compatible' | 'codex-cli' | 'grok-cli';

/**
 * The endpoint half of an 'openai-compatible' account. Present on `Account` iff
 * kind === 'openai-compatible'. Carries NO key material: `hasKey` is derived from
 * the key file's existence and is the only thing that crosses the boundary
 * (multi-provider-endpoint FR-3).
 */
export interface EndpointConfig {
  /** Normalized: absolute, no trailing slash, https:// except on loopback (FR-4). */
  baseUrl: string;
  hasKey: boolean;
  /** User override of the discovered catalog; absent ⇒ discover from /models. */
  modelIds?: string[];
}

export interface Account {
  id: AccountId;
  label: string; // user-editable, non-empty (FR-5)
  email?: string; // <configDir>/.claude.json → oauthAccount.emailAddress
  organization?: string; // …oauthAccount.organizationName
  configDir: string | null; // null ⇔ built-in default: no CLAUDE_CONFIG_DIR override
  builtIn: boolean; // true only for 'default'
  isDefault: boolean; // exactly one true across the list (FR-4)
  createdAt: number; // epoch ms (0 for the built-in)
  authFailedAt?: number; // epoch ms of the last credential failure (FR-22/FR-23)
  /** multi-provider-seam FR-12. A persisted record without it loads as 'claude-code-oauth'. */
  kind: AccountKind;
  /** multi-provider-endpoint FR-1. Present iff kind === 'openai-compatible'. */
  endpoint?: EndpointConfig;
  /**
   * multi-provider-codex FR-21a, widened by multi-provider-grok FR-22. Present
   * iff kind === 'codex-cli' | 'grok-cli'; derived on every list from
   * `auth.json`'s existence in the account's CODEX_HOME / GROK_HOME (FR-20),
   * never persisted — the same shape and reasoning as EndpointConfig.hasKey.
   *
   * Distinct from `authFailedAt`, which only ever gets set BY a failed turn: a
   * freshly added Codex/Grok account has no credential and no failure yet, and
   * must still read as "sign in first" rather than as healthy.
   */
  signedIn?: boolean;
}

// francois:account:list — no payload
export type AccountListResponse = Result<Account[]>; // errors: 'INTERNAL'

// francois:account:add — starts (or re-runs, FR-17) an interactive login
export interface AccountAddPayload {
  label?: string; // omit → email at login, else 'Account <n>'
  accountId?: AccountId; // present ⇒ Re-login into an existing row (FR-17)
}
export interface AccountLoginStarted { loginId: string; cols: number; rows: number }
export type AccountAddResponse = Result<AccountLoginStarted>;
// errors: 'INVALID_INPUT' (login already in flight | blank label | unknown accountId),
//         'SPAWN_FAILED' (claude could not be spawned for the login PTY), 'PTY_ERROR', 'INTERNAL'

export interface AccountLoginWritePayload { loginId: string; data: string } // raw bytes
export interface AccountLoginResizePayload { loginId: string; cols: number; rows: number }
export interface AccountLoginCancelPayload { loginId: string }
export type AccountLoginAck = Result<void>; // errors: 'INVALID_INPUT', 'PTY_ERROR'

export interface AccountRenamePayload { accountId: AccountId; label: string }
export type AccountRenameResponse = Result<Account[]>;
// errors: 'ACCOUNT_NOT_FOUND', 'INVALID_INPUT' (blank label), 'INTERNAL'

export interface AccountSetDefaultPayload { accountId: AccountId }
export type AccountSetDefaultResponse = Result<Account[]>; // errors: 'ACCOUNT_NOT_FOUND', 'INTERNAL'

export interface AccountRemovePayload { accountId: AccountId }
export interface AccountRemoveData {
  accounts: Account[];
  reassignedSessions: SessionId[]; // now on 'default' (FR-9)
}
export type AccountRemoveResponse = Result<AccountRemoveData>;
// errors: 'ACCOUNT_NOT_FOUND', 'ACCOUNT_NOT_REMOVABLE', 'INTERNAL'

// francois:account:addEndpoint → invoke('account_add_endpoint')
export interface AccountAddEndpointPayload {
  label: string; // non-empty after trim
  baseUrl: string;
  apiKey?: string; // WRITE-ONLY. Absent ⇒ no key (a loopback server that needs none).
  modelIds?: string[]; // non-empty when present
}
export type AccountAddEndpointResponse = Result<Account[]>;
// errors: 'INVALID_INPUT', 'ACCOUNT_KEY_WRITE_FAILED', 'INTERNAL'

// francois:account:addCodex → invoke('account_add_codex')
// multi-provider-codex FR-18/FR-24. Label only: a Codex account has no URL and
// no key, just a CODEX_HOME that `codex login` fills in afterwards.
export interface AccountAddCodexPayload {
  label: string; // non-empty after trim
}
export type AccountAddCodexResponse = Result<Account[]>;
// errors: 'INVALID_INPUT', 'INTERNAL'

// francois:account:codexLogin → invoke('account_codex_login')
// multi-provider-codex FR-25. Resolves as soon as `codex login` is spawned; the
// browser round-trip happens out of band and the refreshed list arrives on
// account.list once auth.json lands. NOT the Claude login sub-stream: there is
// no PTY and nothing to render, so no loginId is minted.
export interface AccountCodexLoginPayload {
  accountId: AccountId;
}
export type AccountCodexLoginResponse = Result<void>;
// errors: 'INVALID_INPUT', 'SPAWN_FAILED', 'INTERNAL'

// francois:account:addGrok → invoke('account_add_grok')
// multi-provider-grok FR-20. Label only: a Grok account has no URL and no key,
// just a GROK_HOME that `grok login` fills in afterwards.
export interface AccountAddGrokPayload {
  label: string; // non-empty after trim
}
export type AccountAddGrokResponse = Result<Account[]>;
// errors: 'INVALID_INPUT', 'INTERNAL'

// francois:account:grokLogin → invoke('account_grok_login')
// multi-provider-grok FR-21. Resolves as soon as `grok login` is spawned; the
// browser round-trip happens out of band and the refreshed list arrives on
// account.list once auth.json lands — no PTY and no loginId, mirroring
// account:codexLogin exactly.
export interface AccountGrokLoginPayload {
  accountId: AccountId;
}
export type AccountGrokLoginResponse = Result<void>;
// errors: 'INVALID_INPUT', 'SPAWN_FAILED', 'INTERNAL'

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

// ---------------------------------------------------------------- CLI tools
//
// The vendor CLIs a provider's login route is driven by. Not accounts and not a
// registry: a CLI is installed once per MACHINE and every account on that
// provider shares it, which is why this lives beside the account surface rather
// than on `Account`.
//
// `grok` now backs a real `grok-cli` AccountKind (multi-provider-grok FR-2) —
// installing it is the first half of the route, `addGrok` + `grokLogin` the rest.

export type CliToolId = 'claude' | 'codex' | 'grok';

export interface CliToolStatus {
  id: CliToolId;
  /** The command a user would type — `claude`, `codex`, `grok`. */
  bin: string;
  installed: boolean;
  /**
   * `<bin> --version`, first line, trimmed. Absent when the probe timed out or
   * the CLI answered nothing — `installed` stays true either way, because the
   * executable IS on PATH and a slow version banner is not a missing install.
   */
  version?: string;
  /** The resolved executable, Windows shims (`.cmd`) included. Absent iff !installed. */
  program?: string;
  /** What `npm i -g` would install — also what the UI shows as the manual command. */
  npmPackage: string;
  docsUrl: string;
}

// francois:account:cliTools → invoke('account_cli_tools')
// Probes all three every call (no cache): installing outside the app is the
// normal case, so a stale "not installed" would outlive the fix.
export type AccountCliToolsResponse = Result<CliToolStatus[]>; // errors: 'INTERNAL'

// francois:account:installCli → invoke('account_install_cli')
// Resolves as soon as `npm i -g <package>` is SPAWNED. Output and the outcome
// arrive on francois://account/event, like the Claude login sub-stream — an
// install takes tens of seconds and the modal must stay usable throughout.
export interface AccountInstallCliPayload {
  tool: CliToolId;
}
export type AccountInstallCliResponse = Result<void>;
// errors: 'INVALID_INPUT' (an install is already in flight for this tool),
//         'CLI_INSTALL_UNAVAILABLE' (npm is not on PATH — nothing to install with),
//         'SPAWN_FAILED', 'INTERNAL'

// francois:account:event → francois://account/event
export type AccountEvent =
  | { type: 'account.list'; accounts: Account[] }
  | { type: 'account.login.data'; loginId: string; data: string }
  | { type: 'account.login.done'; loginId: string; account: Account }
  | { type: 'account.login.failed'; loginId: string; error: AppError }
  /** A chunk of the install's merged stdout+stderr, verbatim. */
  | { type: 'cli.install.output'; tool: CliToolId; data: string }
  /**
   * Terminal. `error` absent ⇒ npm exited 0. `tools` is the RE-PROBED status of
   * all three either way, so a failed install still corrects the UI if the CLI
   * turned out to be there (or a successful one that npm reported oddly).
   */
  | { type: 'cli.install.done'; tool: CliToolId; tools: CliToolStatus[]; error?: AppError };
