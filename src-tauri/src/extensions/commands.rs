//! §5 — the `francois:extensions:<verb>` Tauri command surface.
//!
//! Every handler is the same shape: resolve the panel out of the COMPILED
//! registry, refuse before spawning anything if the extension is off (FR-7) or
//! the root does not detect it (FR-3), then delegate. Nothing here parses a
//! definition, and nothing here composes an argv out of a string.
//!
//! Every failure names its cause and carries the RESOLVED COMMAND in its detail,
//! because FR-49 renders exactly that under the message — the frontend must
//! never have to reconstruct what Francois ran.

use super::detect::{detect_cached_locked, normalize_root, Detection, NO_ROOT_REASON};
use super::provider::{build_argv, run, ProviderError};
use super::stream::{
    file_rel_path, new_stream_id, process_argv, resolve_under_root, spawn_file_stream,
    spawn_process_stream, valid_token, SourceError,
};
use super::{
    emit, registry, schema, toggles, ExtensionEvent, ExtensionInfo, ExtensionState, PanelData,
    PanelDefinition, PanelScope, PrimitiveKind, ProbeResult, Source, EXT_PAGE_SIZE,
};
use crate::ipc::{err, err_detail, ok, IpcResult};
use serde_json::json;
use std::path::PathBuf;
use tauri::{AppHandle, State};

// ---------- shared resolution ----------

/// FR-24/FR-21/FR-22 → the wire. Each message names its cause in the copy §7
/// prescribes, over the resolved command the frontend renders in monospace.
fn provider_error<T: serde::Serialize>(e: ProviderError, argv: &[String]) -> IpcResult<T> {
    let command = argv.join(" ");
    match e {
        ProviderError::Missing { argv0 } => err_detail(
            "EXT_PROVIDER_MISSING",
            format!("{argv0} not found on PATH"),
            json!({ "argv0": argv0, "command": command }),
        ),
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

/// FR-24 for a `log-tail` process source (`extensions_open_stream`'s own spawn,
/// distinct from a provider `run()` call). The contract has no dedicated code
/// for this path, so it still wears `EXT_PROVIDER_MISSING` — but unlike a bare
/// `ProviderError::Missing`, the message and detail carry the REAL `io::Error`
/// (e.g. permission-denied), never an assumed "not found on PATH" when that
/// was not the actual cause.
fn spawn_error<T: serde::Serialize>(e: &std::io::Error, argv: &[String]) -> IpcResult<T> {
    let argv0 = argv[0].clone();
    let command = argv.join(" ");
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

/// FR-53: a fleet-scoped panel takes no root and runs in the user's home — the
/// same cwd discipline `usage.rs` uses for its own app-scoped probe.
fn fleet_cwd() -> Option<PathBuf> {
    dirs::home_dir()
}

/// The full FR-1..FR-11 answer for one root. `None` ⇒ FR-14: no active session,
/// so every extension reports `detected: false` WITH a reason. This governs
/// whether a NEW tab is offered; it never closes an open one.
fn list_impl(app: &AppHandle, state: &ExtensionState, root: Option<&str>) -> Vec<ExtensionInfo> {
    let enabled: Vec<bool> = {
        let mut toggles = state.toggles.lock().unwrap();
        toggles.ensure_loaded(app);
        registry::REGISTRY
            .iter()
            .map(|ext| toggles.is_enabled(ext.id))
            .collect()
    };
    let normalized = root.map(normalize_root);
    // CRITICAL: never hold `state.detect` across this loop — a cache miss runs
    // `evaluate` (up to the FR-21 10s `docker info` exec) with the lock
    // released, so it cannot block every other extensions_list/detect/panel
    // call in the app for up to 10s. `detect_cached_locked` re-acquires the
    // lock only to read a hit or record a fresh result.
    registry::REGISTRY
        .iter()
        .zip(enabled)
        .map(|(ext, enabled)| {
            let detection = match normalized.as_ref() {
                Some(root) => detect_cached_locked(&state.detect, ext, root, enabled),
                None => Detection {
                    detected: false,
                    reason: Some(NO_ROOT_REASON.to_string()),
                },
            };
            ExtensionInfo {
                id: ext.id.to_string(),
                label: ext.label.to_string(),
                enabled,
                detected: detection.detected,
                undetected_reason: detection.reason,
                min_version_label: ext.min_version_label.map(str::to_string),
                panels: ext.panels.iter().map(|p| p.to_info()).collect(),
            }
        })
        .collect()
}

fn is_enabled(app: &AppHandle, state: &ExtensionState, extension_id: &str) -> bool {
    let mut toggles = state.toggles.lock().unwrap();
    toggles.ensure_loaded(app);
    toggles.is_enabled(extension_id)
}

/// The cwd a panel's provider (or stream) runs in, or the error that stops it
/// before anything is spawned.
enum PanelRoot {
    Resolved(PathBuf),
    NoSession,
    NotDetected(String),
    NoHome,
}

fn panel_root(
    app: &AppHandle,
    state: &ExtensionState,
    panel: &PanelDefinition,
    extension_id: &str,
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
    let Some(ext) = registry::extension(extension_id) else {
        return PanelRoot::NotDetected("unknown extension".to_string());
    };
    let detection = detect_cached_locked(&state.detect, ext, &normalized, enabled);
    let _ = app;
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

/// FR-49/FR-53: the `EXT_NOT_DETECTED` raised when `dirs::home_dir()` itself
/// fails still carries a `command` detail, like every other in-section
/// failure — here it names the provider/source binary that would have run
/// under the (unresolvable) home directory, since no cwd was ever reached.
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

// ---------- francois:extensions:list / setEnabled / detect ----------

/// francois:extensions:list (FR-3, FR-6, FR-11, FR-14, FR-56).
#[tauri::command(async)]
pub fn extensions_list(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    root: Option<String>,
) -> IpcResult<Vec<ExtensionInfo>> {
    ok(list_impl(&app, &state, root.as_deref()))
}

/// francois:extensions:setEnabled (FR-6, FR-7, FR-8). Returns the FULL refreshed
/// list, so the frontend never re-queries to learn what changed — evaluated
/// against the CALLER-SUPPLIED root (`SetExtensionEnabledRequest.root`), never a
/// remembered one, so a toggle from one project's tab can never evaluate
/// against whichever root a different session queried most recently.
#[tauri::command(async)]
pub fn extensions_set_enabled(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    extension_id: String,
    enabled: bool,
    root: Option<String>,
) -> IpcResult<Vec<ExtensionInfo>> {
    if registry::extension(&extension_id).is_none() {
        return err("INVALID_INPUT", "no such extension");
    }
    {
        let mut toggles = state.toggles.lock().unwrap();
        toggles.ensure_loaded(&app);
        toggles.set(&extension_id, enabled);
        toggles::save(&app, toggles.as_map());
    }
    if !enabled {
        // FR-8: within the same turn as the toggle write — every live stream the
        // extension owns is killed before this call returns.
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
    }
    ok(list_impl(&app, &state, root.as_deref()))
}

/// francois:extensions:detect (FR-4, FR-57) — invalidates this root's cache
/// entry and re-runs every predicate, including the `docker info` exec.
#[tauri::command(async)]
pub fn extensions_detect(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    root: String,
) -> IpcResult<Vec<ExtensionInfo>> {
    let normalized = normalize_root(&root);
    state.detect.lock().unwrap().invalidate(&normalized);
    ok(list_impl(&app, &state, Some(&root)))
}

// ---------- francois:extensions:panel ----------

/// francois:extensions:panel (FR-18..FR-25, FR-31..FR-33).
#[tauri::command(async)]
pub fn extensions_panel(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    panel_id: String,
    root: Option<String>,
    offset: Option<u32>,
    // FR-31: page size is a fixed 100 rows — never caller-negotiable.
    _limit: Option<u32>,
) -> IpcResult<PanelData> {
    let Some((ext, panel)) = registry::panel(&panel_id) else {
        return err("EXT_PANEL_NOT_FOUND", "no such panel");
    };
    // FR-7: before any process is created.
    let enabled = is_enabled(&app, &state, ext.id);
    if !enabled {
        return not_enabled(ext.id);
    }
    let Some(provider) = panel.provider.as_ref() else {
        return err(
            "EXT_PANEL_NOT_FOUND",
            "a log-tail panel opens a stream, it does not resolve a payload",
        );
    };
    let limit = EXT_PAGE_SIZE;
    let offset = offset.unwrap_or(0);
    let cwd = match panel_root(&app, &state, panel, ext.id, root.as_deref(), enabled) {
        PanelRoot::Resolved(path) => path,
        // FR-14: a project-scoped panel with no session reads `select a session`.
        PanelRoot::NoSession => return not_detected(NO_ROOT_REASON.to_string()),
        // FR-13: the tab stays open; this is what its body renders.
        PanelRoot::NotDetected(reason) => return not_detected(reason),
        // FR-49: the command detail reflects the actually-requested page, not
        // always page 1 — a page-2+ request on a missing home still reports
        // the argv that WOULD have run.
        PanelRoot::NoHome => {
            return no_home(build_argv(provider, panel.paginated, offset, limit).join(" "))
        }
    };
    let argv = build_argv(provider, panel.paginated, offset, limit);
    match run(&argv, &cwd) {
        Ok(stdout) => match schema::panel_data(panel, &stdout, offset, limit) {
            Ok(data) => ok(data),
            // FR-25: nothing partial is ever rendered.
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

/// francois:extensions:openStream (FR-38..FR-45).
#[tauri::command(async)]
pub fn extensions_open_stream(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    panel_id: String,
    root: Option<String>,
    token: Option<String>,
) -> IpcResult<String> {
    let Some((ext, panel)) = registry::panel(&panel_id) else {
        return err("EXT_PANEL_NOT_FOUND", "no such panel");
    };
    let enabled = is_enabled(&app, &state, ext.id);
    if !enabled {
        return not_enabled(ext.id);
    }
    if panel.primitive != PrimitiveKind::LogTail {
        return err("EXT_PANEL_NOT_FOUND", "this panel has no stream");
    }
    let Some(source) = panel.source.as_ref() else {
        return err("EXT_PANEL_NOT_FOUND", "this panel declares no source");
    };
    // FR-38: the core RE-VALIDATES and never trusts the frontend's check.
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
    let cwd = match panel_root(&app, &state, panel, ext.id, root.as_deref(), enabled) {
        PanelRoot::Resolved(path) => path,
        PanelRoot::NoSession => return not_detected(NO_ROOT_REASON.to_string()),
        PanelRoot::NotDetected(reason) => return not_detected(reason),
        PanelRoot::NoHome => {
            let command = match source {
                Source::File(segs) => file_rel_path(segs, token.as_deref().unwrap_or_default()),
                Source::Process { .. } => process_argv(source, token.as_deref())
                    .map(|a| a.join(" "))
                    .unwrap_or_default(),
            };
            return no_home(command);
        }
    };

    let stream_id = new_stream_id();
    match source {
        Source::File(segs) => {
            let rel = file_rel_path(segs, token.as_deref().unwrap_or_default());
            // FR-39: checked BEFORE any handle is opened, and re-checked on
            // every poll by `follow_file` — this call only refuses to start a
            // stream whose FIRST resolution already escapes the root. A root
            // that has simply vanished (deleted/unmounted project dir) is a
            // different failure than a genuine containment breach, and gets
            // its own message rather than the misleading "outside root" copy.
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
                .open(&stream_id, panel.id, ext.id, stop, None);
        }
        Source::Process { .. } => {
            let Some(argv) = process_argv(source, token.as_deref()) else {
                return err("EXT_PANEL_NOT_FOUND", "this panel declares no source");
            };
            match spawn_process_stream(&app, &stream_id, &argv, &cwd) {
                Ok((stop, child)) => state.streams.lock().unwrap().open(
                    &stream_id,
                    panel.id,
                    ext.id,
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
            panel_id: panel.id.to_string(),
        },
    );
    ok(stream_id)
}

/// francois:extensions:closeStream (FR-16, FR-42, FR-43).
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

// ---------- francois:extensions:probe / launch ----------

/// francois:extensions:probe (FR-47).
#[tauri::command(async)]
pub fn extensions_probe(
    app: AppHandle,
    state: State<'_, ExtensionState>,
) -> IpcResult<ProbeResult> {
    // FR-7: the probe belongs to cohorte's health panel; off means off.
    if !is_enabled(&app, &state, "cohorte") {
        return not_enabled("cohorte");
    }
    ok(super::launch::probe())
}

/// francois:extensions:launch (FR-46..FR-48). Idempotent: the frontend calls it
/// for BOTH the `Open dashboard` and `Launch dashboard` states.
#[tauri::command(async)]
pub fn extensions_launch(
    app: AppHandle,
    state: State<'_, ExtensionState>,
    action_id: String,
) -> IpcResult<()> {
    let Some(action) = registry::action(&action_id) else {
        return err("INVALID_INPUT", "no such action");
    };
    if !is_enabled(&app, &state, "cohorte") {
        return not_enabled("cohorte");
    }
    match super::launch::run_launch(action.argv) {
        Ok(()) => ok(()),
        Err(super::launch::LaunchError::PortOccupied) => err_detail(
            "EXT_PORT_OCCUPIED",
            "port 4317 is taken by something else",
            json!({ "url": super::launch::DASHBOARD_URL }),
        ),
        Err(super::launch::LaunchError::Failed(message)) => err_detail(
            "EXT_LAUNCH_FAILED",
            message,
            json!({ "command": action.argv.join(" ") }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn error_of<T: serde::Serialize>(result: IpcResult<T>) -> Value {
        serde_json::to_value(result).unwrap()
    }

    // FR-24 + §7: every provider failure names its cause AND carries the
    // resolved command, which is what FR-49 renders under the message.
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

    // §7: the old-cohorte case — a non-zero exit carries the code and the
    // truncated stderr the section renders.
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
        assert_eq!(
            value["error"]["detail"]["command"],
            json!("cohorte panels health --json")
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
        assert_eq!(timeout["error"]["message"], json!("timed out after 10s"));
        assert_eq!(timeout["error"]["detail"]["timeoutMs"], json!(10_000));

        let capped = error_of(provider_error::<PanelData>(
            ProviderError::Capped {
                cap_bytes: 4 * 1024 * 1024,
            },
            &argv,
        ));
        assert_eq!(capped["error"]["code"], json!("EXT_OUTPUT_CAPPED"));
        assert_eq!(capped["error"]["message"], json!("output exceeded 4 MiB"));
        assert_eq!(
            capped["error"]["detail"]["capBytes"],
            json!(4 * 1024 * 1024)
        );
    }

    // FR-7: the refusal is an ERROR with the extension named — a disabled
    // extension never answers with empty data that could read as "nothing here".
    #[test]
    fn a_disabled_extension_is_refused_by_code() {
        let value = error_of(not_enabled::<PanelData>("docker"));
        assert_eq!(value["error"]["code"], json!("EXT_NOT_ENABLED"));
        assert_eq!(value["error"]["detail"]["extensionId"], json!("docker"));
    }

    // FR-13/FR-14: `not detected` carries the reason the body renders, and is a
    // DISTINCT code from every provider failure.
    #[test]
    fn an_undetected_root_reports_its_reason() {
        let value = error_of(not_detected::<PanelData>("not a git repository".into()));
        assert_eq!(value["error"]["code"], json!("EXT_NOT_DETECTED"));
        assert_eq!(value["error"]["message"], json!("not a git repository"));
    }

    // §5: a successful payload is the contract's `{ ok: true, data }` envelope,
    // with `data` discriminated by `primitive`.
    #[test]
    fn a_successful_panel_resolves_the_contract_envelope() {
        let value = serde_json::to_value(ok(PanelData::StatRow { tiles: vec![] })).unwrap();
        assert_eq!(
            value,
            json!({ "ok": true, "data": { "primitive": "stat-row", "tiles": [] } })
        );
    }

    // The registry is the only source of panels, so an unknown id can never
    // reach a spawn.
    #[test]
    fn an_unknown_panel_id_is_not_found() {
        assert!(registry::panel("evil:panel").is_none());
        let value = error_of(err::<PanelData>("EXT_PANEL_NOT_FOUND", "no such panel"));
        assert_eq!(value["error"]["code"], json!("EXT_PANEL_NOT_FOUND"));
    }

    // FR-49/FR-53: an unresolvable home directory is still EXT_NOT_DETECTED,
    // but — like every other in-section failure — carries the command in its
    // detail, so the frontend never renders a bare "no home directory".
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
}
