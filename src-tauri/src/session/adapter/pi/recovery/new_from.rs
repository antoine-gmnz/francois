//! session/adapter/pi/recovery/new_from.rs — pi-session-durability §5's
//! `session_new_from`: "Create new session" from a session whose native
//! conversation cannot be resumed.
//!
//! Split out of `recovery.rs` (which was at 900 of CLAUDE.md's ~1000 lines
//! before the round-2 remediation grew both halves) — the reconnect path and
//! this one share only the `SESSION_BUSY` claim and the account snapshot,
//! which stay in the parent.

use crate::ipc::{AppError, ErrorCode};
use crate::session::adapter::{AgentRuntime, ProviderProtocol, RuntimeModelRef};
use crate::session::{emit, persist, Engine, ResponseMode, SessionEvent, SessionMeta};
use tauri::{AppHandle, Manager};

use super::{account_snapshot, claim_recovery};

/// Everything `new_from_session` copies off the SOURCE session — snapshotted
/// under the engine lock, same discipline as `ReconnectSnapshot`.
pub(super) struct NewFromSnapshot {
    name: String,
    cwd: String,
    model_id: String,
    model_label: String,
    /// pi-models-metrics: copied VERBATIM. Re-deriving it through
    /// `resolve_model_display` sent a Pi model id down the Anthropic-shaped
    /// humanize/context-window path, which answers the Claude placeholder —
    /// the new session then showed a context bar against a window its model
    /// does not have. `session_create` reads the Pi descriptor for exactly
    /// this reason; here the source session already IS that answer.
    context_limit_tokens: u64,
    effort: Option<String>,
    permission_mode: String,
    runtime: String,
    /// session-worktree FR-10: follows `cwd`, which is copied — a source
    /// whose cwd lives inside a WSL distro hands the new session a path only
    /// that distro can resolve, and dropping the distro made every later
    /// `probe_installation`/connect run it natively and fail.
    worktree_distro: Option<String>,
    allow_git: bool,
    project_id: Option<String>,
    account_id: String,
    system_prompt: Option<String>,
    extra_args: Vec<String>,
    profile: Option<crate::profiles::SessionProfileRef>,
    /// pi-models-metrics FR-4: the exact provider/model pair the source was
    /// created with. Pi does not treat `model_id` alone as an identity, so a
    /// session without this can never build a `RuntimeConnectContext` — the
    /// copy came out "no recorded model identity" on its very first send.
    runtime_model: Option<RuntimeModelRef>,
    /// pi-migration-rollout FR-3: carried over verbatim — "Create new
    /// session" copies validated profile/model settings, this included.
    pi_profile_settings: Option<crate::profiles::PiProfileSettings>,
    /// pi-migration-rollout FR-3 (read-once fix): the source's OWN resolved
    /// snapshot, copied VERBATIM — never re-read. `None` only if the source
    /// itself has never resolved one yet (an un-reconnected pre-fix record).
    pi_launch_prompt: Option<super::super::profile_args::PiLaunchPrompt>,
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

pub(super) fn load_new_from_snapshot(engine: &Engine, session_id: &str) -> Option<NewFromSnapshot> {
    engine.with_session(session_id, |s| NewFromSnapshot {
        name: s.name.clone(),
        cwd: s.cwd.clone(),
        model_id: s.model_id.clone(),
        model_label: s.model_label.clone(),
        context_limit_tokens: s.context_limit_tokens,
        effort: s.effort.clone(),
        permission_mode: s.permission_mode.clone(),
        runtime: s.runtime.clone(),
        worktree_distro: s.worktree_distro.clone(),
        allow_git: s.allow_git,
        project_id: s.project_id.clone(),
        account_id: s.account_id.clone(),
        system_prompt: s.system_prompt.clone(),
        extra_args: s.extra_args.clone(),
        profile: s.profile.clone(),
        runtime_model: s.runtime_model.clone(),
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
    let Some(claim) = claim_recovery(&engine, source_id) else {
        return Err(AppError::new(
            ErrorCode::SessionBusy,
            "this session has a recovery already in flight",
        ));
    };
    let outcome = build_new_from(app, &engine, &source, name);
    drop(claim);
    if let Ok(meta) = &outcome {
        emit(app, SessionEvent::Meta { meta: meta.clone() });
    }
    outcome
}

/// §5: "copies only VALIDATED cwd/project/account/profile/model settings".
/// The cwd is the one the source recorded, which may have been deleted,
/// renamed or unmounted since — exactly the situation that made its Pi
/// conversation unresumable in the first place. `session_create`'s own
/// front-door check is reused rather than re-derived, so a WSL path is
/// stat'ed inside its distro instead of failing as a bad Windows path.
fn validated_cwd(source: &NewFromSnapshot) -> Result<(), AppError> {
    crate::session::commands::validate_create_input(
        &source.cwd,
        Some(source.model_id.clone()),
        Some(source.permission_mode.clone()),
        Some(source.runtime.clone()),
        false, // never an adopt: this copies a cwd, it never resolves a worktree
    )
    .map(|_| ())
}

/// The new `Session` itself — PURE over the snapshot (no `AppHandle`, no
/// I/O), so every setting this copies, and every one it deliberately does
/// not, has a test with no Tauri context at all.
fn new_session_from(
    source: &NewFromSnapshot,
    id: String,
    name: String,
    now: u64,
    agent_runtime: AgentRuntime,
    protocol: ProviderProtocol,
) -> crate::session::Session {
    let session = crate::session::Session::new(
        id,
        name,
        source.cwd.clone(),
        source.model_id.clone(),
        source.model_label.clone(),
        0,
        source.context_limit_tokens,
        now,
        now,
        source.effort.clone(),
        source.permission_mode.clone(),
        source.runtime.clone(),
        source.allow_git,
        source.project_id.clone(),
        None, // no worktree provenance — see this fn's own doc comment
        // ...but the DISTRO does follow the cwd this copies (FR-10).
        source.worktree_distro.clone(),
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
    // pi-models-metrics FR-4: the exact pair, same `Session { .. }` shape
    // `session_create` uses — `Session::new` takes no `runtime_model`, and a
    // Pi session without one can never build a `RuntimeConnectContext`.
    crate::session::Session {
        runtime_model: source.runtime_model.clone(),
        ..session
    }
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
    validated_cwd(source)?;
    let id = crate::ids::uuid();
    let (agent_runtime, protocol) =
        AgentRuntime::from_account_kind(crate::account::kind_of(app, &source.account_id));
    let session = new_session_from(
        source,
        id.clone(),
        name.unwrap_or_else(|| derive_new_from_name(&source.name)),
        crate::ids::now_ms(),
        agent_runtime,
        protocol,
    );
    let meta = session.meta(app);
    engine
        .sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id.clone(), session);
    persist(app, engine);
    // diff-view FR-15: the new session gets its OWN cwd watcher, exactly as
    // `session_create` ends. Without it the DIFF tab stayed empty for the
    // whole life of a session created this way — the one path that reaches a
    // live session without passing through `session_create`.
    crate::diff::watch_session(app, &id, &source.cwd);
    Ok(meta)
}

#[cfg(test)]
#[path = "new_from_tests.rs"]
mod tests;
