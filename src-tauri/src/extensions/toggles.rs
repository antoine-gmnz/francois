//! FR-15..FR-20 — `Toggles`, the ONLY mutable input to the extension system.
//!
//! `{ [extensionId]: { enabled, consentSha256 } }` persisted to
//! `app_data_dir()/extensions.json`, alongside the state `session/persistence.rs`
//! writes. FR-15 (supersedes `extensions` FR-6): a key never written reads as
//! **DISABLED** — a manifest found on disk is inert until the user consents.
//!
//! Note what is NOT here: the loaded registry, the detection cache and every
//! live stream are in-memory and rebuild on restart (§6). This file is the
//! whole persistence surface of the feature.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "extensions.json";

/// One extension's persisted state. `consent_sha256` is the manifest hash the
/// user last consented to (FR-18) — `None` ⇒ `ConsentState::Never`.
#[derive(Default, Debug, Clone, PartialEq)]
pub(crate) struct ToggleEntry {
    pub enabled: bool,
    pub consent_sha256: Option<String>,
}

/// The in-memory toggle map. Only keys the user (or a consent grant) has
/// explicitly written are present — everything else reads as disabled/never
/// consented (FR-15).
#[derive(Default, Debug, Clone, PartialEq)]
pub(crate) struct Toggles {
    map: HashMap<String, ToggleEntry>,
    loaded: bool,
}

impl Toggles {
    pub(crate) fn entry(&self, extension_id: &str) -> ToggleEntry {
        self.map.get(extension_id).cloned().unwrap_or_default()
    }

    #[allow(dead_code)]
    pub(crate) fn is_enabled(&self, extension_id: &str) -> bool {
        self.entry(extension_id).enabled
    }

    pub fn set_enabled(&mut self, extension_id: &str, enabled: bool) {
        self.map
            .entry(extension_id.to_string())
            .or_default()
            .enabled = enabled;
    }

    /// FR-16: the only way `enabled` becomes true for a `never`/`stale`
    /// extension — binds the consent to `manifest_sha256` in the same write.
    pub(crate) fn grant_consent(&mut self, extension_id: &str, manifest_sha256: &str) {
        let entry = self.map.entry(extension_id.to_string()).or_default();
        entry.enabled = true;
        entry.consent_sha256 = Some(manifest_sha256.to_string());
    }

    /// FR-19: drop entries whose directory is gone, so a same-named directory
    /// installed later cannot inherit a stranger's consent record.
    pub(crate) fn retain_ids<'a>(&mut self, live_ids: impl Iterator<Item = &'a str>) {
        let live: std::collections::HashSet<&str> = live_ids.collect();
        self.map.retain(|id, _| live.contains(id.as_str()));
    }

    pub(crate) fn as_map(&self) -> &HashMap<String, ToggleEntry> {
        &self.map
    }

    /// Read `extensions.json` once per app run. Any later read is served from
    /// memory — Francois is the file's only writer.
    pub(crate) fn ensure_loaded(&mut self, app: &AppHandle) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        let Some(path) = toggles_path(app) else {
            return;
        };
        if let Ok(bytes) = std::fs::read(path) {
            self.map = parse(&bytes);
        }
    }
}

pub fn toggles_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME))
}

/// FR-15: a missing, empty or unparseable document yields NO overrides — i.e.
/// everything disabled/never-consented — and is never fatal.
pub fn parse(bytes: &[u8]) -> HashMap<String, ToggleEntry> {
    let Ok(doc) = serde_json::from_slice::<Value>(bytes) else {
        return HashMap::new();
    };
    let Some(obj) = doc.get("toggles").and_then(|v| v.as_object()) else {
        return HashMap::new();
    };
    obj.iter()
        .filter_map(|(k, v)| {
            let enabled = v.get("enabled")?.as_bool()?;
            let consent_sha256 = v
                .get("consentSha256")
                .and_then(|s| s.as_str())
                .map(str::to_string);
            Some((
                k.clone(),
                ToggleEntry {
                    enabled,
                    consent_sha256,
                },
            ))
        })
        .collect()
}

/// `{ "version": 1, "toggles": { … } }` — written in a stable (sorted) order
/// so the file never reshuffles between writes.
pub fn document(map: &HashMap<String, ToggleEntry>) -> Value {
    let mut ids: Vec<&String> = map.keys().collect();
    ids.sort();
    let mut toggles = Map::new();
    for id in ids {
        let entry = &map[id];
        let mut obj = Map::new();
        obj.insert("enabled".to_string(), Value::Bool(entry.enabled));
        if let Some(sha) = entry.consent_sha256.as_ref() {
            obj.insert("consentSha256".to_string(), Value::String(sha.clone()));
        }
        toggles.insert(id.clone(), Value::Object(obj));
    }
    serde_json::json!({ "version": 1, "toggles": Value::Object(toggles) })
}

/// Best-effort persistence: a write that fails leaves the in-memory state
/// authoritative for this run rather than failing the user's toggle.
pub fn save(app: &AppHandle, map: &HashMap<String, ToggleEntry>) {
    let Some(path) = toggles_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&document(map)) {
        let _ = std::fs::write(path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // FR-15: a missing key reads as DISABLED — inverted from `extensions` FR-6.
    #[test]
    fn a_missing_key_reads_as_disabled() {
        let toggles = Toggles::default();
        assert!(!toggles.is_enabled("git"));
        assert_eq!(toggles.entry("git").consent_sha256, None);
    }

    #[test]
    fn set_enabled_flips_only_that_extension() {
        let mut toggles = Toggles::default();
        toggles.grant_consent("git", "sha1");
        toggles.set_enabled("git", false);
        assert!(!toggles.is_enabled("git"));
        assert!(!toggles.is_enabled("docker"));
        toggles.set_enabled("git", true);
        assert!(toggles.is_enabled("git"));
        // The consent record survives a disable/re-enable (FR-20).
        assert_eq!(toggles.entry("git").consent_sha256.as_deref(), Some("sha1"));
    }

    // FR-16: consenting both enables AND binds the sha in one write.
    #[test]
    fn grant_consent_enables_and_binds_the_sha() {
        let mut toggles = Toggles::default();
        toggles.grant_consent("git", "abc123");
        assert!(toggles.is_enabled("git"));
        assert_eq!(
            toggles.entry("git").consent_sha256.as_deref(),
            Some("abc123")
        );
    }

    // FR-19: an entry whose directory is gone is dropped on load.
    #[test]
    fn retain_ids_drops_entries_for_directories_that_are_gone() {
        let mut toggles = Toggles::default();
        toggles.grant_consent("git", "sha1");
        toggles.grant_consent("k8s", "sha2");
        toggles.retain_ids(["git"].into_iter());
        assert!(toggles.entry("git").consent_sha256.is_some());
        assert_eq!(toggles.entry("k8s"), ToggleEntry::default());
    }

    #[test]
    fn a_missing_or_unparseable_document_yields_no_overrides() {
        assert!(parse(b"").is_empty());
        assert!(parse(b"{").is_empty());
        assert!(parse(b"[]").is_empty());
        assert!(parse(br#"{"version":1}"#).is_empty());
    }

    #[test]
    fn a_non_boolean_enabled_value_is_dropped_rather_than_coerced() {
        let parsed = parse(br#"{"toggles":{"docker":{"enabled":"yes"}}}"#);
        assert_eq!(parsed.get("docker"), None);
    }

    #[test]
    fn the_document_round_trips_through_parse() {
        let mut map = HashMap::new();
        map.insert(
            "docker".to_string(),
            ToggleEntry {
                enabled: false,
                consent_sha256: None,
            },
        );
        map.insert(
            "git".to_string(),
            ToggleEntry {
                enabled: true,
                consent_sha256: Some("sha1".into()),
            },
        );
        let bytes = serde_json::to_vec(&document(&map)).unwrap();
        assert_eq!(parse(&bytes), map);
    }

    #[test]
    fn the_document_is_written_in_sorted_order() {
        let mut map = HashMap::new();
        map.insert(
            "git".to_string(),
            ToggleEntry {
                enabled: false,
                consent_sha256: None,
            },
        );
        map.insert(
            "cohorte".to_string(),
            ToggleEntry {
                enabled: false,
                consent_sha256: None,
            },
        );
        let text = serde_json::to_string(&document(&map)).unwrap();
        let cohorte = text.find("cohorte").unwrap();
        let git = text.find("git").unwrap();
        assert!(cohorte < git, "{text}");
    }
}
