//! Outer session runtime composition.
mod observations;
mod projection;
#[cfg(any(test, feature = "harness"))]
pub(crate) use projection::project_runtime_event;
mod requests;
pub(crate) use requests::{finalize_text_block, resolve_permission, resolve_question};
mod resource;
pub(crate) use resource::close_session;
#[cfg(test)]
mod native_tests;
#[cfg(test)]
mod tests;
use super::application::*;
use super::*;
use crate::ipc::{AppError, ErrorCode};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub(crate) fn require_account(app: &AppHandle, id: &str) -> Result<(), AppError> {
    require_known_account(id, &crate::account::known_ids(app))
}
fn require_known_account(
    id: &str,
    known: &std::collections::HashSet<String>,
) -> Result<(), AppError> {
    if known.contains(id) {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::AccountNotFound,
            "This session's saved account is unavailable. Choose an account explicitly.",
        ))
    }
}

pub(crate) struct EngineState<'a>(pub &'a Engine);
impl EngineState<'_> {
    fn gate(&self, id: &str) -> Result<Arc<std::sync::Mutex<()>>, AppError> {
        self.0
            .with_session(id, |s| s.runtime_gate.clone())
            .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))
    }
}
impl SessionStatePort for EngineState<'_> {
    fn dispatch_control(
        &self,
        scope: &RuntimeScope,
        action: &mut dyn FnMut(&RuntimeOwner) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let gate = self.gate(&scope.session_id)?;
        let _guard = gate.lock().unwrap();
        let owner = self
            .snapshot(&scope.session_id)?
            .owner
            .filter(|owner| owner.scope == *scope)
            .ok_or_else(|| {
                AppError::new(ErrorCode::SessionNotRunning, "runtime scope was replaced")
            })?;
        action(&owner)
    }
    fn snapshot(&self, id: &str) -> Result<SessionSnapshot, AppError> {
        self.0.ensure_available(id)?;
        self.0
            .with_session(id, |s| SessionSnapshot {
                runtime: s.agent_runtime,
                status: s.status.clone(),
                owner: s.runtime_owner.clone(),
                settings_revision: s.settings_revision,
            })
            .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))
    }
    fn claim_start(
        &self,
        mut context: TurnContext,
    ) -> Result<(TurnContext, Arc<RuntimeOwner>), AppError> {
        self.0.ensure_available(&context.session_id)?;
        let id = context.session_id.clone();
        let gate = self.gate(&id)?;
        let _guard = gate.lock().unwrap();
        self.0
            .with_session_mut(&id, |s| {
                if s.runtime_owner.is_some() {
                    return Err(AppError::new(
                        ErrorCode::SessionBusy,
                        "a runtime start is already claimed",
                    ));
                }
                s.next_generation += 1;
                context.scope = RuntimeScope {
                    session_id: id.clone(),
                    turn_id: context.block_id.clone(),
                    generation: s.next_generation,
                };
                let owner = Arc::new(RuntimeOwner::new(context.scope.clone()));
                s.runtime_owner = Some(owner.clone());
                s.runtime_generation = Some(context.scope.generation.to_string());
                // process-native-capabilities FR-4: a replaced generation's
                // snapshot never carries over; the new child negotiates its own.
                s.effective_capabilities = None;
                s.running_context = Some(context.clone());
                Ok((context, owner))
            })
            .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))?
    }
    fn install(&self, scope: &RuntimeScope, control: Arc<dyn TurnControl>) -> bool {
        self.0
            .with_session_mut(&scope.session_id, |s| {
                if s.runtime_owner.as_ref().is_some_and(|o| o.scope == *scope)
                    && status::is_busy(&s.status)
                {
                    s.current = Some(control);
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false)
    }
    fn claim_close(&self, id: &str) -> Result<Option<Arc<RuntimeOwner>>, AppError> {
        self.0.ensure_available(id)?;
        let gate = self.gate(id)?;
        let _guard = gate.lock().unwrap();
        self.0
            .with_session_mut(id, |s| {
                s.current = None;
                s.effective_capabilities = None;
                s.runtime_generation = None;
                s.running_context = None;
                s.runtime_owner.take()
            })
            .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))
    }
    fn compare_settings(
        &self,
        id: &str,
        revision: u64,
        settings: SettingsResult,
    ) -> Result<(), AppError> {
        self.0.ensure_available(id)?;
        self.0
            .with_session_mut(id, |s| {
                if s.settings_revision != revision {
                    return Err(AppError::new(
                        ErrorCode::InvalidInput,
                        "Session changed while loading models. Please retry.",
                    ));
                }
                s.settings_revision += 1;
                s.model_id = settings.model_id;
                s.model_label = settings.model_label;
                s.context_limit_tokens = settings.context_limit;
                s.effort = settings.effort;
                Ok(())
            })
            .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))?
    }
}

/// Outer compatibility infrastructure for the non-native Grok/Francois runners.
/// Claude (task 08) and Codex (task 09) start through RuntimePort directly above.
struct LegacyRuntimeBridge<'a> {
    app: &'a AppHandle,
    adapter: &'static dyn SessionAdapter,
}
impl RuntimePort for LegacyRuntimeBridge<'_> {
    fn preflight(&self, ctx: &TurnContext) -> Result<(), AppError> {
        self.adapter.preflight(self.app, ctx)
    }
    fn begin_turn(
        &self,
        ctx: TurnContext,
        _sink: Arc<dyn RuntimeEventSink>,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        self.adapter.begin_turn(self.app, ctx)
    }
}

/// The on-disk sign-in marker each vendor CLI leaves in its account home.
fn signed_in(runtime: AgentRuntime, home: &str) -> bool {
    match runtime {
        AgentRuntime::Codex => crate::account::codex_auth_file_exists(home),
        AgentRuntime::ClaudeCode => crate::account::identity_file_exists(home),
        _ => true,
    }
}

/// process-settings-and-metrics FR-1: fill the turn's immutable execution
/// snapshot from ONE account read (`account::execution_account`). The account
/// must still map to the runtime the turn was routed to — a start that raced an
/// account removal fails with the typed error instead of spawning without a
/// home override (which the vendor CLI would read as its ambient home).
pub(crate) fn resolve_execution(
    ctx: &mut TurnContext,
    runtime: AgentRuntime,
    (kind, home): (crate::account::AccountKind, Option<String>),
    signed_in: impl Fn(AgentRuntime, &str) -> bool,
) -> Result<(), AppError> {
    if AgentRuntime::from_account_kind(kind).0 != runtime {
        return Err(AppError::new(
            ErrorCode::AccountNotFound,
            "This session's saved account changed. Choose an account explicitly.",
        ));
    }
    ctx.execution.identity = ExecutionIdentity {
        account_id: ctx.account_id.clone(),
        home: home.clone(),
        runtime: ctx.runtime.clone(),
        worktree_distro: ctx.worktree_distro.clone(),
    };
    ctx.execution.environment = account_env_for_kind(home.as_deref(), kind, &ctx.runtime, &[]);
    ctx.execution.account_authenticated = home.as_deref().is_none_or(|h| signed_in(runtime, h));
    Ok(())
}

pub(crate) fn start_runtime(
    app: &AppHandle,
    runtime: AgentRuntime,
    mut ctx: TurnContext,
) -> Result<(), AppError> {
    let account = crate::account::execution_account(app, &ctx.account_id)?;
    resolve_execution(&mut ctx, runtime, account, signed_in)?;
    let engine = app.state::<Engine>();
    let state = EngineState(&engine);
    let effects = Arc::new(AppEffects {
        app: app.clone(),
        cwd: ctx.cwd.clone(),
    });
    // Invalidate any previous generation before installing the replacement.
    application::close(&state, effects.as_ref(), &ctx.session_id)?;
    ctx.execution.local_images = engine
        .with_session(&ctx.session_id, |s| {
            s.attachments
                .iter()
                .filter(|a| a.kind == "image" && ctx.text.contains(&format!("@{}", a.ref_path)))
                .map(|a| a.stored_path.clone())
                .collect()
        })
        .unwrap_or_default();
    ctx.execution.response_prefix = pending_prefix(
        app,
        &ctx.session_id,
        ctx.response_mode,
        ctx.resume.is_none(),
    )
    .map(str::to_string);
    if runtime == AgentRuntime::ClaudeCode {
        return application::start(&state, &adapter::ClaudeCodeAdapter, effects, ctx).map(|_| ());
    }
    if runtime == AgentRuntime::Codex {
        let resource = state.session_runtime(
            &ctx.session_id,
            &ctx.execution.identity,
            adapter::codex::session_runtime(),
        )?;
        return application::start(&state, resource.as_ref(), effects, ctx).map(|_| ());
    }
    let legacy = LegacyRuntimeBridge {
        app,
        adapter: adapter_for(runtime),
    };
    application::start(&state, &legacy, effects, ctx).map(|_| ())
}

// Catalog and old outer dispatch retain their existing shape, but no Tauri
// parameter crosses the migrated Codex runtime's own entry points.
impl SessionAdapter for adapter::codex::CodexAdapter {
    fn agent_runtime(&self) -> AgentRuntime {
        AgentRuntime::Codex
    }
    fn preflight(&self, app: &AppHandle, ctx: &TurnContext) -> Result<(), AppError> {
        let mut resolved = ctx.clone();
        let account = crate::account::execution_account(app, &ctx.account_id)?;
        resolve_execution(&mut resolved, AgentRuntime::Codex, account, signed_in)?;
        let result = RuntimePort::preflight(self, &resolved);
        if result.is_err() {
            crate::account::mark_auth_failed(app, &ctx.account_id);
        }
        result
    }
    fn begin_turn(
        &self,
        app: &AppHandle,
        ctx: TurnContext,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        let id = ctx.session_id.clone();
        start_runtime(app, AgentRuntime::Codex, ctx)?;
        app.state::<Engine>()
            .with_session(&id, |s| s.current.clone())
            .flatten()
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::RuntimeUnavailable,
                    "runtime ended during startup",
                )
            })
    }
    fn models(&self, app: &AppHandle, id: &str) -> Vec<ModelInfo> {
        adapter::codex::model_catalog(app, id, false)
            .map(|c| c.models)
            .unwrap_or_default()
    }
}

// claude-process-adapter FR-1: the native Claude entry is framework-free; the
// Tauri-aware catalog, auth side effect and outer dispatch live here, as for Codex.
impl SessionAdapter for adapter::ClaudeCodeAdapter {
    fn agent_runtime(&self) -> AgentRuntime {
        AgentRuntime::ClaudeCode
    }
    fn preflight(&self, app: &AppHandle, ctx: &TurnContext) -> Result<(), AppError> {
        let mut resolved = ctx.clone();
        let account = crate::account::execution_account(app, &ctx.account_id)?;
        resolve_execution(&mut resolved, AgentRuntime::ClaudeCode, account, signed_in)?;
        let result = RuntimePort::preflight(self, &resolved);
        if result.is_err() {
            crate::account::mark_auth_failed(app, &ctx.account_id);
        }
        result
    }
    fn begin_turn(
        &self,
        app: &AppHandle,
        ctx: TurnContext,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        let id = ctx.session_id.clone();
        start_runtime(app, AgentRuntime::ClaudeCode, ctx)?;
        app.state::<Engine>()
            .with_session(&id, |s| s.current.clone())
            .flatten()
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::RuntimeUnavailable,
                    "runtime ended during startup",
                )
            })
    }
    /// Live `/v1/models` fetch with static fallback; with the handle, a landed
    /// fetch also mirrors the catalog and reconciles every session's window.
    fn models(&self, app: &AppHandle, _account_id: &str) -> Vec<ModelInfo> {
        refresh_models_for(Some(app))
    }
}

pub(crate) struct AppEffects {
    pub app: AppHandle,
    pub cwd: String,
}
impl RuntimeEffectPort for AppEffects {
    fn apply(&self, scope: &RuntimeScope, event: RuntimeEvent) -> Result<(), AppError> {
        let app = &self.app;
        let id = &scope.session_id;
        let next =
            projection::apply_to_session(
                app,
                &self.cwd,
                scope,
                event,
                |terminal| match terminal {
                    RuntimeEvent::TurnFinished => {
                        super::turn::finish_turn_effect(app, id, false, None)
                    }
                    RuntimeEvent::TurnFailed(error) => {
                        super::turn::finish_turn_failure(app, id, error)
                    }
                    _ => None,
                },
            )?;
        if let Some((block, text)) = next {
            // Start the queued turn after this sink call releases its owner dispatcher.
            let app = app.clone();
            let id = id.clone();
            std::thread::spawn(move || begin_turn(&app, &id, block, text, TurnMode::Normal));
        }
        Ok(())
    }
}

pub(crate) fn finish_legacy(app: &AppHandle, id: &str) {
    let engine = app.state::<Engine>();
    let _ = application::close(
        &EngineState(&engine),
        &AppEffects {
            app: app.clone(),
            cwd: String::new(),
        },
        id,
    );
}
pub(crate) struct Rules<'a>(pub &'a Engine);
impl PermissionRulePort for Rules<'_> {
    fn remember(
        &self,
        id: &str,
        pattern: &str,
        tier: Option<&str>,
        allow: bool,
    ) -> Result<crate::permissions::PermissionRule, AppError> {
        let tier = tier.unwrap_or("local");
        if !crate::permissions::is_valid_tier(tier) {
            return Err(AppError::new(ErrorCode::InvalidInput, "unknown tier"));
        }
        let path = crate::permissions::tier_path(self.0, id, tier)?;
        crate::permissions::write_rule(&path, tier, if allow { "allow" } else { "deny" }, pattern)
    }
}
