//! session/adapter/pi/recovery.rs — pi-session-durability §4/§5: FR-3's
//! pre-resume validation, FR-4/FR-5's projection rebuild (native entry
//! ancestry + stable-block-id reconciliation), FR-8's version-transition
//! backup, and the `session_reconnect`/`session_new_from` orchestration those
//! Tauri commands (`session/commands/lifecycle.rs`) call into.
//!
//! Every DECISION is a pure function, unit-tested directly with no
//! `AppHandle` — same discipline `protocol.rs`/`normalize/mod.rs` follow:
//! FR-3's validation and its ordering behind the account gate
//! (`validate_before_resume`, `gate_then_validate`), FR-8's version verdict,
//! the backup-before-spawn order and the version actually recorded
//! (`version_transition`, `backup_then_spawn`, `recorded_version`), and —
//! in the `projection` child module — the whole FR-4/FR-5/FR-7 rebuild
//! (`rebuild_projection`), which decides what the transcript should become
//! before anything here touches disk.
//!
//! The I/O shell is split into two seams that take their I/O as closures —
//! `fetch_and_rebuild` (the `get_entries` round trip + the rebuild decision)
//! and `commit_rebuild` (the transcript write) — so `recovery/shell_tests.rs`
//! drives the whole "reconnect → `get_entries` → merged transcript on disk"
//! chain against a REAL fake child over a socket and a REAL file in a temp
//! dir, with no `AppHandle`. That is also where §7's one invariant is pinned:
//! a rebuild that fails returns BEFORE the write, so the cached transcript
//! stays readable.
//!
//! What is still NOT tested: what genuinely needs an `AppHandle` — the
//! account gate, `super::connect`'s spawn, `install_runtime_connection` and
//! the final `with_session_mut`/`emit`. This crate wires up no `AppHandle`
//! test harness; those are held together by keeping every decision above
//! pure.
//!
//! **Provisional**, same honest caveat every other Pi wire assumption in this
//! adapter carries (see `wire.rs`'s doc): no real capture of `get_entries`
//! exists yet. `NativeEntry`'s shape (in `projection`) is a best-effort
//! mirror of the audited session-format doc ("versioned JSONL tree, stable
//! entry/parent IDs"), reconciled against a real capture once one exists.
//! Because those names are unconfirmed, a payload this build cannot prove an
//! ancestry from is REFUSED rather than guessed at.

use crate::ipc::{AppError, ErrorCode};
use crate::session::adapter::{
    AgentRuntime, RuntimeConnectContext, RuntimeLaunchPolicy, RuntimeModelRef,
    RuntimeProfileSnapshot, RuntimeSessionControl,
};
use crate::session::events::{RuntimeRecovery, RuntimeRecoveryState};
use crate::session::{emit, persist, BufBlock, Engine, SessionEvent, SessionMeta};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use super::persistence::{self, PiResumeRecord};

/// §5's `session_new_from` — a sibling concern, not a step of the reconnect
/// path: it never connects, never reads an entry, and shares only the
/// `SESSION_BUSY` claim and the account snapshot below.
mod new_from;
mod projection;

pub(crate) use new_from::new_from_session;
use projection::{rebuild_projection, GetEntriesData, Rebuild};

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

/// Do two path STRINGS name the same location? Every path this module
/// compares — the pinned `config_dir`, the session's `cwd`, the conversation
/// file Pi reports back — arrives from a different producer than the one that
/// recorded it, so a trailing separator, a `./` segment or (on Windows) a
/// different case made a perfectly healthy session fail validation as
/// "moved"/"no longer available". `project::same_root` is the crate's one
/// answer to that question: lexical (never resolves symlinks, so an
/// unreadable path still compares), component-wise, case-folded only on
/// Windows.
fn same_path(a: &str, b: &str) -> bool {
    crate::project::same_root(a, b)
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
    let config_dir_matches = account
        .config_dir
        .as_deref()
        .is_some_and(|dir| same_path(dir, &record.config_dir));
    if !account.is_pi || !config_dir_matches {
        return Err(AppError::new(
            ErrorCode::RuntimeAccountMissing,
            "the account pinned to this session's Pi conversation is no longer available",
        ));
    }
    if !same_path(session_cwd, &record.cwd) {
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

/// FR-8's backup and the spawn it protects, as ONE ordered step: `spawn` is
/// unreachable unless the backup is already on disk. Pure (no `AppHandle` —
/// the spawn arrives as a closure), so the ORDER itself has a test with no
/// Tauri context at all, same discipline as `gate_then_validate`.
///
/// It matters because `super::connect` launches the NEW Pi version with
/// `--resume` against the recorded file, which Pi migrates IN PLACE — and
/// that file is the only copy. A backup that failed is therefore a refusal,
/// never a warning.
pub(crate) fn backup_then_spawn<T>(
    needs_backup: bool,
    native_file: &Path,
    from_version: &str,
    spawn: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    if needs_backup {
        backup_native_file(native_file, from_version).map_err(|e| {
            AppError::new(
                ErrorCode::Internal,
                format!(
                    "could not back up this session's Pi conversation before upgrading it: {e}"
                ),
            )
        })?;
    }
    spawn()
}

/// FR-8: the Pi version to RECORD after a successful reconnect. An
/// installation whose version could not be detected must NEVER overwrite a
/// known recorded one: `version_transition` fails open on an empty string,
/// so one such write permanently disables FR-8's downgrade guard for that
/// session. Unknown ⇒ keep whatever the record already holds.
pub(crate) fn recorded_version(record_version: &str, detected: Option<&str>) -> String {
    match detected.map(str::trim).filter(|v| !v.is_empty()) {
        Some(detected) => detected.to_string(),
        None => record_version.to_string(),
    }
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
    /// The session's CURRENT transcript, verbatim and in order — the whole
    /// input side of the merge (spec round-2 remediation): the rebuild reads
    /// back each block's own `at`, attachments and every other local field
    /// from here (rule 1), and re-anchors every local-only row — Tool
    /// executions, notices — to the message it followed (rules 2/3). The
    /// three parallel maps this used to carry are derived inside
    /// `rebuild_projection` now, so they cannot drift from the blocks.
    previous_blocks: Vec<BufBlock>,
    busy: bool,
}

fn load_reconnect_snapshot(engine: &Engine, session_id: &str) -> Option<ReconnectSnapshot> {
    engine.with_session(session_id, |s| ReconnectSnapshot {
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
        previous_blocks: s.block_buffer.clone(),
        busy: crate::session::status::is_busy(&s.status) || s.recovery_busy,
    })
}

pub(super) fn account_snapshot(app: &AppHandle, account_id: &str) -> AccountSnapshot {
    AccountSnapshot {
        is_pi: crate::account::kind_of(app, account_id) == crate::account::AccountKind::Pi,
        config_dir: crate::account::config_dir_of(app, account_id),
    }
}

/// The `SESSION_BUSY` claim, held as a GUARD: `recovery_busy` is cleared when
/// this drops, so a panic anywhere in the reconnect/new-from body leaves the
/// session usable. Releasing it by hand after the call (what this replaced)
/// meant one panicking run left the session permanently "busy" — every later
/// reconnect AND every `newFrom` answered `SESSION_BUSY` until the app was
/// restarted, and the recovery banner's Retry button could never clear it.
pub(super) struct RecoveryClaim<'a> {
    engine: &'a Engine,
    session_id: String,
}

impl Drop for RecoveryClaim<'_> {
    fn drop(&mut self) {
        self.engine
            .with_session_mut(&self.session_id, |s| s.recovery_busy = false);
    }
}

/// Claim the `SESSION_BUSY` guard — `None` iff another recovery already holds
/// it (the caller then answers `SESSION_BUSY` and releases nothing, since it
/// took nothing).
pub(super) fn claim_recovery<'a>(
    engine: &'a Engine,
    session_id: &str,
) -> Option<RecoveryClaim<'a>> {
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
        .then(|| RecoveryClaim {
            engine,
            session_id: session_id.to_string(),
        })
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
    let Some(claim) = claim_recovery(&engine, session_id) else {
        return Err(AppError::new(
            ErrorCode::SessionBusy,
            "a turn or another recovery is already in flight for this session",
        ));
    };
    let result = run_reconnect(app, &engine, session_id, &snapshot);
    drop(claim); // released BEFORE the meta below, which reads the session again
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

/// `get_entries` → the rebuild decision, as ONE step. The malformed-payload
/// refusal belongs WITH the parse, and parameterizing the fetch is what gives
/// this half of the I/O shell a test driven by a real fake child with no
/// `AppHandle` at all (`recovery/shell_tests.rs`) — the sequencing this
/// module's doc used to list as untested.
fn fetch_and_rebuild(
    fetch: impl FnOnce() -> Result<Option<serde_json::Value>, AppError>,
    previous: &[BufBlock],
) -> Result<Rebuild, AppError> {
    // A payload this build cannot prove an ancestry from is an ERROR, never
    // an empty rebuild — and an error means the caller's `commit_rebuild`
    // below is never reached, so the cached history stays readable exactly as
    // §7 promises.
    let data: GetEntriesData = fetch()?
        .ok_or(())
        .and_then(|v| serde_json::from_value(v).map_err(|_| ()))
        .map_err(|()| {
            AppError::new(
                ErrorCode::RuntimeProtocolError,
                "get_entries returned a malformed payload",
            )
        })?;
    rebuild_projection(data, previous)
}

/// What `commit_rebuild` wrote, for the ONE `with_session_mut` below to
/// apply. `buffer`/`appended` are both `None` when nothing about the
/// transcript changed, and the two anchors then stay at whatever the record
/// already held rather than being erased to `null`.
struct CommittedRebuild {
    buffer: Option<Vec<BufBlock>>,
    /// The single non-destructive line the `KeepLocal` path may add
    /// (remediation rule 4's delivery-unknown notice) — already on disk when
    /// this is `Some`, and pushed onto the live buffer by the caller.
    appended: Option<BufBlock>,
    truncated: bool,
    last_entry_id: Option<String>,
    leaf_id: Option<String>,
}

/// The rebuild's whole DISK side, ordered: nothing reaches the session until
/// the transcript file itself is written. Parameterized over the two writes
/// (`replace`/`append`) so the ordering has a test with no `AppHandle`.
fn commit_rebuild(
    rebuild: Rebuild,
    record: &PiResumeRecord,
    replace: impl FnOnce(&[BufBlock]) -> std::io::Result<()>,
    append: impl FnOnce(&BufBlock),
) -> Result<CommittedRebuild, AppError> {
    match rebuild {
        Rebuild::Merged {
            blocks: mut rebuilt,
            last_entry_id,
            leaf_id,
        } => {
            replace(&rebuilt).map_err(|e| {
                AppError::new(
                    ErrorCode::Internal,
                    format!("could not save the rebuilt transcript: {e}"),
                )
            })?;
            // FR-6: the FULL rebuilt list is on disk already (`replace`,
            // above) — this only bounds what stays in memory, same
            // cap/eviction logic every other runtime's own live append uses.
            let truncated = crate::session::trim_transcript(
                &mut rebuilt,
                crate::session::TRANSCRIPT_BUFFER_CAP,
            );
            Ok(CommittedRebuild {
                buffer: Some(rebuilt),
                appended: None,
                truncated,
                last_entry_id,
                leaf_id,
            })
        }
        Rebuild::KeepLocal { append: notice } => {
            // Remediation rule 4: ONE appended line, nothing rewritten — the
            // transcript this path keeps is the only copy of a conversation
            // Pi's entries cannot reproduce.
            if let Some(notice) = &notice {
                append(notice);
            }
            Ok(CommittedRebuild {
                buffer: None,
                appended: notice,
                truncated: false,
                last_entry_id: record.last_entry_id.clone(),
                leaf_id: record.leaf_id.clone(),
            })
        }
    }
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
    let (config_dir, pinned_runtime, pinned_distro, inherit) =
        gate_then_validate(gate, record, &snapshot.cwd, &native_root)?;
    // PR #142 §5: the account's PINNED environment is not decoration (FR-1/
    // FR-6). Its `PI_CODING_AGENT_DIR` is spelled for that environment, so
    // reconnecting from a session running somewhere else would hand the child
    // a directory that does not exist there — and Pi would quietly fall back
    // to the ambient one. Same helper `session_create`'s gate uses; the
    // session's distro is its worktree's, or the one its WSL cwd names.
    let session_distro = snapshot
        .worktree_distro
        .clone()
        .or_else(|| crate::wsl::wsl_unc_to_linux(&snapshot.cwd).map(|(d, _)| d));
    if let Some(reason) = crate::account::pi_environment_mismatch(
        &pinned_runtime,
        pinned_distro.as_deref(),
        &snapshot.runtime,
        session_distro.as_deref(),
    ) {
        // RUNTIME_UNAVAILABLE, not INVALID_INPUT: reconnect's contract error
        // list has no INVALID_INPUT, and Pi genuinely is not reachable for
        // this session as configured.
        return Err(AppError::new(
            ErrorCode::RuntimeUnavailable,
            format!("this session's Pi account {reason}"),
        ));
    }

    let installed = super::discovery::probe_installation(
        &snapshot.runtime,
        snapshot.worktree_distro.as_deref(),
        false,
    )?;
    let installed_version = installed.detected_version.clone().unwrap_or_default();
    // FR-8, decided here so a DOWNGRADE refuses before anything else is
    // built or spawned; the backup it calls for is taken immediately before
    // the spawn itself (`backup_then_spawn`, below).
    let needs_backup = version_transition(&record.pi_version, &installed_version)?;

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

    let conn = backup_then_spawn(
        needs_backup,
        Path::new(&record.native_session_file),
        &record.pi_version,
        || super::connect(app, ctx),
    )?;
    // FR-3: a resumed handshake reporting a DIFFERENT native file than the
    // one it was just told to resume is corruption, not a value to trust —
    // best-effort (a response that omits `sessionFile` skips the check,
    // same "provisional, no real capture" caveat every other Pi wire
    // assumption in this adapter carries).
    if let Some(reported) = conn.handshake_info().session_file {
        if !same_path(&reported, &record.native_session_file) {
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
    let rebuild = match fetch_and_rebuild(
        || conn.get_entries(None).map(|resp| resp.data),
        &snapshot.previous_blocks,
    ) {
        Ok(rebuild) => rebuild,
        Err(e) => {
            let _ = conn.shutdown();
            return Err(e);
        }
    };
    let committed = match commit_rebuild(
        rebuild,
        record,
        |blocks| crate::session::persistence::replace_transcript(app, session_id, blocks),
        |block| crate::session::persistence::append_transcript(app, session_id, block),
    ) {
        Ok(committed) => committed,
        Err(e) => {
            let _ = conn.shutdown();
            return Err(e);
        }
    };

    let updated_record = PiResumeRecord {
        last_entry_id: committed.last_entry_id,
        leaf_id: committed.leaf_id,
        pi_version: recorded_version(&record.pi_version, installed.detected_version.as_deref()),
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
            if let Some(blocks) = committed.buffer {
                s.block_buffer = blocks;
            }
            if let Some(notice) = committed.appended {
                s.block_buffer.push(notice);
            }
            // transcript-scale FR-6: monotonic — a rebuild that happens to
            // fit entirely in memory this time must not un-truncate a
            // session whose history was already known to run past the cap.
            s.transcript_truncated = s.transcript_truncated || committed.truncated;
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

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;

/// The I/O shell's own tests, driven by a fake child — kept in their own file
/// because they need a socket harness the decision tests above do not.
#[cfg(test)]
#[path = "recovery/shell_tests.rs"]
mod shell_tests;
