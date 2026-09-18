use super::lifecycle::*;
use crate::ipc::{err, ok, IpcResult};
use crate::session::*;
use serde_json::Value;
use tauri::{AppHandle, State};
/// session-settings-sheet §5: the wire shape of `francois:session:updateSettings`'s
/// `patch` — changed keys only, never null. `effort: Some("")` is FR's "clears
/// back to the model's own default" (mirrors `session_switch_effort`'s absent/
/// blank rule).
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettingsPatch {
    pub name: Option<String>,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub response_mode: Option<String>,
    pub allow_git: Option<bool>,
}

impl SessionSettingsPatch {
    /// §7 case 2: everything but `name` touches a process/turn concern, so a
    /// terminal session accepts a name-only patch (matching `session_rename`)
    /// and rejects any patch that carries one of these.
    pub(crate) fn touches_run_key(&self) -> bool {
        self.model_id.is_some()
            || self.effort.is_some()
            || self.permission_mode.is_some()
            || self.response_mode.is_some()
            || self.allow_git.is_some()
    }

    /// FR-3: no key at all.
    pub(crate) fn is_empty(&self) -> bool {
        self.name.is_none() && !self.touches_run_key()
    }
}

/// The changed-keys-only patch after FR-6's re-validation, ready to write.
/// `effort: Some(None)` is the FR-3-style clear; `None` (outer) means the key
/// was absent from the patch, i.e. "leave alone".
#[derive(Debug)]
pub(crate) struct ValidatedSettingsPatch {
    name: Option<String>,
    model_id: Option<String>,
    effort: Option<Option<String>>,
    permission_mode: Option<&'static str>,
    response_mode: Option<ResponseMode>,
    allow_git: Option<bool>,
}

/// session-settings-sheet FR-6/§7 cases 3-5: the core's OWN re-validation of
/// every key `SessionSettingsPatch` carries — the frontend's narrowing (a
/// picker/toggle that cannot itself produce a bad value) is never trusted. The
/// FIRST bad key stops the whole patch, so nothing partial is ever written.
/// `advertised_models` is the session's ACCOUNT catalog (case 4) — pass an
/// empty slice when the patch carries no `modelId` (the model call is skipped
/// entirely, sparing sessions with no live catalog from needing one for an
/// unrelated field).
pub(crate) fn validate_settings_patch(
    patch: &SessionSettingsPatch,
    advertised_models: &[String],
) -> Result<ValidatedSettingsPatch, (&'static str, &'static str)> {
    let name = match &patch.name {
        Some(raw) => Some(validate_session_name(raw)?),
        None => None,
    };
    let model_id = match &patch.model_id {
        Some(raw) => {
            if !advertised_models.iter().any(|m| m == raw) {
                return Err((
                    "INVALID_INPUT",
                    "model is not advertised for this session's account",
                ));
            }
            Some(raw.clone())
        }
        None => None,
    };
    let effort = match &patch.effort {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Some(None)
            } else if valid_effort(trimmed) {
                Some(Some(trimmed.to_string()))
            } else {
                return Err(("INVALID_INPUT", "unknown effort level"));
            }
        }
        None => None,
    };
    let permission_mode = match &patch.permission_mode {
        Some(raw) => match parse_permission_mode(raw) {
            Some(mode) => Some(mode),
            None => return Err(("INVALID_INPUT", "unknown permission mode")),
        },
        None => None,
    };
    let response_mode = match &patch.response_mode {
        Some(raw) => match ResponseMode::parse(raw) {
            Some(mode) => Some(mode),
            None => return Err(("INVALID_INPUT", "unknown response mode")),
        },
        None => None,
    };
    Ok(ValidatedSettingsPatch {
        name,
        model_id,
        effort,
        permission_mode,
        response_mode,
        allow_git: patch.allow_git,
    })
}

/// session-settings-sheet FR-2/FR-3/§7 case 2: the engine half of
/// `session_update_settings` — SESSION_NOT_FOUND, FR-3's empty-patch no-op,
/// the terminal+run-key guard, FR-6's re-validation and the batched mutation,
/// all pure (no `AppHandle`) like `switch_permission_mode_in_engine` — persist
/// + emit stay in the handler, which also owns the model-catalog fetch this
/// needs for FR-6's `modelId` check. `Ok((meta, false))` is FR-3: the caller
/// must not persist or emit for it.
pub(crate) fn update_settings_in_engine(
    engine: &Engine,
    session_id: &str,
    patch: &SessionSettingsPatch,
    advertised_models: &[String],
) -> Result<(SessionMeta, bool), (&'static str, &'static str)> {
    if patch.is_empty() {
        let meta = engine
            .with_session(session_id, |s| s.meta())
            .ok_or(("SESSION_NOT_FOUND", "no such session"))?;
        return Ok((meta, false));
    }
    let terminal = engine
        .with_session(session_id, |s| status::is_terminal(&s.status))
        .ok_or(("SESSION_NOT_FOUND", "no such session"))?;
    if terminal && patch.touches_run_key() {
        return Err(("SESSION_NOT_RUNNING", "session has ended"));
    }
    let validated = validate_settings_patch(patch, advertised_models)?;
    let meta = engine
        .with_session_mut(session_id, |s| {
            // Sandbox selection is independent of interactive approval support.
            if patch.permission_mode.is_some() && s.agent_runtime == AgentRuntime::Pi {
                return Err((
                    "RUNTIME_UNSUPPORTED",
                    "runtime sandbox selection is unavailable",
                ));
            }
            for (needed, key) in [
                (
                    patch.model_id.is_some() || patch.effort.is_some(),
                    "modelSwitching",
                ),
                (patch.allow_git.is_some(), "permissions"),
            ] {
                if needed
                    && !adapter::resolve_capability(
                        s.agent_runtime,
                        s.effective_capabilities.as_ref(),
                        key,
                    )
                {
                    return Err(("RUNTIME_UNSUPPORTED", "runtime capability is unavailable"));
                }
            }
            if status::is_terminal(&s.status) && patch.touches_run_key() {
                return Err(("SESSION_NOT_RUNNING", "session has ended"));
            }
            if let Some(name) = validated.name {
                s.name = name;
            }
            if let Some(model_id) = validated.model_id {
                s.context_limit_tokens = context_limit(&model_id);
                s.model_id = model_id;
            }
            if let Some(effort) = validated.effort {
                s.effort = effort;
            }
            if let Some(mode) = validated.permission_mode {
                // FR-4: stamped on EVERY write, including a no-op re-pick —
                // mirrors switch_permission_mode_in_engine's rationale.
                s.permission_mode = mode.to_string();
                s.permission_mode_since = now_ms();
            }
            if let Some(mode) = validated.response_mode {
                s.response_mode = mode;
            }
            if let Some(allow_git) = validated.allow_git {
                s.allow_git = allow_git;
            }
            Ok(s.meta())
        })
        .ok_or(("SESSION_NOT_FOUND", "no such session"))??;
    Ok((meta, true))
}

/// session-settings-sheet FR-2: `francois:session:updateSettings` /
/// `session_update_settings`. Validates every changed key in ONE pass (§7
/// cases 3-5: one bad key writes NONE of them), applies them in ONE pass,
/// persists once and emits exactly one `session.meta` — the same shape as the
/// single-setting switch verbs above, batched. FR-5: no verb here reaches into
/// a running turn — `name`/`allowGit` land immediately because they touch no
/// `TurnContext` snapshot, and the rest reach only the session's next turn,
/// exactly like the switch verbs they replace in this sheet.
#[tauri::command(async)]
pub fn session_update_settings(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    patch: SessionSettingsPatch,
) -> IpcResult<Value> {
    // The model catalog is fetched only when the patch actually carries a
    // modelId — sparing a settings-only edit the round trip and the account
    // lookup it needs.
    if patch.model_id.is_some() {
        if let Err((code, msg)) = engine.require_capability(&session_id, "modelSwitching") {
            return err(code, msg);
        }
    }
    let advertised_models: Vec<String> = if patch.model_id.is_some() {
        let Some((account_id, agent_runtime)) =
            engine.with_session(&session_id, |s| (s.account_id.clone(), s.agent_runtime))
        else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        adapter_for(agent_runtime)
            .models(&app, &account_id)
            .into_iter()
            .map(|m| m.id)
            .collect()
    } else {
        Vec::new()
    };
    match update_settings_in_engine(&engine, &session_id, &patch, &advertised_models) {
        Ok((meta, true)) => {
            persist(&app, &engine);
            emit(&app, SessionEvent::Meta { meta: meta.clone() });
            ok(serde_json::to_value(meta).unwrap())
        }
        Ok((meta, false)) => ok(serde_json::to_value(meta).unwrap()),
        Err((code, msg)) => err(code, msg),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::{test_engine_with, test_session};
    fn patch_with_name(name: &str) -> SessionSettingsPatch {
        SessionSettingsPatch {
            name: Some(name.into()),
            ..Default::default()
        }
    }

    #[test]
    fn an_empty_patch_touches_no_run_key_and_is_empty() {
        let patch = SessionSettingsPatch::default();
        assert!(patch.is_empty());
        assert!(!patch.touches_run_key());
    }

    #[test]
    fn a_name_only_patch_is_not_empty_but_touches_no_run_key() {
        let patch = patch_with_name("new name");
        assert!(!patch.is_empty());
        assert!(!patch.touches_run_key());
    }

    #[test]
    fn any_other_key_touches_a_run_key() {
        let allow_git = SessionSettingsPatch {
            allow_git: Some(true),
            ..Default::default()
        };
        assert!(allow_git.touches_run_key());
        assert!(!allow_git.is_empty());

        let model = SessionSettingsPatch {
            model_id: Some("opus".into()),
            ..Default::default()
        };
        assert!(model.touches_run_key());
    }

    // ---------- validate_settings_patch (FR-6, §7 cases 3-5) ----------

    #[test]
    fn validate_settings_patch_accepts_every_field_when_well_formed() {
        let patch = SessionSettingsPatch {
            name: Some("renamed".into()),
            model_id: Some("opus".into()),
            effort: Some("high".into()),
            permission_mode: Some("acceptEdits".into()),
            response_mode: Some("concise".into()),
            allow_git: Some(true),
        };
        let validated =
            validate_settings_patch(&patch, &["sonnet".to_string(), "opus".to_string()]).unwrap();
        assert_eq!(validated.name.as_deref(), Some("renamed"));
        assert_eq!(validated.model_id.as_deref(), Some("opus"));
        assert_eq!(validated.effort, Some(Some("high".to_string())));
        assert_eq!(validated.permission_mode, Some("acceptEdits"));
        assert_eq!(validated.response_mode, Some(ResponseMode::Concise));
        assert_eq!(validated.allow_git, Some(true));
    }

    #[test]
    fn validate_settings_patch_clears_effort_on_a_blank_value() {
        // §5: '' clears back to the model's own default, mirroring
        // session_switch_effort's absent/blank rule.
        let patch = SessionSettingsPatch {
            effort: Some("".into()),
            ..Default::default()
        };
        let validated = validate_settings_patch(&patch, &[]).unwrap();
        assert_eq!(validated.effort, Some(None));
    }

    #[test]
    fn validate_settings_patch_rejects_a_blank_name() {
        let patch = patch_with_name("   ");
        let err = validate_settings_patch(&patch, &[]).unwrap_err();
        assert_eq!(err.0, "INVALID_INPUT");
    }

    #[test]
    fn validate_settings_patch_rejects_a_model_the_account_does_not_advertise() {
        // §7 case 4: the picker cannot produce it, so this is the
        // tampered-payload path.
        let patch = SessionSettingsPatch {
            model_id: Some("claude-nonexistent".into()),
            ..Default::default()
        };
        let err = validate_settings_patch(&patch, &["sonnet".to_string()]).unwrap_err();
        assert_eq!(err.0, "INVALID_INPUT");
    }

    #[test]
    fn validate_settings_patch_rejects_unknown_effort_permission_and_response_modes() {
        let bad_effort = SessionSettingsPatch {
            effort: Some("turbo".into()),
            ..Default::default()
        };
        assert_eq!(
            validate_settings_patch(&bad_effort, &[]).unwrap_err().0,
            "INVALID_INPUT"
        );

        let bad_permission = SessionSettingsPatch {
            permission_mode: Some("yolo".into()),
            ..Default::default()
        };
        assert_eq!(
            validate_settings_patch(&bad_permission, &[]).unwrap_err().0,
            "INVALID_INPUT"
        );

        let bad_response = SessionSettingsPatch {
            response_mode: Some("terse".into()),
            ..Default::default()
        };
        assert_eq!(
            validate_settings_patch(&bad_response, &[]).unwrap_err().0,
            "INVALID_INPUT"
        );
    }

    // ---------- update_settings_in_engine (FR-2/FR-3/FR-4/§7 cases 1-5) ----------

    #[test]
    fn update_settings_in_engine_rejects_an_unknown_session() {
        let engine = test_engine_with(test_session());
        let Err(err) = update_settings_in_engine(&engine, "nope", &patch_with_name("x"), &[])
        else {
            panic!("expected an error");
        };
        assert_eq!(err.0, "SESSION_NOT_FOUND");
    }

    #[test]
    fn an_empty_patch_is_a_no_op_success_that_the_caller_must_not_persist_or_emit() {
        // FR-3.
        let engine = test_engine_with(test_session());
        let (meta, should_persist) =
            update_settings_in_engine(&engine, "s1", &SessionSettingsPatch::default(), &[])
                .unwrap();
        assert_eq!(meta.name, "n");
        assert!(!should_persist);
    }

    #[test]
    fn a_name_only_patch_succeeds_on_a_terminal_session() {
        // §7 case 2: matches session_rename — name touches no process.
        let mut session = test_session();
        session.status = status::DONE.into();
        let engine = test_engine_with(session);
        let (meta, should_persist) =
            update_settings_in_engine(&engine, "s1", &patch_with_name("renamed"), &[]).unwrap();
        assert_eq!(meta.name, "renamed");
        assert!(should_persist);
    }

    #[test]
    fn adding_a_run_key_to_a_terminal_session_is_rejected_whole() {
        // §7 case 2: adding modelId to a name patch on a done session rejects
        // the WHOLE patch — the name does not silently apply either.
        let mut session = test_session();
        session.status = status::DONE.into();
        let engine = test_engine_with(session);
        let patch = SessionSettingsPatch {
            name: Some("renamed".into()),
            model_id: Some("sonnet".into()),
            ..Default::default()
        };
        let Err(err) = update_settings_in_engine(&engine, "s1", &patch, &["sonnet".to_string()])
        else {
            panic!("expected an error");
        };
        assert_eq!(err.0, "SESSION_NOT_RUNNING");
        assert_eq!(
            engine.with_session("s1", |s| s.name.clone()),
            Some("n".into())
        );
    }

    #[test]
    fn a_patch_with_one_invalid_key_writes_none_of_its_keys() {
        // §7 cases 3-5: validate all, write all — nothing partial.
        let engine = test_engine_with(test_session());
        let patch = SessionSettingsPatch {
            name: Some("renamed".into()),
            allow_git: Some(true),
            permission_mode: Some("not-a-mode".into()),
            ..Default::default()
        };
        let Err(err) = update_settings_in_engine(&engine, "s1", &patch, &[]) else {
            panic!("expected an error");
        };
        assert_eq!(err.0, "INVALID_INPUT");
        assert_eq!(
            engine.with_session("s1", |s| s.name.clone()),
            Some("n".into())
        );
        assert_eq!(engine.with_session("s1", |s| s.allow_git), Some(false));
    }

    #[test]
    fn four_changed_keys_apply_in_one_pass() {
        // FR-2: validate all -> write all in a single mutation.
        let engine = test_engine_with(test_session());
        let patch = SessionSettingsPatch {
            model_id: Some("opus".into()),
            permission_mode: Some("acceptEdits".into()),
            response_mode: Some("concise".into()),
            allow_git: Some(true),
            ..Default::default()
        };
        let (meta, should_persist) =
            update_settings_in_engine(&engine, "s1", &patch, &["opus".to_string()]).unwrap();
        assert!(should_persist);
        assert_eq!(meta.model.id, "opus");
        assert_eq!(meta.permission_mode, "acceptEdits");
        assert_eq!(meta.response_mode, ResponseMode::Concise);
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["allowGit"], true);
        assert!(meta.permission_mode_since > 0);
    }

    #[test]
    fn permission_mode_stamps_since_even_on_a_no_op_re_pick() {
        // FR-4: mirrors switch_permission_mode_in_engine's rule exactly.
        let mut session = test_session();
        session.permission_mode_since = 1;
        let engine = test_engine_with(session);
        let patch = SessionSettingsPatch {
            permission_mode: Some("default".into()),
            ..Default::default()
        };
        let (meta, _) = update_settings_in_engine(&engine, "s1", &patch, &[]).unwrap();
        assert!(meta.permission_mode_since > 1);
    }

    #[test]
    fn re_sending_the_current_value_is_an_idempotent_success() {
        // FR-3: not special-cased — same mutation, same persist+emit signal.
        let engine = test_engine_with(test_session()); // name "n"
        let (meta, should_persist) =
            update_settings_in_engine(&engine, "s1", &patch_with_name("n"), &[]).unwrap();
        assert_eq!(meta.name, "n");
        assert!(should_persist);
    }

    #[test]
    fn effort_clears_through_the_full_pipeline() {
        let mut session = test_session();
        session.effort = Some("high".into());
        let engine = test_engine_with(session);
        let patch = SessionSettingsPatch {
            effort: Some("".into()),
            ..Default::default()
        };
        let (meta, _) = update_settings_in_engine(&engine, "s1", &patch, &[]).unwrap();
        assert_eq!(meta.effort, None);
        assert_eq!(engine.with_session("s1", |s| s.effort.clone()), Some(None));
    }
}

#[cfg(test)]
mod narrowed_tests {
    use super::*;
    use crate::session::testutil::*;
    #[test]
    fn batch_sandbox_selection_is_independent_of_approval_capabilities() {
        for runtime in [
            AgentRuntime::ClaudeCode,
            AgentRuntime::Codex,
            AgentRuntime::Grok,
            AgentRuntime::Pi,
        ] {
            for available in [None, Some(false), Some(true)] {
                let mut session = test_session();
                session.agent_runtime = runtime;
                session.effective_capabilities = available.map(|available| {
                    [(
                        "permissions".into(),
                        adapter::CapabilityState {
                            available,
                            reason: None,
                        },
                    )]
                    .into()
                });
                let engine = test_engine_with(session);
                let patch = SessionSettingsPatch {
                    name: Some("changed".into()),
                    permission_mode: Some("plan".into()),
                    ..Default::default()
                };
                let result = update_settings_in_engine(&engine, "s1", &patch, &[]);
                if runtime == AgentRuntime::Pi {
                    assert_eq!(result.err().unwrap().0, "RUNTIME_UNSUPPORTED");
                    assert_eq!(
                        engine
                            .with_session("s1", |s| (s.name.clone(), s.permission_mode.clone()))
                            .unwrap(),
                        ("n".into(), "default".into())
                    );
                } else {
                    let (meta, persist) = result.unwrap();
                    assert!(persist);
                    assert_eq!(meta.name, "changed");
                    assert_eq!(meta.permission_mode, "plan");
                }
            }
        }
    }

    #[test]
    fn narrowed_settings_reject_entire_patch() {
        for (key, patch) in [
            (
                "modelSwitching",
                SessionSettingsPatch {
                    model_id: Some("opus".into()),
                    ..Default::default()
                },
            ),
            (
                "modelSwitching",
                SessionSettingsPatch {
                    effort: Some("high".into()),
                    ..Default::default()
                },
            ),
            (
                "permissions",
                SessionSettingsPatch {
                    allow_git: Some(true),
                    ..Default::default()
                },
            ),
        ] {
            let mut s = test_session();
            s.effective_capabilities = Some(
                [(
                    key.into(),
                    adapter::CapabilityState {
                        available: false,
                        reason: Some("Disabled".into()),
                    },
                )]
                .into(),
            );
            let engine = test_engine_with(s);
            let patch = SessionSettingsPatch {
                name: Some("changed".into()),
                ..patch
            };
            assert_eq!(
                update_settings_in_engine(&engine, "s1", &patch, &["opus".into()])
                    .err()
                    .unwrap()
                    .0,
                "RUNTIME_UNSUPPORTED"
            );
            assert_eq!(engine.with_session("s1", |s| s.name.clone()).unwrap(), "n");
        }
    }
}
