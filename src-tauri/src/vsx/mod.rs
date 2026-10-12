// vsx/ — code-editor-vsx (specs/code-editor-vsx.md FR-1..FR-5): declarative VS
// Code extensions from Open VSX. Only the declarative half is ever kept —
// languages, TextMate grammars, snippets, language configuration. No extension
// code is downloaded into the webview, evaluated, or run anywhere.
//
// mod.rs owns the model (mirrors contract/code-editor-vsx.ts EXACTLY), the FR-4
// limits, the id/path rules both install and contributions apply, and the
// injectable HTTP seam (`Fetch`) — tests never touch the network. Children:
//  * registry.rs      — Open VSX search/details JSON + capped GETs (FR-1/FR-2)
//  * classify.rs      — support, counts and language ids from a package.json (FR-3)
//  * icons.rs         — icon → data URL, disk cache with an LRU cap (FR-1)
//  * install.rs       — download, sha256, allowlisted zip extraction (FR-4)
//  * store.rs         — `installed.json`: list / enable / uninstall
//  * contributions.rs — enabled installs → inlined file contents (FR-5)
//  * commands.rs      — the seven `#[tauri::command]`s

mod classify;
pub mod commands;
mod contributions;
mod icons;
mod install;
mod registry;
mod store;

#[cfg(test)]
pub(crate) mod testutil;

use crate::ipc::{AppError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

// ---------- FR-1 / FR-4 limits (contract constants) ----------

pub(crate) const VSX_REGISTRY: &str = "https://open-vsx.org";
pub(crate) const VSX_MAX_PACKAGE_BYTES: u64 = 60 * 1024 * 1024;
pub(crate) const VSX_MAX_EXTRACT_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const VSX_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub(crate) const VSX_SEARCH_PAGE: u32 = 30;

/// FR-1 timeouts.
pub(crate) const SHORT_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

// ---------- model (mirrors contract/code-editor-vsx.ts EXACTLY) ----------

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum VsxSupport {
    Full,
    Partial,
    Unsupported,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VsxContributionCounts {
    pub languages: u32,
    pub grammars: u32,
    pub snippets: u32,
    pub language_configurations: u32,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxSummary {
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub publisher: String,
    pub download_count: u64,
    pub average_rating: Option<f64>,
    pub icon: Option<String>,
    pub support: Option<VsxSupport>,
    pub verified: bool,
}

/// `VsxDetails extends VsxSummary` — flattened so the wire object is one level.
/// `support` is narrowed to non-null by construction (always `Some`).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxDetails {
    #[serde(flatten)]
    pub summary: VsxSummary,
    pub contributions: VsxContributionCounts,
    pub language_ids: Vec<String>,
    pub license: Option<String>,
    pub repository: Option<String>,
    pub page_url: String,
    pub readme: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxInstalled {
    pub id: String,
    pub display_name: String,
    pub publisher: String,
    pub description: String,
    pub version: String,
    pub icon: Option<String>,
    /// Never `Unsupported` — install refuses those (FR-3).
    pub support: VsxSupport,
    pub contributions: VsxContributionCounts,
    pub language_ids: Vec<String>,
    pub enabled: bool,
    pub installed_at: u64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxSearchRequest {
    pub query: String,
    pub offset: u32,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxSearchData {
    pub results: Vec<VsxSummary>,
    pub total: u64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxDetailsRequest {
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxInstallRequest {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxUninstallRequest {
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxSetEnabledRequest {
    pub id: String,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxLanguage {
    pub extension_id: String,
    pub id: String,
    pub aliases: Vec<String>,
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
    pub filename_patterns: Vec<String>,
    pub first_line: Option<String>,
    pub configuration: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum GrammarFormat {
    Json,
    Plist,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxGrammar {
    pub extension_id: String,
    pub language: Option<String>,
    pub scope_name: String,
    pub content: String,
    pub format: GrammarFormat,
    pub embedded_languages: BTreeMap<String, String>,
    pub token_types: BTreeMap<String, String>,
    pub inject_to: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VsxSnippetFile {
    pub extension_id: String,
    pub language: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VsxContributions {
    pub languages: Vec<VsxLanguage>,
    pub grammars: Vec<VsxGrammar>,
    pub snippets: Vec<VsxSnippetFile>,
}

// ---------- ids ----------

/// A validated `<namespace>.<name>`, lower-cased (Open VSX resolves names
/// case-insensitively, and the contract's `VsxId` is lower-case).
/// The charset rule is what keeps an id from ever smuggling a path segment into
/// a registry URL or an install directory name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExtId {
    pub namespace: String,
    pub name: String,
}

impl ExtId {
    pub(crate) fn parse(id: &str) -> Result<Self, AppError> {
        let bad = || {
            AppError::new(
                ErrorCode::InvalidInput,
                format!("Not an extension id: {id}"),
            )
        };
        let (ns, name) = id.split_once('.').ok_or_else(bad)?;
        if !is_segment(ns) || !is_segment(name) {
            return Err(bad());
        }
        Ok(Self {
            namespace: ns.to_ascii_lowercase(),
            name: name.to_ascii_lowercase(),
        })
    }

    pub(crate) fn id(&self) -> String {
        format!("{}.{}", self.namespace, self.name)
    }
}

fn is_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Registry versions are semver-ish; anything else could not name a directory safely.
pub(crate) fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && !v.starts_with('.')
        && !v.contains("..")
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
}

// ---------- paths ----------

/// `~/.francois/vsx` — production root; every child takes the root as a
/// parameter so tests run in a temp dir.
pub(crate) fn default_root() -> Option<PathBuf> {
    crate::fs_util::francois_home_dir().map(|h| h.join("vsx"))
}

/// `<root>/<id>-<version>` — the one install directory per extension.
pub(crate) fn install_dir(root: &Path, id: &str, version: &str) -> PathBuf {
    root.join(format!("{id}-{version}"))
}

/// Normalise a relative path (`./syntaxes/x.json`, `a\b`, `a/./b/../c`) to
/// forward-slash segments. `None` when it is absolute, carries a drive or UNC
/// prefix, escapes its base with `..`, contains a NUL, or is empty — the FR-4
/// zip-slip rule, applied to package.json references and zip entries alike.
pub(crate) fn normalize_rel(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.contains('\0') {
        return None;
    }
    let p = raw.replace('\\', "/");
    if p.starts_with('/') {
        return None;
    }
    let b = p.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        return None; // `C:x` / `C:/x`
    }
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s if s.contains(':') => return None, // ADS / drive-relative tricks
            s => out.push(s),
        }
    }
    (!out.is_empty()).then(|| out.join("/"))
}

// ---------- errors ----------

pub(crate) type VsxResult<T> = Result<T, AppError>;

pub(crate) fn invalid_package(reason: impl Into<String>) -> AppError {
    let reason = reason.into();
    AppError::with_detail(
        ErrorCode::VsxInvalidPackage,
        format!("The extension package was rejected: {reason}"),
        serde_json::json!({ "reason": reason }),
    )
}

pub(crate) fn internal(what: &str, e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Internal, format!("{what}: {e}"))
}

// ---------- the HTTP seam (FR-1) ----------

#[derive(Debug)]
pub(crate) enum FetchError {
    /// The server answered with a non-2xx status.
    Status(u16),
    /// DNS / connect / TLS / timeout — the registry was never reached usably.
    Transport(String),
}

/// One GET. Production is `UreqFetch`; tests inject a map of canned bodies.
pub(crate) trait Fetch: Send + Sync {
    fn get(&self, url: &str, timeout: Duration) -> Result<Box<dyn Read + Send>, FetchError>;
}

pub(crate) struct UreqFetch;

impl Fetch for UreqFetch {
    fn get(&self, url: &str, timeout: Duration) -> Result<Box<dyn Read + Send>, FetchError> {
        // `timeout` is the OVERALL deadline in ureq 2 — connect, redirects and
        // reading the body — so a stalled download cannot hold a worker forever.
        let agent = ureq::AgentBuilder::new().timeout(timeout).build();
        match agent
            .get(url)
            .set(
                "User-Agent",
                &format!("francois/{}", env!("CARGO_PKG_VERSION")),
            )
            .call()
        {
            Ok(resp) => Ok(Box::new(resp.into_reader())),
            Err(ureq::Error::Status(code, _)) => Err(FetchError::Status(code)),
            Err(ureq::Error::Transport(t)) => Err(FetchError::Transport(t.to_string())),
        }
    }
}

pub(crate) fn fetch_error(e: FetchError) -> AppError {
    match e {
        FetchError::Status(404) => AppError::new(
            ErrorCode::VsxNotFound,
            "Open VSX has no such extension or version.",
        ),
        FetchError::Status(code) => AppError::with_detail(
            ErrorCode::VsxUnreachable,
            format!("Open VSX answered HTTP {code}."),
            serde_json::json!({ "status": code }),
        ),
        FetchError::Transport(t) => AppError::with_detail(
            ErrorCode::VsxUnreachable,
            format!("Could not reach Open VSX: {t}"),
            serde_json::json!({}),
        ),
    }
}

/// Outcome of a capped read: the bytes, or the fact the cap was crossed.
#[derive(Debug)]
pub(crate) enum Capped {
    Over,
    Io(std::io::Error),
}

/// Read at most `cap` bytes; one byte more means the source is over the cap.
pub(crate) fn read_capped(r: impl Read, cap: u64) -> Result<Vec<u8>, Capped> {
    let mut buf = Vec::new();
    r.take(cap + 1).read_to_end(&mut buf).map_err(Capped::Io)?;
    if buf.len() as u64 > cap {
        return Err(Capped::Over);
    }
    Ok(buf)
}

/// The one Open VSX client: base URL + fetcher, both injectable.
pub(crate) struct Registry {
    pub base: String,
    pub fetch: std::sync::Arc<dyn Fetch>,
}

impl Registry {
    pub(crate) fn production() -> Self {
        Self {
            base: VSX_REGISTRY.to_string(),
            fetch: std::sync::Arc::new(UreqFetch),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_parse_lowercase_and_reject_path_tricks() {
        let id = ExtId::parse("Tamasfe.Even-Better-TOML").unwrap();
        assert_eq!(id.namespace, "tamasfe");
        assert_eq!(id.id(), "tamasfe.even-better-toml");
        for bad in [
            "", "noname", ".x", "x.", "a/b.c", "a.b/c", "a..b", "a.b.c", "../x.y", "a.b c",
        ] {
            assert!(ExtId::parse(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn versions_are_directory_safe() {
        assert!(valid_version("1.2.3"));
        assert!(valid_version("0.4.0-beta+1"));
        for bad in ["", "..", "1/2", "1\\2", "../1", ".1", "1..2"] {
            assert!(!valid_version(bad), "{bad}");
        }
    }

    #[test]
    fn normalize_rel_resolves_dots_and_rejects_escapes() {
        assert_eq!(
            normalize_rel("./syntaxes/toml.tmLanguage.json").as_deref(),
            Some("syntaxes/toml.tmLanguage.json")
        );
        assert_eq!(normalize_rel(r"a\b\..\c").as_deref(), Some("a/c"));
        assert_eq!(normalize_rel("a//./b").as_deref(), Some("a/b"));
        for bad in [
            "",
            "../evil",
            "a/../../x",
            "/etc/passwd",
            r"\\server\share\x",
            "C:/x",
            "c:x",
            "a/b:stream",
            "a\0b",
            ".",
            "a/..",
        ] {
            assert_eq!(normalize_rel(bad), None, "{bad:?} should be rejected");
        }
    }

    #[test]
    fn read_capped_detects_one_byte_over() {
        assert_eq!(read_capped(&b"abcd"[..], 4).unwrap(), b"abcd");
        assert!(matches!(read_capped(&b"abcde"[..], 4), Err(Capped::Over)));
    }

    #[test]
    fn fetch_errors_map_to_contract_codes() {
        assert_eq!(
            fetch_error(FetchError::Status(404)).code,
            ErrorCode::VsxNotFound
        );
        let e = fetch_error(FetchError::Status(503));
        assert_eq!(e.code, ErrorCode::VsxUnreachable);
        assert_eq!(e.detail, Some(json!({ "status": 503 })));
        assert_eq!(
            fetch_error(FetchError::Transport("dns".into())).code,
            ErrorCode::VsxUnreachable
        );
    }

    fn summary() -> VsxSummary {
        VsxSummary {
            id: "a.b".into(),
            namespace: "a".into(),
            name: "b".into(),
            display_name: "B".into(),
            description: "d".into(),
            version: "1.0.0".into(),
            publisher: "A".into(),
            download_count: 7,
            average_rating: None,
            icon: None,
            support: None,
            verified: true,
        }
    }

    #[test]
    fn summary_and_details_serialize_as_the_contract() {
        let s = summary();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(
            v,
            json!({
                "id": "a.b", "namespace": "a", "name": "b", "displayName": "B",
                "description": "d", "version": "1.0.0", "publisher": "A",
                "downloadCount": 7, "averageRating": null, "icon": null,
                "support": null, "verified": true
            })
        );
        assert_eq!(serde_json::from_value::<VsxSummary>(v).unwrap(), s);

        let d = VsxDetails {
            summary: VsxSummary {
                support: Some(VsxSupport::Partial),
                ..summary()
            },
            contributions: VsxContributionCounts {
                languages: 1,
                grammars: 2,
                snippets: 3,
                language_configurations: 1,
            },
            language_ids: vec!["toml".into()],
            license: Some("MIT".into()),
            repository: None,
            page_url: "https://open-vsx.org/extension/a/b".into(),
            readme: Some("hi".into()),
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["support"], "partial");
        assert_eq!(v["id"], "a.b");
        assert_eq!(
            v["contributions"],
            json!({ "languages": 1, "grammars": 2, "snippets": 3, "languageConfigurations": 1 })
        );
        assert_eq!(v["languageIds"], json!(["toml"]));
        assert_eq!(v["pageUrl"], "https://open-vsx.org/extension/a/b");
        assert_eq!(serde_json::from_value::<VsxDetails>(v).unwrap(), d);
    }

    #[test]
    fn requests_and_installed_round_trip() {
        let r: VsxSearchRequest =
            serde_json::from_value(json!({ "query": "", "offset": 30 })).unwrap();
        assert_eq!(r.offset, 30);
        let r: VsxInstallRequest = serde_json::from_value(json!({ "id": "a.b" })).unwrap();
        assert_eq!(r.version, None);
        let r: VsxInstallRequest =
            serde_json::from_value(json!({ "id": "a.b", "version": "1.0.0" })).unwrap();
        assert_eq!(r.version.as_deref(), Some("1.0.0"));
        let r: VsxSetEnabledRequest =
            serde_json::from_value(json!({ "id": "a.b", "enabled": false })).unwrap();
        assert!(!r.enabled);
        let _: VsxUninstallRequest = serde_json::from_value(json!({ "id": "a.b" })).unwrap();
        let _: VsxDetailsRequest = serde_json::from_value(json!({ "id": "a.b" })).unwrap();

        let i = VsxInstalled {
            id: "a.b".into(),
            display_name: "B".into(),
            publisher: "A".into(),
            description: "d".into(),
            version: "1.0.0".into(),
            icon: Some("data:image/png;base64,AA==".into()),
            support: VsxSupport::Full,
            contributions: VsxContributionCounts::default(),
            language_ids: vec![],
            enabled: true,
            installed_at: 1_700_000_000_000,
        };
        let v = serde_json::to_value(&i).unwrap();
        assert_eq!(v["installedAt"], 1_700_000_000_000u64);
        assert_eq!(v["support"], "full");
        assert_eq!(serde_json::from_value::<VsxInstalled>(v).unwrap(), i);

        let data = VsxSearchData {
            results: vec![summary()],
            total: 1,
        };
        let v = serde_json::to_value(&data).unwrap();
        assert_eq!(serde_json::from_value::<VsxSearchData>(v).unwrap(), data);
    }

    #[test]
    fn contributions_serialize_as_the_contract() {
        let c = VsxContributions {
            languages: vec![VsxLanguage {
                extension_id: "a.b".into(),
                id: "toml".into(),
                aliases: vec!["TOML".into()],
                extensions: vec![".toml".into()],
                filenames: vec![],
                filename_patterns: vec!["*.toml.in".into()],
                first_line: None,
                configuration: Some("{}".into()),
            }],
            grammars: vec![VsxGrammar {
                extension_id: "a.b".into(),
                language: None,
                scope_name: "source.toml".into(),
                content: "{}".into(),
                format: GrammarFormat::Plist,
                embedded_languages: BTreeMap::from([("meta.x".into(), "js".into())]),
                token_types: BTreeMap::new(),
                inject_to: vec!["source.md".into()],
            }],
            snippets: vec![VsxSnippetFile {
                extension_id: "a.b".into(),
                language: "toml".into(),
                content: "{}".into(),
            }],
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["languages"][0]["extensionId"], "a.b");
        assert_eq!(v["languages"][0]["filenamePatterns"], json!(["*.toml.in"]));
        assert_eq!(v["languages"][0]["firstLine"], json!(null));
        assert_eq!(v["grammars"][0]["format"], "plist");
        assert_eq!(v["grammars"][0]["scopeName"], "source.toml");
        assert_eq!(
            v["grammars"][0]["embeddedLanguages"],
            json!({ "meta.x": "js" })
        );
        assert_eq!(v["grammars"][0]["injectTo"], json!(["source.md"]));
        assert_eq!(v["grammars"][0]["tokenTypes"], json!({}));
        assert_eq!(v["snippets"][0]["language"], "toml");
        assert_eq!(serde_json::from_value::<VsxContributions>(v).unwrap(), c);
    }
}
