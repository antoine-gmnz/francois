//! session/adapter/pi/recovery.rs — pi-session-durability §4/§5: FR-3's
//! pre-resume validation, FR-4/FR-5's projection rebuild (native entry
//! ancestry + stable-block-id reconciliation), FR-8's version-transition
//! backup, and the `session_reconnect`/`session_new_from` orchestration those
//! Tauri commands (`session/commands/lifecycle.rs`) call into.
//!
//! Every DECISION is a pure function, unit-tested directly with no
//! `AppHandle` — same discipline `protocol.rs`/`normalize/mod.rs` follow.
//! Only the bottom "orchestration" section touches an `AppHandle` (spawning
//! the child, reading `sessions.json`'s app-data root, emitting events), and
//! is exercised the same way `dispatcher_tests.rs` exercises the wire layer:
//! a fake child over a loopback pipe, never a real `pi` binary.
//!
//! **Provisional**, same honest caveat every other Pi wire assumption in this
//! adapter carries (see `wire.rs`'s doc): no real capture of `get_entries`
//! exists yet. `NativeEntry`'s shape is this module's best-effort mirror of
//! the audited session-format doc ("versioned JSONL tree, stable entry/parent
//! IDs"), reconciled against a real capture once one exists.

use crate::ipc::{AppError, ErrorCode};
use crate::session::adapter::{
    AgentRuntime, RuntimeConnectContext, RuntimeLaunchPolicy, RuntimeModelRef,
    RuntimeProfileSnapshot, RuntimeSessionControl,
};
use crate::session::events::{RuntimeRecovery, RuntimeRecoveryState};
use crate::session::{
    emit, persist, BlockKind, BufBlock, Engine, ResponseMode, SessionEvent, SessionMeta,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use super::persistence::{self, PiResumeRecord};

// ---------------------------------------------------------------- FR-4: native entries

/// PROVISIONAL — one node of Pi's native entry tree (specs/research/
/// pi-integration-audit.md: "versioned JSONL tree, stable entry/parent IDs").
/// Only the fields the projection rebuild reads; anything else in a real
/// `get_entries` response is ignored, not rejected.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct NativeEntry {
    pub(crate) id: String,
    #[serde(rename = "parentId", default)]
    pub(crate) parent_id: Option<String>,
    /// "user" | "assistant" — anything else is dropped by `active_branch`'s
    /// caller rather than guessed at.
    pub(crate) role: String,
    #[serde(default)]
    pub(crate) text: String,
}

#[derive(Deserialize)]
struct GetEntriesData {
    #[serde(default)]
    entries: Vec<NativeEntry>,
    #[serde(rename = "leafId", default)]
    leaf_id: Option<String>,
}

/// FR-4: reconstruct the ACTIVE branch by walking `parentId` from `leaf_id`
/// back to the root, then return it in chronological (root → leaf) order.
/// An entry not on this ancestry — an abandoned branch, or one superseded by
/// compaction — is never returned, so it never renders as the current
/// conversation. A cycle (a corrupt parent chain) stops the walk rather than
/// looping forever; whatever was collected before the cycle is still shown,
/// per the edge case "corrupt parent chains fail with readable cached
/// history" (the CACHED history is the caller's fallback on an error from
/// THIS function's sibling, `validate_before_resume` — this function itself
/// never errors, it just cannot walk past a break).
pub(crate) fn active_branch(entries: &[NativeEntry], leaf_id: &str) -> Vec<NativeEntry> {
    let by_id: HashMap<&str, &NativeEntry> = entries.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut current = by_id.get(leaf_id).copied();
    while let Some(entry) = current {
        if !seen.insert(entry.id.as_str()) {
            break; // cycle guard — a corrupt parent chain must not loop forever
        }
        chain.push(entry.clone());
        current = entry
            .parent_id
            .as_deref()
            .and_then(|pid| by_id.get(pid).copied());
    }
    chain.reverse();
    chain
}

// ---------------------------------------------------------------- FR-5: block-id reconciliation

/// One ancestry entry, resolved to the stable François block id it should
/// render as.
pub(crate) struct RebuiltBlock {
    pub(crate) block_id: String,
    pub(crate) native_entry_id: String,
    pub(crate) role: String,
    pub(crate) text: String,
}

/// FR-5: "map native entry ID ... to stable François block IDs" + "reconcile
/// provisional live blocks with entries in ordered FIFO position, not text
/// deduplication".
///
/// `previous_by_native_id` covers every entry this projection has already
/// shown before — read back from the PERSISTED transcript's own
/// `nativeEntryId` tags, so an entry's block id survives every later rebuild
/// (this is what keeps a reopened transcript's React keys stable). Matched by
/// IDENTITY (the native id), never by comparing text — two entries with
/// byte-identical text but different ids stay two distinct rows.
///
/// `provisional_tail` is the ordered block ids of blocks the LIVE buffer
/// still held as unsettled (streaming, never persisted) at reconnect time —
/// a turn interrupted mid-stream while the François app kept running. Each
/// leftover entry the rebuild has never seen before consumes the OLDEST
/// still-unmatched provisional id, in order (FIFO): the first new entry
/// chronologically reconciles with the first still-open row, and so on.
/// Anything left over after that (a genuinely new entry the live buffer never
/// saw) mints a fresh id.
///
/// Returns the rebuilt blocks AND the set of `provisional_tail` ids that were
/// actually consumed — the caller (`unconfirmed_user_block`) uses the
/// complement (never consumed) to find a submitted message this rebuild
/// still cannot confirm at all (FR-7 / this feature's readiness gap on
/// "delivery-unknown").
pub(crate) fn reconcile_block_ids(
    ancestry: &[NativeEntry],
    previous_by_native_id: &HashMap<String, String>,
    provisional_tail: &[String],
) -> (Vec<RebuiltBlock>, std::collections::HashSet<String>) {
    let mut unmatched_provisional = provisional_tail.iter();
    let mut consumed = std::collections::HashSet::new();
    let rebuilt = ancestry
        .iter()
        .map(|entry| {
            let block_id = previous_by_native_id
                .get(&entry.id)
                .cloned()
                .or_else(|| {
                    let id = unmatched_provisional.next().cloned();
                    if let Some(id) = &id {
                        consumed.insert(id.clone());
                    }
                    id
                })
                .unwrap_or_else(crate::ids::uuid);
            RebuiltBlock {
                block_id,
                native_entry_id: entry.id.clone(),
                role: entry.role.clone(),
                text: entry.text.clone(),
            }
        })
        .collect();
    (rebuilt, consumed)
}

/// FR-7 (this feature's readiness gap, "FR-7 delivery-unknown" — lead's
/// decision): the SAME projection rebuild that reconciles provisional blocks
/// against fresh entries also reveals the opposite case — a `message.user`
/// block the live buffer showed but this rebuild's ancestry never confirms
/// AT ALL (`provisional_tail`'s id was never consumed by
/// `reconcile_block_ids`). Never auto-resent; the caller keeps its existing
/// block verbatim and appends exactly one `notice` (never a new IPC shape).
/// Only the LAST such candidate matters — an intent queue's own delivery
/// state (beyond this one warning) belongs to pi-turn-controls (Pi 08).
pub(crate) fn unconfirmed_user_block(
    previous_user_blocks: &[(String, String)], // (blockId, text), in buffer order
    consumed_provisional: &std::collections::HashSet<String>,
    provisional_tail: &[String],
) -> Option<(String, String)> {
    let unmatched: std::collections::HashSet<&str> = provisional_tail
        .iter()
        .map(String::as_str)
        .filter(|id| !consumed_provisional.contains(*id))
        .collect();
    previous_user_blocks
        .iter()
        .rev()
        .find(|(block_id, _)| unmatched.contains(block_id.as_str()))
        .cloned()
}

fn to_buf_block(rb: &RebuiltBlock) -> BufBlock {
    let kind = if rb.role == "user" {
        BlockKind::User
    } else {
        BlockKind::Assistant
    };
    BufBlock {
        text: rb.text.clone(),
        native_entry_id: Some(rb.native_entry_id.clone()),
        ..BufBlock::new(&rb.block_id, kind)
    }
}

// ---------------------------------------------------------------- FR-3: pre-resume validation

/// What `validate_before_resume` needs to know about the CURRENTLY pinned
/// account — resolved by the caller (which has the `AppHandle`), so the
/// decision itself stays pure and testable with no Tauri context at all.
pub(crate) struct AccountSnapshot {
    /// The account still exists and its kind is `Pi` — never falls back to
    /// the built-in `default` (Claude) account (edge case: "Deleted account
    /// never falls back to the default Claude/Pi account").
    pub(crate) is_pi: bool,
    pub(crate) config_dir: Option<String>,
}

/// PROVISIONAL, same caveat as `NativeEntry` — a best-effort identity check
/// against the FIRST line of Pi's own session file, which the audited
/// session-format doc implies opens with a header/meta entry. Reads only
/// that one line: cheap, and this is a validation gate, not a full parse.
fn native_identity_matches(path: &Path, expected_session_id: &str) -> bool {
    use std::io::BufRead as _;
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut first_line = String::new();
    if std::io::BufReader::new(file)
        .read_line(&mut first_line)
        .unwrap_or(0)
        == 0
    {
        return false;
    }
    let Ok(header) = serde_json::from_str::<serde_json::Value>(first_line.trim()) else {
        return false;
    };
    header.get("sessionId").and_then(|v| v.as_str()) == Some(expected_session_id)
}

/// FR-3: "canonicalize/validate the owned file location, exact identity,
/// pinned account and working directory. Missing/mismatched/corrupt files
/// fail resume." Order matters: account/cwd first (cheap, no filesystem
/// dependent on the untrusted record), then the file itself.
pub(crate) fn validate_before_resume(
    record: &PiResumeRecord,
    session_cwd: &str,
    account: &AccountSnapshot,
    native_root: &Path,
) -> Result<(), AppError> {
    if !account.is_pi || account.config_dir.as_deref() != Some(record.config_dir.as_str()) {
        return Err(AppError::new(
            ErrorCode::RuntimeAccountMissing,
            "the account pinned to this session's Pi conversation is no longer available",
        ));
    }
    if session_cwd != record.cwd {
        return Err(AppError::new(
            ErrorCode::RuntimeSessionCorrupt,
            "this session's working directory has moved since it last connected to Pi",
        ));
    }
    let file = Path::new(&record.native_session_file);
    if !file.is_file() {
        return Err(AppError::new(
            ErrorCode::RuntimeSessionMissing,
            "the recorded Pi conversation file no longer exists",
        ));
    }
    if !persistence::is_owned_path(native_root, file) {
        return Err(AppError::new(
            ErrorCode::RuntimeSessionCorrupt,
            "the recorded Pi conversation file is outside its owned location",
        ));
    }
    if !native_identity_matches(file, &record.native_session_id) {
        return Err(AppError::new(
            ErrorCode::RuntimeSessionCorrupt,
            "the recorded Pi conversation file does not match its recorded identity",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------- FR-8: version transition

fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let mut parts = s.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// FR-8: "Back up native files before the first load by a newly certified Pi
/// version ... Never downgrade a migrated file automatically." `Ok(true)` ⇒
/// take a backup before proceeding (a genuine version change); `Ok(false)` ⇒
/// unchanged; `Err` ⇒ refuse outright (a downgrade). Unparsable versions fail
/// OPEN (proceed with a backup) rather than refuse — same "no false negative"
/// philosophy `discovery.rs`'s own node-version gate documents, since this
/// build cannot tell a downgrade from a lateral rename without a real
/// version to compare.
pub(crate) fn version_transition(
    record_version: &str,
    installed_version: &str,
) -> Result<bool, AppError> {
    if record_version == installed_version {
        return Ok(false);
    }
    if let (Some(recorded), Some(installed)) = (
        parse_semver(record_version),
        parse_semver(installed_version),
    ) {
        if installed < recorded {
            return Err(AppError::new(
                ErrorCode::RuntimeIncompatible,
                format!(
                    "this Pi installation ({installed_version}) is older than the one that last wrote this session ({record_version}) — refusing to downgrade its conversation file automatically"
                ),
            ));
        }
    }
    Ok(true)
}

/// FR-8: the sibling backup path for a version transition — never overwrites
/// an existing backup for the SAME version (idempotent: a reconnect retried
/// after a partial failure must not clobber the one backup FR-8 asks for).
pub(crate) fn backup_path(native_file: &Path, from_version: &str) -> std::path::PathBuf {
    let file_name = native_file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("session");
    let safe_version: String = from_version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.')
        .collect();
    native_file.with_file_name(format!("{file_name}.v{safe_version}.bak"))
}

fn backup_native_file(native_file: &Path, from_version: &str) -> std::io::Result<()> {
    let backup = backup_path(native_file, from_version);
    if !backup.exists() {
        std::fs::copy(native_file, &backup)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- orchestration

/// Everything `run_reconnect` needs off the session, snapshotted under the
/// engine lock and released before any I/O (same discipline `TurnContext`
/// documents).
struct ReconnectSnapshot {
    account_id: String,
    cwd: String,
    runtime: String,
    worktree_distro: Option<String>,
    /// pi-session-durability (quality remediation): checked BEFORE the
    /// `SESSION_BUSY` guard even claims `recovery_busy` — a non-Pi session
    /// has no native Pi conversation to reconnect to at all, and must answer
    /// `RUNTIME_UNSUPPORTED`, never a Pi-specific "missing"/"corrupt" code
    /// that would misreport a healthy Claude session as lost.
    agent_runtime: AgentRuntime,
    permission_mode: String,
    allow_git: bool,
    system_prompt: Option<String>,
    extra_args: Vec<String>,
    model: Option<RuntimeModelRef>,
    /// pi-migration-rollout FR-3: the session's OWN creation-time snapshot,
    /// carried through unchanged so a reconnect relaunches with the SAME
    /// profile settings a later profile/project-default edit never touches.
    pi_profile_settings: Option<crate::profiles::PiProfileSettings>,
    /// pi-migration-rollout FR-3 (read-once fix): the session's OWN resolved
    /// launch prompt. `None` alongside `Some` settings means a pre-fix
    /// record — `effective_launch_prompt` resolves it lazily, once.
    pi_launch_prompt: Option<super::profile_args::PiLaunchPrompt>,
    /// pi-skills-capabilities: the session's OWN pinned policy, carried
    /// verbatim into the reconnect's `RuntimeConnectContext` — a reconnect
    /// never resets the acknowledgment (unlike `NewFromSnapshot`, which
    /// starts a genuinely NEW session).
    resource_policy: Option<crate::session::adapter::pi::RuntimeResourcePolicy>,
    pi_resume: Option<PiResumeRecord>,
    previous_by_native_id: HashMap<String, String>,
    /// Every `User`/`Assistant` block the CURRENT buffer holds with no
    /// `native_entry_id` yet — a live-produced block a rebuild has never
    /// reconciled, whether it is still mid-stream or was already "settled"
    /// locally before the connection was lost. FIFO-reconciled first
    /// (`reconcile_block_ids`); whatever is left unmatched is what
    /// `unconfirmed_user_block` checks (FR-7).
    provisional_tail: Vec<String>,
    /// Every `User` block's `(blockId, text)`, in buffer order — read back by
    /// `unconfirmed_user_block` to keep a still-unconfirmed message's
    /// ORIGINAL text/id verbatim rather than reconstructing it.
    previous_user_blocks: Vec<(String, String)>,
    busy: bool,
}

fn load_reconnect_snapshot(engine: &Engine, session_id: &str) -> Option<ReconnectSnapshot> {
    engine.with_session(session_id, |s| {
        let mut previous_by_native_id = HashMap::new();
        let mut provisional_tail = Vec::new();
        let mut previous_user_blocks = Vec::new();
        for b in &s.block_buffer {
            match (&b.native_entry_id, b.kind) {
                (Some(native_id), _) => {
                    previous_by_native_id.insert(native_id.clone(), b.block_id.clone());
                }
                (None, BlockKind::User | BlockKind::Assistant) => {
                    provisional_tail.push(b.block_id.clone());
                }
                _ => {}
            }
            if b.kind == BlockKind::User {
                previous_user_blocks.push((b.block_id.clone(), b.text.clone()));
            }
        }
        ReconnectSnapshot {
            account_id: s.account_id.clone(),
            cwd: s.cwd.clone(),
            runtime: s.runtime.clone(),
            worktree_distro: s.worktree_distro.clone(),
            agent_runtime: s.agent_runtime,
            permission_mode: s.permission_mode.clone(),
            allow_git: s.allow_git,
            system_prompt: s.system_prompt.clone(),
            extra_args: s.extra_args.clone(),
            model: s.runtime_model.clone(),
            pi_profile_settings: s.pi_profile_settings.clone(),
            pi_launch_prompt: s.pi_launch_prompt.clone(),
            resource_policy: s.resource_policy,
            pi_resume: s.pi_resume.clone(),
            previous_by_native_id,
            provisional_tail,
            previous_user_blocks,
            busy: crate::session::status::is_busy(&s.status) || s.recovery_busy,
        }
    })
}

fn account_snapshot(app: &AppHandle, account_id: &str) -> AccountSnapshot {
    AccountSnapshot {
        is_pi: crate::account::kind_of(app, account_id) == crate::account::AccountKind::Pi,
        config_dir: crate::account::config_dir_of(app, account_id),
    }
}

/// Claim the `SESSION_BUSY` guard — `true` iff this call won it (and so owns
/// clearing it when done).
fn claim_recovery(engine: &Engine, session_id: &str) -> bool {
    engine
        .with_session_mut(session_id, |s| {
            if s.recovery_busy {
                false
            } else {
                s.recovery_busy = true;
                true
            }
        })
        .unwrap_or(false)
}

fn release_recovery(engine: &Engine, session_id: &str) {
    engine.with_session_mut(session_id, |s| s.recovery_busy = false);
}

/// pi-migration-rollout FR-3 (read-once fix): the pure decision behind
/// `effective_launch_prompt` below — an already-resolved snapshot is
/// returned VERBATIM, never re-derived from `settings`; only a genuinely
/// unresolved one (`existing: None`, a pre-fix record) is resolved now.
/// Split out so this rule has a test with no `AppHandle` at all.
fn resolve_or_reuse_launch_prompt(
    settings: &crate::profiles::PiProfileSettings,
    existing: Option<&super::profile_args::PiLaunchPrompt>,
) -> Result<super::profile_args::PiLaunchPrompt, crate::profiles::ProfileError> {
    match existing {
        Some(existing) => Ok(existing.clone()),
        None => super::profile_args::resolve_launch_prompt(settings),
    }
}

/// pi-migration-rollout FR-3 (read-once fix, backward compatibility): a
/// pre-fix record has no resolved prompt yet — resolve it lazily, exactly
/// once, and persist the result immediately so every LATER reconnect finds
/// `existing` already `Some`.
fn effective_launch_prompt(
    app: &AppHandle,
    engine: &Engine,
    session_id: &str,
    settings: &crate::profiles::PiProfileSettings,
    existing: Option<&super::profile_args::PiLaunchPrompt>,
) -> Result<super::profile_args::PiLaunchPrompt, AppError> {
    let was_unresolved = existing.is_none();
    let resolved = resolve_or_reuse_launch_prompt(settings, existing)?;
    if was_unresolved {
        engine.with_session_mut(session_id, |s| {
            s.pi_launch_prompt = Some(resolved.clone());
        });
        persist(app, engine);
    }
    Ok(resolved)
}

/// FR-3/FR-7: the ONE cause a failed reconnect settles the session's
/// `recovery` on, so the banner and the rejected promise never disagree
/// (contract doc). Every other error (`SESSION_BUSY`, `RUNTIME_TIMEOUT`,
/// `RUNTIME_PROTOCOL_ERROR`, `RUNTIME_UNAVAILABLE`, `INTERNAL`) is transient
/// or not a validation verdict at all — `recovery` is left as `disconnected`
/// for those, matching the design brief ("Disconnected: readable history,
/// reconnect on send").
fn recovery_state_for(code: ErrorCode) -> Option<RuntimeRecoveryState> {
    match code {
        ErrorCode::RuntimeSessionMissing => Some(RuntimeRecoveryState::Missing),
        ErrorCode::RuntimeSessionCorrupt => Some(RuntimeRecoveryState::Corrupt),
        ErrorCode::RuntimeIncompatible => Some(RuntimeRecoveryState::Incompatible),
        ErrorCode::RuntimeAccountMissing => Some(RuntimeRecoveryState::AccountMissing),
        _ => None,
    }
}

/// pi-provider-auth FR-4's execution gate, then this feature's own FR-3
/// pre-resume validation — IN THAT ORDER, and pure (no `AppHandle`) so the
/// order itself has a test with no Tauri context at all. `gate` is the
/// caller's already-resolved outcome of
/// `crate::account::pi_execution_preflight_for` (run under the account lock
/// only that accessor can reach); an untrusted/drifted account's error
/// propagates VERBATIM here — FR-3's file/identity/cwd checks below never
/// run, so a record that would ALSO fail one of THOSE still reports the
/// gate's own code, never FR-3's, and no connect is ever attempted.
pub(crate) fn gate_then_validate(
    gate: Result<(String, String, Option<String>, bool), AppError>,
    record: &PiResumeRecord,
    session_cwd: &str,
    native_root: &Path,
) -> Result<(String, String, Option<String>, bool), AppError> {
    let (config_dir, runtime, distro, inherit) = gate?;
    let account = AccountSnapshot {
        is_pi: true,
        config_dir: Some(config_dir.clone()),
    };
    validate_before_resume(record, session_cwd, &account, native_root)?;
    Ok((config_dir, runtime, distro, inherit))
}

/// FR-3/FR-7: `session_reconnect` — explicit, read-only re-attachment to the
/// session's RECORDED native conversation. Dispatches only `get_state`
/// (inside `super::connect`) and `get_entries` — never a `prompt`, so no
/// model call and no user message is ever issued here.
pub(crate) fn reconnect_session(
    app: &AppHandle,
    session_id: &str,
) -> Result<SessionMeta, AppError> {
    let engine = app.state::<Engine>();
    let Some(snapshot) = load_reconnect_snapshot(&engine, session_id) else {
        return Err(AppError::new(ErrorCode::SessionNotFound, "no such session"));
    };
    if snapshot.agent_runtime != AgentRuntime::Pi {
        return Err(AppError::new(
            ErrorCode::RuntimeUnsupported,
            "this session's runtime does not support reconnect",
        ));
    }
    if snapshot.busy {
        return Err(AppError::new(
            ErrorCode::SessionBusy,
            "a turn or another recovery is already in flight for this session",
        ));
    }
    if !claim_recovery(&engine, session_id) {
        return Err(AppError::new(
            ErrorCode::SessionBusy,
            "a turn or another recovery is already in flight for this session",
        ));
    }
    let result = run_reconnect(app, &engine, session_id, &snapshot);
    release_recovery(&engine, session_id);
    match &result {
        Ok(meta) => emit(app, SessionEvent::Meta { meta: meta.clone() }),
        Err(e) => {
            if let Some(state) = recovery_state_for(e.code) {
                let meta = engine.with_session_mut(session_id, |s| {
                    s.recovery = RuntimeRecovery::failed(state, e.message.clone());
                    s.meta(app)
                });
                if let Some(meta) = meta {
                    emit(app, SessionEvent::Meta { meta });
                }
            }
        }
    }
    result
}

fn run_reconnect(
    app: &AppHandle,
    engine: &Engine,
    session_id: &str,
    snapshot: &ReconnectSnapshot,
) -> Result<SessionMeta, AppError> {
    let Some(record) = &snapshot.pi_resume else {
        return Err(AppError::new(
            ErrorCode::RuntimeSessionMissing,
            "this session has no recorded Pi conversation to reconnect to",
        ));
    };
    let native_root = persistence::native_session_dir(app, session_id).ok_or_else(|| {
        AppError::new(
            ErrorCode::Internal,
            "could not resolve this session's native data directory",
        )
    })?;
    // pi-provider-auth FR-4's execution gate, before FR-3's own validation —
    // an untrusted or drifted account refuses right here, executes nothing,
    // and leaves `recovery` untouched (the caller only writes `recovery` on
    // ITS OWN error-handling path, after this function returns).
    let gate = crate::account::pi_execution_preflight_for(
        app,
        &snapshot.account_id,
        "reconnecting this session",
    );
    let (config_dir, _pinned_runtime, _pinned_distro, inherit) =
        gate_then_validate(gate, record, &snapshot.cwd, &native_root)?;

    let installed = super::discovery::probe_installation(
        &snapshot.runtime,
        snapshot.worktree_distro.as_deref(),
        false,
    )?;
    let installed_version = installed.detected_version.clone().unwrap_or_default();
    if version_transition(&record.pi_version, &installed_version)? {
        let _ = backup_native_file(Path::new(&record.native_session_file), &record.pi_version);
    }

    let model = snapshot.model.clone().ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeSessionCorrupt,
            "this session has a recorded Pi conversation but no recorded model identity",
        )
    })?;
    // pi-migration-rollout FR-3 (read-once fix): resolve lazily, once, only
    // for a pre-fix record — see `effective_launch_prompt`.
    let pi_launch_prompt = match &snapshot.pi_profile_settings {
        Some(settings) => Some(effective_launch_prompt(
            app,
            engine,
            session_id,
            settings,
            snapshot.pi_launch_prompt.as_ref(),
        )?),
        None => None,
    };
    let ctx = RuntimeConnectContext {
        session_id: session_id.to_string(),
        cwd: snapshot.cwd.clone(),
        runtime: snapshot.runtime.clone(),
        worktree_distro: snapshot.worktree_distro.clone(),
        account_id: snapshot.account_id.clone(),
        launch_policy: RuntimeLaunchPolicy {
            permission_mode: snapshot.permission_mode.clone(),
            allow_git: snapshot.allow_git,
        },
        profile_snapshot: RuntimeProfileSnapshot {
            system_prompt: snapshot.system_prompt.clone(),
            extra_args: snapshot.extra_args.clone(),
        },
        model: model.clone(),
        resume: Some(record.native_session_id.clone()),
        config_dir: Some(config_dir),
        inherit_environment_credentials: inherit,
        pi_profile_settings: snapshot.pi_profile_settings.clone(),
        pi_launch_prompt,
        // pi-skills-capabilities: the session's OWN pinned policy, carried
        // through unchanged — a reconnect never resets the acknowledgment.
        resource_policy: snapshot.resource_policy,
    }
    .validate()?;

    let conn = super::connect(app, ctx)?;
    // FR-3: a resumed handshake reporting a DIFFERENT native file than the
    // one it was just told to resume is corruption, not a value to trust —
    // best-effort (a response that omits `sessionFile` skips the check,
    // same "provisional, no real capture" caveat every other Pi wire
    // assumption in this adapter carries).
    if let Some(reported) = conn.handshake_info().session_file {
        if reported != record.native_session_file {
            let _ = conn.shutdown();
            return Err(AppError::new(
                ErrorCode::RuntimeSessionCorrupt,
                "Pi reported a different conversation file than the one this session resumed",
            ));
        }
    }
    // FR-4/FR-6: always a FULL fetch, never the recorded cursor — this
    // feature does no incremental sync, and the cursor's paging semantics
    // (does Pi return entries AFTER it, or a page STARTING at it) are
    // unconfirmed without a real capture. `active_branch` needs the WHOLE
    // ancestry to walk `parentId` back to the root, so guessing wrong here
    // would silently truncate history rather than fail loudly. KNOWN GAP
    // (this feature's handoff): a session too large for one `get_entries`
    // response has no pagination or bounded-streaming-native-file fallback
    // yet — it fails with whatever `RUNTIME_PROTOCOL_ERROR`/transport error
    // the oversized response itself raises.
    let entries = match conn.get_entries(None) {
        Ok(resp) => resp,
        Err(e) => {
            let _ = conn.shutdown();
            return Err(e);
        }
    };
    let data: GetEntriesData = match entries
        .data
        .ok_or(())
        .and_then(|v| serde_json::from_value(v).map_err(|_| ()))
    {
        Ok(d) => d,
        Err(()) => {
            let _ = conn.shutdown();
            return Err(AppError::new(
                ErrorCode::RuntimeProtocolError,
                "get_entries returned a malformed payload",
            ));
        }
    };
    let ancestry = match &data.leaf_id {
        Some(leaf) => active_branch(&data.entries, leaf),
        None => Vec::new(),
    };
    let (rebuilt, consumed_provisional) = reconcile_block_ids(
        &ancestry,
        &snapshot.previous_by_native_id,
        &snapshot.provisional_tail,
    );
    let mut blocks: Vec<BufBlock> = rebuilt.iter().map(to_buf_block).collect();
    // FR-7 (readiness gap "FR-7 delivery-unknown"): a submitted message this
    // rebuild still cannot confirm is kept verbatim, never re-sent, with one
    // warning notice — never silently dropped.
    if let Some((block_id, text)) = unconfirmed_user_block(
        &snapshot.previous_user_blocks,
        &consumed_provisional,
        &snapshot.provisional_tail,
    ) {
        blocks.push(BufBlock {
            text,
            ..BufBlock::new(&block_id, BlockKind::User)
        });
        blocks.push(BufBlock {
            text: "Delivery of the last message is unknown — it was not re-sent.".into(),
            tone: Some("warning".into()),
            ..BufBlock::new(&crate::ids::uuid(), BlockKind::Notice)
        });
    }

    if let Err(e) = crate::session::persistence::replace_transcript(app, session_id, &blocks) {
        let _ = conn.shutdown();
        return Err(AppError::new(
            ErrorCode::Internal,
            format!("could not save the rebuilt transcript: {e}"),
        ));
    }
    // FR-6: the FULL rebuilt list is on disk already (`replace_transcript`,
    // above) — this only bounds what stays in memory, same cap/eviction
    // logic every other runtime's own live append uses.
    let truncated =
        crate::session::trim_transcript(&mut blocks, crate::session::TRANSCRIPT_BUFFER_CAP);

    let updated_record = PiResumeRecord {
        last_entry_id: ancestry.last().map(|e| e.id.clone()),
        leaf_id: data.leaf_id.clone(),
        pi_version: installed_version,
        ..record.clone()
    };

    let capabilities = conn.capabilities();
    // pi-models-metrics (lead clarification): the SAME `get_state` handshake
    // already read the current model/effort/available-levels — captured here,
    // before `conn` moves below, so the FIRST `session.meta` after connecting
    // carries `model.efforts`/`effort` without a second round trip.
    let handshake_model = conn.handshake_info().model;
    engine.install_runtime_connection(
        app,
        session_id.to_string(),
        conn as Arc<dyn RuntimeSessionControl>,
        model,
        capabilities,
    )?;

    let now = crate::ids::now_ms();
    let meta = engine
        .with_session_mut(session_id, |s| {
            s.block_buffer = blocks;
            // transcript-scale FR-6: monotonic — a rebuild that happens to
            // fit entirely in memory this time must not un-truncate a
            // session whose history was already known to run past the cap.
            s.transcript_truncated = s.transcript_truncated || truncated;
            s.pi_resume = Some(updated_record);
            s.recovery = RuntimeRecovery::ready(now);
            if let Some((_, effort, efforts)) = &handshake_model {
                s.effort = effort.clone();
                s.model_efforts = efforts.clone();
            }
            s.meta(app)
        })
        .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))?;
    persist(app, engine);
    Ok(meta)
}

/// Everything `new_from_session` copies off the SOURCE session — snapshotted
/// under the engine lock, same discipline as `ReconnectSnapshot`.
struct NewFromSnapshot {
    name: String,
    cwd: String,
    model_id: String,
    model_label: String,
    effort: Option<String>,
    permission_mode: String,
    runtime: String,
    allow_git: bool,
    project_id: Option<String>,
    account_id: String,
    system_prompt: Option<String>,
    extra_args: Vec<String>,
    profile: Option<crate::profiles::SessionProfileRef>,
    /// pi-migration-rollout FR-3: carried over verbatim — "Create new
    /// session" copies validated profile/model settings, this included.
    pi_profile_settings: Option<crate::profiles::PiProfileSettings>,
    /// pi-migration-rollout FR-3 (read-once fix): the source's OWN resolved
    /// snapshot, copied VERBATIM — never re-read. `None` only if the source
    /// itself has never resolved one yet (an un-reconnected pre-fix record).
    pi_launch_prompt: Option<super::profile_args::PiLaunchPrompt>,
    response_mode: ResponseMode,
    /// pi-skills-capabilities: the source session's pinned launch policy —
    /// `build_new_from` copies `projectResources`/`extensions` but resets
    /// `acknowledgedUnrestrictedTools` (a session created unacknowledged
    /// needs its own acknowledgment; a profile/source can never fabricate
    /// it).
    resource_policy: Option<crate::session::adapter::pi::RuntimeResourcePolicy>,
    /// pi-session-durability (quality remediation): same early
    /// `RUNTIME_UNSUPPORTED` guard `ReconnectSnapshot` carries — see its doc.
    agent_runtime: AgentRuntime,
    busy: bool,
}

fn load_new_from_snapshot(engine: &Engine, session_id: &str) -> Option<NewFromSnapshot> {
    engine.with_session(session_id, |s| NewFromSnapshot {
        name: s.name.clone(),
        cwd: s.cwd.clone(),
        model_id: s.model_id.clone(),
        model_label: s.model_label.clone(),
        effort: s.effort.clone(),
        permission_mode: s.permission_mode.clone(),
        runtime: s.runtime.clone(),
        allow_git: s.allow_git,
        project_id: s.project_id.clone(),
        account_id: s.account_id.clone(),
        system_prompt: s.system_prompt.clone(),
        extra_args: s.extra_args.clone(),
        profile: s.profile.clone(),
        pi_profile_settings: s.pi_profile_settings.clone(),
        pi_launch_prompt: s.pi_launch_prompt.clone(),
        response_mode: s.response_mode,
        resource_policy: s.resource_policy,
        agent_runtime: s.agent_runtime,
        busy: crate::session::status::is_busy(&s.status) || s.recovery_busy,
    })
}

/// session-rename FR-1's cap, doubled for the " (copy)" suffix's own room —
/// `validate_session_name` re-checks the 80-char cap regardless, so a name
/// this derives can never exceed it either.
fn derive_new_from_name(source_name: &str) -> String {
    let candidate = format!("{source_name} (copy)");
    if candidate.chars().count() <= 80 {
        candidate
    } else {
        source_name.chars().take(80).collect()
    }
}

/// "Create new session" from a session whose native conversation cannot be
/// resumed. Copies ONLY validated cwd/project/account/profile/model settings
/// into a NEW session id — no messages, no native resume anchor (so no
/// `worktree` provenance either: the new session is not itself attached to
/// whatever worktree the source's `cwd` happened to be, see this feature's
/// handoff). Never spawns a Pi child and never sends a prompt — this is a
/// pure metadata copy, which is what makes it safe to offer even when Pi
/// itself is unreachable.
pub(crate) fn new_from_session(
    app: &AppHandle,
    source_id: &str,
    name: Option<String>,
) -> Result<SessionMeta, AppError> {
    let name = match name {
        Some(raw) => Some(crate::session::validate_session_name(&raw)?),
        None => None,
    };
    let engine = app.state::<Engine>();
    let Some(source) = load_new_from_snapshot(&engine, source_id) else {
        return Err(AppError::new(ErrorCode::SessionNotFound, "no such session"));
    };
    if source.agent_runtime != AgentRuntime::Pi {
        return Err(AppError::new(
            ErrorCode::RuntimeUnsupported,
            "this session's runtime does not support this action",
        ));
    }
    if source.busy {
        return Err(AppError::new(
            ErrorCode::SessionBusy,
            "this session has a recovery already in flight",
        ));
    }
    if !claim_recovery(&engine, source_id) {
        return Err(AppError::new(
            ErrorCode::SessionBusy,
            "this session has a recovery already in flight",
        ));
    }
    let outcome = build_new_from(app, &engine, &source, name);
    release_recovery(&engine, source_id);
    if let Ok(meta) = &outcome {
        emit(app, SessionEvent::Meta { meta: meta.clone() });
    }
    outcome
}

fn build_new_from(
    app: &AppHandle,
    engine: &Engine,
    source: &NewFromSnapshot,
    name: Option<String>,
) -> Result<SessionMeta, AppError> {
    let account = account_snapshot(app, &source.account_id);
    if !account.is_pi {
        return Err(AppError::new(
            ErrorCode::RuntimeAccountMissing,
            "the pinned account for this session is no longer a Pi account",
        ));
    }
    let now = crate::ids::now_ms();
    let id = crate::ids::uuid();
    let name = name.unwrap_or_else(|| derive_new_from_name(&source.name));
    let (agent_runtime, protocol) =
        AgentRuntime::from_account_kind(crate::account::kind_of(app, &source.account_id));
    let session = crate::session::Session::new(
        id.clone(),
        name,
        source.cwd.clone(),
        source.model_id.clone(),
        source.model_label.clone(),
        0,
        crate::session::resolve_model_display(app, &source.account_id, &source.model_id).1,
        now,
        now,
        source.effort.clone(),
        source.permission_mode.clone(),
        source.runtime.clone(),
        source.allow_git,
        source.project_id.clone(),
        None, // no worktree provenance — see this fn's own doc comment
        None,
        source.account_id.clone(),
        agent_runtime,
        protocol,
        None, // no native resume anchor
        Vec::new(),
        source.system_prompt.clone(),
        source.extra_args.clone(),
        source.profile.clone(),
        source.response_mode,
        source.pi_profile_settings.clone(),
        // pi-migration-rollout FR-3 (read-once fix): copied verbatim, never
        // re-resolved — see this fn's own doc comment.
        source.pi_launch_prompt.clone(),
        // pi-skills-capabilities: copy the project-resources/extensions
        // choice, but never the acknowledgment — the new session needs its
        // own (`session_acknowledge_policy`).
        source
            .resource_policy
            .map(|p| crate::session::adapter::pi::RuntimeResourcePolicy {
                acknowledged_unrestricted_tools: false,
                ..p
            }),
    );
    let meta = session.meta(app);
    engine
        .sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id, session);
    persist(app, engine);
    Ok(meta)
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
