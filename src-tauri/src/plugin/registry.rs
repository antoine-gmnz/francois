//! FR-16 / FR-61..FR-80 — `plugins.json`, consent state, enablement, settings.
//!
//! Everything here is a pure function of `(entries, inputs)` except the four
//! path/IO helpers at the bottom, so the whole decision surface is testable
//! without a Tauri `AppHandle` (the crate does not enable tauri's `test`
//! feature, so handler-level tests are not available — the same split
//! `project/registry.rs` uses).
//!
//! The load path never executes plugin code (FR-69). It reads the registry,
//! re-reads each on-disk manifest, and compares the two capability sets. That
//! comparison is the entire consent model: what the user agreed to lives in the
//! registry, what the code now wants lives on disk, and any gap freezes the
//! plugin until a human closes it.

use super::*;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// FR-16: the message a registry entry carries when its tree vanished (§7 #39).
pub(crate) const MISSING_DIR_MSG: &str = "install directory missing";

// ---------- FR-13/FR-16: capability comparison ----------

/// FR-13: hosts compare after lowercasing and stripping a trailing dot. Storage
/// stays VERBATIM (FR-11 shows the consent card the manifest's own spelling) —
/// only the comparison normalizes.
fn norm_host(h: &str) -> String {
    h.trim_end_matches('.').to_ascii_lowercase()
}

/// What `new` asks for beyond `granted`: the flags, then the hosts.
///
/// Hosts are reported VERBATIM from `new` (not normalized) because the consent
/// card highlights them with a `+` and must show the manifest's own spelling.
pub(crate) fn capability_diff(
    granted: &PluginCapabilities,
    new: &PluginCapabilities,
) -> (Vec<String>, Vec<String>) {
    let mut flags = Vec::new();
    if new.read_state() && !granted.read_state() {
        flags.push("readState".to_string());
    }
    if new.drive_sessions() && !granted.drive_sessions() {
        flags.push("driveSessions".to_string());
    }
    if new.has_network() && !granted.has_network() {
        flags.push("network".to_string());
    }
    let have: HashSet<String> = granted.hosts().iter().map(|h| norm_host(h)).collect();
    let mut seen = HashSet::new();
    let hosts = new
        .hosts()
        .iter()
        .filter(|h| !have.contains(&norm_host(h)) && seen.insert(norm_host(h)))
        .cloned()
        .collect();
    (flags, hosts)
}

/// FR-13: an update is widening when it wants ANY flag or ANY host the granted
/// set does not already carry. Narrowing and reordering are not widening.
pub(crate) fn is_widening(granted: &PluginCapabilities, new: &PluginCapabilities) -> bool {
    let (flags, hosts) = capability_diff(granted, new);
    !flags.is_empty() || !hosts.is_empty()
}

/// FR-16: `consentPending` is exactly "the on-disk manifest wants more than was
/// granted". A missing on-disk manifest is NOT pending — the entry is inert for a
/// different reason (§7 #39) and offering "review permissions" there would be a
/// dead end.
pub(crate) fn consent_pending(entry: &PluginEntry) -> bool {
    match &entry.disk_manifest {
        Some(disk) => is_widening(&entry.granted_capabilities, &disk.capabilities),
        None => false,
    }
}

// ---------- FR-76: enablement ----------

/// FR-76. `scope` is the sidebar's project filter: `Some(id)` for one project,
/// `None` for *All projects*.
///
/// Under *All projects* a `projects`-scoped plugin is active when its set is
/// non-empty — the union reading, so a plugin enabled somewhere is visible in the
/// view that shows everywhere. An EMPTY set behaves as `off` in both scopes (FR-77).
pub(crate) fn is_active(entry: &PluginEntry, scope: Option<&str>) -> bool {
    if entry.consent_pending {
        return false; // FR-16: inert until re-consent, whatever the enablement says
    }
    match &entry.enablement {
        PluginEnablement::Off => false,
        PluginEnablement::All => true,
        PluginEnablement::Projects { project_ids } => match scope {
            Some(id) => project_ids.iter().any(|p| p == id),
            None => !project_ids.is_empty(),
        },
    }
}

/// FR-77/FR-78: drop ids that no longer resolve to a registry project. Returns
/// true when anything changed, so the caller only persists on a real edit.
pub(crate) fn prune_project_ids(entries: &mut [PluginEntry], known: &HashSet<String>) -> bool {
    let mut changed = false;
    for entry in entries.iter_mut() {
        if let PluginEnablement::Projects { project_ids } = &mut entry.enablement {
            let before = project_ids.len();
            project_ids.retain(|id| known.contains(id));
            changed |= project_ids.len() != before;
        }
    }
    changed
}

// ---------- FR-61..FR-64: settings ----------

/// The value a descriptor takes when nothing is stored and no `default` is
/// declared. Every declared key is always present in the resolved map, because
/// `PluginSettingsView` is a total `Record` and a plugin reading `undefined` for
/// a declared setting would be a contract violation.
fn empty_for(kind: PluginSettingType) -> Value {
    match kind {
        PluginSettingType::Number => Value::from(0),
        PluginSettingType::Boolean => Value::Bool(false),
        // string / select / secret — "" reads as unset, and a `select` whose
        // options never include "" is how the form shows "nothing chosen yet".
        _ => Value::String(String::new()),
    }
}

fn declared_default(d: &PluginSettingDescriptor) -> Value {
    // FR-61: a `secret` may not declare a default, so an unset secret is always "".
    match (&d.default, d.kind) {
        (Some(v), k) if k != PluginSettingType::Secret => v.clone(),
        _ => empty_for(d.kind),
    }
}

/// FR-28: the plugin's own view — declared defaults overlaid with stored values,
/// **secrets in plaintext**. This is the only place a stored secret is opened,
/// and the result never crosses back to the webview.
///
/// A secret that cannot be opened (missing or rotated `secret.key`) reads as
/// UNSET rather than failing the invocation (§7 #42): a plugin that handles "no
/// token configured" already handles this, and failing would take the whole panel
/// down for a recoverable condition.
pub(crate) fn resolve_settings(
    entry: &PluginEntry,
    key: Option<&[u8; 32]>,
) -> (Map<String, Value>, bool) {
    let mut out = Map::new();
    let mut unreadable = false;
    for d in entry.manifest.configuration() {
        let stored = entry.settings.get(&d.key);
        let value = match (d.kind, stored) {
            (_, None) => declared_default(d),
            (PluginSettingType::Secret, Some(Value::String(raw))) => {
                match (secrets::is_envelope(raw), key) {
                    (false, _) => Value::String(raw.clone()), // never sealed (empty)
                    (true, Some(k)) => match secrets::open(k, raw) {
                        Ok(plain) => Value::String(plain),
                        Err(_) => {
                            unreadable = true;
                            Value::String(String::new())
                        }
                    },
                    (true, None) => {
                        unreadable = true;
                        Value::String(String::new())
                    }
                }
            }
            (_, Some(v)) => v.clone(),
        };
        out.insert(d.key.clone(), value);
    }
    (out, unreadable)
}

/// FR-64: the WEBVIEW's view. A set secret reads as the sentinel, an unset one as
/// `''`. The ciphertext never leaves the core either — the modal has no use for
/// it and shipping it would put the secret one `atob` away from a devtools user.
pub(crate) fn settings_view(entry: &PluginEntry) -> Map<String, Value> {
    let mut out = Map::new();
    for d in entry.manifest.configuration() {
        let stored = entry.settings.get(&d.key);
        let value = match (d.kind, stored) {
            (PluginSettingType::Secret, Some(Value::String(raw))) if !raw.is_empty() => {
                Value::String(SECRET_SENTINEL.to_string())
            }
            (PluginSettingType::Secret, _) => Value::String(String::new()),
            (_, Some(v)) => v.clone(),
            (_, None) => declared_default(d),
        };
        out.insert(d.key.clone(), value);
    }
    out
}

/// FR-63: validate a patch against the descriptors and produce the RAW values to
/// store. Atomic — one bad key rejects the whole call and nothing is written.
///
/// FR-64's sentinel rule lives here: writing `'••••••'` back to a secret is a
/// NO-OP that preserves the stored value, so a form round-trip that never touched
/// the field cannot erase a token. Clearing is spelled `''`.
pub(crate) fn validate_settings_patch(
    entry: &PluginEntry,
    patch: &Map<String, Value>,
    key: Option<&[u8; 32]>,
) -> Result<Map<String, Value>, String> {
    let mut next = entry.settings.clone();
    for (k, raw) in patch {
        let d = entry
            .manifest
            .configuration()
            .iter()
            .find(|d| &d.key == k)
            .ok_or_else(|| format!("unknown setting \"{}\"", clean_text(k, 64, false)))?;
        match d.kind {
            PluginSettingType::Boolean => {
                let b = raw.as_bool().ok_or_else(|| type_err(k, "a boolean"))?;
                next.insert(k.clone(), Value::Bool(b));
            }
            PluginSettingType::Number => {
                let n = raw
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| type_err(k, "a number"))?;
                if let Some(min) = d.min {
                    if n < min {
                        return Err(format!(
                            "\"{}\" must be at least {min}",
                            clean_text(k, 64, false)
                        ));
                    }
                }
                if let Some(max) = d.max {
                    if n > max {
                        return Err(format!(
                            "\"{}\" must be at most {max}",
                            clean_text(k, 64, false)
                        ));
                    }
                }
                next.insert(k.clone(), raw.clone());
            }
            PluginSettingType::Select => {
                let s = raw.as_str().ok_or_else(|| type_err(k, "a string"))?;
                let options = d.options.as_deref().unwrap_or(&[]);
                if !options.iter().any(|o| o.value == s) {
                    return Err(format!(
                        "\"{}\" is not one of the declared options",
                        clean_text(k, 64, false)
                    ));
                }
                next.insert(k.clone(), Value::String(s.to_string()));
            }
            PluginSettingType::String => {
                let s = raw.as_str().ok_or_else(|| type_err(k, "a string"))?;
                if s.chars().count() > SETTING_MAX_STRING {
                    return Err(too_long(k));
                }
                next.insert(k.clone(), Value::String(s.to_string()));
            }
            PluginSettingType::Secret => {
                let s = raw.as_str().ok_or_else(|| type_err(k, "a string"))?;
                if s == SECRET_SENTINEL {
                    continue; // FR-64: the round-trip no-op
                }
                if s.chars().count() > SETTING_MAX_STRING {
                    return Err(too_long(k));
                }
                if s.is_empty() {
                    next.insert(k.clone(), Value::String(String::new()));
                    continue;
                }
                let k32 = key.ok_or_else(|| {
                    "secrets cannot be stored — the key file is unavailable".to_string()
                })?;
                next.insert(k.clone(), Value::String(secrets::seal(k32, s)?));
            }
        }
    }
    Ok(next)
}

fn type_err(key: &str, want: &str) -> String {
    format!("\"{}\" must be {want}", clean_text(key, 64, false))
}

fn too_long(key: &str) -> String {
    format!(
        "\"{}\" must be at most {SETTING_MAX_STRING} characters",
        clean_text(key, 64, false)
    )
}

/// FR-15: an update keeps stored settings, drops keys the new manifest no longer
/// declares, and lets a newly declared key fall to its `default`.
pub(crate) fn migrate_settings(
    stored: &Map<String, Value>,
    next: &PluginManifest,
) -> Map<String, Value> {
    let mut out = Map::new();
    for d in next.configuration() {
        if let Some(v) = stored.get(&d.key) {
            out.insert(d.key.clone(), v.clone());
        }
    }
    out
}

// ---------- the webview projection ----------

/// FR-64/FR-16. The manifest sent up is the ON-DISK one when it is readable, so
/// the modal can show what a pending update wants; the granted set alongside it
/// is what is actually in force.
pub(crate) fn to_view(entry: &PluginEntry) -> InstalledPlugin {
    InstalledPlugin {
        manifest: entry
            .disk_manifest
            .clone()
            .unwrap_or_else(|| entry.manifest.clone()),
        source: entry.source.clone(),
        resolved_ref: entry.resolved_ref.clone(),
        install_path: entry.install_path.clone(),
        installed_at: entry.installed_at,
        updated_at: entry.updated_at,
        enablement: entry.enablement.clone(),
        granted_capabilities: entry.granted_capabilities.clone(),
        consent_pending: entry.consent_pending,
        settings: settings_view(entry),
        last_error: entry.last_error.clone(),
    }
}

pub(crate) fn snapshot(entries: &[PluginEntry]) -> Vec<InstalledPlugin> {
    entries.iter().map(to_view).collect()
}

// ---------- FR-79: persistence ----------

pub(crate) fn plugins_json_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("plugins.json"))
}

pub(crate) fn plugins_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("plugins"))
}

/// FR-27/§6: the KV store sits BESIDE the code directory, not inside it, so an
/// update swap (which replaces the directory wholesale) cannot clobber it.
pub(crate) fn storage_path(app: &tauri::AppHandle, plugin_id: &str) -> Option<PathBuf> {
    plugins_dir(app).map(|d| d.join(format!("{plugin_id}.storage.json")))
}

pub(crate) fn staging_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    plugins_dir(app).map(|d| d.join(".staging"))
}

/// FR-79: `Err(())` means UNPARSEABLE and the caller renames the file to
/// `plugins.json.bak`. A missing file is not unparseable — it is an empty
/// registry, and a first run must not produce a spurious backup notice.
pub(crate) fn parse_registry(bytes: &[u8]) -> Result<Vec<PluginEntry>, ()> {
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Vec::new());
    }
    let Ok(doc) = serde_json::from_slice::<Value>(bytes) else {
        return Err(());
    };
    let Some(list) = doc.get("plugins").and_then(|v| v.as_array()) else {
        return Err(());
    };
    // One undeserializable ENTRY is skipped rather than resetting the registry —
    // losing every plugin because one row is malformed is the worse failure.
    Ok(list
        .iter()
        .filter_map(|e| serde_json::from_value::<PluginEntry>(e.clone()).ok())
        .collect())
}

pub(crate) fn save_to(path: &Path, entries: &[PluginEntry]) -> Result<(), String> {
    let doc = serde_json::json!({ "version": 1, "plugins": entries });
    crate::permissions::write_json_atomic(path, &doc)
}

/// FR-69: re-read the on-disk manifest so `consentPending` reflects the CODE, not
/// the registry's memory of it. Never executes anything — this is a file read.
pub(crate) fn read_disk_manifest(install_path: &str) -> Option<PluginManifest> {
    let bytes = std::fs::read(Path::new(install_path).join(MANIFEST_FILENAME)).ok()?;
    serde_json::from_slice::<PluginManifest>(&bytes).ok()
}

/// FR-69: bring a freshly-parsed entry up to date with the filesystem. Split out
/// so tests can drive it against a real temp tree without a Tauri handle.
pub(crate) fn hydrate(entry: &mut PluginEntry) {
    entry.disk_manifest = read_disk_manifest(&entry.install_path);
    entry.consent_pending = consent_pending(entry);
    entry.last_error = match entry.disk_manifest {
        None => Some(PluginRuntimeError {
            at: now_ms(),
            surface: PluginSurface::Panel,
            message: MISSING_DIR_MSG.to_string(),
        }),
        Some(_) => None,
    };
}

/// FR-79: persist, and on failure restore `snapshot` so memory and disk always
/// agree. The caller has already mutated `entries` in place.
pub(crate) fn persist_or_rollback(
    app: &tauri::AppHandle,
    entries: &mut Vec<PluginEntry>,
    snapshot: Vec<PluginEntry>,
) -> Result<(), (&'static str, String)> {
    let Some(path) = plugins_json_path(app) else {
        *entries = snapshot;
        return Err((
            E_STORE_WRITE_FAILED,
            "could not resolve the app data directory".to_string(),
        ));
    };
    if let Err(msg) = save_to(&path, entries) {
        *entries = snapshot;
        return Err((E_STORE_WRITE_FAILED, msg));
    }
    Ok(())
}

/// Load the registry at startup (FR-69/FR-79). Returns `true` when an unparseable
/// file was backed up, which the modal surfaces once (§7 #40).
pub(crate) fn load_registry(path: &Path) -> (Vec<PluginEntry>, bool) {
    let Ok(bytes) = std::fs::read(path) else {
        return (Vec::new(), false); // missing ⇒ empty, not a reset
    };
    match parse_registry(&bytes) {
        Ok(mut entries) => {
            for e in entries.iter_mut() {
                hydrate(e);
            }
            (entries, false)
        }
        Err(()) => {
            let _ = std::fs::rename(path, path.with_extension("json.bak"));
            (Vec::new(), true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::*;
    use serde_json::json;

    fn descriptor(key: &str, kind: PluginSettingType) -> PluginSettingDescriptor {
        PluginSettingDescriptor {
            key: key.into(),
            kind,
            label: key.into(),
            description: None,
            default: None,
            placeholder: None,
            options: None,
            min: None,
            max: None,
        }
    }

    fn with_config(id: &str, config: Vec<PluginSettingDescriptor>) -> PluginEntry {
        let mut e = entry_fixture(id, "/tmp/x");
        e.manifest.configuration = Some(config);
        e.disk_manifest = Some(e.manifest.clone());
        e
    }

    // ---------- FR-13: widening ----------

    #[test]
    fn adding_a_flag_or_a_host_is_widening_and_removing_one_is_not() {
        let granted = caps(true, false, &["api.github.com"]);

        assert!(!is_widening(&granted, &granted), "identical");
        assert!(
            !is_widening(&granted, &caps(false, false, &[])),
            "FR-14: narrowing is applied silently"
        );
        assert!(
            !is_widening(&granted, &caps(true, false, &["API.GitHub.com."])),
            "FR-13: hosts compare case-insensitively, trailing dot stripped"
        );

        assert!(
            is_widening(&granted, &caps(true, true, &["api.github.com"])),
            "new flag"
        );
        assert!(
            is_widening(
                &granted,
                &caps(true, false, &["api.github.com", "telemetry.acme.dev"])
            ),
            "new host"
        );
        // network appearing where there was none at all
        assert!(is_widening(
            &caps(true, false, &[]),
            &caps(true, false, &["a.dev"])
        ));
    }

    #[test]
    fn the_diff_reports_added_flags_and_hosts_verbatim_for_the_consent_card() {
        // FR-11/FR-13: the card highlights these with a `+`, so they must carry
        // the manifest's own spelling, not a normalized one.
        let (flags, hosts) = capability_diff(
            &caps(false, false, &["api.github.com"]),
            &caps(
                true,
                true,
                &[
                    "API.GitHub.com",
                    "Telemetry.Acme.dev",
                    "telemetry.acme.dev.",
                ],
            ),
        );
        assert_eq!(flags, ["readState", "driveSessions"]);
        assert_eq!(
            hosts,
            ["Telemetry.Acme.dev"],
            "deduped, verbatim, already-granted excluded"
        );

        let (flags, hosts) =
            capability_diff(&caps(true, true, &["a.dev"]), &caps(true, true, &["a.dev"]));
        assert!(flags.is_empty() && hosts.is_empty());
    }

    // ---------- FR-16: consentPending ----------

    #[test]
    fn consent_is_pending_exactly_when_the_disk_manifest_wants_more() {
        // §7 #49: a hand-edited manifest freezes the plugin on next load.
        let mut e = entry_fixture("acme-ci", "/tmp/x");
        e.granted_capabilities = caps(true, false, &[]);
        e.disk_manifest = Some(manifest_with_caps("acme-ci", caps(true, false, &[])));
        assert!(!consent_pending(&e));

        e.disk_manifest = Some(manifest_with_caps("acme-ci", caps(true, true, &[])));
        assert!(consent_pending(&e));

        e.disk_manifest = Some(manifest_with_caps("acme-ci", PluginCapabilities::default()));
        assert!(!consent_pending(&e), "narrowing is not pending");

        // §7 #39: a missing tree is inert for a DIFFERENT reason — offering
        // "review permissions" there would be a dead end.
        e.disk_manifest = None;
        assert!(!consent_pending(&e));
    }

    // ---------- FR-76/FR-77: enablement ----------

    #[test]
    fn enablement_resolves_against_the_sidebar_scope() {
        let mut e = entry_fixture("acme-ci", "/tmp/x");

        e.enablement = PluginEnablement::Off;
        assert!(!is_active(&e, Some("p1")) && !is_active(&e, None));

        e.enablement = PluginEnablement::All;
        assert!(is_active(&e, Some("p1")) && is_active(&e, None));

        e.enablement = PluginEnablement::Projects {
            project_ids: vec!["p1".into()],
        };
        assert!(is_active(&e, Some("p1")));
        assert!(!is_active(&e, Some("p2")));
        assert!(is_active(&e, None), "FR-76: the union under *All projects*");

        // FR-77: an emptied set behaves as `off` in BOTH scopes
        e.enablement = PluginEnablement::Projects {
            project_ids: Vec::new(),
        };
        assert!(!is_active(&e, Some("p1")) && !is_active(&e, None));
    }

    #[test]
    fn a_consent_pending_plugin_is_never_active_whatever_its_enablement() {
        // FR-16: renders no panel, publishes no status item, registers no command.
        let mut e = entry_fixture("acme-ci", "/tmp/x");
        e.enablement = PluginEnablement::All;
        e.consent_pending = true;
        assert!(!is_active(&e, Some("p1")) && !is_active(&e, None));
    }

    #[test]
    fn removing_a_project_drops_its_id_from_every_plugin() {
        // FR-78 / §7 #45.
        let mut entries = vec![
            entry_fixture("a", "/tmp/a"),
            entry_fixture("b", "/tmp/b"),
            entry_fixture("c", "/tmp/c"),
        ];
        entries[0].enablement = PluginEnablement::Projects {
            project_ids: vec!["p1".into(), "p2".into()],
        };
        entries[1].enablement = PluginEnablement::Projects {
            project_ids: vec!["p2".into()],
        };
        entries[2].enablement = PluginEnablement::All;

        let known: HashSet<String> = ["p1".to_string()].into_iter().collect();
        assert!(prune_project_ids(&mut entries, &known));
        assert_eq!(
            entries[0].enablement,
            PluginEnablement::Projects {
                project_ids: vec!["p1".into()]
            }
        );
        assert_eq!(
            entries[1].enablement,
            PluginEnablement::Projects {
                project_ids: Vec::new()
            },
            "emptied, which behaves as off"
        );
        assert_eq!(entries[2].enablement, PluginEnablement::All, "untouched");

        // a second prune changes nothing, so the caller does not re-persist
        assert!(!prune_project_ids(&mut entries, &known));
    }

    // ---------- FR-28/FR-64: settings resolution ----------

    #[test]
    fn the_plugins_view_gets_defaults_overlaid_with_stored_values() {
        let mut e = with_config(
            "acme-ci",
            vec![
                PluginSettingDescriptor {
                    default: Some(json!("acme/x")),
                    ..descriptor("repo", PluginSettingType::String)
                },
                PluginSettingDescriptor {
                    default: Some(json!(30)),
                    ..descriptor("poll", PluginSettingType::Number)
                },
                descriptor("verbose", PluginSettingType::Boolean),
                descriptor("mode", PluginSettingType::Select),
            ],
        );
        let (resolved, unreadable) = resolve_settings(&e, None);
        assert_eq!(resolved["repo"], json!("acme/x"));
        assert_eq!(resolved["poll"], json!(30));
        assert_eq!(
            resolved["verbose"],
            json!(false),
            "undeclared default ⇒ typed empty"
        );
        assert_eq!(resolved["mode"], json!(""));
        assert!(!unreadable);

        e.settings.insert("repo".into(), json!("acme/other"));
        e.settings.insert("verbose".into(), json!(true));
        let (resolved, _) = resolve_settings(&e, None);
        assert_eq!(resolved["repo"], json!("acme/other"));
        assert_eq!(resolved["verbose"], json!(true));
        assert_eq!(
            resolved["poll"],
            json!(30),
            "untouched keys keep their default"
        );
    }

    #[test]
    fn every_declared_key_is_present_even_with_nothing_stored() {
        // PluginSettingsView is a TOTAL record — a plugin reading `undefined` for
        // a declared setting would be a contract violation.
        let e = with_config(
            "acme-ci",
            vec![
                descriptor("a", PluginSettingType::String),
                descriptor("b", PluginSettingType::Number),
                descriptor("c", PluginSettingType::Boolean),
                descriptor("d", PluginSettingType::Secret),
            ],
        );
        let (resolved, _) = resolve_settings(&e, None);
        for k in ["a", "b", "c", "d"] {
            assert!(resolved.contains_key(k), "missing {k}");
        }
        assert_eq!(settings_view(&e).len(), 4);
    }

    #[test]
    fn a_secret_reaches_the_isolate_in_plaintext_and_the_webview_as_the_sentinel() {
        // FR-28 vs FR-64 — the same stored value, two different projections.
        let key = [3u8; 32];
        let mut e = with_config(
            "acme-ci",
            vec![descriptor("token", PluginSettingType::Secret)],
        );
        e.settings.insert(
            "token".into(),
            json!(secrets::seal(&key, "ghp_real").unwrap()),
        );

        let (resolved, unreadable) = resolve_settings(&e, Some(&key));
        assert_eq!(
            resolved["token"],
            json!("ghp_real"),
            "FR-28: plaintext, isolate-only"
        );
        assert!(!unreadable);

        let view = settings_view(&e);
        assert_eq!(
            view["token"],
            json!(SECRET_SENTINEL),
            "FR-64: never the value"
        );
        assert!(
            !serde_json::to_string(&view).unwrap().contains("ghp_real"),
            "the ciphertext must not travel either"
        );
    }

    #[test]
    fn an_unopenable_secret_reads_as_unset_rather_than_failing_the_render() {
        // §7 #42: a missing or rotated secret.key must not take the panel down.
        let mut e = with_config(
            "acme-ci",
            vec![descriptor("token", PluginSettingType::Secret)],
        );
        e.settings.insert(
            "token".into(),
            json!(secrets::seal(&[3u8; 32], "ghp_real").unwrap()),
        );

        let (resolved, unreadable) = resolve_settings(&e, Some(&[9u8; 32]));
        assert_eq!(resolved["token"], json!(""));
        assert!(
            unreadable,
            "the modal shows `stored secrets could not be read`"
        );

        let (resolved, unreadable) = resolve_settings(&e, None);
        assert_eq!(resolved["token"], json!(""));
        assert!(unreadable);
    }

    #[test]
    fn an_unset_secret_is_empty_in_both_projections() {
        let mut e = with_config(
            "acme-ci",
            vec![descriptor("token", PluginSettingType::Secret)],
        );
        assert_eq!(settings_view(&e)["token"], json!(""));
        e.settings.insert("token".into(), json!(""));
        assert_eq!(settings_view(&e)["token"], json!(""));
        assert_eq!(resolve_settings(&e, Some(&[1u8; 32])).0["token"], json!(""));
    }

    // ---------- FR-63/FR-64: writing settings ----------

    #[test]
    fn a_patch_validates_every_value_against_its_descriptor() {
        let e = with_config(
            "acme-ci",
            vec![
                descriptor("s", PluginSettingType::String),
                PluginSettingDescriptor {
                    min: Some(5.0),
                    max: Some(60.0),
                    ..descriptor("n", PluginSettingType::Number)
                },
                descriptor("b", PluginSettingType::Boolean),
                PluginSettingDescriptor {
                    options: Some(vec![PluginSettingOption {
                        value: "a".into(),
                        label: "A".into(),
                    }]),
                    ..descriptor("sel", PluginSettingType::Select)
                },
            ],
        );

        let good = validate_settings_patch(
            &e,
            &json!({ "s": "x", "n": 30, "b": true, "sel": "a" })
                .as_object()
                .unwrap()
                .clone(),
            None,
        )
        .unwrap();
        assert_eq!(good["n"], json!(30));

        for bad in [
            json!({ "nope": "x" }), // unknown key
            json!({ "s": 42 }),     // wrong type
            json!({ "b": "true" }),
            json!({ "n": "30" }),
            json!({ "n": 4 }),     // below min
            json!({ "n": 61 }),    // above max
            json!({ "sel": "z" }), // not a declared option
            json!({ "s": "x".repeat(SETTING_MAX_STRING + 1) }),
        ] {
            assert!(
                validate_settings_patch(&e, bad.as_object().unwrap(), None).is_err(),
                "should reject {bad}"
            );
        }
        // the bounds themselves are inclusive
        assert!(validate_settings_patch(&e, json!({ "n": 5 }).as_object().unwrap(), None).is_ok());
        assert!(validate_settings_patch(&e, json!({ "n": 60 }).as_object().unwrap(), None).is_ok());
    }

    #[test]
    fn a_patch_is_atomic_so_one_bad_key_writes_nothing() {
        // FR-63: "the whole call is atomic".
        let mut e = with_config(
            "acme-ci",
            vec![
                descriptor("a", PluginSettingType::String),
                descriptor("b", PluginSettingType::Number),
            ],
        );
        e.settings.insert("a".into(), json!("original"));
        let err = validate_settings_patch(
            &e,
            json!({ "a": "changed", "b": "not a number" })
                .as_object()
                .unwrap(),
            None,
        );
        assert!(err.is_err());
        assert_eq!(e.settings["a"], json!("original"), "unchanged in memory");
    }

    #[test]
    fn writing_the_sentinel_back_preserves_the_stored_secret() {
        // FR-64 / §7 #43: the form round-trip must not be able to erase a token.
        let key = [3u8; 32];
        let mut e = with_config(
            "acme-ci",
            vec![descriptor("token", PluginSettingType::Secret)],
        );
        let sealed = secrets::seal(&key, "ghp_real").unwrap();
        e.settings.insert("token".into(), json!(sealed.clone()));

        let next = validate_settings_patch(
            &e,
            json!({ "token": SECRET_SENTINEL }).as_object().unwrap(),
            Some(&key),
        )
        .unwrap();
        assert_eq!(
            next["token"],
            json!(sealed),
            "byte-identical, not re-sealed"
        );

        // ...and clearing is spelled ''
        let cleared =
            validate_settings_patch(&e, json!({ "token": "" }).as_object().unwrap(), Some(&key))
                .unwrap();
        assert_eq!(cleared["token"], json!(""));
    }

    #[test]
    fn a_written_secret_is_sealed_and_never_stored_in_the_clear() {
        let key = [3u8; 32];
        let e = with_config(
            "acme-ci",
            vec![descriptor("token", PluginSettingType::Secret)],
        );
        let next = validate_settings_patch(
            &e,
            json!({ "token": "ghp_new" }).as_object().unwrap(),
            Some(&key),
        )
        .unwrap();
        let stored = next["token"].as_str().unwrap();
        assert!(secrets::is_envelope(stored), "FR-65: enc:v1: at rest");
        assert!(!stored.contains("ghp_new"));
        assert_eq!(secrets::open(&key, stored).unwrap(), "ghp_new");

        // with no key available, a secret write FAILS rather than storing plaintext
        assert!(validate_settings_patch(
            &e,
            json!({ "token": "ghp_new" }).as_object().unwrap(),
            None
        )
        .is_err());
    }

    // ---------- FR-15: settings across an update ----------

    #[test]
    fn an_update_keeps_known_settings_drops_removed_ones_and_defaults_new_ones() {
        let mut stored = Map::new();
        stored.insert("keep".into(), json!("v"));
        stored.insert("gone".into(), json!("old"));

        let mut next = manifest_fixture("acme-ci");
        next.configuration = Some(vec![
            descriptor("keep", PluginSettingType::String),
            PluginSettingDescriptor {
                default: Some(json!("fresh")),
                ..descriptor("added", PluginSettingType::String)
            },
        ]);

        let migrated = migrate_settings(&stored, &next);
        assert_eq!(migrated["keep"], json!("v"));
        assert!(
            !migrated.contains_key("gone"),
            "no longer declared ⇒ dropped"
        );
        assert!(
            !migrated.contains_key("added"),
            "not stored — it falls to its default"
        );

        let mut e = entry_fixture("acme-ci", "/tmp/x");
        e.manifest = next;
        e.settings = migrated;
        assert_eq!(settings_view(&e)["added"], json!("fresh"));
    }

    // ---------- FR-79: the registry file ----------

    #[test]
    fn the_registry_round_trips_and_never_persists_derived_state() {
        let dir = tmp_dir("registry-roundtrip");
        let path = dir.join("plugins.json");
        let mut e = entry_fixture("acme-ci", &dir.to_string_lossy());
        e.consent_pending = true;
        e.last_error = Some(PluginRuntimeError {
            at: 5,
            surface: PluginSurface::Panel,
            message: "boom".into(),
        });
        save_to(&path, std::slice::from_ref(&e)).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("consentPending"),
            "§6: recomputed at load:\n{raw}"
        );
        assert!(
            !raw.contains("lastError"),
            "§6: a fresh run starts clean:\n{raw}"
        );

        let (loaded, reset) = load_registry(&path);
        assert!(!reset);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].manifest.id, "acme-ci");
        assert!(
            loaded[0].last_error.is_some(),
            "no manifest on disk at that path"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_registry_is_empty_and_is_not_a_reset() {
        // A first run must not show `the plugin registry was reset`.
        let dir = tmp_dir("registry-missing");
        let (entries, reset) = load_registry(&dir.join("nope.json"));
        assert!(entries.is_empty() && !reset);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unparseable_registry_is_backed_up_and_replaced_with_an_empty_one() {
        // §7 #40 / FR-79.
        let dir = tmp_dir("registry-corrupt");
        let path = dir.join("plugins.json");
        std::fs::write(&path, b"{ not json").unwrap();

        let (entries, reset) = load_registry(&path);
        assert!(entries.is_empty());
        assert!(reset, "the modal surfaces this once");
        assert!(dir.join("plugins.json.bak").exists(), "the backup is kept");

        // shapes that are valid JSON but not OURS are also a reset
        assert!(parse_registry(b"[]").is_err());
        assert!(parse_registry(br#"{"version":1}"#).is_err());
        // ...but whitespace/empty is simply empty
        assert_eq!(parse_registry(b"").unwrap().len(), 0);
        assert_eq!(parse_registry(b"  \n ").unwrap().len(), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_undeserializable_entry_is_skipped_rather_than_resetting_the_registry() {
        let doc = json!({
            "version": 1,
            "plugins": [
                serde_json::to_value(entry_fixture("keep-me", "/tmp/a")).unwrap(),
                { "id": "not an entry" },
                "not even an object",
            ]
        });
        let loaded = parse_registry(doc.to_string().as_bytes()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].manifest.id, "keep-me");
    }

    #[test]
    fn hydrate_reads_the_manifest_from_disk_and_flags_a_missing_tree() {
        // FR-69: the load path reads files; it never runs plugin code.
        let dir = tmp_dir("hydrate");
        let install = dir.join("acme-ci");
        write_plugin_tree(&install, "acme-ci", "export default {}");

        let mut e = entry_fixture("acme-ci", &install.to_string_lossy());
        hydrate(&mut e);
        assert!(e.disk_manifest.is_some());
        assert!(!e.consent_pending);
        assert_eq!(e.last_error, None);

        // widen the manifest on disk behind the registry's back (§7 #49)
        let mut widened = manifest_fixture("acme-ci");
        widened.capabilities = caps(true, true, &["evil.dev"]);
        std::fs::write(
            install.join(MANIFEST_FILENAME),
            serde_json::to_vec(&widened).unwrap(),
        )
        .unwrap();
        hydrate(&mut e);
        assert!(e.consent_pending, "FR-16: frozen until re-consent");

        // §7 #39: the tree disappears entirely
        std::fs::remove_dir_all(&install).unwrap();
        hydrate(&mut e);
        assert!(e.disk_manifest.is_none());
        assert!(!e.consent_pending);
        assert_eq!(e.last_error.unwrap().message, MISSING_DIR_MSG);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_webview_projection_shows_the_disk_manifest_beside_the_granted_set() {
        // FR-16: the modal must be able to say what the update WANTS while the
        // granted set is what is actually in force.
        let mut e = entry_fixture("acme-ci", "/tmp/x");
        e.granted_capabilities = caps(true, false, &[]);
        e.disk_manifest = Some(manifest_with_caps(
            "acme-ci",
            caps(true, true, &["evil.dev"]),
        ));
        e.consent_pending = true;

        let view = to_view(&e);
        assert!(
            view.manifest.capabilities.drive_sessions(),
            "what disk wants"
        );
        assert!(
            !view.granted_capabilities.drive_sessions(),
            "what is in force"
        );
        assert!(view.consent_pending);

        // with no readable manifest the LAST CONSENTED one is shown
        e.disk_manifest = None;
        assert!(!to_view(&e).manifest.capabilities.drive_sessions());
    }
}
