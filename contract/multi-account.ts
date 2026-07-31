// contract/multi-account.ts — multi-account (several Anthropic accounts).
// Authored from specs/multi-account.md §5. Imports shared vocabulary from
// common.ts; never redefines it.
//
// Physical Tauri binding: `francois:account:<verb>` → `invoke('account_<verb>')`;
// `francois:account:event` → `listen('francois://account/event')`.

import type { AppError, AccountId, Result, SessionId } from './common';

// AccountId lives in common.ts (SessionMeta.accountId / ProjectDefaults.accountId need it
// and common.ts never imports from feature files) — re-exported here for import-site parity.
export type { AccountId } from './common';
export const DEFAULT_ACCOUNT_ID: AccountId = 'default';

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

// francois:account:event → francois://account/event
export type AccountEvent =
  | { type: 'account.list'; accounts: Account[] }
  | { type: 'account.login.data'; loginId: string; data: string }
  | { type: 'account.login.done'; loginId: string; account: Account }
  | { type: 'account.login.failed'; loginId: string; error: AppError };
