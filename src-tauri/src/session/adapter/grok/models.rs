//! The Grok model catalog (multi-provider-grok FR-25).
//!
//! Read from `<GROK_HOME>/config.toml`'s `[models]`/`[model."<id>">]` tables —
//! confirmed against the CLI's own `docs/user-guide/11-custom-models.md`
//! (installed grok 1.0.5): `[models] default` names the default model,
//! `[model.<name>]` sections add custom/overridden entries with a `name` field
//! for the picker label. A freshly created `GROK_HOME`'s `config.toml` (also
//! read live in this environment) carries neither section — Grok's BUILT-IN
//! models (`grok-4.6`, `grok-4.5`, …) are never written to `config.toml` at
//! all, so the common case is an empty `[model.*]` table and the fallback
//! below is what actually serves a fresh account, not an edge case.
//!
//! Pure apart from the single `read_to_string`, isolated in `catalog_for_home`
//! so the TOML → catalog mapping is testable against fixture text — same shape
//! as `codex::models`.

use crate::session::models::ModelInfo;

use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize, Default)]
struct ConfigToml {
    #[serde(default)]
    models: ModelsSection,
    /// `[model.<id>]` — a TOML table of tables, which serde/toml maps onto a
    /// `BTreeMap` directly. `BTreeMap` (not `HashMap`) so the catalog's order
    /// is deterministic without an extra sort key breaking ties randomly.
    #[serde(default)]
    model: std::collections::BTreeMap<String, ModelSection>,
}

#[derive(Deserialize, Default)]
struct ModelsSection {
    #[serde(default)]
    default: Option<String>,
}

#[derive(Deserialize, Default)]
struct ModelSection {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    context_window: Option<u64>,
}

/// FR-25's fallback catalog — verified LIVE against `grok models` (grok
/// 1.0.5, unauthenticated, in this environment): "Default model: grok-4.6" /
/// "Available models: grok-4.6 (default), grok-4.5". NOT the spec's guessed
/// `grok-4.6-mini`/`grok-build-0.1`, which do not exist in the real catalog —
/// a build-step FR-11 finding, reported in the handoff.
fn fallback() -> Vec<ModelInfo> {
    ["grok-4.6", "grok-4.5"]
        .iter()
        .map(|id| ModelInfo {
            id: (*id).to_string(),
            label: (*id).to_string(),
            brief: None,
            context_tokens: None,
            efforts: Vec::new(),
        })
        .collect()
}

/// The pure half: config text → catalog. `None` when the file declares no
/// custom `[model.*]` entries at all — the fresh-account case — so the caller
/// falls back rather than presenting an empty picker.
fn parse_catalog(text: &str) -> Option<Vec<ModelInfo>> {
    let cfg: ConfigToml = toml::from_str(text).ok()?;
    if cfg.model.is_empty() {
        return None;
    }
    let default_id = cfg.models.default;
    let mut rows: Vec<ModelInfo> = cfg
        .model
        .into_iter()
        .filter(|(id, _)| !id.is_empty())
        .map(|(id, m)| ModelInfo {
            label: m.name.unwrap_or_else(|| id.clone()),
            id,
            brief: m.description,
            context_tokens: m.context_window,
            efforts: Vec::new(),
        })
        .collect();
    // The config's own default sorts first; everything else keeps the
    // BTreeMap's alphabetical order.
    rows.sort_by(|a, b| {
        let a_default = default_id.as_deref() == Some(a.id.as_str());
        let b_default = default_id.as_deref() == Some(b.id.as_str());
        b_default.cmp(&a_default).then_with(|| a.id.cmp(&b.id))
    });
    Some(rows)
}

/// FR-25: the catalog for one account's `GROK_HOME`, falling back when the
/// config cannot be used or declares no models.
pub(super) fn catalog_for_home(grok_home: Option<&Path>) -> Vec<ModelInfo> {
    let Some(home) = grok_home else {
        return fallback();
    };
    std::fs::read_to_string(home.join("config.toml"))
        .ok()
        .and_then(|text| parse_catalog(&text))
        .unwrap_or_else(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The REAL `config.toml` of a freshly-npm-installed grok 1.0.5, read live
    /// in this environment (`~/.grok/config.toml`, no account yet added).
    const LIVE_FRESH_CONFIG: &str = r#"[cli]
installer = "npm"

[marketplace]
default_skills_installs_purged = true
"#;

    #[test]
    fn a_fresh_installs_config_declares_no_models_so_the_caller_falls_back() {
        // This is the COMMON case, not an edge case — verified live.
        assert!(parse_catalog(LIVE_FRESH_CONFIG).is_none());
    }

    const CUSTOM_MODELS: &str = r#"
[models]
default = "company-grok"

[model.company-grok]
model = "grok-build"
base_url = "https://grok-proxy.acme.com/"
name = "Grok Build Latest (Proxy)"
context_window = 128000

[model.claude-opus]
model = "claude-opus-4-6"
base_url = "https://api.anthropic.com/v1"
name = "Claude Opus 4.6"
api_backend = "messages"
context_window = 200000
"#;

    #[test]
    fn custom_model_sections_map_field_for_field_onto_model_info() {
        let catalog = parse_catalog(CUSTOM_MODELS).expect("a real config parses");
        let proxy = catalog.iter().find(|m| m.id == "company-grok").unwrap();
        assert_eq!(proxy.label, "Grok Build Latest (Proxy)");
        assert_eq!(proxy.context_tokens, Some(128_000));
    }

    #[test]
    fn the_configured_default_sorts_first() {
        let catalog = parse_catalog(CUSTOM_MODELS).unwrap();
        assert_eq!(catalog[0].id, "company-grok");
        assert_eq!(catalog[1].id, "claude-opus");
    }

    #[test]
    fn a_model_with_no_name_falls_back_to_its_id_as_the_label() {
        let catalog = parse_catalog(
            r#"
[model.local-llama]
model = "llama-3.1-70b"
base_url = "http://localhost:8080/v1"
"#,
        )
        .unwrap();
        assert_eq!(catalog[0].id, "local-llama");
        assert_eq!(catalog[0].label, "local-llama");
        assert_eq!(catalog[0].brief, None);
    }

    #[test]
    fn a_malformed_or_empty_config_yields_none_so_the_caller_can_fall_back() {
        assert!(parse_catalog("not = [valid").is_none());
        assert!(parse_catalog("").is_none());
        assert!(parse_catalog("[cli]\ninstaller = \"npm\"\n").is_none());
    }

    // ---------- the fallback ----------

    fn ids(catalog: &[ModelInfo]) -> Vec<&str> {
        catalog.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn a_missing_config_falls_back_rather_than_emptying_the_picker() {
        let dir = std::env::temp_dir().join("francois-grok-models-missing");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let catalog = catalog_for_home(Some(&dir));
        assert!(!catalog.is_empty());
        assert_eq!(ids(&catalog), ids(&fallback()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_real_shaped_config_on_disk_falls_back() {
        let dir = std::env::temp_dir().join("francois-grok-models-fresh");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("config.toml"), LIVE_FRESH_CONFIG).unwrap();
        assert_eq!(ids(&catalog_for_home(Some(&dir))), ids(&fallback()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_config_falls_back() {
        let dir = std::env::temp_dir().join("francois-grok-models-bad");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("config.toml"), "not = [valid").unwrap();
        assert_eq!(ids(&catalog_for_home(Some(&dir))), ids(&fallback()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_real_custom_config_on_disk_is_read_and_beats_the_fallback() {
        let dir = std::env::temp_dir().join("francois-grok-models-custom");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("config.toml"), CUSTOM_MODELS).unwrap();
        let catalog = catalog_for_home(Some(&dir));
        assert_eq!(catalog[0].id, "company-grok");
        assert_ne!(ids(&catalog), ids(&fallback()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_built_in_account_with_no_config_dir_still_gets_a_catalog() {
        assert_eq!(ids(&catalog_for_home(None)), ids(&fallback()));
        assert!(!fallback().is_empty());
    }
}
