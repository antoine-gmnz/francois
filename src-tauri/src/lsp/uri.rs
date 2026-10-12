// lsp/uri.rs — code-editor-lsp FR-8: `file://` URIs between the webview's view
// of the filesystem and the server's.
//
// The webview names a WSL file `file://wsl.localhost/<distro>/home/u/a.ts`; a
// server running INSIDE that distro names it `file:///home/u/a.ts`. Every JSON
// string (and object key — `WorkspaceEdit.changes` is keyed by URI) that starts
// with `file://` is rewritten on the way in and on the way out. Windows drive
// URIs are normalised on the way out to the one form the contract names
// (`file:///C:/…`): servers built on `vscode-uri` emit `file:///c%3A/…`.

use serde_json::{Map, Value};

/// How a server sees the filesystem.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum UriMap {
    /// Same filesystem as the webview.
    Native,
    /// Inside a WSL distro.
    Wsl { distro: String },
}

impl UriMap {
    /// Webview view -> server view, in place, deep.
    pub(crate) fn to_server(&self, v: &mut Value) {
        if let UriMap::Wsl { distro } = self {
            rewrite_deep(v, &|s| wsl_to_server(distro, s));
        }
    }

    /// Server view -> webview view, in place, deep.
    pub(crate) fn to_webview(&self, v: &mut Value) {
        match self {
            UriMap::Native => rewrite_deep(v, &normalize_drive),
            UriMap::Wsl { distro } => rewrite_deep(v, &|s| wsl_to_webview(distro, s)),
        }
    }
}

/// Apply `f` to every string value and object key starting with `file://`
/// (scheme compared case-insensitively). `f` returns `None` to leave one as is.
pub(crate) fn rewrite_deep(v: &mut Value, f: &impl Fn(&str) -> Option<String>) {
    match v {
        Value::String(s) if is_file_uri(s) => {
            if let Some(n) = f(s) {
                *s = n;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|i| rewrite_deep(i, f)),
        Value::Object(map) => {
            if map.keys().any(|k| is_file_uri(k)) {
                let old = std::mem::take(map);
                let mut out = Map::with_capacity(old.len());
                for (k, val) in old {
                    let k = if is_file_uri(&k) {
                        f(&k).unwrap_or(k)
                    } else {
                        k
                    };
                    out.insert(k, val);
                }
                *map = out;
            }
            map.values_mut().for_each(|i| rewrite_deep(i, f));
        }
        _ => {}
    }
}

fn is_file_uri(s: &str) -> bool {
    s.len() >= 7 && s[..7].eq_ignore_ascii_case("file://")
}

/// `file:///c%3A/x` | `file:///c:/x` -> `file:///C:/x`; `None` when not a drive URI.
pub(crate) fn normalize_drive(s: &str) -> Option<String> {
    if s.len() < 9 || !s[..8].eq_ignore_ascii_case("file:///") {
        return None;
    }
    let rest = &s[8..];
    let letter = rest.chars().next().filter(char::is_ascii_alphabetic)?;
    let after = &rest[1..];
    let tail = if let Some(t) = after.strip_prefix(':') {
        t
    } else if after.len() >= 3 && after[..3].eq_ignore_ascii_case("%3a") {
        &after[3..]
    } else {
        return None;
    };
    if !(tail.is_empty() || tail.starts_with('/')) {
        return None;
    }
    Some(format!("file:///{}:{tail}", letter.to_ascii_uppercase()))
}

/// `file://wsl.localhost/<distro>/p` (or `wsl$`) -> `file:///p`; a drive URI
/// -> `file:///mnt/<x>/…` (the distro's automount view of it).
fn wsl_to_server(distro: &str, s: &str) -> Option<String> {
    let after_scheme = &s[7..];
    let lower = after_scheme.to_ascii_lowercase();
    for host in ["wsl.localhost/", "wsl$/", "wsl%24/"] {
        if let Some(stripped) = lower.strip_prefix(host) {
            let start = after_scheme.len() - stripped.len();
            let rest = &after_scheme[start..];
            let (name, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
            if !percent_decode(name).eq_ignore_ascii_case(distro) {
                return None;
            }
            return Some(format!(
                "file://{}",
                if path.is_empty() { "/" } else { path }
            ));
        }
    }
    let drive = normalize_drive(s)?;
    let letter = drive[8..9].to_ascii_lowercase();
    Some(format!("file:///mnt/{letter}{}", &drive[10..]))
}

/// The reverse of [`wsl_to_server`].
fn wsl_to_webview(distro: &str, s: &str) -> Option<String> {
    let path = s.get(7..).filter(|p| p.starts_with('/'))?;
    let b = path.as_bytes();
    let is_mount = path.starts_with("/mnt/")
        && b.len() >= 6
        && b[5].is_ascii_alphabetic()
        && (b.len() == 6 || b[6] == b'/');
    if is_mount {
        return Some(format!(
            "file:///{}:{}",
            (b[5] as char).to_ascii_uppercase(),
            if b.len() == 6 { "/" } else { &path[6..] }
        ));
    }
    Some(format!("file://wsl.localhost/{distro}{path}"))
}

/// The webview-view `file://` URI of an absolute directory (any separator
/// style). UNC (`\\host\share\…`) keeps its host as the URI authority.
pub(crate) fn dir_to_uri(dir: &str) -> String {
    let norm = crate::fs_util::norm_path(dir);
    if let Some(unc) = norm.strip_prefix("//") {
        let (host, rest) = unc.split_at(unc.find('/').unwrap_or(unc.len()));
        return format!("file://{host}{}", encode_path(rest));
    }
    let b = norm.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        let rest = &norm[2..];
        return format!(
            "file:///{}{}",
            &norm[..2],
            if rest.is_empty() {
                "/".to_string()
            } else {
                encode_path(rest)
            }
        );
    }
    format!("file://{}", encode_path(&norm))
}

fn encode_path(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    for byte in p.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub(crate) fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && b[i + 1].is_ascii_hexdigit()
            && b[i + 2].is_ascii_hexdigit()
        {
            let hex = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
            out.push(hex(b[i + 1]) * 16 + hex(b[i + 2]));
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A comparison key: drive normalised, percent-decoded, lower-cased.
fn compare_key(uri: &str) -> String {
    let n = normalize_drive(uri).unwrap_or_else(|| uri.to_string());
    percent_decode(&n).to_lowercase()
}

/// §7: is `uri` the root itself or inside it? Both in the webview's view.
pub(crate) fn is_under(uri: &str, root_uri: &str) -> bool {
    let u = compare_key(uri);
    let r = compare_key(root_uri);
    let r = r.trim_end_matches('/');
    u == r || u.starts_with(&format!("{r}/"))
}

/// The key the core tracks an open document under — the same document named
/// `file:///c%3A/x` and `file:///C:/x` is one document.
pub(crate) fn doc_key(uri: &str) -> String {
    normalize_drive(uri).unwrap_or_else(|| uri.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wsl() -> UriMap {
        UriMap::Wsl {
            distro: "Ubuntu".into(),
        }
    }

    #[test]
    fn drive_uris_normalise_to_the_contract_form() {
        assert_eq!(
            normalize_drive("file:///c%3A/repo/a.ts").as_deref(),
            Some("file:///C:/repo/a.ts")
        );
        assert_eq!(
            normalize_drive("file:///d:/x").as_deref(),
            Some("file:///D:/x")
        );
        assert_eq!(normalize_drive("file:///C:").as_deref(), Some("file:///C:"));
        assert_eq!(normalize_drive("file:///home/u"), None);
        assert_eq!(normalize_drive("file:///cd/x"), None);
    }

    #[test]
    fn wsl_rewrite_is_deep_and_covers_keys_both_ways() {
        let mut v = json!({
            "textDocument": { "uri": "file://wsl.localhost/Ubuntu/home/u/api/a.ts" },
            "other": ["file://WSL$/ubuntu/home/u/b.ts", "file://wsl.localhost/Debian/x", "plain", 3],
            "drive": "file:///c%3A/w/x.ts"
        });
        wsl().to_server(&mut v);
        assert_eq!(v["textDocument"]["uri"], "file:///home/u/api/a.ts");
        assert_eq!(v["other"][0], "file:///home/u/b.ts");
        assert_eq!(v["other"][1], "file://wsl.localhost/Debian/x");
        assert_eq!(v["other"][2], "plain");
        assert_eq!(v["drive"], "file:///mnt/c/w/x.ts");

        let mut back = json!({
            "changes": { "file:///home/u/api/a.ts": [{ "newText": "x" }] },
            "uri": "file:///mnt/c/w/x.ts",
            "nested": [{ "targetUri": "file:///usr/lib/x.d.ts" }]
        });
        wsl().to_webview(&mut back);
        assert_eq!(
            back["changes"]["file://wsl.localhost/Ubuntu/home/u/api/a.ts"][0]["newText"],
            "x"
        );
        assert_eq!(back["uri"], "file:///C:/w/x.ts");
        assert_eq!(
            back["nested"][0]["targetUri"],
            "file://wsl.localhost/Ubuntu/usr/lib/x.d.ts"
        );
    }

    #[test]
    fn native_leaves_requests_alone_and_normalises_answers() {
        let mut v = json!({ "uri": "file:///C:/r/a.ts" });
        UriMap::Native.to_server(&mut v);
        assert_eq!(v["uri"], "file:///C:/r/a.ts");
        let mut r = json!({ "changes": { "file:///c%3A/r/a.ts": [] }, "u": "file:///home/x" });
        UriMap::Native.to_webview(&mut r);
        assert!(r["changes"].get("file:///C:/r/a.ts").is_some());
        assert_eq!(r["u"], "file:///home/x");
    }

    #[test]
    fn dir_to_uri_covers_drive_unc_and_unix() {
        assert_eq!(dir_to_uri(r"d:\repo\my app"), "file:///D:/repo/my%20app");
        assert_eq!(dir_to_uri(r"C:\"), "file:///C:/");
        assert_eq!(
            dir_to_uri(r"\\wsl.localhost\Ubuntu\home\u\api"),
            "file://wsl.localhost/Ubuntu/home/u/api"
        );
        assert_eq!(dir_to_uri("/home/u/api/"), "file:///home/u/api");
        let mut root = Value::String(dir_to_uri(r"\\wsl$\Ubuntu\home\u\api"));
        wsl().to_server(&mut root);
        assert_eq!(root, "file:///home/u/api");
    }

    #[test]
    fn is_under_tolerates_encoding_and_case() {
        let root = "file:///D:/repo/my%20app";
        assert!(is_under("file:///d%3A/repo/my%20app/src/a.ts", root));
        assert!(is_under("file:///D:/repo/my app/a.ts", root));
        assert!(is_under(root, root));
        assert!(!is_under("file:///D:/repo/my%20apps/a.ts", root));
        assert!(!is_under("file:///D:/other/a.ts", root));
    }

    #[test]
    fn percent_decode_handles_edges() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%C3%A9"), "é");
    }
}
