// account.rs — the `account` domain (specs/multi-account.md).
//
// An account is a Claude Code config directory (`CLAUDE_CONFIG_DIR`): the
// built-in `default` account passes no override, every added account owns
// `<app_data>/accounts/<accountId>/` and is logged into once, in-app, through a
// real `claude` TUI shown in an embedded terminal (login.rs). The account
// chosen at session creation is stored on the session (`Session::account_id`,
// session/mod.rs) and applied to EVERY claude spawn that session makes — the
// turn spawn, the /usage-/cost side-probe, the create-time probe, the
// remote-control PTY and the SHELL tab (FR-21, applied via
// `session::spawn::account_env_vars`).
//
// `mod.rs` owns the shared data model (`Account`, `AccountState`/`AccountInner`,
// the event union) and the cross-cutting lookups every other domain calls
// into; children own one concern each:
//  * registry.rs — accounts.json persistence, ordering, default resolution,
//    the FR-6/7/8 mutation logic.
//  * login.rs — the in-app login PTY + `<configDir>/.claude.json` identity poll.
//  * mirror.rs — seeding an account's config dir from the global `~/.claude`,
//    so the override isolates credentials without also isolating the user's
//    commands, agents, skills and hooks.
//  * commands.rs — the francois:account:<verb> Tauri command surface.
//
// LOCK ORDER: `AccountState` is a LEAF like `usage::UsageState` — nothing here
// ever takes `session::Engine.sessions`. FR-9's session repointing (an account
// was removed) is driven from commands.rs AFTER the registry write returns,
// by calling into `session::reassign_account_sessions` with no account lock held.

/// The vendor CLIs the login routes are driven by (`claude`, `codex`, `grok`):
/// is one installed on this machine, and `npm i -g` it if not. A CHILD here
/// rather than a domain of its own — it is machine-scoped, not account-scoped,
/// but the only surface that asks is the Accounts modal.
mod cli_tools;
mod codex;
mod commands;
/// multi-provider-endpoint FR-1..FR-10: the `openai-compatible` account's
/// storage half — base-URL validation, the sidecar key file, and the
/// stateless connection probe. A CHILD of this module, not a sibling of
/// registry.rs's OAuth-focused FRs, even though both touch `AccountRecord` —
/// same "one concern per child" shape as `cloud` inside `session`.
mod endpoint;
/// multi-provider-grok FR-19..FR-22: `grok-cli` accounts — a per-account
/// `GROK_HOME` that `grok login` fills in. Structurally identical to codex.rs
/// (same trade, same file layout); a CHILD of its own rather than folded into
/// codex.rs so a third CLI does not turn that file into a two-vendor module.
mod grok;
mod login;
mod mirror;
mod registry;

pub(crate) use cli_tools::*;
pub(crate) use codex::*;
pub use commands::*;
pub(crate) use endpoint::*;
pub(crate) use grok::*;
pub use login::*;
pub(crate) use mirror::*;
pub use registry::*;

#[cfg(test)]
mod testutil;

use crate::ipc::{AppError, ErrorCode};
use portable_pty::{ChildKiller, MasterPty};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// The reserved, always-present, unremovable built-in account id (FR-2).
pub(crate) const DEFAULT_ACCOUNT_ID: &str = "default";

/// francois:account:event → `francois://account/event` (§5).
const EVENT_CHANNEL: &str = "francois://account/event";

// ---------- contract shapes (contract/multi-account.ts, mirrored) ----------

/// Mirrors `AccountKind` (contract/multi-account.ts). 'claude-code-oauth' is the
/// only kind an account can carry today — the interactive Claude Code login this
/// whole module drives; 'openai-compatible' is added by multi-provider-openai.
/// multi-provider-seam FR-12: a persisted record without a `kind` key loads as
/// `ClaudeCodeOauth`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum AccountKind {
    #[default]
    #[serde(rename = "claude-code-oauth")]
    ClaudeCodeOauth,
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    /// multi-provider-codex FR-2: an interactive `codex login` with its own
    /// `CODEX_HOME`. Structurally the same trade as `ClaudeCodeOauth` — a
    /// per-account config dir the vendor's own CLI fills in — differing only in
    /// which CLI and which env var (FR-18).
    #[serde(rename = "codex-cli")]
    CodexCli,
    /// multi-provider-grok FR-2: an interactive `grok login` with its own
    /// `GROK_HOME` — the same trade again, a third time (FR-19).
    #[serde(rename = "grok-cli")]
    GrokCli,
}

impl AccountKind {
    /// multi-provider-codex FR-18: the environment variable that points this
    /// kind's CLI at an account's own config dir. `None` for kinds whose
    /// credential is not a config dir at all (`OpenAiCompatible` keys off a
    /// sidecar key file instead).
    ///
    /// This exists so `account_env` stops hard-coding `CLAUDE_CONFIG_DIR`: the
    /// variable is a property OF THE KIND, and putting it here keeps the
    /// `match` exhaustive so a fourth kind cannot silently inherit Claude's.
    pub(crate) fn config_dir_env_var(self) -> Option<&'static str> {
        match self {
            AccountKind::ClaudeCodeOauth => Some("CLAUDE_CONFIG_DIR"),
            AccountKind::CodexCli => Some("CODEX_HOME"),
            // multi-provider-grok FR-19.
            AccountKind::GrokCli => Some("GROK_HOME"),
            AccountKind::OpenAiCompatible => None,
        }
    }
}

/// Mirrors `Account`. `configDir`/`builtIn`/`isDefault` distinguish the
/// synthesized built-in row (never persisted, FR-2) from an added one.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Account {
    id: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    organization: Option<String>,
    #[serde(rename = "configDir")]
    config_dir: Option<String>,
    #[serde(rename = "builtIn")]
    built_in: bool,
    #[serde(rename = "isDefault")]
    is_default: bool,
    #[serde(rename = "createdAt")]
    created_at: u64,
    #[serde(rename = "authFailedAt", skip_serializing_if = "Option::is_none")]
    auth_failed_at: Option<u64>,
    /// multi-provider-seam FR-12. Required on the wire — every account has a kind.
    kind: AccountKind,
    /// multi-provider-endpoint FR-1. Present iff `kind == OpenAiCompatible`.
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<AccountEndpoint>,
    /// multi-provider-codex FR-21a, widened by multi-provider-grok FR-22.
    /// Present iff `kind == CodexCli | GrokCli`, and **derived** on every list
    /// from `auth.json`'s existence (FR-20/FR-19) — the same shape and the same
    /// reasoning as `AccountEndpoint::has_key`.
    ///
    /// It exists because `authFailedAt` cannot answer this: that flag is only
    /// ever set BY a failed turn, so a freshly added Codex/Grok account would
    /// look healthy right up until the first message bounced.
    #[serde(rename = "signedIn", skip_serializing_if = "Option::is_none")]
    signed_in: Option<bool>,
}

/// Mirrors `EndpointConfig` (contract/multi-account.ts). Carries NO key
/// material — `has_key` is DERIVED from the key file's existence (FR-3), never
/// read off anything persisted.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AccountEndpoint {
    #[serde(rename = "baseUrl")]
    base_url: String,
    #[serde(rename = "hasKey")]
    has_key: bool,
    #[serde(rename = "modelIds", skip_serializing_if = "Option::is_none")]
    model_ids: Option<Vec<String>>,
}

/// francois:account:remove data (§5).
#[derive(Serialize)]
pub struct AccountRemoveData {
    accounts: Vec<Account>,
    #[serde(rename = "reassignedSessions")]
    reassigned_sessions: Vec<String>,
}

// francois:account:event → francois://account/event (§5).
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub(crate) enum AccountEvent {
    #[serde(rename = "account.list")]
    List { accounts: Vec<Account> },
    #[serde(rename = "account.login.data")]
    LoginData {
        #[serde(rename = "loginId")]
        login_id: String,
        data: String,
    },
    #[serde(rename = "account.login.done")]
    LoginDone {
        #[serde(rename = "loginId")]
        login_id: String,
        account: Account,
    },
    #[serde(rename = "account.login.failed")]
    LoginFailed {
        #[serde(rename = "loginId")]
        login_id: String,
        error: crate::ipc::AppError,
    },
    /// A chunk of `npm i -g <package>`'s merged output (cli_tools.rs).
    #[serde(rename = "cli.install.output")]
    CliInstallOutput { tool: String, data: String },
    /// Terminal for one install. `tools` is the re-probed status of ALL of them,
    /// so one channel keeps the whole CLI section honest — including the case
    /// where npm failed but the binary is nonetheless there.
    #[serde(rename = "cli.install.done")]
    CliInstallDone {
        tool: String,
        tools: Vec<CliToolStatus>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<crate::ipc::AppError>,
    },
}

pub(crate) fn emit(app: &AppHandle, ev: AccountEvent) {
    let _ = app.emit(EVENT_CHANNEL, ev);
}

// ---------- managed state (§6) ----------

/// One persisted account row (registry.rs owns the shape). `default` is NEVER
/// one of these — it is synthesized at every read (FR-2).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AccountRecord {
    id: String,
    label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    organization: Option<String>,
    #[serde(rename = "configDir")]
    config_dir: String,
    #[serde(rename = "createdAt", default)]
    created_at: u64,
    /// multi-provider-seam FR-12: absent on every pre-feature record, which
    /// loads as `ClaudeCodeOauth` via `AccountKind`'s `Default`.
    #[serde(default)]
    kind: AccountKind,
    /// multi-provider-endpoint FR-1: present iff `kind == OpenAiCompatible` —
    /// enforced on load by `registry::account_record_invariant_holds`, which
    /// drops any record that violates it rather than repairing it. The key
    /// itself is NEVER here (FR-2): only `base_url`/`model_ids` ride the JSON;
    /// the sidecar `<configDir>/endpoint-key` file is the key's only home.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    endpoint: Option<EndpointRecord>,
}

/// The persisted half of an `openai-compatible` account (multi-provider-endpoint
/// FR-1). `base_url` is already normalized (FR-4) by the time it lands here.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EndpointRecord {
    #[serde(rename = "baseUrl")]
    pub(crate) base_url: String,
    #[serde(rename = "modelIds", default, skip_serializing_if = "Option::is_none")]
    pub(crate) model_ids: Option<Vec<String>>,
}

/// The single in-flight login (FR-16). Lives in mod.rs because both login.rs
/// (which drives it) and commands.rs (which reserves the slot) touch its fields,
/// and a child module can read its ancestor's private fields.
pub struct LoginHandle {
    pub(crate) login_id: String,
    /// The row this login will register — a fresh uuid, or the id of the row a
    /// Re-login is refreshing (FR-17).
    pub(crate) account_id: String,
    /// The caller-supplied label, if any (FR-5).
    pub(crate) label: Option<String>,
    pub(crate) config_dir: String,
    /// true ⇔ FR-17 Re-login: the row already exists and is only refreshed.
    pub(crate) existing: bool,
    pub(crate) writer: Box<dyn Write + Send>,
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) killer: Box<dyn ChildKiller + Send + Sync>,
    /// Set the moment one of the four finishers claims the login, so the losers
    /// stop early rather than racing on a handle that is already gone.
    pub(crate) settled: Arc<AtomicBool>,
}

/// The second field is FR-16's `login_pending` reservation flag, kept OUTSIDE
/// the mutex on purpose: `account_add` reserves it while it does the blocking
/// directory creation + process spawn (see commands.rs), and must be able to
/// release the reservation even if the mutex is poisoned by the time it comes
/// back to register the finished handle — an `AtomicBool` never poisons.
/// `account_add` still only ever flips it while holding the mutex lock, so
/// the lock's mutual exclusion still makes the reserve-then-set atomic with
/// respect to a second concurrent `account_add`.
pub struct AccountState(Mutex<AccountInner>, AtomicBool);

pub struct AccountInner {
    records: Vec<AccountRecord>,
    /// "default" or a live record id — ALWAYS resolves (FR-4).
    default_account_id: String,
    /// FR-22/23: runtime-only, never persisted. Cleared on a successful (re-)login.
    auth_failed_at: HashMap<String, u64>,
    /// FR-3: the built-in account's identity, read best-effort at startup only.
    default_email: Option<String>,
    default_organization: Option<String>,
    /// FR-16: at most one login in flight, app-wide.
    login: Option<LoginHandle>,
}

impl Default for AccountState {
    fn default() -> Self {
        AccountState(
            Mutex::new(AccountInner {
                records: Vec::new(),
                default_account_id: DEFAULT_ACCOUNT_ID.to_string(),
                auth_failed_at: HashMap::new(),
                default_email: None,
                default_organization: None,
                login: None,
            }),
            AtomicBool::new(false),
        )
    }
}

// ---------- cross-domain lookups (called from session/shell/usage) ----------

/// FR-21: the `CLAUDE_CONFIG_DIR` a spawn on behalf of `account_id` should use —
/// `None` for the built-in default (no override) AND for an id the registry no
/// longer knows (defensive: every stored `account_id` is validated at creation
/// or pruned on load, so this arm should not be reachable in practice).
pub fn config_dir_of(app: &AppHandle, account_id: &str) -> Option<String> {
    if account_id == DEFAULT_ACCOUNT_ID {
        return None;
    }
    app.try_state::<AccountState>().and_then(|s| {
        let Ok(inner) = s.0.lock() else {
            return None;
        };
        inner
            .records
            .iter()
            .find(|r| r.id == account_id)
            .map(|r| r.config_dir.clone())
    })
}

/// multi-provider-codex FR-18: `config_dir_of`, but **only for accounts whose
/// config dir is a Claude one** — `None` for a `codex-cli` or
/// `openai-compatible` account.
///
/// Every spawn of `claude` on behalf of a session goes through a
/// `CLAUDE_CONFIG_DIR` derived from `config_dir_of`, which returns a directory
/// for ANY kind. Pointing `claude` at a Codex account's `CODEX_HOME` does not
/// fail quietly: `claude` INITIALIZES whatever directory it is given, so the
/// account came back carrying `.claude.json`, `projects/`, `sessions/` and
/// `session-env/` — observed in the dev build the first time a Codex account
/// was created.
///
/// `None` is the right answer rather than the Codex dir, because the caller's
/// question is specifically "which Claude config should this spawn use", and
/// for a non-Claude account there is none. `None` already means "no override"
/// at every call site (the built-in `default` account's answer).
pub fn claude_config_dir_of(app: &AppHandle, account_id: &str) -> Option<String> {
    if kind_of(app, account_id) != AccountKind::ClaudeCodeOauth {
        return None;
    }
    config_dir_of(app, account_id)
}

/// multi-provider-seam FR-13: the kind of an account, for deriving a new
/// session's `provider` at creation. The built-in `default` account and any
/// id the registry no longer knows are `ClaudeCodeOauth` (`AccountKind`'s
/// `Default`) — the same "falls back to default" path FR-13 names.
/// core-architecture-wave3 FR-11: the one question the session domain asks the
/// account domain every time it builds a `SessionMeta` — *what kind is this
/// account right now?* A trait rather than the free `kind_of` below for one
/// reason: the answer has to be suppliable without an `AppHandle`.
///
/// **Why not thread `AppHandle` itself**, as the spec's FR-11 text says. Tauri's
/// only test handle is `AppHandle<MockRuntime>`, and every signature in this
/// crate says `AppHandle` = `AppHandle<Wry>` — a different type. So a unit test
/// cannot construct one at all (`session/env.rs` has said as much since the
/// seam landed), and the ~15 tests that call `meta()` would have had to be
/// deleted rather than fixed. This trait is the same derivation with a seam a
/// test can stand on; `impl AccountKinds for AppHandle` is what the production
/// path uses, and it is one line, so the two cannot diverge.
/// core-architecture-wave3 FR-9: the last thing `account` needed from
/// `session`. Removing an account has a side-effect on sessions bound to it —
/// they are repointed at `default` (multi-account FR-9) — and `account_remove`
/// used to reach across and call `session::reassign_account_sessions` by name.
///
/// Inverted the same way `session::SessionTeardown` is: this domain declares
/// what has to happen and knows nothing about who does it, the domain that owns
/// the affected state implements it, and the crate root wires the two together
/// at startup. The return value is what `AccountRemoveData.reassignedSessions`
/// carries, so the wire payload is unchanged.
///
/// **No new lock edge**: observers are called with the account lock already
/// RELEASED (multi-account §6 LOCK ORDER), exactly as the direct call was, and
/// the observer list itself is a write-once `OnceLock` with no mutex at all.
pub trait AccountRemovalObserver: Send + Sync {
    fn account_removed(&self, app: &AppHandle, account_id: &str) -> Vec<String>;
}

static REMOVAL_OBSERVERS: std::sync::OnceLock<Vec<Box<dyn AccountRemovalObserver>>> =
    std::sync::OnceLock::new();

/// Called ONCE, from the crate root's `.setup()`. A second call is ignored —
/// see `session::register_teardown` for why that is not a panic.
pub fn register_removal_observers(observers: Vec<Box<dyn AccountRemovalObserver>>) {
    let _ = REMOVAL_OBSERVERS.set(observers);
}

/// Notify every registered observer that `account_id` is gone, and collect the
/// ids they repointed. Empty when nothing is registered, which is the case in
/// every unit test and is correct there: a test with no session registry has no
/// session to repoint.
pub fn notify_account_removed(app: &AppHandle, account_id: &str) -> Vec<String> {
    REMOVAL_OBSERVERS
        .get()
        .map(|observers| {
            observers
                .iter()
                .flat_map(|o| o.account_removed(app, account_id))
                .collect()
        })
        .unwrap_or_default()
}

pub trait AccountKinds {
    fn kind_of(&self, account_id: &str) -> AccountKind;
}

impl AccountKinds for AppHandle {
    fn kind_of(&self, account_id: &str) -> AccountKind {
        kind_of(self, account_id)
    }
}

pub fn kind_of(app: &AppHandle, account_id: &str) -> AccountKind {
    if account_id == DEFAULT_ACCOUNT_ID {
        return AccountKind::ClaudeCodeOauth;
    }
    app.try_state::<AccountState>()
        .and_then(|s| {
            let Ok(inner) = s.0.lock() else {
                return None;
            };
            inner
                .records
                .iter()
                .find(|r| r.id == account_id)
                .map(|r| r.kind)
        })
        .unwrap_or_default()
}

/// What an `openai-compatible` account needs to issue a request
/// (multi-provider-openai FR-2/FR-3/FR-18): the normalized base URL, the
/// `modelIds` override if the account carries one, and the config dir the key
/// sidecar lives in.
///
/// `None` for the built-in `default` account, for an unknown id, and for any
/// account whose kind is not `OpenAiCompatible` — FR-2's preflight turns each of
/// those into `INVALID_INPUT` before any I/O.
///
/// **The key is deliberately not returned.** It is read from
/// `<configDir>/endpoint-key` per request (`endpoint::read_key`, FR-3) and never
/// held in session state — the write-only boundary the 2026-08-12 `auth`
/// decision draws. Handing back a config dir keeps that read at the call site,
/// where it is one line and cannot be accidentally cloned into a struct that
/// outlives the request.
/// `pub(crate)` rather than `pub` like its two neighbours: it hands back
/// `EndpointRecord`, which is itself `pub(crate)`, and a `pub` fn leaking a
/// private type is a `private_interfaces` warning.
pub fn endpoint_of(app: &AppHandle, account_id: &str) -> Option<(EndpointRecord, String)> {
    if account_id == DEFAULT_ACCOUNT_ID {
        return None;
    }
    app.try_state::<AccountState>().and_then(|s| {
        let Ok(inner) = s.0.lock() else {
            return None;
        };
        let record = inner.records.iter().find(|r| r.id == account_id)?;
        if record.kind != AccountKind::OpenAiCompatible {
            return None;
        }
        // `account_record_invariant_holds` drops any OpenAiCompatible record
        // with no endpoint at load, so `None` here means the registry was
        // mutated out from under us — still not a panic.
        let endpoint = record.endpoint.clone()?;
        Some((endpoint, record.config_dir.clone()))
    })
}

/// FR-10: every account id a persisted `SessionMeta.accountId` may resolve
/// against — the built-in id plus every registered one.
pub fn known_ids(app: &AppHandle) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    set.insert(DEFAULT_ACCOUNT_ID.to_string());
    let registered: Vec<String> = app
        .try_state::<AccountState>()
        .and_then(|s| {
            let Ok(inner) = s.0.lock() else {
                return None;
            };
            Some(inner.records.iter().map(|r| r.id.clone()).collect())
        })
        .unwrap_or_default();
    set.extend(registered);
    set
}

/// FR-18: resolve `NewSessionRequest.accountId` — omitted/blank ⇒ the isDefault
/// account; an id the registry does not know ⇒ `ACCOUNT_NOT_FOUND`.
pub fn resolve_new_session_account(
    app: &AppHandle,
    requested: Option<&str>,
) -> Result<String, AppError> {
    let Some(state) = app.try_state::<AccountState>() else {
        return Ok(DEFAULT_ACCOUNT_ID.to_string());
    };
    let Ok(inner) = state.0.lock() else {
        return Err(AppError::new(
            ErrorCode::Internal,
            "account state is unavailable",
        ));
    };
    match requested.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(inner.default_account_id.clone()),
        Some(id) if exists(&inner, id) => Ok(id.to_string()),
        Some(_) => Err(AppError::new(ErrorCode::AccountNotFound, "no such account")),
    }
}

/// The current isDefault account id (usage-bar §5: `accountId` omitted ⇒ this).
pub fn default_account_id(app: &AppHandle) -> String {
    app.try_state::<AccountState>()
        .and_then(|s| {
            let Ok(inner) = s.0.lock() else {
                return None;
            };
            Some(inner.default_account_id.clone())
        })
        .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string())
}

/// FR-25: an account `configDir` a `wsl.exe` spawn can reach. Only a
/// drive-letter Windows path is (wsl.exe maps it to `/mnt/...` itself); a UNC
/// path (including a `\\wsl$\...`/`\\wsl.localhost\...` one) is not.
pub fn wsl_translatable_config_dir(path: &str) -> bool {
    !path.trim_start().starts_with("\\\\") && !path.trim_start().starts_with("//")
}

/// FR-22: does this account's config dir report an identity on disk?
pub fn identity_file_exists(config_dir: &str) -> bool {
    Path::new(config_dir).join(".claude.json").is_file()
}

/// multi-provider-codex FR-20: the same question for a `codex-cli` account —
/// signed in iff `codex login` has written an `auth.json` into its `CODEX_HOME`.
///
/// **Derived, never persisted**, exactly like `identity_file_exists`: an auth
/// flag stored in `accounts.json` would go stale the moment the user ran
/// `codex logout` in a terminal, and would then block turns on an account that
/// is actually fine (or, worse, wave through one that is not).
pub fn codex_auth_file_exists(config_dir: &str) -> bool {
    Path::new(config_dir).join("auth.json").is_file()
}

/// multi-provider-grok FR-19/FR-22: the same question for a `grok-cli`
/// account — signed in iff `grok login` has written an `auth.json` into its
/// `GROK_HOME`. Same filename, same derivation, same "never persisted"
/// reasoning as `codex_auth_file_exists` — xAI's own CLI docs list
/// `GROK_HOME/auth.json` as "Cached OAuth2/API credentials", the direct
/// analogue of Codex's file.
pub fn grok_auth_file_exists(config_dir: &str) -> bool {
    Path::new(config_dir).join("auth.json").is_file()
}

/// FR-22/23: flag an account's credential failure (in-memory only) and publish
/// the refreshed list — the Accounts modal then offers Re-login on that row.
pub fn mark_auth_failed(app: &AppHandle, account_id: &str) {
    let Some(state) = app.try_state::<AccountState>() else {
        return;
    };
    // A poisoned lock must not brick the account domain — best-effort: skip the
    // flag and the refreshed list rather than panicking.
    let Ok(mut inner) = state.0.lock() else {
        return;
    };
    inner
        .auth_failed_at
        .insert(account_id.to_string(), crate::ids::now_ms());
    let list = build_list(&inner);
    drop(inner);
    emit(app, AccountEvent::List { accounts: list });
}

/// FR-23 heuristic: does a turn's terminal error message read as a
/// credential/authentication failure (as opposed to any other turn error)?
/// Best-effort — the CLI does not carry a machine-readable auth-failure code
/// on this path, so this matches on the wording it is known to use.
pub fn is_credential_failure(message: &str) -> bool {
    let m = message.to_lowercase();
    [
        "unauthorized",
        "authentication_error",
        "authentication failed",
        "invalid api key",
        "invalid x-api-key",
        "not authenticated",
        "please run `claude`",
        "please log in",
    ]
    .iter()
    .any(|needle| m.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::*;
    use serde_json::json;

    #[test]
    fn every_account_event_member_serializes_to_the_contract_shape() {
        // §5: the tagged union on francois://account/event.
        let accounts = build_list(&inner_fixture(&["a1"], "default"));
        let list = serde_json::to_value(AccountEvent::List {
            accounts: accounts.clone(),
        })
        .unwrap();
        assert_eq!(list["type"], "account.list");
        assert_eq!(list["accounts"][0]["id"], "default");
        assert_eq!(list["accounts"][1]["id"], "a1");

        let data = serde_json::to_value(AccountEvent::LoginData {
            login_id: "l1".into(),
            data: "\u{1b}[2J".into(),
        })
        .unwrap();
        assert_eq!(
            data,
            json!({ "type": "account.login.data", "loginId": "l1", "data": "\u{1b}[2J" })
        );

        let done = serde_json::to_value(AccountEvent::LoginDone {
            login_id: "l1".into(),
            account: accounts[1].clone(),
        })
        .unwrap();
        assert_eq!(done["type"], "account.login.done");
        assert_eq!(done["loginId"], "l1");
        assert_eq!(done["account"]["id"], "a1");

        let failed = serde_json::to_value(AccountEvent::LoginFailed {
            login_id: "l1".into(),
            error: crate::ipc::AppError {
                code: ErrorCode::AccountDuplicate,
                message: "already registered".into(),
                detail: None,
            },
        })
        .unwrap();
        assert_eq!(
            failed,
            json!({ "type": "account.login.failed", "loginId": "l1",
                    "error": { "code": "ACCOUNT_DUPLICATE", "message": "already registered" } })
        );
    }

    #[test]
    fn wsl_translatable_config_dir_rejects_unc_and_accepts_drive_paths() {
        assert!(wsl_translatable_config_dir("D:\\francois\\accounts\\a1"));
        assert!(!wsl_translatable_config_dir(
            "\\\\wsl$\\Ubuntu\\home\\u\\.francois"
        ));
        assert!(!wsl_translatable_config_dir(
            "\\\\server\\share\\accounts\\a1"
        ));
        assert!(!wsl_translatable_config_dir("//server/share/accounts/a1"));
    }

    #[test]
    fn credential_failure_heuristic_matches_known_wording_only() {
        assert!(is_credential_failure(
            "Unauthorized: please run `claude` to log in"
        ));
        assert!(is_credential_failure(
            "Authentication failed for this account"
        ));
        assert!(!is_credential_failure(
            "network timeout while contacting the API"
        ));
        assert!(!is_credential_failure(
            "could not start claude: No such file or directory"
        ));
    }
}
