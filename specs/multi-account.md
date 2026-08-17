---
id: multi-account
title: Multi-account (several Anthropic accounts)
status: shipped
created: 2026-07-30
depends_on: [session-engine, sessions-sidebar, projects, usage-bar, app-shell, shell-terminal, remote-control]
design_files: ["https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html"]
---

# Multi-account (several Anthropic accounts)

## Amendments

Applied to this spec in place, after it shipped.

### A1 — 2026-08-17 · removing an account clears it from every project that named it

`account_remove` now also clears `defaults.accountId` on every project pointing at the removed
account (`project::clear_default_account`), alongside the FR-9 session reassignment it already drove,
so `projects.json` stops accumulating references to accounts that are gone. Best-effort and after the
row is gone: a failed project write leaves a stale id, which FR-20's fallback to the `isDefault`
account already absorbs. That fallback therefore stays, as the backstop for that case and for
registries written before the sweep existed. Shares its implementation with the identical
session-profiles sweep, including its boot-time reconcile and the empty-registry guard (see
`specs/session-profiles.md` §A2). For accounts that guard requires at least one REGISTERED account:
`known_ids` always contains the built-in `default` id, so its presence alone proves nothing about
whether accounts.json was read.

## 1. Summary

Francois can register several Anthropic accounts and run each session under the one the user picks.
An account is a **Claude Code config directory** (`CLAUDE_CONFIG_DIR`): the built-in `default`
account passes no override and behaves exactly as today, every added account owns
`<app_data>/accounts/<accountId>/` and is logged in once, in-app, through a real `claude` TUI shown
in an embedded terminal. The account is chosen in the new-session modal (pre-fillable per project),
stored on the session, and applied to **every** `claude` spawn that session makes — turns, usage
probes, the remote-control PTY, and the SHELL tab's environment.

## 2. Goals & non-goals

- **Goals**
  - Register / rename / remove several accounts; one is the default for new sessions.
  - Add an account by logging in from inside Francois (no terminal trip).
  - Bind an account to a session at creation; keep it for the session's whole life.
  - Pre-fill the account from the session's project defaults.
  - Plan-limit usage reported **per account**.
  - Works for both `native` and `wsl` runtimes.
- **Non-goals**
  - Changing an existing session's account (the resume anchor belongs to the old account's history —
    the user makes a new session instead).
  - API-key / `ANTHROPIC_API_KEY` accounts, org/workspace switching inside one account.
  - Sharing settings, skills, agents, MCP servers or user memory across accounts — a config dir
    isolates all of them, and that is accepted (documented in the Accounts modal, FR-36).
  - Per-distro WSL logins: one Windows-side config dir serves native **and** WSL (FR-24).

## 3. User stories / flows

**Add an account.** Status bar shows the active session's account chip → click (or `⌘K` →
"Accounts") → Accounts modal lists `Default` plus every added account with email, meters and a
`DEFAULT` badge. `[+ Add account]` → the core creates a fresh config dir and spawns `claude` in it;
the modal swaps to a live terminal running the real onboarding/login TUI. The user picks a theme,
opens the OAuth URL, pastes the code. As soon as the config dir reports an identity, the terminal
closes, the row appears with its email, and the modal returns to the list. `Esc` at any point
cancels: the PTY is killed and the half-written dir deleted.

**Open a session on a chosen account.** `n` (new session) → the modal's `ACCOUNT` field lists every
account (default pre-selected, or the project's default when a project is chosen) → pick → create.
The sidebar row carries the account badge; every turn of that session runs under it.

**Remove an account.** Accounts modal → `Remove` on a row → confirm dialog naming the sessions that
will fall back to `Default` → confirm → the row and its config dir (credentials included) are gone.

**Keyboard.** Accounts modal: `↑/↓` move, `Enter` = set default, `r` = rename, `Del` = remove,
`a` = add, `Esc` = close. New-session modal: the `ACCOUNT` field joins the existing tab order right
after `MODEL`.

## 4. Functional requirements

### Registry

- **FR-1** The core owns an account registry persisted at `<app_data>/accounts.json` (same shape and
  load discipline as `projects.json`: a missing/empty/unparseable file yields an empty registry and
  is overwritten on the next successful write, never fatal). It is loaded at startup **before**
  `session::load_persisted`.
- **FR-2** The registry always exposes a built-in account `id = "default"`, `builtIn = true`,
  `configDir = null`, first in the list. It is never persisted, never removable and always present,
  including on first run with no `accounts.json`.
- **FR-3** The default account's `email`/`organization` are read best-effort at startup from
  `~/.claude.json` → `oauthAccount` (`emailAddress`, `organizationName`). Unreadable ⇒ both absent
  and the UI labels the row `Default`.
- **FR-4** Exactly one account has `isDefault = true`; it is `default` until the user changes it.
  Setting a new one clears the previous. If the persisted default id no longer resolves, `default`
  takes over on load.
- **FR-5** `label` is user-editable and non-empty after trimming; it defaults to the email captured
  at login, falling back to `Account <n>`. Labels need not be unique.
- **FR-6** Added accounts store `configDir = <app_data>/accounts/<accountId>` (absolute, native
  path). `accountId` is a uuid-v4; `"default"` is reserved.
- **FR-7** Every registry mutation persists, then emits `account.list` with the full list.
- **FR-8** Removing an account deletes its row **and** recursively deletes its `configDir`. Removing
  `default` fails with `ACCOUNT_NOT_REMOVABLE`. Removing the account that is `isDefault` moves the
  flag to `default`.
- **FR-9** On removal, every session bound to that account is repointed to `default` (in-memory and
  persisted) and each emits a `session.meta` event. Their ids come back in `AccountRemoveData`.
- **FR-10** At session load, an `accountId` that resolves to no registry entry is replaced by
  `default` — same pruning discipline as `projectId` (projects FR-18).
- **FR-10a** An account's `configDir` **mirrors the user's global `~/.claude`** for the shared,
  non-credential entries: `commands`, `agents`, `skills`, `templates`, `pipeline`, `workflows`,
  `hooks`, `plugins`, `settings.json`. `CLAUDE_CONFIG_DIR` REPLACES the user config root rather than
  layering onto it, so without this an added account loses every slash command, subagent, skill and
  hook the user installed globally — multi-account isolates credentials, not the toolbox. The
  mirror is by **symlink** (Windows: directory junction, since an unprivileged `CreateSymbolicLink`
  is unavailable; `settings.json`, being a file, is copied there), so a global install stays live
  for every account. It is applied at creation *and* re-applied at every load as a backfill, and it
  **never replaces an entry the account already owns** — an account's own `settings.json` survives.
  The allowlist is explicit: per-account state (`sessions/`, `projects/`, `.claude.json`,
  `history.jsonl`, `cache/`) is never mirrored back. Best-effort throughout — a failed mirror
  degrades the account, never the login.

### Login

- **FR-11** `account:add` creates the config dir and spawns an interactive PTY running `claude` with
  `CLAUDE_CONFIG_DIR=<configDir>`, `TERM=xterm-256color`, cwd = the user's home, PATH from
  `claude_path_env()`. The runtime is always **native** — one Windows-side dir serves WSL too
  (FR-24). It returns a `loginId`; PTY bytes stream out as `account.login.data`.
- **FR-12** The frontend renders those bytes verbatim in an xterm.js instance and forwards keystrokes
  through `account:loginWrite` / geometry through `account:loginResize` — the same raw-passthrough
  contract as the SHELL tab.
- **FR-13** The core polls `<configDir>/.claude.json` every 1s (and once on PTY exit) for
  `oauthAccount.emailAddress`. First non-empty value ⇒ login succeeded: kill the PTY, register the
  account, emit `account.login.done` then `account.list`.
- **FR-14** If the captured `emailAddress` equals that of an already-registered account (including
  the default account's, when known), the login fails with `ACCOUNT_DUPLICATE` and the dir is
  deleted. The message states that the platform's credential store may be shared, so this account
  cannot be isolated — this is the feature's isolation check and it must fail loudly, never silently
  bill the wrong account.
- **FR-15** A login that neither succeeds nor is cancelled within **5 minutes**, or whose PTY exits
  without an identity, fails with `ACCOUNT_LOGIN_FAILED`; the PTY is killed and the dir deleted.
- **FR-16** `account:loginCancel` kills the PTY and deletes the dir. App exit cancels every in-flight
  login the same way. At most one login runs at a time; a second `account:add` returns
  `INVALID_INPUT`.
- **FR-17** An account whose `<configDir>/.claude.json` no longer exists is **not** removed from the
  registry; it is reported as unauthenticated (FR-22) and the Accounts modal offers `Re-login`, which
  is `account:add` reusing the existing row + dir.

### Session binding & spawn

- **FR-18** `NewSessionRequest.accountId` selects the account. Omitted ⇒ the `isDefault` account.
  An id that resolves to no entry ⇒ `ACCOUNT_NOT_FOUND` and no session is created.
- **FR-19** `Session` stores `account_id` verbatim at creation, persists it, and exposes it as
  `SessionMeta.accountId`. It is never re-derived and never changed afterwards (except FR-9/FR-10).
- **FR-20** `ProjectDefaults.accountId` pre-fills the new-session modal, snapshot-style like every
  other default (projects FR-24). Removing an account clears this field wherever it named that
  account (amendment A1); the modal's fallback to the `isDefault` account remains for a clear that
  could not be persisted, and for registries written before the sweep existed.
- **FR-21** **Every** spawn made on behalf of a session sets `CLAUDE_CONFIG_DIR` to that session's
  account `configDir` when it is non-null, and sets nothing when it is null (`default`): the turn
  spawn (`session/turn.rs`), the `/usage`-`/cost` side-probe (`session/usage_probe.rs`), the
  create-time claude probe (`session/commands/lifecycle.rs`), the remote-control PTY
  (`session/remote/start.rs`) and the SHELL tab's PTY (`shell/commands.rs` — so a hand-typed `claude`
  in that tab matches the session it belongs to).
- **FR-22** Before spawning a turn on an account with a non-null `configDir`, the core checks that
  `<configDir>/.claude.json` exists. Missing ⇒ the turn fails with `ACCOUNT_NOT_AUTHENTICATED`
  (session `status: 'error'`) and the account is flagged (`authFailedAt`) instead of spawning an
  unauthenticated `claude` that would hang.
- **FR-23** A turn that ends with a credential/authentication failure sets `authFailedAt` on the
  account and emits `account.list`; the Accounts modal shows the row as needing `Re-login`.
- **FR-24** For `runtime: 'wsl'`, the Windows-side `configDir` is passed through the WSL boundary by
  the environment, not the argv: `CLAUDE_CONFIG_DIR` keeps its Windows value and `WSLENV` gains
  `CLAUDE_CONFIG_DIR/up` (`/u` = pass in, `/p` = translate the path to `/mnt/...`), merged into any
  existing `WSLENV` exactly as `wsl_term_env` already merges `TERM/u`. `wsl_term_env` generalizes to
  a list-merging helper; its existing `TERM/u` behavior is unchanged.
- **FR-25** If a WSL session's account `configDir` is not on a path WSL can translate (a UNC path —
  i.e. not a drive-letter path), session creation fails with `INVALID_INPUT` naming the account.
- **FR-26** Nothing else about a session's behavior changes with the account: model, effort,
  permission mode, worktree, git routing and the resume anchor are all account-independent.

### Usage

- **FR-27** The app usage cache is keyed by `accountId`. `app:getUsage` / `app:refreshUsage` take an
  optional `accountId` (omitted ⇒ the `isDefault` account) and `usage.state` events carry the
  `accountId` they describe. Each account's snapshot keeps the existing lifecycle invariants
  (usage-bar FR-18..FR-20) independently.
- **FR-28** Each probe spawns with its account's `CLAUDE_CONFIG_DIR` (FR-21) from that account's
  perspective; probes for different accounts may run concurrently, one in flight per account.
- **FR-29** The 5-minute background tick (usage-bar FR-12) probes the `isDefault` account plus every
  account bound to at least one live session — never accounts with no sessions. The post-turn
  debounce (usage-bar FR-13) probes only that session's account.
- **FR-30** The usage bar renders the snapshot of the **selected session's** account, and its
  tooltip names that account. With no session selected it renders the `isDefault` account's.

### UI

- **FR-31** New-session modal: an `ACCOUNT` field after `MODEL` listing every account
  (label + email), pre-selected per FR-18/FR-20.
- **FR-32** Sidebar session rows show a compact account badge; rows on the `isDefault` account show
  no badge, so the badge means "not the usual account".
- **FR-33** The status bar shows the selected session's account (label, or email when the label is
  the email); clicking it opens the Accounts modal. It is also reachable from the command palette
  (`Accounts`, plus `Add account`).
- **FR-34** The Accounts modal lists every account with label, email, `DEFAULT` badge, its usage
  meters, and per-row `Set default` / `Rename` / `Remove` / `Re-login` actions, and an
  `[+ Add account]` action.
- **FR-35** `Remove` is confirm-gated and the confirmation names the sessions that will fall back to
  `Default` (FR-9) and states that the account's credentials on disk are deleted.
- **FR-36** The modal carries one line of explanation: each added account has its own Claude Code
  configuration — settings, skills, agents and MCP servers are not shared with the default account.

## 5. API contract

New domain **`account`** (add it to PIPELINE.md §Conventions "Domains"). Physical binding per
PIPELINE §Conventions: `francois:account:<verb>` → `invoke('account_<verb>')`;
`francois:account:event` → `listen('francois://account/event')`.

`contract/multi-account.ts`:

```ts
import type { AppError, ProjectId, Result, SessionId, UsageMeter } from './common';

export type AccountId = string;                // uuid v4, or the reserved 'default'
export const DEFAULT_ACCOUNT_ID: AccountId = 'default';

export interface Account {
  id: AccountId;
  label: string;                  // user-editable, non-empty (FR-5)
  email?: string;                 // <configDir>/.claude.json → oauthAccount.emailAddress
  organization?: string;          // …oauthAccount.organizationName
  configDir: string | null;       // null ⇔ built-in default: no CLAUDE_CONFIG_DIR override
  builtIn: boolean;               // true only for 'default'
  isDefault: boolean;             // exactly one true across the list (FR-4)
  createdAt: number;              // epoch ms (0 for the built-in)
  authFailedAt?: number;          // epoch ms of the last credential failure (FR-22/FR-23)
}

// francois:account:list — no payload
export type AccountListResponse = Result<Account[]>;                 // errors: 'INTERNAL'

// francois:account:add — starts (or re-runs, FR-17) an interactive login
export interface AccountAddPayload {
  label?: string;                 // omit → email at login, else 'Account <n>'
  accountId?: AccountId;          // present ⇒ Re-login into an existing row (FR-17)
}
export interface AccountLoginStarted { loginId: string; cols: number; rows: number }
export type AccountAddResponse = Result<AccountLoginStarted>;
// errors: 'INVALID_INPUT' (login already in flight | blank label | unknown accountId),
//         'SPAWN_FAILED' (claude could not be spawned for the login PTY), 'PTY_ERROR', 'INTERNAL'

export interface AccountLoginWritePayload { loginId: string; data: string }   // raw bytes
export interface AccountLoginResizePayload { loginId: string; cols: number; rows: number }
export interface AccountLoginCancelPayload { loginId: string }
export type AccountLoginAck = Result<void>;   // errors: 'INVALID_INPUT', 'PTY_ERROR'

export interface AccountRenamePayload { accountId: AccountId; label: string }
export type AccountRenameResponse = Result<Account[]>;
// errors: 'ACCOUNT_NOT_FOUND', 'INVALID_INPUT' (blank label), 'INTERNAL'

export interface AccountSetDefaultPayload { accountId: AccountId }
export type AccountSetDefaultResponse = Result<Account[]>;   // errors: 'ACCOUNT_NOT_FOUND', 'INTERNAL'

export interface AccountRemovePayload { accountId: AccountId }
export interface AccountRemoveData {
  accounts: Account[];
  reassignedSessions: SessionId[];   // now on 'default' (FR-9)
}
export type AccountRemoveResponse = Result<AccountRemoveData>;
// errors: 'ACCOUNT_NOT_FOUND', 'ACCOUNT_NOT_REMOVABLE', 'INTERNAL'

// francois:account:event → francois://account/event
export type AccountEvent =
  | { type: 'account.list'; accounts: Account[] }
  | { type: 'account.login.data'; loginId: string; data: string }
  | { type: 'account.login.done'; loginId: string; account: Account }
  | { type: 'account.login.failed'; loginId: string; error: AppError };
```

**Amendments to existing contract files** (the lead authors these in the same pass):

- `contract/common.ts`
  - `ErrorCode` gains `'ACCOUNT_NOT_FOUND' | 'ACCOUNT_NOT_REMOVABLE' | 'ACCOUNT_DUPLICATE' |
    'ACCOUNT_LOGIN_FAILED' | 'ACCOUNT_NOT_AUTHENTICATED'`.
  - `SessionMeta` gains `accountId: AccountId` (**required** — persisted sessions without it load as
    `'default'`, FR-10).
  - `ProjectDefaults` gains `accountId?: AccountId`.
- `contract/sessions-sidebar.ts` — `NewSessionRequest` gains `accountId?: AccountId` (omit ⇒ the
  `isDefault` account).
- `contract/usage-bar.ts` — `app_get_usage` and `app_refresh_usage` take
  `{ accountId?: AccountId }`; `AppEvent`'s `usage.state` member gains `accountId: AccountId`.
  `UsageSnapshot` itself is unchanged.

## 6. Data & state

- **Core.** `AccountState { accounts: Vec<Account>, login: Option<LoginHandle> }` in its own
  `src-tauri/src/account/` module (`mod.rs` owns the model, children: `registry.rs` for
  `accounts.json` + ordering + default resolution, `login.rs` for the PTY + identity poll,
  `commands.rs`). `Session` gains `account_id: String`, persisted alongside `project_id`.
  `UsageState` becomes `HashMap<AccountId, UsageSnapshot>` + one in-flight flag per account.
  **Lock order:** `AccountState` is a LEAF like `UsageState` — nothing under `account/` ever takes
  `Engine.sessions`; FR-9's session repointing is driven from the command layer after the registry
  write returns.
- **Persistence.** `<app_data>/accounts.json` = `{ accounts: [...] }` for non-built-in rows only,
  plus the `defaultAccountId`. Config dirs live at `<app_data>/accounts/<accountId>/` and are owned
  entirely by the Claude Code CLI.
- **Frontend.** `accounts: Account[]` and `activeLogin` in the zustand store, hydrated by
  `account_list` at boot and kept current by `account.list` events. The account shown by the status
  bar/usage bar is derived from the selected session's `accountId`, never stored separately.
- **Not persisted.** Login PTY state, usage snapshots, `authFailedAt` (in-memory for the run).

## 7. Edge cases & errors

| Condition | Behavior |
|---|---|
| Login TUI never reaches an identity (timeout / PTY exit) | `ACCOUNT_LOGIN_FAILED` event, PTY killed, dir deleted, modal returns to the list with the error inline (FR-15) |
| Logged-in identity already registered | `ACCOUNT_DUPLICATE`, dir deleted; message explains the credential store may be shared on this platform (FR-14) |
| `Esc` / modal close during login | `account:loginCancel` — PTY killed, dir deleted (FR-16) |
| App quits during login | Same cleanup on exit; no orphan dir, no orphan PTY |
| No `~/.claude` on the machine | Nothing to mirror; the account dir stays bare and behaves as it did pre-FR-10a |
| A mirrored entry appears in `~/.claude` after the account was made | The next load backfills it (FR-10a) |
| An account dir was hand-deleted | The load-time backfill skips it rather than resurrecting it as a shell of links (FR-10a) |
| Second `account:add` while one is in flight | `INVALID_INPUT`, first login untouched (FR-16) |
| `configDir` deleted outside Francois | Row stays, marked unauthenticated; turns fail `ACCOUNT_NOT_AUTHENTICATED`; `Re-login` fixes it (FR-17/FR-22) |
| Credentials expire mid-turn | Turn errors as it does today; `authFailedAt` set, `account.list` emitted (FR-23) |
| `accountId` unknown at session create | `ACCOUNT_NOT_FOUND`, no session created (FR-18) |
| Persisted `accountId` no longer in registry | Silently loads as `'default'` (FR-10) |
| Account removed while its sessions run | Sessions keep running; they are repointed to `default` and their **next** turn spawns on `default` (FR-9) |
| Remove `default` | `ACCOUNT_NOT_REMOVABLE` |
| WSL session on an account whose dir is a UNC path | `INVALID_INPUT` at creation, naming the account (FR-25) |
| `accounts.json` missing/corrupt | Empty registry (built-in `default` only), overwritten on the next write (FR-1) |
| Usage probe fails for one account | Only that account's snapshot goes `status: 'error'`; others untouched (FR-27) |

## 8. Design brief

Accounts modal (Projects-modal chrome: centered panel, `--surface-raised`, 1px `--border` frame,
JetBrains Mono), rows = `label · email · meters · DEFAULT badge · actions`; an embedded login
terminal replaces the list while a login runs. New-session modal gains an `ACCOUNT` field after
`MODEL` (same select chrome as `MODEL`). Status bar gains an account chip; sidebar rows gain a
compact badge shown only for non-default accounts.

> full brief: `specs/design/multi-account.md`

## 9. Acceptance criteria

- [ ] A fresh install shows exactly one account, `Default`, and every session behaves as before (FR-2, FR-26)
- [ ] `[+ Add account]` runs the real `claude` login TUI in-app and registers the account with its email (FR-11..FR-13)
- [ ] Logging in twice with the same Anthropic account is refused with `ACCOUNT_DUPLICATE` (FR-14)
- [ ] Cancelling or timing out a login leaves no registry row and no directory on disk (FR-15, FR-16)
- [ ] A session created on account B runs its turns, its `/usage` probe, its remote-control PTY and its SHELL tab under B's config dir (FR-21)
- [ ] A `wsl`-runtime session on account B reaches B's config dir inside the distro via `WSLENV` (FR-24)
- [ ] A project default pre-fills the account in the new-session modal and is snapshotted at creation (FR-20)
- [x] Removing an account clears `defaults.accountId` on every project that named it, leaving each project's other defaults intact (amendment A1)
- [ ] Removing an account deletes its directory and moves its sessions to `Default`, with the confirm dialog naming them (FR-8, FR-9, FR-35)
- [ ] Deleting an account's config dir behind Francois' back makes its next turn fail `ACCOUNT_NOT_AUTHENTICATED`, and `Re-login` restores it (FR-17, FR-22)
- [ ] The usage bar shows the selected session's account's meters, and the Accounts modal shows each account's own (FR-27, FR-30)
- [ ] Sidebar badge and status-bar chip name the right account for each session (FR-32, FR-33)
- [ ] Restarting the app preserves accounts, the default flag, and every session's account (FR-1, FR-19)

## Remediation

### 2026-07-30 — preflight gate (pre-review, `/review` §0)

- 2026-07-30 — 2 findings, all fixed

### 2026-07-31 — review findings (`/review multi-account`, verdict BLOCK)

- 2026-07-31 — 10 findings (2 CRITICAL, 1 HIGH, 5 MEDIUM, 2 LOW), all fixed
  - Follow-up (not a finding): no unit test covers `session_compact`'s / `begin_turn`'s
    `ACCOUNT_NOT_AUTHENTICATED` guard — neither harness constructs a real `AppHandle`/`AccountState`
    (Tauri's `test` feature is not enabled here). Would need AppHandle test scaffolding.

### 2026-07-31 — review findings (`/review multi-account`, verdict REVISE, round 2)

- [x] CRITICAL · `PIPELINE.md` §Conventions "Domains" line · spec-violation · Spec §5 requires the
  `account` domain to be added to the Domains list, but it was never appended. → append `account` to
  the `Domains` bullet in `PIPELINE.md` §Conventions. — fixed: lead, appended `account` to the Domains
  line directly (not a surface path).
- [x] HIGH · `src-tauri/src/account/mod.rs:192-193,209-210,243` · quality · `config_dir_of`,
  `known_ids`, and `default_account_id` call `.lock().unwrap()` on `AccountState`, panicking on a
  poisoned mutex, unlike the rest of the module — replace with
  `let Ok(inner) = s.0.lock() else { return None/default };`. — fixed: all three now use the
  `let Ok(inner) = … else { return None/default }` form in `account/mod.rs`.
- [x] HIGH · `src-tauri/src/usage.rs:553` · spec-violation · `start_timers`'s initial boot probe only
  requests `default_account_id`, not `tick_targets(&app)`, so non-default-account sessions show an
  `empty` usage snapshot until the first 5-minute tick (violates FR-29) — call `request_probe` for
  every `tick_targets(&app)` id in the initial boot thread too. — fixed: the boot-probe thread in
  `usage.rs` `start_timers` now iterates `tick_targets(&app)`.
- [x] MEDIUM · `src-tauri/src/account/commands.rs:25-35` with `src-tauri/src/account/registry.rs:209`
  · quality · `apply_remove`'s `auth_failed_at` removal is not covered by `commit`'s
  rollback-on-persist-failure (`RegistrySnapshot` only restores `records`/`default_account_id`) — widen
  `RegistrySnapshot` to snapshot/restore `auth_failed_at` too. — fixed: `RegistrySnapshot` widened to
  `(Vec<AccountRecord>, String, HashMap<String, u64>)` and `commit`'s rollback restores `auth_failed_at`.
- [x] MEDIUM · `src/features/accounts/accounts.ts:330-338` (`loginErrorMessage`) · spec-violation ·
  FR-14 requires the duplicate-login message to state the credential store may be shared; the
  hard-coded copy discards the core's message and never says so — append the credential-store caveat
  to the ACCOUNT_DUPLICATE copy, or confirm with lead that the design brief supersedes FR-14 and amend
  the spec. — fixed: `ACCOUNT_DUPLICATE` copy in `accounts.ts` now carries the credential-store caveat;
  assertion updated in `accounts.test.ts`.
- [x] MEDIUM · `src/features/accounts/AccountsModal.tsx:109,120,131` · quality ·
  `accountRename(...)`, `accountSetDefault(...)` and `accountRemove(...)` chain `.then(...)` with no
  `.catch()`, unlike `AccountLoginView.tsx`'s `accountAdd(...).catch(...)` / the `safeCall` pattern —
  wrap all three the same way so IPC rejections surface via `setError` instead of becoming unhandled
  promise rejections. — fixed: `commitRename`/`setDefault`/`doRemove` all chain `.catch(onIpcRejected)`.
- [x] MEDIUM · `src/features/accounts/AccountLoginView.tsx:148-159` · quality · The
  `.acc-login-connecting` overlay has no `z-index` above `.acc-login-term` (`accounts.css:314-326`);
  xterm's opaque canvas covers the "connecting" message for the whole life of that state — give
  `.acc-login-connecting` a higher `z-index`, or only mount `AccountLoginTerminal` once `loginId` is
  non-null. — fixed: `AccountLoginTerminal` now mounts only once `loginId` is non-null (`pendingRef`
  still buffers early bytes).
- [ ] LOW · `src-tauri/src/account/commands.rs:919-963` · quality (TDD coverage) · Only pure-state
  helpers (`build_list`, `apply_remove`) and serialization are unit-tested; none of the
  `#[tauri::command]` handlers (`account_rename`, `account_set_default`, `account_remove`,
  `account_add`) are exercised end-to-end — add a fake-`AppHandle`/emit-capturing harness so the
  command layer gets coverage. — **still open, deferred:** every command in the crate is hard-typed to
  `AppHandle<Wry>` (`#[default_runtime(crate::Wry, wry)]`), and `persist`/`accounts_json_path` thread
  that same concrete handle; admitting `tauri::test::MockRuntime` means making the whole command layer
  (and `session::reassign_account_sessions`, `cancel_login_for_account`, …) generic over
  `tauri::Runtime` — a cross-cutting signature change beyond a LOW fix. Same root cause as the
  `begin_turn`/`session_compact` follow-up in the round above.
- [x] LOW · `src-tauri/src/account/commands.rs:711-779` · quality · `account_add` performs blocking
  filesystem I/O (`create_dir_all`) and a process spawn (`spawn_login`) while holding the
  `AccountState` mutex, blocking concurrent `account_list`/`account_rename`/`account_set_default`/
  `account_remove` — reserve the login slot under the lock, release it, do `create_dir_all`/
  `spawn_login`, then re-acquire only to store the resulting `LoginHandle`. — fixed: new
  `AccountInner.login_pending` reservation flag; lock released across `create_dir_all`/`spawn_login`
  and re-acquired via `clear_login_pending` / to install the `LoginHandle`.
- [x] LOW · `src/features/accounts/AccountChip.tsx:165-179` · quality · The `NEEDS LOGIN` alert state
  on the status-bar chip is conveyed by color only (`acc-chip--alert`) — add a small text/glyph cue
  (e.g. an exclamation mark) when `needsLogin` is true, not just the color class. — fixed:
  `.acc-chip-alert` `!` glyph rendered next to the label when `needsLogin`.

### 2026-07-31 — review findings (`/review multi-account`, verdict REVISE, round 3)

- 2026-07-31 — 4 findings (1 HIGH, 2 MEDIUM, 1 LOW), all fixed
  - `registry.rs` `label_of` no longer `unwrap()`s a poisoned `AccountState` lock;
    `account_add`'s `login_pending` reservation moved to an `AtomicBool` on `AccountState` so a
    poisoned re-lock still kills the PTY, removes a new config dir, and clears the reservation;
    `usage.rs` `resolve_usage_account` validates the id against `account::known_ids` and falls back
    to `default_account_id` for both the spawn *and* the emitted label; `login.rs`
    `write_login`/`resize_login` return the contract-documented `PTY_ERROR` on a poisoned mutex.
  - Follow-up (not a finding): `resolve_usage_account`'s fallback branch has no direct unit test —
    it needs a real `AppHandle`/managed state, the same Tauri-`test`-feature blocker as the still
    open round-2 LOW item above.

### 2026-07-31 — review findings (`/review multi-account`, verdict REVISE, round 4)

- 2026-07-31 — 3 findings (1 CRITICAL, 2 LOW), all fixed
  - `login.rs` `register()` now takes an `existing: bool` and returns `Option<Account>`, refusing to
    re-insert a row when a re-login's target account was removed mid-flight (closing the
    `account_add` reservation-window race that resurrected a just-removed account); `settle_success`
    routes the refusal into the existing `ACCOUNT_NOT_FOUND` arm, which kills the PTY, deletes the
    config dir and emits `account.login.failed`. Regression test
    `a_relogin_whose_target_row_was_removed_mid_flight_does_not_resurrect_it`.
  - Stale comments corrected in `StatusBar.tsx` and `useProjectDefaults.ts`: both now match
    `AccountChip`/`AccountField`'s actual unconditional rendering (including a single-account
    install's own Default row).

### 2026-07-31 — review findings (`/review multi-account`, verdict REVISE, round 5)

- 2026-07-31 — 4 findings (2 CRITICAL, 2 LOW), all fixed
  - `login.rs` no longer settles a Re-login on a **stale** pre-existing `.claude.json`: `spawn_login`
    snapshots the identity file's mtime (`registry::identity_mtime`) before the PTY spawns and
    threads it through `LoginThreads.baseline_mtime`; a new `fresh_identity()` gate — used by both
    `spawn_reader_thread`'s exit check and `spawn_identity_poller`'s loop — accepts an identity only
    when there was no file before (fresh login) or its mtime is strictly newer than the baseline.
    Closes the "Re-login reports success with still-invalid credentials → unbreakable
    `ACCOUNT_NOT_AUTHENTICATED` loop" defect. 5 new tests, incl. the stale-Re-login-dir regression.
  - `register()`'s tail `.expect("the row was just registered")` replaced with an explicit `match`
    returning `None`, consistent with the module's poisoned-lock-safe style.
  - Rename cancel is now race-proof against the delayed native `blur`: `AccountsModal` tracks a
    `renameHandledRef`, flipped synchronously by both the new `cancelRename` helper and
    `commitRename`; `commitRename` no-ops once tripped. The stale `onBlur={commitRename}` closure
    that the input's unmount fires after Escape can no longer persist the cancelled draft (and a
    legitimate Enter-commit's trailing blur is now idempotent too).
  - Status-bar chip truncation matches the design brief literally: new pure
    `statusChipMaxChars(windowWidth)` (8 below 900px, 18 at/above, unit-tested) driving
    `statusChipLabel` via a local `useWindowWidth()` hook in `AccountChip.tsx`; the CSS ellipsis
    rule stays as a pixel-width safety net underneath.
