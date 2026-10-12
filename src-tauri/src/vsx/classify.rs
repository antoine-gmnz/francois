// vsx/classify.rs — FR-3: what Francois can take from an extension, read off
// its package.json. Declarative = `contributes.languages`, `.grammars`,
// `.snippets` (language configuration rides on `languages[].configuration`).
// `full` = declarative and no `main`/`browser`; `partial` = declarative + code;
// `unsupported` = nothing declarative, or an extension pack (v1).

use super::{VsxContributionCounts, VsxSupport};
use serde_json::Value;

pub(crate) struct Classification {
    pub support: VsxSupport,
    pub counts: VsxContributionCounts,
    pub language_ids: Vec<String>,
}

fn array<'a>(manifest: &'a Value, key: &str) -> &'a [Value] {
    manifest
        .get("contributes")
        .and_then(|c| c.get(key))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub(crate) fn languages(manifest: &Value) -> &[Value] {
    array(manifest, "languages")
}
pub(crate) fn grammars(manifest: &Value) -> &[Value] {
    array(manifest, "grammars")
}
pub(crate) fn snippets(manifest: &Value) -> &[Value] {
    array(manifest, "snippets")
}

pub(crate) fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `main`/`browser` — the code half Francois never runs.
pub(crate) fn code_entries(manifest: &Value) -> Vec<&str> {
    ["main", "browser"]
        .iter()
        .filter_map(|k| str_field(manifest, k))
        .collect()
}

pub(crate) fn classify(manifest: &Value) -> Classification {
    let langs = languages(manifest);
    let counts = VsxContributionCounts {
        languages: langs.len() as u32,
        grammars: grammars(manifest).len() as u32,
        snippets: snippets(manifest).len() as u32,
        language_configurations: langs
            .iter()
            .filter(|l| str_field(l, "configuration").is_some())
            .count() as u32,
    };
    let declarative = counts.languages + counts.grammars + counts.snippets > 0;
    let pack = manifest
        .get("extensionPack")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());
    let support = if pack || !declarative {
        VsxSupport::Unsupported
    } else if code_entries(manifest).is_empty() {
        VsxSupport::Full
    } else {
        VsxSupport::Partial
    };

    let mut language_ids: Vec<String> = Vec::new();
    let ids = langs
        .iter()
        .chain(grammars(manifest))
        .chain(snippets(manifest))
        .filter_map(|v| str_field(v, "id").or_else(|| str_field(v, "language")));
    for id in ids {
        if !language_ids.iter().any(|l| l == id) {
            language_ids.push(id.to_string());
        }
    }
    Classification {
        support,
        counts,
        language_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn declarative_only_is_full() {
        let m = json!({
            "name": "toml",
            "contributes": {
                "languages": [{ "id": "toml", "configuration": "./language-configuration.json" }],
                "grammars": [{ "language": "toml", "scopeName": "source.toml", "path": "./s.json" }],
                "snippets": [{ "language": "toml", "path": "./snip.json" }]
            }
        });
        let c = classify(&m);
        assert_eq!(c.support, VsxSupport::Full);
        assert_eq!(
            c.counts,
            VsxContributionCounts {
                languages: 1,
                grammars: 1,
                snippets: 1,
                language_configurations: 1
            }
        );
        assert_eq!(c.language_ids, vec!["toml"]);
    }

    #[test]
    fn declarative_plus_code_is_partial() {
        let m = json!({
            "main": "./out/extension.js",
            "contributes": {
                "languages": [{ "id": "toml" }, { "id": "cargo-lock" }],
                "grammars": [{ "scopeName": "markdown.toml.injection", "path": "./i.json", "injectTo": ["text.html.markdown"] }],
                "commands": [{ "command": "x" }]
            }
        });
        let c = classify(&m);
        assert_eq!(c.support, VsxSupport::Partial);
        assert_eq!(c.counts.language_configurations, 0);
        assert_eq!(c.language_ids, vec!["toml", "cargo-lock"]);

        let browser_only = json!({ "browser": "./web.js", "contributes": { "snippets": [{ "language": "go", "path": "s.json" }] } });
        assert_eq!(classify(&browser_only).support, VsxSupport::Partial);
    }

    #[test]
    fn code_only_or_empty_is_unsupported() {
        let m = json!({ "main": "./x.js", "contributes": { "commands": [{ "command": "x" }], "languages": [] } });
        let c = classify(&m);
        assert_eq!(c.support, VsxSupport::Unsupported);
        assert_eq!(c.counts, VsxContributionCounts::default());
        assert_eq!(classify(&json!({})).support, VsxSupport::Unsupported);
        assert_eq!(
            classify(&json!({ "contributes": "nonsense" })).support,
            VsxSupport::Unsupported
        );
    }

    #[test]
    fn extension_packs_are_unsupported_in_v1() {
        let m = json!({
            "extensionPack": ["a.b", "c.d"],
            "contributes": { "languages": [{ "id": "x" }] }
        });
        assert_eq!(classify(&m).support, VsxSupport::Unsupported);
        let empty_pack =
            json!({ "extensionPack": [], "contributes": { "languages": [{ "id": "x" }] } });
        assert_eq!(classify(&empty_pack).support, VsxSupport::Full);
    }
}
