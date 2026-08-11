//! FR-6 — `ExtensionToggles`, the ONLY mutable input to the extension system.
//!
//! `{ [extensionId]: boolean }` persisted to `app_data_dir()/extensions.json`,
//! alongside the state `session/persistence.rs` writes. A missing key reads as
//! `true`: an extension is enabled by default, and a fresh install writes
//! nothing until the user flips something.
//!
//! Note what is NOT here: the detection cache and every live stream are
//! in-memory and rebuild on restart (§6). This file is the whole persistence
//! surface of the feature.

use super::registry;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "extensions.json";

/// The in-memory toggle map. Only keys the user has explicitly flipped are
/// present — `is_enabled` answers `true` for everything else (FR-6).
#[derive(Default, Debug, Clone, PartialEq)]
pub(crate) struct Toggles {
    map: HashMap<String, bool>,
    /// Loaded lazily on first use: `ExtensionState` is `Default`-constructed by
    /// `.manage()` before an `AppHandle` exists to resolve app_data_dir() with.
    loaded: bool,
}

impl Toggles {
    pub(crate) fn is_enabled(&self, extension_id: &str) -> bool {
        self.map.get(extension_id).copied().unwrap_or(true)
    }

    pub(crate) fn set(&mut self, extension_id: &str, enabled: bool) {
        self.map.insert(extension_id.to_string(), enabled);
    }

    pub(crate) fn as_map(&self) -> &HashMap<String, bool> {
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

pub(crate) fn toggles_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME))
}

/// FR-6: a missing, empty or unparseable document yields NO overrides — i.e.
/// everything enabled — and is never fatal. A key that is not a registry id is
/// dropped, so a hand-edited file cannot introduce an extension.
pub(crate) fn parse(bytes: &[u8]) -> HashMap<String, bool> {
    let Ok(doc) = serde_json::from_slice::<Value>(bytes) else {
        return HashMap::new();
    };
    let Some(obj) = doc.get("toggles").and_then(|v| v.as_object()) else {
        return HashMap::new();
    };
    obj.iter()
        .filter(|(k, _)| registry::extension(k).is_some())
        .filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b)))
        .collect()
}

/// `{ "version": 1, "toggles": { … } }` — written in registry order so the file
/// is stable across writes and readable by a human who opens it.
pub(crate) fn document(map: &HashMap<String, bool>) -> Value {
    let mut toggles = Map::new();
    for ext in registry::REGISTRY.iter() {
        if let Some(enabled) = map.get(ext.id) {
            toggles.insert(ext.id.to_string(), Value::Bool(*enabled));
        }
    }
    serde_json::json!({ "version": 1, "toggles": Value::Object(toggles) })
}

/// Best-effort persistence: a write that fails leaves the in-memory state
/// authoritative for this run rather than failing the user's toggle.
pub(crate) fn save(app: &AppHandle, map: &HashMap<String, bool>) {
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

    // FR-6: default ON — a key that was never written reads as enabled.
    #[test]
    fn a_missing_key_reads_as_enabled() {
        let toggles = Toggles::default();
        assert!(toggles.is_enabled("docker"));
        assert!(toggles.is_enabled("cohorte"));
    }

    #[test]
    fn an_explicit_false_disables_only_that_extension() {
        let mut toggles = Toggles::default();
        toggles.set("docker", false);
        assert!(!toggles.is_enabled("docker"));
        assert!(toggles.is_enabled("git"));
        toggles.set("docker", true);
        assert!(toggles.is_enabled("docker"));
    }

    #[test]
    fn a_missing_or_unparseable_document_yields_no_overrides() {
        assert!(parse(b"").is_empty());
        assert!(parse(b"{").is_empty());
        assert!(parse(b"[]").is_empty());
        assert!(parse(br#"{"version":1}"#).is_empty());
    }

    // A hand-edited file cannot introduce an extension, and a non-boolean value
    // is dropped rather than coerced.
    #[test]
    fn only_registry_ids_with_boolean_values_survive_a_parse() {
        let parsed = parse(br#"{"toggles":{"docker":false,"evil":true,"git":"yes"}}"#);
        assert_eq!(parsed.get("docker"), Some(&false));
        assert_eq!(parsed.get("evil"), None);
        assert_eq!(parsed.get("git"), None);
    }

    #[test]
    fn the_document_round_trips_through_parse() {
        let mut map = HashMap::new();
        map.insert("docker".to_string(), false);
        map.insert("cohorte".to_string(), true);
        let bytes = serde_json::to_vec(&document(&map)).unwrap();
        assert_eq!(parse(&bytes), map);
    }

    // Written in registry order, so the file never reshuffles between writes.
    #[test]
    fn the_document_is_written_in_registry_order() {
        let mut map = HashMap::new();
        map.insert("git".to_string(), false);
        map.insert("cohorte".to_string(), false);
        let text = serde_json::to_string(&document(&map)).unwrap();
        let cohorte = text.find("cohorte").unwrap();
        let git = text.find("git").unwrap();
        assert!(cohorte < git, "{text}");
    }
}
