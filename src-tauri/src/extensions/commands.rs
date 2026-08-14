//! §5 — the `francois:extensions:<verb>` Tauri command surface, amended by
//! `extension-install`: `extensions_probe`/`extensions_launch` are GONE
//! (FR-24), and one command is new — `extensions_consent` (FR-16).
//!
//! Every handler resolves the panel out of the LOADED registry
//! (`ExtensionState.registry`, rebuilt on launch and on `extensions_detect`
//! only — FR-13), refuses before spawning anything if the extension is off
//! (`extensions` FR-7), unconsented (FR-17) or the root does not detect it
//! (FR-12), then delegates. Nothing here parses a manifest, and nothing here
//! composes an argv out of untrusted text.

use super::detect::{detect_cached_locked, normalize_root, NO_ROOT_REASON};
use super::manifest::sanitize_argv_element;
use super::provider::{build_argv, run, ProviderError};
use super::stream::{
    file_rel_path, new_stream_id, process_argv, resolve_under_root, spawn_file_stream,
    spawn_process_stream, valid_token, SourceError,
};
use super::toggles::ToggleEntry;
use super::{
    emit, registry, schema, ConsentState, ExtensionEvent, ExtensionInfo, ExtensionSource,
    ExtensionState, LoadedExtension, PanelData, PanelDefinition, PanelScope, PrimitiveKind, Source,
    EXT_PAGE_SIZE,
};
use crate::ipc::{err, err_detail, ok, AppError, IpcResult};
use serde_json::json;
use std::path::PathBuf;
use tauri::{AppHandle, State};

// ---------- registry (re)loading (FR-1, FR-13, FR-18, FR-19) ----------

/// Rebuild the loaded registry from `~/.francois/extensions/` and reconcile
/// the persisted toggles against it. Called at app setup and by
/// `extensions_detect` — the only two FR-13 triggers.
pub(crate) fn refresh_registry(app: &AppHandle, state: &ExtensionState) {
    let dir = crate::fs_util::extensions_dir();
    if let Some(dir) = dir.as_ref() {
        let _ = crate::fs_util::ensure_dir_0700(dir);
    }
    let loaded: Vec<LoadedExtension> = dir.as_deref().map(registry::scan_dir).unwrap_or_default();

    let mut streams_to_kill: Vec<String> = Vec::new();
    {
        let mut toggles = state.toggles.lock().unwrap();
        toggles.ensure_loaded(app);
        // FR-19: an entry whose directory is gone is dropped.
        toggles.retain_ids(loaded.iter().map(|e| e.id.as_str()));
        // FR-18: a previously-granted consent whose sha no longer matches
        // reverts the extension to disabled, in the same pass.
        for ext in loaded.iter() {
            let Some(sha) = ext.manifest_sha256.as_ref() else {
                continue;
            };
            let entry = toggles.entry(&ext.id);
            let stale = entry
                .consent_sha256
                .as_deref()
                .is_some_and(|consented| consented != sha.as_str());
            if stale && entry.enabled {
                toggles.set_enabled(&ext.id, false);
                streams_to_kill.push(ext.id.clone());
            }
        }
        super::toggles::save(app, toggles.as_map());
    }
    for extension_id in streams_to_kill {
        let killed = state.streams.lock().unwrap().close_extension(&extension_id);
        for stream_id in killed {
            emit(
                app,
                ExtensionEvent::StreamEnded {
                    stream_id,
                    exit_code: None,
                },
            );
        }
    }

    // FR-13: a predicate is part of what a manifest declares, so a rescan that
    // changes one must invalidate every cached detection for it — a per-root
    // `invalidate` (what `extensions_detect` also does, for the queried root)
    // is not enough when the SAME extension is cached under other roots too.
    let mut registry = state.registry.lock().unwrap();
    let predicate_changed = loaded.iter().any(|ext| {
        registry
            .iter()
            .find(|old| old.id == ext.id)
            .is_none_or(|old| old.predicate != ext.predicate)
    });
    if predicate_changed {
        state.detect.lock().unwrap().invalidate_all();
    }
    *registry = loaded;
}

fn consent_state_of(entry: &ToggleEntry, ext: &LoadedExtension) -> ConsentState {
    match (&entry.consent_sha256, &ext.manifest_sha256) {
        (None, _) => ConsentState::Never,
        (Some(consented), Some(current)) if consented == current => ConsentState::Granted,
        (Some(_), _) => ConsentState::Stale,
    }
}

// ---------- shared resolution ----------

/// FR-51/belt-and-braces: the argv joined into `detail.command` (and
/// `detail.argv0`) crosses IPC even on the error path, so it gets the same
/// `sanitize_argv_element` scrub `declared_commands` applies on the consent
/// path — a manifest-controlled bidi override or zero-width char must not
/// reach the renderer unsanitized just because the provider failed.
fn sanitized_command(argv: &[String]) -> String {
    argv.iter()
        .map(|a| sanitize_argv_element(a))
        .collect::<Vec<_>>()
        .join(" ")
}

fn provider_error<T: serde::Serialize>(e: ProviderError, argv: &[String]) -> IpcResult<T> {
    let command = sanitized_command(argv);
    match e {
        ProviderError::Missing { argv0 } => {
            let argv0 = sanitize_argv_element(&argv0);
            err_detail(
                "EXT_PROVIDER_MISSING",
                format!("{argv0} not found on PATH"),
                json!({ "argv0": argv0, "command": command }),
            )
        }
        ProviderError::Timeout { timeout_ms } => err_detail(
            "EXT_PROVIDER_TIMEOUT",
            format!("timed out after {}s", timeout_ms / 1_000),
            json!({ "timeoutMs": timeout_ms, "command": command }),
        ),
        ProviderError::Exit { code, stderr } => err_detail(
            "EXT_PROVIDER_EXIT",
            format!("exited {code}"),
            json!({ "code": code, "stderr": stderr, "command": command }),
        ),
        ProviderError::Capped { cap_bytes } => err_detail(
            "EXT_OUTPUT_CAPPED",
            format!("output exceeded {} MiB", cap_bytes / (1024 * 1024)),
            json!({ "capBytes": cap_bytes, "command": command }),
        ),
    }
}

fn spawn_error<T: serde::Serialize>(e: &std::io::Error, argv: &[String]) -> IpcResult<T> {
    let argv0 = sanitize_argv_element(&argv[0]);
    let command = sanitized_command(argv);
    let message = if e.kind() == std::io::ErrorKind::NotFound {
        format!("{argv0} not found on PATH")
    } else {
        format!("{argv0} could not be started: {e}")
    };
    err_detail(
        "EXT_PROVIDER_MISSING",
        message,
        json!({ "argv0": argv0, "command": command, "reason": e.to_string() }),
    )
}

fn fleet_cwd() -> Option<PathBuf> {
    dirs::home_dir()
}

/// The full FR-12..FR-14 answer for one root, off the CACHED registry (no
/// rescan — FR-13 says launch/`extensions_detect` only).
fn list_impl(app: &AppHandle, state: &ExtensionState, root: Option<&str>) -> Vec<ExtensionInfo> {
    let registry = state.registry.lock().unwrap();
    let normalized = root.map(normalize_root);
    let mut toggles = state.toggles.lock().unwrap();
    toggles.ensure_loaded(app);

    registry
        .iter()
        .map(|ext| {
            let entry = toggles.entry(&ext.id);
            let consent = consent_state_of(&entry, ext);
            let effective_enabled = entry.enabled && consent == ConsentState::Granted;

            let (detected, undetected_reason) = if ext.manifest_error.is_some() {
                (false, None)
            } else {
                match normalized.as_ref() {
                    Some(root) => {
                        let d = detect_cached_locked(&state.detect, ext, root, effective_enabled);
                        (d.detected, d.reason)
                    }
                    None => (false, Some(NO_ROOT_REASON.to_string())),
                }
            };

            ExtensionInfo {
                id: ext.id.clone(),
                label: ext.label.clone(),
                enabled: effective_enabled,
                consent,
                detected,
                undetected_reason,
                min_version_label: ext.min_version_label.clone(),
                source: ExtensionSource {
                    dir: ext.dir.to_string_lossy().to_string(),
                    // FR-18: what the consent dialog echoes back — the empty
                    // string only when the manifest could not be read at all.
                    manifest_sha256: ext.manifest_sha256.clone().unwrap_or_default(),
                    declared_commands: ext.declared_commands.clone(),
                },
                predicate: clone_predicate(&ext.predicate),
                panels: if ext.manifest_error.is_some() {
                    Vec::new()
                } else {
                    ext.panels.iter().map(|p| p.to_info()).collect()
                },
                manifest_error: ext.manifest_error.clone(),
            }
        })
        .collect()
}

fn clone_predicate(p: &super::DetectPredicate) -> super::DetectPredicate {
    match p {
        super::DetectPredicate::PathExists { path } => {
            super::DetectPredicate::PathExists { path: path.clone() }
        }
        super::DetectPredicate::PathJsonEquals {
            path,
            pointer,
            equals,
        } => super::DetectPredicate::PathJsonEquals {
            path: path.clone(),
            pointer: pointer.clone(),
            equals: equals.clone(),
        },
        super::DetectPredicate::CommandSucceeds { argv } => {
            super::DetectPredicate::CommandSucceeds { argv: argv.clone() }
        }
    }
}

fn effective_enabled(state: &ExtensionState, app: &AppHandle, ext: &LoadedExtension) -> bool {
    let mut toggles = state.toggles.lock().unwrap();
    toggles.ensure_loaded(app);
    let entry = toggles.entry(&ext.id);
    entry.enabled && consent_state_of(&entry, ext) == ConsentState::Granted
}

enum PanelRoot {
    Resolved(PathBuf),
    NoSession,
    NotDetected(String),
    NoHome,
}

fn panel_root(
    state: &ExtensionState,
    ext: &LoadedExtension,
    panel: &PanelDefinition,
    root: Option<&str>,
    enabled: bool,
) -> PanelRoot {
    if panel.scope == PanelScope::Fleet {
        return match fleet_cwd() {
            Some(home) => PanelRoot::Resolved(home),
            None => PanelRoot::NoHome,
        };
    }
    let Some(root) = root else {
        return PanelRoot::NoSession;
    };
    let normalized = normalize_root(root);
    let detection = detect_cached_locked(&state.detect, ext, &normalized, enabled);
    if detection.detected {
        PanelRoot::Resolved(normalized)
    } else {
        PanelRoot::NotDetected(
            detection
                .reason
                .unwrap_or_else(|| "not available here".to_string()),
        )
    }
}

fn not_detected<T: serde::Serialize>(reason: String) -> IpcResult<T> {
    err_detail(
        "EXT_NOT_DETECTED",
        reason.clone(),
        json!({ "reason": reason }),
    )
}

fn no_home<T: serde::Serialize>(command: String) -> IpcResult<T> {
    err_detail(
        "EXT_NOT_DETECTED",
        "no home directory",
        json!({ "command": command }),
    )
}

fn not_enabled<T: serde::Serialize>(extension_id: &str) -> IpcResult<T> {
    err_detail(
        "EXT_NOT_ENABLED",
        format!("{extension_id} is turned off"),
        json!({ "extensionId": extension_id }),
    )
}

fn not_consented<T: serde::Serialize>(extension_id: &str) -> IpcResult<T> {
    err_detail(
        "EXT_NOT_CONSENTED",
        format!("{extension_id} has not been reviewed and enabled"),
        json!({ "extensionId": extension_id }),
    )
}

// ---------- francois:extensions:list / setEnabled / detect / consent ----------

/// francois:extensions:list (FR-12, FR-15, FR-14).
#[tauri::command(async)]
pub fn extensions_list(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    root: Option<String>,
) -> IpcResult<Vec<ExtensionInfo>> {
    ok(list_impl(&app, &state, root.as_deref()))
}

/// francois:extensions:setEnabled (FR-15..FR-20). `EXT_NOT_CONSENTED` when
/// asked to enable an extension whose consent is not `granted` — the frontend
/// must route through `extensions_consent` first.
#[tauri::command(async)]
pub fn extensions_set_enabled(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    extension_id: String,
    enabled: bool,
    root: Option<String>,
) -> IpcResult<Vec<ExtensionInfo>> {
    let registry = state.registry.lock().unwrap();
    let Some(ext) = registry::extension(&registry, &extension_id) else {
        return err("INVALID_INPUT", "no such extension");
    };
    if enabled {
        let mut toggles = state.toggles.lock().unwrap();
        toggles.ensure_loaded(&app);
        let entry = toggles.entry(&extension_id);
        if consent_state_of(&entry, ext) != ConsentState::Granted {
            return not_consented(&extension_id);
        }
        toggles.set_enabled(&extension_id, true);
        super::toggles::save(&app, toggles.as_map());
        drop(toggles);
        drop(registry);
        return ok(list_impl(&app, &state, root.as_deref()));
    }
    drop(registry);
    {
        let mut toggles = state.toggles.lock().unwrap();
        toggles.ensure_loaded(&app);
        toggles.set_enabled(&extension_id, false);
        super::toggles::save(&app, toggles.as_map());
    }
    // FR-8 (extensions): within the same turn as the toggle write — every
    // live stream the extension owns is killed before this call returns.
    let killed = state.streams.lock().unwrap().close_extension(&extension_id);
    for stream_id in killed {
        emit(
            &app,
            ExtensionEvent::StreamEnded {
                stream_id,
                exit_code: None,
            },
        );
    }
    ok(list_impl(&app, &state, root.as_deref()))
}

/// francois:extensions:detect (FR-13) — re-scans the manifest directory,
/// invalidates this root's cache entry, and re-runs every predicate.
#[tauri::command(async)]
pub fn extensions_detect(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    root: String,
) -> IpcResult<Vec<ExtensionInfo>> {
    refresh_registry(&app, &state);
    let normalized = normalize_root(&root);
    state.detect.lock().unwrap().invalidate(&normalized);
    ok(list_impl(&app, &state, Some(&root)))
}

/// Pre-flight for `extensions_consent`: refuses a manifest that failed to
/// load (never offerable for consent regardless of the sha match) and a
/// stale sha, before any toggle state is touched. `Ok(())` means the caller
/// may proceed to grant consent.
fn check_consentable(ext: &LoadedExtension, manifest_sha256: &str) -> Result<(), AppError> {
    if ext.manifest_error.is_some() {
        return Err(AppError {
            code: "INVALID_INPUT".into(),
            message: "this manifest failed to load".into(),
            detail: None,
        });
    }
    let Some(current_sha) = ext.manifest_sha256.as_deref() else {
        return Err(AppError {
            code: "INVALID_INPUT".into(),
            message: "this manifest failed to load".into(),
            detail: None,
        });
    };
    if current_sha != manifest_sha256 {
        return Err(AppError {
            code: "EXT_CONSENT_STALE".into(),
            message: "the manifest changed since this dialog opened".into(),
            detail: Some(json!({ "extensionId": ext.id })),
        });
    }
    Ok(())
}

/// francois:extensions:consent (FR-16) — the only way `enabled` becomes true
/// for a `never`/`stale` extension.
#[tauri::command(async)]
pub fn extensions_consent(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    extension_id: String,
    manifest_sha256: String,
    root: Option<String>,
) -> IpcResult<Vec<ExtensionInfo>> {
    let registry = state.registry.lock().unwrap();
    let Some(ext) = registry::extension(&registry, &extension_id) else {
        return err("INVALID_INPUT", "no such extension");
    };
    if let Err(e) = check_consentable(ext, &manifest_sha256) {
        return IpcResult::Err {
            ok: false,
            error: e,
        };
    }
    drop(registry);
    {
        let mut toggles = state.toggles.lock().unwrap();
        toggles.ensure_loaded(&app);
        toggles.grant_consent(&extension_id, &manifest_sha256);
        super::toggles::save(&app, toggles.as_map());
    }
    ok(list_impl(&app, &state, root.as_deref()))
}

// ---------- francois:extensions:panel ----------

/// francois:extensions:panel.
#[tauri::command(async)]
pub fn extensions_panel(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    panel_id: String,
    root: Option<String>,
    offset: Option<u32>,
    // FR-31: pagination is a fixed page size (`EXT_PAGE_SIZE`) — a client-
    // supplied limit would let one panel diverge from the schema's declared
    // page contract, so it is accepted (for forward compatibility with the
    // request shape) but intentionally ignored.
    _limit: Option<u32>,
) -> IpcResult<PanelData> {
    let registry = state.registry.lock().unwrap();
    let Some((ext, panel)) = registry::panel(&registry, &panel_id) else {
        return err("EXT_PANEL_NOT_FOUND", "no such panel");
    };
    let enabled = effective_enabled(&state, &app, ext);
    if !enabled {
        return not_enabled(&ext.id);
    }
    let Some(provider) = panel.provider.as_ref() else {
        return err(
            "EXT_PANEL_NOT_FOUND",
            "a log-tail panel opens a stream, it does not resolve a payload",
        );
    };
    let limit = EXT_PAGE_SIZE;
    let offset = offset.unwrap_or(0);
    let cwd = match panel_root(&state, ext, panel, root.as_deref(), enabled) {
        PanelRoot::Resolved(path) => path,
        PanelRoot::NoSession => return not_detected(NO_ROOT_REASON.to_string()),
        PanelRoot::NotDetected(reason) => return not_detected(reason),
        PanelRoot::NoHome => {
            return no_home(build_argv(provider, panel.paginated, offset, limit).join(" "))
        }
    };
    let argv = build_argv(provider, panel.paginated, offset, limit);
    match run(&argv, &cwd) {
        Ok(stdout) => match schema::panel_data(panel, &stdout, offset, limit) {
            Ok(data) => ok(data),
            Err(_) => err_detail(
                "EXT_SCHEMA_INVALID",
                "unexpected output shape",
                json!({ "command": argv.join(" ") }),
            ),
        },
        Err(e) => provider_error(e, &argv),
    }
}

// ---------- francois:extensions:openStream / closeStream ----------

/// francois:extensions:openStream.
#[tauri::command(async)]
pub fn extensions_open_stream(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    panel_id: String,
    root: Option<String>,
    token: Option<String>,
) -> IpcResult<String> {
    let registry = state.registry.lock().unwrap();
    let Some((ext, panel)) = registry::panel(&registry, &panel_id) else {
        return err("EXT_PANEL_NOT_FOUND", "no such panel");
    };
    let enabled = effective_enabled(&state, &app, ext);
    if !enabled {
        return not_enabled(&ext.id);
    }
    if panel.primitive != PrimitiveKind::LogTail {
        return err("EXT_PANEL_NOT_FOUND", "this panel has no stream");
    }
    let Some(source) = panel.source.as_ref() else {
        return err("EXT_PANEL_NOT_FOUND", "this panel declares no source");
    };
    let token = match (panel.token_source.as_ref(), token.as_deref()) {
        (Some(_), Some(t)) if valid_token(t) => Some(t.to_string()),
        (Some(_), _) => {
            return err_detail(
                "EXT_INVALID_TOKEN",
                "that row cannot be used as a log target",
                json!({ "panelId": panel_id }),
            )
        }
        (None, _) => None,
    };
    let cwd = match panel_root(&state, ext, panel, root.as_deref(), enabled) {
        PanelRoot::Resolved(path) => path,
        PanelRoot::NoSession => return not_detected(NO_ROOT_REASON.to_string()),
        PanelRoot::NotDetected(reason) => return not_detected(reason),
        PanelRoot::NoHome => {
            let command = match source {
                Source::File { path_template } => {
                    file_rel_path(path_template, token.as_deref().unwrap_or_default())
                }
                Source::Process { .. } => process_argv(source, token.as_deref())
                    .map(|a| a.join(" "))
                    .unwrap_or_default(),
            };
            return no_home(command);
        }
    };

    let stream_id = new_stream_id();
    match source {
        Source::File { path_template } => {
            let rel = file_rel_path(path_template, token.as_deref().unwrap_or_default());
            match resolve_under_root(&cwd, &rel) {
                Ok(_) => {}
                Err(SourceError::RootMissing) => {
                    return err_detail(
                        "EXT_PATH_OUTSIDE_ROOT",
                        "the project root is no longer available",
                        json!({ "panelId": panel_id }),
                    );
                }
                Err(SourceError::OutsideRoot) => {
                    return err_detail(
                        "EXT_PATH_OUTSIDE_ROOT",
                        "that log lives outside the project root",
                        json!({ "panelId": panel_id }),
                    );
                }
            }
            let stop = spawn_file_stream(&app, &stream_id, cwd.clone(), rel);
            state
                .streams
                .lock()
                .unwrap()
                .open(&stream_id, &panel.id, &ext.id, stop, None);
        }
        Source::Process { .. } => {
            let Some(argv) = process_argv(source, token.as_deref()) else {
                return err("EXT_PANEL_NOT_FOUND", "this panel declares no source");
            };
            match spawn_process_stream(&app, &stream_id, &argv, &cwd) {
                Ok((stop, child)) => state.streams.lock().unwrap().open(
                    &stream_id,
                    &panel.id,
                    &ext.id,
                    stop,
                    Some(child),
                ),
                Err(e) => return spawn_error(&e, &argv),
            }
        }
    }
    emit(
        &app,
        ExtensionEvent::StreamStarted {
            stream_id: stream_id.clone(),
            panel_id: panel.id.clone(),
        },
    );
    ok(stream_id)
}

/// francois:extensions:closeStream.
#[tauri::command(async)]
pub fn extensions_close_stream(
    state: State<'_, ExtensionState>,
    stream_id: String,
) -> IpcResult<()> {
    if state.streams.lock().unwrap().close(&stream_id) {
        ok(())
    } else {
        err("EXT_STREAM_NOT_FOUND", "no such stream")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn error_of<T: serde::Serialize>(result: IpcResult<T>) -> Value {
        serde_json::to_value(result).unwrap()
    }

    #[test]
    fn a_missing_provider_names_the_binary_and_the_command() {
        let argv = vec!["cohorte".to_string(), "panels".to_string()];
        let value = error_of(provider_error::<PanelData>(
            ProviderError::Missing {
                argv0: "cohorte".into(),
            },
            &argv,
        ));
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["error"]["code"], json!("EXT_PROVIDER_MISSING"));
        assert_eq!(
            value["error"]["message"],
            json!("cohorte not found on PATH")
        );
        assert_eq!(value["error"]["detail"]["argv0"], json!("cohorte"));
        assert_eq!(value["error"]["detail"]["command"], json!("cohorte panels"));
    }

    #[test]
    fn error_detail_argv_is_sanitized_of_bidi_and_zero_width_chars() {
        // belt-and-braces: a manifest-controlled argv element carrying a
        // bidi override or zero-width char must not reach `detail.command`/
        // `detail.argv0` unsanitized, even on the error path.
        let dirty_argv0 = "cohort\u{202e}e";
        let argv = vec![dirty_argv0.to_string(), "pa\u{200b}nels".to_string()];

        let missing = error_of(provider_error::<PanelData>(
            ProviderError::Missing {
                argv0: dirty_argv0.to_string(),
            },
            &argv,
        ));
        assert_eq!(missing["error"]["detail"]["argv0"], json!("cohorte"));
        assert_eq!(
            missing["error"]["detail"]["command"],
            json!("cohorte panels")
        );
        assert_eq!(
            missing["error"]["message"],
            json!("cohorte not found on PATH")
        );

        let spawn = error_of(spawn_error::<PanelData>(
            &std::io::Error::new(std::io::ErrorKind::NotFound, "not found"),
            &argv,
        ));
        assert_eq!(spawn["error"]["detail"]["argv0"], json!("cohorte"));
        assert_eq!(spawn["error"]["detail"]["command"], json!("cohorte panels"));
    }

    #[test]
    fn a_non_zero_exit_carries_its_code_and_stderr() {
        let argv = vec![
            "cohorte".to_string(),
            "panels".to_string(),
            "health".to_string(),
            "--json".to_string(),
        ];
        let value = error_of(provider_error::<PanelData>(
            ProviderError::Exit {
                code: 1,
                stderr: "unknown command: panels".into(),
            },
            &argv,
        ));
        assert_eq!(value["error"]["code"], json!("EXT_PROVIDER_EXIT"));
        assert_eq!(value["error"]["message"], json!("exited 1"));
        assert_eq!(value["error"]["detail"]["code"], json!(1));
        assert_eq!(
            value["error"]["detail"]["stderr"],
            json!("unknown command: panels")
        );
    }

    #[test]
    fn a_timeout_and_a_cap_report_their_own_limits() {
        let argv = vec!["docker".to_string(), "ps".to_string()];
        let timeout = error_of(provider_error::<PanelData>(
            ProviderError::Timeout { timeout_ms: 10_000 },
            &argv,
        ));
        assert_eq!(timeout["error"]["code"], json!("EXT_PROVIDER_TIMEOUT"));
        let capped = error_of(provider_error::<PanelData>(
            ProviderError::Capped {
                cap_bytes: 4 * 1024 * 1024,
            },
            &argv,
        ));
        assert_eq!(capped["error"]["code"], json!("EXT_OUTPUT_CAPPED"));
    }

    #[test]
    fn a_disabled_extension_is_refused_by_code() {
        let value = error_of(not_enabled::<PanelData>("docker"));
        assert_eq!(value["error"]["code"], json!("EXT_NOT_ENABLED"));
        assert_eq!(value["error"]["detail"]["extensionId"], json!("docker"));
    }

    // FR-17: enabling without consent is a distinct, named refusal.
    #[test]
    fn an_unconsented_enable_is_refused_by_code() {
        let value = error_of(not_consented::<Vec<ExtensionInfo>>("k8s"));
        assert_eq!(value["error"]["code"], json!("EXT_NOT_CONSENTED"));
    }

    #[test]
    fn an_undetected_root_reports_its_reason() {
        let value = error_of(not_detected::<PanelData>("not a git repository".into()));
        assert_eq!(value["error"]["code"], json!("EXT_NOT_DETECTED"));
        assert_eq!(value["error"]["message"], json!("not a git repository"));
    }

    #[test]
    fn a_successful_panel_resolves_the_contract_envelope() {
        let value = serde_json::to_value(ok(PanelData::StatRow { tiles: vec![] })).unwrap();
        assert_eq!(
            value,
            json!({ "ok": true, "data": { "primitive": "stat-row", "tiles": [] } })
        );
    }

    #[test]
    fn an_unknown_panel_id_is_not_found() {
        let value = error_of(err::<PanelData>("EXT_PANEL_NOT_FOUND", "no such panel"));
        assert_eq!(value["error"]["code"], json!("EXT_PANEL_NOT_FOUND"));
    }

    #[test]
    fn a_missing_home_directory_still_carries_a_command() {
        let value = error_of(no_home::<PanelData>("cohorte panels health --json".into()));
        assert_eq!(value["error"]["code"], json!("EXT_NOT_DETECTED"));
        assert_eq!(value["error"]["message"], json!("no home directory"));
        assert_eq!(
            value["error"]["detail"]["command"],
            json!("cohorte panels health --json")
        );
    }

    // FR-15..FR-18: the consent-state derivation itself.
    #[test]
    fn consent_state_is_derived_from_the_stored_and_current_sha() {
        let ext = LoadedExtension {
            id: "git".into(),
            dir: PathBuf::from("/tmp/git"),
            label: "git".into(),
            min_version_label: None,
            predicate: super::super::DetectPredicate::PathExists {
                path: ".git".into(),
            },
            panels: vec![],
            declared_commands: vec![],
            manifest_sha256: Some("abc".into()),
            manifest_error: None,
        };
        assert_eq!(
            consent_state_of(&ToggleEntry::default(), &ext),
            ConsentState::Never
        );
        assert_eq!(
            consent_state_of(
                &ToggleEntry {
                    enabled: true,
                    consent_sha256: Some("abc".into())
                },
                &ext
            ),
            ConsentState::Granted
        );
        assert_eq!(
            consent_state_of(
                &ToggleEntry {
                    enabled: false,
                    consent_sha256: Some("old".into())
                },
                &ext
            ),
            ConsentState::Stale
        );
    }

    // REVIEW round 4: consent must not be grantable for a manifest that
    // failed to load, even when the caller happens to echo back the exact
    // sha256 of the (invalid) bytes on disk — a broken manifest has no
    // panels/predicate to trust, so `EXT_MANIFEST_INVALID` extensions must
    // never reach `Granted`.
    #[test]
    fn consent_is_refused_for_an_extension_with_a_manifest_error() {
        let ext = LoadedExtension {
            id: "broken".into(),
            dir: PathBuf::from("/tmp/broken"),
            label: "broken".into(),
            min_version_label: None,
            predicate: super::super::DetectPredicate::PathExists {
                path: String::new(),
            },
            panels: vec![],
            declared_commands: vec![],
            // The manifest bytes still hash even when they fail validation
            // (see `manifest::load_one`'s `failed` closure) — proving the
            // refusal does NOT depend on the sha being absent or mismatched.
            manifest_sha256: Some("deadbeef".into()),
            manifest_error: Some(AppError {
                code: "EXT_MANIFEST_INVALID".into(),
                message: "invalid manifest".into(),
                detail: None,
            }),
        };
        let result = check_consentable(&ext, "deadbeef");
        let e = result.expect_err("a manifest_error must refuse consent");
        assert_eq!(e.code, "INVALID_INPUT");
    }

    // REGRESSION (contract): `ExtensionSource.manifestSha256` is what the
    // consent dialog echoes back in `ConsentRequest`. It used not to cross the
    // boundary at all, so the frontend sent an empty hash and
    // `extensions_consent`'s equality check could never pass —
    // EXT_CONSENT_STALE forever, consent ungrantable end-to-end.
    //
    // Proven against a REAL manifest on disk: the hash the wire carries is
    // byte-for-byte the one `extensions_consent` compares `manifest_sha256`
    // against, and granting with it lands on `Granted`.
    #[test]
    fn the_wire_manifest_sha_is_exactly_what_consent_accepts() {
        let root = crate::extensions::testutil::tmp_root("consent-wire-sha");
        let dir = root.join("k8s");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("extension.json"),
            br#"{"manifest":1,"detect":{"kind":"pathExists","path":"k8s"},"panels":[]}"#,
        )
        .unwrap();
        let ext = super::super::manifest::load_one(&dir).unwrap();
        assert!(ext.manifest_error.is_none(), "{:?}", ext.manifest_error);

        // The value `list_impl` puts on the wire...
        let wire = ExtensionSource {
            dir: ext.dir.to_string_lossy().to_string(),
            manifest_sha256: ext.manifest_sha256.clone().unwrap_or_default(),
            declared_commands: ext.declared_commands.clone(),
        };
        assert!(!wire.manifest_sha256.is_empty(), "the hash must cross IPC");
        assert_eq!(wire.manifest_sha256.len(), 64, "hex-encoded sha256");
        // ...is exactly what `extensions_consent` compares against (it resolves
        // EXT_CONSENT_STALE on any inequality here).
        assert_eq!(
            ext.manifest_sha256.as_deref(),
            Some(wire.manifest_sha256.as_str())
        );

        // Happy path end-to-end: grant with the wire hash => Granted.
        let mut toggles = super::super::toggles::Toggles::default();
        toggles.grant_consent(&ext.id, &wire.manifest_sha256);
        assert_eq!(
            consent_state_of(&toggles.entry(&ext.id), &ext),
            ConsentState::Granted
        );
        assert!(toggles.entry(&ext.id).enabled);

        // The old (broken) empty hash must NOT be accepted — that is the very
        // mismatch `extensions_consent` refuses with EXT_CONSENT_STALE.
        let mut empty_consent = super::super::toggles::Toggles::default();
        empty_consent.grant_consent(&ext.id, "");
        assert_eq!(
            consent_state_of(&empty_consent.entry(&ext.id), &ext),
            ConsentState::Stale
        );
    }

    // An unloadable manifest carries the EMPTY STRING rather than omitting the
    // field — consent is not offerable for it anyway (`manifestError` is set
    // and `panels` is empty), but the shape must stay contract-faithful.
    #[test]
    fn an_unloadable_manifest_puts_an_empty_hash_on_the_wire() {
        let ext = LoadedExtension {
            id: "broken".into(),
            dir: PathBuf::from("/tmp/broken"),
            label: "broken".into(),
            min_version_label: None,
            predicate: super::super::DetectPredicate::PathExists {
                path: String::new(),
            },
            panels: vec![],
            declared_commands: vec![],
            manifest_sha256: None,
            manifest_error: None,
        };
        let wire = ExtensionSource {
            dir: ext.dir.to_string_lossy().to_string(),
            manifest_sha256: ext.manifest_sha256.clone().unwrap_or_default(),
            declared_commands: ext.declared_commands.clone(),
        };
        assert_eq!(wire.manifest_sha256, "");
        // Still SERIALIZED, never skipped — the frontend reads a string.
        let value = serde_json::to_value(&wire).unwrap();
        assert_eq!(value["manifestSha256"], json!(""));
    }
}
