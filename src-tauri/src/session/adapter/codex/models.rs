//! The Codex model catalog (multi-provider-codex FR-17).
//!
//! Read from `<CODEX_HOME>/models_cache.json` — **Codex's own cache, which Codex
//! refreshes**. No network call: an adapter that fetched its own catalog would
//! need the account's credentials, a client, and a staleness policy, all to
//! duplicate a file already sitting next to the auth token. This is the one
//! place where delegating the loop to a CLI pays a dividend the native OpenAI
//! adapter cannot collect.
//!
//! Pure apart from the single `read_to_string`, and that is isolated in
//! `catalog_for_home` so the mapping itself is testable against fixture text.

use crate::session::models::ModelInfo;
use crate::session::spawn::valid_effort;

use serde::Deserialize;
use std::path::Path;

/// FR-17: the shape we read out of `models_cache.json`. Deliberately a SUBSET —
/// the real file carries ~35 keys per model (tool modes, verbosity defaults,
/// service tiers) that are Codex's business. Everything here is `default`ed so a
/// cache written by a newer Codex that drops or renames a field degrades to a
/// usable row instead of failing the whole parse.
#[derive(Deserialize)]
struct CachedModel {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    supported_reasoning_levels: Vec<ReasoningLevel>,
    /// `"hide"` marks a model Codex uses internally (`codex-auto-review`) which
    /// must never reach the picker. Anything else lists.
    #[serde(default)]
    visibility: String,
    #[serde(default)]
    context_window: u64,
    /// Codex's own ordering hint; lower sorts first.
    #[serde(default)]
    priority: i64,
}

#[derive(Deserialize)]
struct ReasoningLevel {
    #[serde(default)]
    effort: String,
}

#[derive(Deserialize)]
struct ModelsCache {
    #[serde(default)]
    models: Vec<CachedModel>,
}

/// FR-17's fallback. Used when the cache is absent (a freshly created account
/// dir has none until Codex first runs), unreadable, or malformed — the picker
/// is never empty, because an empty picker makes a working account look broken.
///
/// Slugs are the ones 0.147.0 ships; if they age out, a wrong id surfaces as a
/// clear Codex error on the first turn, whereas no ids at all surfaces as a
/// dead-end UI with nothing to click.
fn fallback() -> Vec<ModelInfo> {
    ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini"]
        .iter()
        .map(|slug| ModelInfo {
            id: (*slug).to_string(),
            label: pretty_label(slug),
            brief: None,
            context_tokens: None,
            efforts: vec!["low".into(), "medium".into(), "high".into()],
        })
        .collect()
}

/// `gpt-5.6-terra` → `GPT-5.6-Terra`. Only used by the fallback, where no
/// `display_name` exists to read.
fn pretty_label(slug: &str) -> String {
    slug.split('-')
        .map(|part| {
            if part.eq_ignore_ascii_case("gpt") {
                "GPT".to_string()
            } else {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

/// The pure half: cache text → catalog. Returns `None` when the text cannot be
/// used at all, so the caller can pick the fallback (rather than this function
/// baking that policy in and hiding a parse failure behind plausible output).
fn parse_catalog(text: &str) -> Option<Vec<ModelInfo>> {
    let cache: ModelsCache = serde_json::from_str(text).ok()?;
    let mut rows: Vec<(i64, ModelInfo)> = cache
        .models
        .into_iter()
        .filter(|m| !m.slug.is_empty())
        .filter(|m| m.visibility != "hide")
        .map(|m| {
            let label = if m.display_name.is_empty() {
                pretty_label(&m.slug)
            } else {
                m.display_name.clone()
            };
            let efforts: Vec<String> = m
                .supported_reasoning_levels
                .iter()
                // Codex ships an `ultra` level the core's effort vocabulary does
                // not carry (`valid_effort`: low/medium/high/xhigh/max). Filtering
                // here rather than widening that vocabulary keeps one runtime from
                // introducing an effort every other surface would have to handle.
                .filter(|l| valid_effort(&l.effort))
                .map(|l| l.effort.clone())
                .collect();
            (
                m.priority,
                ModelInfo {
                    id: m.slug,
                    label,
                    brief: (!m.description.is_empty()).then_some(m.description),
                    context_tokens: (m.context_window > 0).then_some(m.context_window),
                    efforts,
                },
            )
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    // Stable so equal priorities keep the cache's own order.
    rows.sort_by_key(|(priority, _)| *priority);
    Some(rows.into_iter().map(|(_, m)| m).collect())
}

/// FR-17: the catalog for one account's `CODEX_HOME`, falling back when the
/// cache cannot be used.
pub(super) fn catalog_for_home(codex_home: Option<&Path>) -> Vec<ModelInfo> {
    let Some(home) = codex_home else {
        return fallback();
    };
    std::fs::read_to_string(home.join("models_cache.json"))
        .ok()
        .and_then(|text| parse_catalog(&text))
        .unwrap_or_else(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a REAL `~/.codex/models_cache.json` written by codex-cli
    /// 0.147.0 — same field names, same values, same `hide`/`ultra` members,
    /// with only the ~30 keys this module ignores removed.
    const LIVE_CACHE: &str = r#"{
      "fetched_at": "2026-08-17T10:23:12.388354700Z",
      "client_version": "0.147.0",
      "models": [
        {
          "slug": "gpt-5.6-luna", "display_name": "GPT-5.6-Luna",
          "description": "Fast model for lighter work.",
          "supported_reasoning_levels": [{"effort":"low"},{"effort":"medium"}],
          "visibility": "list", "supported_in_api": true, "priority": 3,
          "context_window": 272000
        },
        {
          "slug": "gpt-5.6-terra", "display_name": "GPT-5.6-Terra",
          "description": "Balanced agentic coding model for everyday work.",
          "supported_reasoning_levels": [
            {"effort":"low"},{"effort":"medium"},{"effort":"high"},
            {"effort":"xhigh"},{"effort":"max"},{"effort":"ultra"}
          ],
          "visibility": "list", "supported_in_api": true, "priority": 2,
          "context_window": 272000
        },
        {
          "slug": "codex-auto-review", "display_name": "Codex Auto Review",
          "description": "Internal.", "supported_reasoning_levels": [],
          "visibility": "hide", "supported_in_api": true, "priority": 1,
          "context_window": 272000
        }
      ]
    }"#;

    #[test]
    fn the_live_cache_maps_field_for_field_onto_model_info() {
        let catalog = parse_catalog(LIVE_CACHE).expect("a real cache parses");
        let terra = catalog.iter().find(|m| m.id == "gpt-5.6-terra").unwrap();
        assert_eq!(terra.label, "GPT-5.6-Terra");
        assert_eq!(
            terra.brief.as_deref(),
            Some("Balanced agentic coding model for everyday work.")
        );
        assert_eq!(terra.context_tokens, Some(272_000));
    }

    #[test]
    fn a_hidden_model_never_reaches_the_picker() {
        // `codex-auto-review` is Codex's own internal reviewer. It has the
        // LOWEST priority number, so a sort-only implementation would put it
        // first in the list.
        let catalog = parse_catalog(LIVE_CACHE).unwrap();
        assert!(!catalog.iter().any(|m| m.id == "codex-auto-review"));
        assert_eq!(catalog.len(), 2);
    }

    #[test]
    fn efforts_are_filtered_to_the_vocabulary_the_core_accepts() {
        // Codex ships `ultra`; `valid_effort` does not carry it. Letting it
        // through would put an effort in the picker that every other surface —
        // and the Claude adapter's own --effort flag — would reject.
        let catalog = parse_catalog(LIVE_CACHE).unwrap();
        let terra = catalog.iter().find(|m| m.id == "gpt-5.6-terra").unwrap();
        assert_eq!(terra.efforts, vec!["low", "medium", "high", "xhigh", "max"]);
        assert!(!terra.efforts.iter().any(|e| e == "ultra"));
        for effort in &terra.efforts {
            assert!(valid_effort(effort));
        }
    }

    #[test]
    fn models_are_ordered_by_codexs_own_priority() {
        let catalog = parse_catalog(LIVE_CACHE).unwrap();
        assert_eq!(catalog[0].id, "gpt-5.6-terra"); // priority 2
        assert_eq!(catalog[1].id, "gpt-5.6-luna"); // priority 3
    }

    #[test]
    fn a_malformed_or_empty_cache_yields_none_so_the_caller_can_fall_back() {
        assert!(parse_catalog("not json").is_none());
        assert!(parse_catalog(r#"{"models":[]}"#).is_none());
        // Every model hidden is the same as no models.
        assert!(parse_catalog(r#"{"models":[{"slug":"x","visibility":"hide"}]}"#).is_none());
        // A model with no slug has no id to select it by.
        assert!(parse_catalog(r#"{"models":[{"display_name":"X"}]}"#).is_none());
    }

    #[test]
    fn a_cache_from_a_newer_codex_degrades_to_a_usable_row() {
        // Only `slug` is load-bearing; everything else has a default. A future
        // Codex renaming `description` must not empty the picker.
        let catalog = parse_catalog(r#"{"models":[{"slug":"gpt-9","brand_new_key":1}]}"#).unwrap();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].id, "gpt-9");
        assert_eq!(catalog[0].label, "GPT-9");
        assert_eq!(catalog[0].brief, None);
        assert_eq!(catalog[0].context_tokens, None);
        assert!(catalog[0].efforts.is_empty());
    }

    // ---------- FR-17: the fallback ----------

    /// `ModelInfo` is a shared serde type with no `PartialEq` — comparing ids is
    /// the identity that matters here anyway (which models the picker offers).
    fn ids(catalog: &[ModelInfo]) -> Vec<&str> {
        catalog.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn a_missing_cache_falls_back_rather_than_emptying_the_picker() {
        let dir = std::env::temp_dir().join("francois-codex-models-missing");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let catalog = catalog_for_home(Some(&dir));
        assert!(!catalog.is_empty());
        assert_eq!(ids(&catalog), ids(&fallback()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_cache_falls_back() {
        let dir = std::env::temp_dir().join("francois-codex-models-bad");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("models_cache.json"), "{{{ not json").unwrap();
        assert_eq!(ids(&catalog_for_home(Some(&dir))), ids(&fallback()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_real_cache_on_disk_is_read_and_beats_the_fallback() {
        let dir = std::env::temp_dir().join("francois-codex-models-good");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("models_cache.json"), LIVE_CACHE).unwrap();
        let catalog = catalog_for_home(Some(&dir));
        assert_eq!(catalog[0].id, "gpt-5.6-terra");
        assert_ne!(ids(&catalog), ids(&fallback()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_built_in_account_with_no_config_dir_still_gets_a_catalog() {
        assert_eq!(ids(&catalog_for_home(None)), ids(&fallback()));
        assert!(!fallback().is_empty());
    }

    #[test]
    fn pretty_label_capitalises_the_way_codex_display_names_do() {
        assert_eq!(pretty_label("gpt-5.6-terra"), "GPT-5.6-Terra");
        assert_eq!(pretty_label("gpt-5.4-mini"), "GPT-5.4-Mini");
    }
}
