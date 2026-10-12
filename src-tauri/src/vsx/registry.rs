// vsx/registry.rs — FR-1/FR-2: the Open VSX client. GETs go to the registry
// base (`/api/-/search`, `/api/<ns>/<name>[/<version>]`) and to the `files.*`
// URLs those responses return — never to a URL the webview supplied, because
// every command takes an extension ID, not a URL. JSON is parsed leniently:
// any field Francois does not strictly need is optional.
//
// Open VSX fields relied on:
//  search  → { totalSize, extensions: [{ namespace, name, version, displayName?,
//             description?, downloadCount?, averageRating?, verified?,
//             namespaceDisplayName?, files: { icon? } }] }
//  version → { namespace, name, version, displayName?, description?,
//             namespaceDisplayName?, downloadCount?, averageRating?, verified?,
//             license?, repository?, files: { download, manifest, sha256?,
//             icon?, readme? } } — or HTTP 404 / `{ error }` when unknown.

use super::{
    fetch_error, read_capped, valid_version, Capped, ExtId, Registry, VsxResult, SHORT_TIMEOUT,
    VSX_SEARCH_PAGE,
};
use crate::ipc::{AppError, ErrorCode};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

/// Registry JSON and package.json documents are small; anything past this is
/// not a response Francois should be parsing.
const JSON_CAP: u64 = 4 * 1024 * 1024;
const README_FETCH_CAP: u64 = 512 * 1024;
const README_EXCERPT_BYTES: usize = 2048;

/// The `files.*` URLs of one version, kept only when they are absolute https
/// (or on the registry base, which is how tests point at a fake).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Files {
    pub download: Option<String>,
    pub manifest: Option<String>,
    pub sha256: Option<String>,
    pub icon: Option<String>,
    pub readme: Option<String>,
}

/// One extension version as the registry describes it (search entry or
/// version document — the search entry simply lacks some fields).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Entry {
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub publisher: String,
    pub download_count: u64,
    pub average_rating: Option<f64>,
    pub verified: bool,
    pub license: Option<String>,
    pub repository: Option<String>,
    pub files: Files,
}

impl Entry {
    pub(crate) fn id(&self) -> String {
        format!("{}.{}", self.namespace, self.name).to_ascii_lowercase()
    }
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

impl Registry {
    fn accept_url(&self, u: Option<String>) -> Option<String> {
        u.filter(|u| u.starts_with("https://") || u.starts_with(&self.base))
    }

    pub(crate) fn parse_entry(&self, v: &Value) -> Option<Entry> {
        let namespace = s(v, "namespace")?;
        let name = s(v, "name")?;
        let version = s(v, "version")?;
        let files = v.get("files").cloned().unwrap_or(Value::Null);
        let repository =
            s(v, "repository").or_else(|| v.get("repository").and_then(|r| s(r, "url")));
        Some(Entry {
            display_name: s(v, "displayName").unwrap_or_else(|| name.clone()),
            description: s(v, "description").unwrap_or_default(),
            publisher: s(v, "namespaceDisplayName").unwrap_or_else(|| namespace.clone()),
            download_count: v.get("downloadCount").and_then(Value::as_u64).unwrap_or(0),
            average_rating: v.get("averageRating").and_then(Value::as_f64),
            verified: v.get("verified").and_then(Value::as_bool).unwrap_or(false),
            license: s(v, "license"),
            repository,
            files: Files {
                download: self.accept_url(s(&files, "download")),
                manifest: self.accept_url(s(&files, "manifest")),
                sha256: self.accept_url(s(&files, "sha256")),
                icon: self.accept_url(s(&files, "icon")),
                readme: self.accept_url(s(&files, "readme")),
            },
            namespace,
            name,
            version,
        })
    }

    /// A capped GET. Over the cap reads as an unusable answer.
    pub(crate) fn get_bytes(&self, url: &str, timeout: Duration, cap: u64) -> VsxResult<Vec<u8>> {
        let reader = self.fetch.get(url, timeout).map_err(fetch_error)?;
        read_capped(reader, cap).map_err(|e| match e {
            Capped::Over => AppError::new(
                ErrorCode::VsxUnreachable,
                format!("Open VSX answered with more than {cap} bytes."),
            ),
            Capped::Io(e) => AppError::new(
                ErrorCode::VsxUnreachable,
                format!("Could not read the Open VSX response: {e}"),
            ),
        })
    }

    pub(crate) fn get_json(&self, url: &str) -> VsxResult<Value> {
        let bytes = self.get_bytes(url, SHORT_TIMEOUT, JSON_CAP)?;
        serde_json::from_slice(&bytes).map_err(|e| {
            AppError::new(
                ErrorCode::VsxUnreachable,
                format!("Open VSX answered with something that is not JSON: {e}"),
            )
        })
    }

    pub(crate) fn search_url(&self, query: &str, offset: u32) -> String {
        let q: String = url::form_urlencoded::byte_serialize(query.trim().as_bytes()).collect();
        let mut u = format!(
            "{}/api/-/search?query={q}&size={VSX_SEARCH_PAGE}&offset={offset}&includeAllVersions=false",
            self.base
        );
        if query.trim().is_empty() {
            u.push_str("&sortBy=downloadCount&sortOrder=desc");
        }
        u
    }

    /// `/api/-/search` → (entries, total). Entries the parser cannot read are dropped.
    pub(crate) fn search(&self, query: &str, offset: u32) -> VsxResult<(Vec<Entry>, u64)> {
        let body = self.get_json(&self.search_url(query, offset))?;
        let entries: Vec<Entry> = body
            .get("extensions")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|e| self.parse_entry(e)).collect())
            .unwrap_or_default();
        let total = body
            .get("totalSize")
            .and_then(Value::as_u64)
            .unwrap_or(entries.len() as u64);
        Ok((entries, total))
    }

    /// `/api/<ns>/<name>[/<version>]`.
    pub(crate) fn version(&self, id: &ExtId, version: Option<&str>) -> VsxResult<Entry> {
        let mut url = format!("{}/api/{}/{}", self.base, id.namespace, id.name);
        if let Some(v) = version {
            if !valid_version(v) {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    format!("Not a version: {v}"),
                ));
            }
            url = format!("{url}/{v}");
        }
        let body = self.get_json(&url)?;
        if let Some(err) = s(&body, "error") {
            if body.get("name").is_none() {
                return Err(AppError::new(ErrorCode::VsxNotFound, err));
            }
        }
        let entry = self.parse_entry(&body).ok_or_else(|| {
            AppError::new(
                ErrorCode::VsxUnreachable,
                "Open VSX described the extension without a namespace, name or version.",
            )
        })?;
        if !valid_version(&entry.version) {
            return Err(AppError::new(
                ErrorCode::VsxUnreachable,
                format!("Open VSX answered an unusable version: {}", entry.version),
            ));
        }
        Ok(entry)
    }

    /// FR-2: the version's package.json (`files.manifest`).
    pub(crate) fn manifest(&self, entry: &Entry) -> VsxResult<Value> {
        let url = entry.files.manifest.as_deref().ok_or_else(|| {
            AppError::new(
                ErrorCode::VsxUnreachable,
                "Open VSX lists no package.json for this version.",
            )
        })?;
        self.get_json(url)
    }

    /// FR-2: README excerpt, best-effort — any failure is simply no README.
    pub(crate) fn readme(&self, entry: &Entry) -> Option<String> {
        let url = entry.files.readme.as_deref()?;
        let bytes = self.get_bytes(url, SHORT_TIMEOUT, README_FETCH_CAP).ok()?;
        readme_excerpt(&String::from_utf8_lossy(&bytes))
    }
}

/// `https://open-vsx.org/extension/<ns>/<name>` — "View on Open VSX".
pub(crate) fn page_url(base: &str, entry: &Entry) -> String {
    format!("{base}/extension/{}/{}", entry.namespace, entry.name)
}

/// FR-2: plain-text excerpt — images, HTML and link targets stripped, the
/// first ~2 KB kept on a char boundary.
pub(crate) fn readme_excerpt(md: &str) -> Option<String> {
    static RES: OnceLock<[Regex; 5]> = OnceLock::new();
    let [comment, image, html, link, blank] = RES.get_or_init(|| {
        [
            Regex::new(r"(?s)<!--.*?-->").unwrap(),
            Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap(),
            Regex::new(r"<[^>\n]+>").unwrap(),
            Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap(),
            Regex::new(r"\n[ \t]*(\n[ \t]*)+").unwrap(),
        ]
    });
    let t = md.replace("\r\n", "\n");
    let t = comment.replace_all(&t, "");
    let t = image.replace_all(&t, "");
    let t = html.replace_all(&t, "");
    let t = link.replace_all(&t, "$1");
    let t = blank.replace_all(&t, "\n\n");
    let t = t.trim();
    if t.is_empty() {
        return None;
    }
    let mut end = t.len().min(README_EXCERPT_BYTES);
    while !t.is_char_boundary(end) {
        end -= 1;
    }
    Some(t[..end].trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vsx::testutil::{registry, FakeFetch};
    use serde_json::json;

    /// Trimmed from a real `/api/-/search` answer.
    fn search_sample() -> Value {
        json!({
            "offset": 0,
            "totalSize": 2,
            "extensions": [
                {
                    "url": "https://open-vsx.org/api/tamasfe/even-better-toml",
                    "files": { "icon": "https://open-vsx.org/api/tamasfe/even-better-toml/0.21.2/file/icon.png" },
                    "name": "even-better-toml",
                    "namespace": "tamasfe",
                    "version": "0.21.2",
                    "timestamp": "2024-11-01T00:00:00Z",
                    "verified": true,
                    "averageRating": 4.5,
                    "downloadCount": 1234567,
                    "displayName": "Even Better TOML",
                    "description": "Fully-featured TOML support",
                    "namespaceDisplayName": "tamasfe"
                },
                { "name": "bare", "namespace": "x", "version": "1.0.0", "files": { "icon": "http://evil.example/icon.png" } },
                { "name": "no-version", "namespace": "x" }
            ]
        })
    }

    #[test]
    fn search_parses_entries_leniently() {
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        fake.json(&reg.search_url("toml", 0), search_sample());
        let (entries, total) = reg.search("toml", 0).unwrap();
        assert_eq!(total, 2);
        assert_eq!(entries.len(), 2, "an entry without a version is dropped");
        let e = &entries[0];
        assert_eq!(e.id(), "tamasfe.even-better-toml");
        assert_eq!(e.display_name, "Even Better TOML");
        assert_eq!(e.download_count, 1_234_567);
        assert_eq!(e.average_rating, Some(4.5));
        assert!(e.verified);
        assert!(e.files.icon.as_deref().unwrap().ends_with("icon.png"));
        let bare = &entries[1];
        assert_eq!(bare.display_name, "bare");
        assert_eq!(bare.publisher, "x");
        assert_eq!(bare.average_rating, None);
        assert!(!bare.verified);
        assert_eq!(bare.files.icon, None, "plain-http file URLs are refused");
    }

    #[test]
    fn search_url_pages_and_sorts_the_empty_query_by_downloads() {
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        let u = reg.search_url("rust analyzer", 30);
        assert!(u.contains("query=rust+analyzer"));
        assert!(u.contains("size=30&offset=30"));
        assert!(!u.contains("sortBy"));
        let u = reg.search_url("  ", 0);
        assert!(u.contains("sortBy=downloadCount&sortOrder=desc"));
        assert!(reg.search_url("a&b=c", 0).contains("query=a%26b%3Dc"));
    }

    #[test]
    fn version_document_carries_files_license_and_repository() {
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        let base = &reg.base;
        fake.json(
            &format!("{base}/api/tamasfe/even-better-toml"),
            json!({
                "namespace": "tamasfe", "name": "even-better-toml", "version": "0.21.2",
                "displayName": "Even Better TOML", "description": "TOML",
                "namespaceDisplayName": "Ferenc", "downloadCount": 10, "verified": false,
                "license": "MIT", "repository": "https://github.com/tamasfe/taplo",
                "files": {
                    "download": format!("{base}/x.vsix"),
                    "manifest": format!("{base}/package.json"),
                    "sha256": format!("{base}/x.sha256"),
                    "readme": format!("{base}/README.md"),
                    "changelog": format!("{base}/CHANGELOG.md")
                }
            }),
        );
        let id = ExtId::parse("tamasfe.even-better-toml").unwrap();
        let e = reg.version(&id, None).unwrap();
        assert_eq!(e.publisher, "Ferenc");
        assert_eq!(e.license.as_deref(), Some("MIT"));
        assert_eq!(
            e.repository.as_deref(),
            Some("https://github.com/tamasfe/taplo")
        );
        assert_eq!(
            e.files.download.as_deref(),
            Some(&*format!("{base}/x.vsix"))
        );
        assert_eq!(e.files.icon, None);
        assert_eq!(
            page_url(base, &e),
            format!("{base}/extension/tamasfe/even-better-toml")
        );
    }

    #[test]
    fn version_errors_map_to_not_found_and_unreachable() {
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        let id = ExtId::parse("a.b").unwrap();
        fake.status(&format!("{}/api/a/b", reg.base), 404);
        assert_eq!(
            reg.version(&id, None).unwrap_err().code,
            ErrorCode::VsxNotFound
        );
        fake.json(
            &format!("{}/api/a/b/1.0.0", reg.base),
            json!({ "error": "Extension not found: a.b" }),
        );
        assert_eq!(
            reg.version(&id, Some("1.0.0")).unwrap_err().code,
            ErrorCode::VsxNotFound
        );
        // unknown URL = transport failure in the fake
        assert_eq!(
            reg.version(&id, Some("2.0.0")).unwrap_err().code,
            ErrorCode::VsxUnreachable
        );
        assert_eq!(
            reg.version(&id, Some("../x")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        fake.bytes(&format!("{}/api/a/b/3.0.0", reg.base), b"<html>".to_vec());
        assert_eq!(
            reg.version(&id, Some("3.0.0")).unwrap_err().code,
            ErrorCode::VsxUnreachable
        );
    }

    #[test]
    fn readme_excerpt_strips_markup_and_caps_at_two_kb() {
        let md = "# Title\r\n\r\n![badge](https://x/b.svg) <img src=\"a.png\">\n\n\n\nSee [the docs](https://d) <!-- hidden -->now.";
        assert_eq!(readme_excerpt(md).unwrap(), "# Title\n\nSee the docs now.");
        let long = "é".repeat(3000);
        let ex = readme_excerpt(&long).unwrap();
        assert!(ex.len() <= 2048);
        assert!(ex.chars().all(|c| c == 'é'));
        assert_eq!(readme_excerpt("<p></p>\n"), None);
    }
}
