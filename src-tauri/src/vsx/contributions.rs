// vsx/contributions.rs — FR-5: walk the ENABLED installs and inline what the
// editor loads. Grammar `format` comes from the file name (`.json` → json;
// `.tmLanguage`/`.plist`/`.xml` → plist). A malformed or missing file skips
// that one contribution (logged); a malformed package.json skips that one
// extension — the call itself never fails. Output is in install order, so a
// consumer applying it left-to-right lets the most recent install win (§7).

use super::classify::{self, str_field};
use super::{
    install_dir, normalize_rel, store, GrammarFormat, VsxContributions, VsxGrammar, VsxLanguage,
    VsxSnippetFile, VSX_MAX_FILE_BYTES,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

fn read_text(dir: &Path, rel: &str) -> Option<String> {
    let p = normalize_rel(rel)?;
    let path = dir.join(p);
    if std::fs::metadata(&path).ok()?.len() > VSX_MAX_FILE_BYTES {
        return None;
    }
    let text = String::from_utf8(std::fs::read(path).ok()?).ok()?;
    Some(
        text.strip_prefix('\u{feff}')
            .map(str::to_string)
            .unwrap_or(text),
    )
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn string_map(v: &Value, key: &str) -> BTreeMap<String, String> {
    v.get(key)
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn grammar_format(path: &str) -> Option<GrammarFormat> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".json") {
        Some(GrammarFormat::Json)
    } else if [".tmlanguage", ".plist", ".xml"]
        .iter()
        .any(|e| lower.ends_with(e))
    {
        Some(GrammarFormat::Plist)
    } else {
        None
    }
}

fn well_formed(content: &str, format: GrammarFormat) -> bool {
    match format {
        GrammarFormat::Json => serde_json::from_str::<Value>(content).is_ok_and(|v| v.is_object()),
        GrammarFormat::Plist => content.contains("<plist") || content.contains("<dict"),
    }
}

fn skip(ext: &str, what: &str) {
    eprintln!("[vsx] {ext}: skipping {what}");
}

fn one_extension(ext: &str, dir: &Path, out: &mut VsxContributions) {
    let Some(manifest) =
        read_text(dir, "package.json").and_then(|t| serde_json::from_str::<Value>(&t).ok())
    else {
        skip(ext, "the whole extension (package.json unreadable)");
        return;
    };

    for l in classify::languages(&manifest) {
        let Some(id) = str_field(l, "id") else {
            skip(ext, "a language without an id");
            continue;
        };
        let configuration = str_field(l, "configuration").and_then(|p| {
            let text = read_text(dir, p);
            if text.is_none() {
                skip(ext, &format!("the configuration {p}"));
            }
            text
        });
        out.languages.push(VsxLanguage {
            extension_id: ext.to_string(),
            id: id.to_string(),
            aliases: strings(l, "aliases"),
            extensions: strings(l, "extensions"),
            filenames: strings(l, "filenames"),
            filename_patterns: strings(l, "filenamePatterns"),
            first_line: str_field(l, "firstLine").map(str::to_string),
            configuration,
        });
    }

    for g in classify::grammars(&manifest) {
        let (Some(scope), Some(path)) = (str_field(g, "scopeName"), str_field(g, "path")) else {
            skip(ext, "a grammar without scopeName/path");
            continue;
        };
        let Some(format) = grammar_format(path) else {
            skip(ext, &format!("the grammar {path} (unknown format)"));
            continue;
        };
        let Some(content) = read_text(dir, path).filter(|c| well_formed(c, format)) else {
            skip(ext, &format!("the grammar {path} (missing or malformed)"));
            continue;
        };
        out.grammars.push(VsxGrammar {
            extension_id: ext.to_string(),
            language: str_field(g, "language").map(str::to_string),
            scope_name: scope.to_string(),
            content,
            format,
            embedded_languages: string_map(g, "embeddedLanguages"),
            token_types: string_map(g, "tokenTypes"),
            inject_to: strings(g, "injectTo"),
        });
    }

    for s in classify::snippets(&manifest) {
        let (Some(language), Some(path)) = (str_field(s, "language"), str_field(s, "path")) else {
            skip(ext, "a snippet file without language/path");
            continue;
        };
        let Some(content) = read_text(dir, path) else {
            skip(ext, &format!("the snippets {path}"));
            continue;
        };
        out.snippets.push(VsxSnippetFile {
            extension_id: ext.to_string(),
            language: language.to_string(),
            content,
        });
    }
}

pub(crate) fn contributions(root: &Path) -> VsxContributions {
    let mut installed: Vec<_> = store::load(root)
        .into_iter()
        .filter(|r| r.enabled)
        .collect();
    installed.sort_by_key(|r| r.installed_at);
    let mut out = VsxContributions::default();
    for rec in installed {
        one_extension(&rec.id, &install_dir(root, &rec.id, &rec.version), &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::TempDir;
    use crate::vsx::testutil::{toml_manifest, GRAMMAR_JSON, GRAMMAR_PLIST};
    use crate::vsx::{VsxContributionCounts, VsxInstalled, VsxSupport};
    use serde_json::json;

    fn put(root: &Path, id: &str, at: u64, enabled: bool, files: &[(&str, &[u8])]) {
        let dir = install_dir(root, id, "1.0.0");
        for (rel, bytes) in files {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, bytes).unwrap();
        }
        let _g = store::lock();
        store::upsert_locked(
            root,
            VsxInstalled {
                id: id.into(),
                display_name: id.into(),
                publisher: "p".into(),
                description: String::new(),
                version: "1.0.0".into(),
                icon: None,
                support: VsxSupport::Full,
                contributions: VsxContributionCounts::default(),
                language_ids: vec![],
                enabled,
                installed_at: at,
            },
        )
        .unwrap();
    }

    fn full_toml() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            (
                "package.json",
                serde_json::to_vec(&toml_manifest("1.0.0")).unwrap(),
            ),
            ("language-configuration.json", b"{ // c\n}".to_vec()),
            ("syntaxes/toml.tmLanguage.json", GRAMMAR_JSON.to_vec()),
            ("syntaxes/md.tmLanguage", GRAMMAR_PLIST.to_vec()),
            ("snippets/toml.json", b"\xEF\xBB\xBF{}".to_vec()),
        ]
    }

    fn refs<'a>(v: &'a [(&'static str, Vec<u8>)]) -> Vec<(&'static str, &'a [u8])> {
        v.iter().map(|(a, b)| (*a, b.as_slice())).collect()
    }

    #[test]
    fn enabled_installs_are_inlined_with_formats() {
        let tmp = TempDir::new();
        let root = tmp.path();
        put(root, "acme.toml", 1, true, &refs(&full_toml()));
        let c = contributions(root);
        assert_eq!(c.languages.len(), 1);
        let l = &c.languages[0];
        assert_eq!(l.extension_id, "acme.toml");
        assert_eq!(l.extensions, vec![".toml"]);
        assert_eq!(l.filenames, vec!["Cargo.lock"]);
        assert_eq!(l.aliases, vec!["TOML", "toml"]);
        assert_eq!(l.first_line, None);
        assert_eq!(l.configuration.as_deref(), Some("{ // c\n}"));
        assert_eq!(c.grammars.len(), 2);
        assert_eq!(c.grammars[0].format, GrammarFormat::Json);
        assert_eq!(c.grammars[0].language.as_deref(), Some("toml"));
        assert_eq!(c.grammars[1].format, GrammarFormat::Plist);
        assert_eq!(c.grammars[1].language, None);
        assert_eq!(c.grammars[1].inject_to, vec!["text.html.markdown"]);
        assert_eq!(
            c.grammars[1].embedded_languages,
            BTreeMap::from([("meta.embedded.block.toml".to_string(), "toml".to_string())])
        );
        assert_eq!(c.snippets.len(), 1);
        assert_eq!(c.snippets[0].content, "{}", "the BOM is stripped");
    }

    #[test]
    fn disabled_installs_contribute_nothing_and_order_is_install_order() {
        let tmp = TempDir::new();
        let root = tmp.path();
        put(root, "z.late", 20, true, &refs(&full_toml()));
        put(root, "a.early", 10, true, &refs(&full_toml()));
        put(root, "m.off", 5, false, &refs(&full_toml()));
        let c = contributions(root);
        let ids: Vec<&str> = c
            .languages
            .iter()
            .map(|l| l.extension_id.as_str())
            .collect();
        assert_eq!(ids, vec!["a.early", "z.late"]);
    }

    #[test]
    fn malformed_files_are_skipped_never_failing() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let mut m = toml_manifest("1.0.0");
        m["contributes"]["grammars"]
            .as_array_mut()
            .unwrap()
            .extend([
                json!({ "scopeName": "source.yaml", "path": "./syntaxes/x.tmLanguage.yaml" }),
                json!({ "scopeName": "source.esc", "path": "../../escape.json" }),
                json!({ "path": "./syntaxes/toml.tmLanguage.json" }),
            ]);
        m["contributes"]["snippets"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "language": "toml", "path": "./snippets/missing.json" }));
        put(
            root,
            "acme.toml",
            1,
            true,
            &[
                ("package.json", &serde_json::to_vec(&m).unwrap()),
                // configuration missing on disk → configuration: null, language kept
                ("syntaxes/toml.tmLanguage.json", b"{ not json"),
                ("syntaxes/md.tmLanguage", b"\xFF\xFE binary"),
                ("syntaxes/x.tmLanguage.yaml", b"scopeName: source.yaml"),
                ("snippets/toml.json", b"{}"),
            ],
        );
        put(root, "bad.pkg", 2, true, &[("package.json", b"{nope")]);
        put(
            root,
            "ok.other",
            3,
            true,
            &[
                (
                    "package.json",
                    &serde_json::to_vec(&json!({ "contributes": { "languages": [{ "id": "other", "extensions": [".o"] }, { "aliases": ["no id"] }] } }))
                        .unwrap(),
                ),
            ],
        );
        let c = contributions(root);
        assert_eq!(
            c.languages
                .iter()
                .map(|l| l.id.as_str())
                .collect::<Vec<_>>(),
            vec!["toml", "other"]
        );
        assert_eq!(c.languages[0].configuration, None);
        assert!(c.grammars.is_empty(), "{:?}", c.grammars);
        assert_eq!(c.snippets.len(), 1);
    }

    #[test]
    fn grammar_formats_follow_the_file_name() {
        assert_eq!(
            grammar_format("a.tmLanguage.json"),
            Some(GrammarFormat::Json)
        );
        assert_eq!(grammar_format("a.JSON"), Some(GrammarFormat::Json));
        assert_eq!(grammar_format("a.tmLanguage"), Some(GrammarFormat::Plist));
        assert_eq!(grammar_format("a.plist"), Some(GrammarFormat::Plist));
        assert_eq!(grammar_format("a.xml"), Some(GrammarFormat::Plist));
        assert_eq!(grammar_format("a.yaml"), None);
    }

    #[test]
    fn nothing_installed_is_empty() {
        let tmp = TempDir::new();
        assert_eq!(contributions(tmp.path()), VsxContributions::default());
    }
}
