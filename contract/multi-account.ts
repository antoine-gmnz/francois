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
 * Claude Code login with its own config dir (the only kind today);
 * 'openai-compatible' is an endpoint + key, added by multi-provider-openai.
 */
export type AccountKind = 'claude-code-oauth' | 'openai-compatible';

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

// francois:account:event → francois://account/event
export type AccountEvent =
  | { type: 'account.list'; accounts: Account[] }
  | { type: 'account.login.data'; loginId: string; data: string }
  | { type: 'account.login.done'; loginId: string; account: Account }
  | { type: 'account.login.failed'; loginId: string; error: AppError };
