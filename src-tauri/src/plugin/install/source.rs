//! FR-3/FR-4 — what the user typed, resolved to a pinned tree.
//!
//! Every string here ends up in a URL or on a `git clone` command line, so the
//! shape checks are strict on purpose: a leading `-` git would read as a flag, a
//! `@` npm reads as a scope marker, a partial version that is a RANGE in
//! disguise. The pin (a 40-char SHA or an exact version) is the whole record of
//! what actually ran.

use super::*;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use std::io::Read as _;
use std::path::Path;
use std::process::{Command, Stdio};

// FR-3/FR-4 — source parsing
// ============================================================================

#[derive(Debug, PartialEq)]
pub(crate) enum ParsedSource {
    Github {
        owner: String,
        repo: String,
        git_ref: Option<String>,
    },
    Npm {
        name: String,
        version: Option<String>,
    },
}

/// FR-3/FR-4 with the auto-detection rule from `PluginResolveInput.kind`: a
/// github URL or an `owner/repo` shape is github, everything else is npm.
///
/// The one genuinely ambiguous shape is `@scope/pkg`, which reads as `owner/repo`
/// to a naive splitter. A leading `@` is npm's scope marker and is never legal in
/// a github owner, so it decides — checked FIRST, before the slash test.
pub(crate) fn parse_source(
    spec: &str,
    kind: Option<PluginSourceKind>,
) -> Result<ParsedSource, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err(BAD_SPEC_MSG.into());
    }
    let detected = match kind {
        Some(k) => k,
        None => {
            if spec.starts_with('@') {
                PluginSourceKind::Npm
            } else if is_github_url(spec) || spec.split('@').next().unwrap_or("").contains('/') {
                PluginSourceKind::Github
            } else {
                PluginSourceKind::Npm
            }
        }
    };
    match detected {
        PluginSourceKind::Github => parse_github(spec),
        PluginSourceKind::Npm => parse_npm(spec),
    }
}

fn is_github_url(spec: &str) -> bool {
    spec.starts_with("https://github.com/") || spec.starts_with("http://github.com/")
}

fn parse_github(spec: &str) -> Result<ParsedSource, String> {
    // Strip the URL form down to `owner/repo`, keeping any `@ref` that follows.
    let body = spec
        .strip_prefix("https://github.com/")
        .or_else(|| spec.strip_prefix("http://github.com/"))
        .unwrap_or(spec);

    // `@` separates the ref. Split from the RIGHT so the (illegal but possible)
    // `@` inside a path cannot swallow the ref.
    let (path, git_ref) = match body.rsplit_once('@') {
        Some((p, r)) if !p.is_empty() && !r.is_empty() => (p, Some(r.to_string())),
        _ => (body, None),
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);

    let (owner, repo) = path.split_once('/').ok_or(BAD_SPEC_MSG)?;
    if !is_github_segment(owner) || !is_github_segment(repo) || repo.contains('/') {
        return Err(BAD_SPEC_MSG.into());
    }
    if let Some(r) = &git_ref {
        if !is_git_ref(r) {
            return Err(BAD_SPEC_MSG.into());
        }
    }
    Ok(ParsedSource::Github {
        owner: owner.to_string(),
        repo: repo.to_string(),
        git_ref,
    })
}

/// A github owner/repo segment. Deliberately strict: this string becomes part of
/// a URL handed to `git clone`, so a leading `-` (which git would read as a flag)
/// or a shell metacharacter must never survive.
fn is_github_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.starts_with('-')
        && !s.starts_with('.')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// A branch, tag or SHA. Same reasoning as above — it is passed as `--branch`.
fn is_git_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && !s.starts_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'))
}

fn parse_npm(spec: &str) -> Result<ParsedSource, String> {
    // A scoped name carries a leading `@` that is NOT a version separator, so
    // look for the version `@` only after the scope.
    let (name, version) = if let Some(rest) = spec.strip_prefix('@') {
        match rest.split_once('@') {
            Some((n, v)) => (format!("@{n}"), Some(v.to_string())),
            None => (spec.to_string(), None),
        }
    } else {
        match spec.split_once('@') {
            Some((n, v)) => (n.to_string(), Some(v.to_string())),
            None => (spec.to_string(), None),
        }
    };
    if !is_npm_name(&name) {
        return Err(BAD_SPEC_MSG.into());
    }
    if let Some(v) = &version {
        // FR-4 / §7 #4: exact version or dist-tag ONLY. A range would make the
        // pin meaningless — the whole point of `resolvedRef` is that the code
        // running tomorrow is the code the user consented to today.
        if !is_exact_version(v) && !is_dist_tag(v) {
            return Err(RANGE_MSG.into());
        }
    }
    Ok(ParsedSource::Npm { name, version })
}

fn is_npm_name(name: &str) -> bool {
    let body = match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') {
            Some((scope, pkg)) if !scope.is_empty() && !pkg.is_empty() => {
                return is_npm_segment(scope) && is_npm_segment(pkg)
            }
            _ => return false,
        },
        None => name,
    };
    is_npm_segment(body)
}

fn is_npm_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 214
        && !s.starts_with('.')
        && !s.starts_with('_')
        && s.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.')
        })
}

/// A FULLY-qualified semver: `1.2.3`, `1.2.3-beta.1`, `1.2.3+build`. A partial
/// version (`1.2`) is a range in disguise and is refused.
pub(crate) fn is_exact_version(v: &str) -> bool {
    let core = v.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        // the pre-release / build metadata, if present, must be non-empty
        && !v.ends_with('-')
        && !v.ends_with('+')
}

/// npm forbids a dist-tag that parses as semver, so "starts with a letter" is
/// enough to separate the two — and it rejects `^1.0`, `>=2`, `1.x` and `*`.
pub(crate) fn is_dist_tag(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.as_bytes()[0].is_ascii_alphabetic()
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

// FR-4 — npm integrity
// ============================================================================

/// FR-4: verify the tarball against `dist.integrity` (SRI, sha512/384/256) or,
/// when absent, the legacy `dist.shasum` (hex sha1).
///
/// Neither present is a FAILURE, not a pass. An unverifiable download is exactly
/// the case where a pin means nothing.
pub(crate) fn verify_integrity(
    bytes: &[u8],
    integrity: Option<&str>,
    shasum: Option<&str>,
) -> Result<(), String> {
    if let Some(sri) = integrity.filter(|s| !s.trim().is_empty()) {
        // npm may list several, space-separated; the strongest one we know wins.
        for candidate in sri.split_whitespace() {
            let Some((algo, b64)) = candidate.split_once('-') else {
                continue;
            };
            let expected = match B64.decode(b64) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let actual = match algo {
                "sha512" => digest_sha512(bytes),
                "sha256" => digest_sha256(bytes),
                _ => continue,
            };
            return if actual == expected {
                Ok(())
            } else {
                Err(INTEGRITY_MSG.into())
            };
        }
    }
    if let Some(hex) = shasum.filter(|s| !s.trim().is_empty()) {
        let expected = decode_hex(hex.trim()).ok_or(INTEGRITY_MSG)?;
        return if digest_sha1(bytes) == expected {
            Ok(())
        } else {
            Err(INTEGRITY_MSG.into())
        };
    }
    Err(INTEGRITY_MSG.into())
}

fn digest_sha512(bytes: &[u8]) -> Vec<u8> {
    use sha2::Digest as _;
    sha2::Sha512::digest(bytes).to_vec()
}

fn digest_sha256(bytes: &[u8]) -> Vec<u8> {
    use sha2::Digest as _;
    sha2::Sha256::digest(bytes).to_vec()
}

fn digest_sha1(bytes: &[u8]) -> Vec<u8> {
    use sha1::Digest as _;
    sha1::Sha1::digest(bytes).to_vec()
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

// ============================================================================
// FR-3/FR-4 — fetching
// ============================================================================

/// FR-3: shallow-clone into `dest` and return the resolved 40-char SHA.
pub(crate) fn clone_github(
    owner: &str,
    repo: &str,
    git_ref: Option<&str>,
    dest: &Path,
) -> Result<String, (&'static str, String)> {
    let url = format!("https://github.com/{owner}/{repo}.git");
    let dest_str = dest.to_string_lossy().into_owned();

    let mut args: Vec<&str> = vec!["clone", "--depth", "1"];
    if let Some(r) = git_ref {
        args.push("--branch");
        args.push(r);
    }
    args.push(&url);
    args.push(&dest_str);

    let out = run_git(&args)?;
    if out.0 != 0 {
        // A SHA is a legal `@ref` for a user to type but `--branch <sha>` is not
        // a thing git supports, so retry through fetch+checkout before giving up.
        if let Some(r) = git_ref.filter(|r| looks_like_sha(r)) {
            let _ = std::fs::remove_dir_all(dest);
            return clone_at_sha(&url, r, dest);
        }
        return Err((E_SOURCE_UNREACHABLE, clone_error(&out.1)));
    }
    let head = rev_parse_head(dest)?;
    // FR-3: the `.git` directory goes before the tree is measured or moved — it
    // is not part of the plugin and would dominate the 5 MB budget.
    let _ = std::fs::remove_dir_all(dest.join(".git"));
    Ok(head)
}

fn clone_at_sha(url: &str, sha: &str, dest: &Path) -> Result<String, (&'static str, String)> {
    let dest_str = dest.to_string_lossy().into_owned();
    std::fs::create_dir_all(dest).map_err(|e| (E_SOURCE_UNREACHABLE, e.to_string()))?;
    for args in [
        vec!["init", "--quiet", &dest_str],
        vec!["-C", &dest_str, "remote", "add", "origin", url],
        vec!["-C", &dest_str, "fetch", "--depth", "1", "origin", sha],
        vec!["-C", &dest_str, "checkout", "--quiet", "FETCH_HEAD"],
    ] {
        let out = run_git(&args)?;
        if out.0 != 0 {
            return Err((E_SOURCE_UNREACHABLE, clone_error(&out.1)));
        }
    }
    let head = rev_parse_head(dest)?;
    let _ = std::fs::remove_dir_all(dest.join(".git"));
    Ok(head)
}

fn rev_parse_head(dest: &Path) -> Result<String, (&'static str, String)> {
    let dest_str = dest.to_string_lossy().into_owned();
    let out = run_git(&["-C", &dest_str, "rev-parse", "HEAD"])?;
    if out.0 != 0 {
        return Err((E_SOURCE_UNREACHABLE, clone_error(&out.1)));
    }
    Ok(out.2.trim().to_string())
}

/// argv array, never a shell string — the spec strings are validated but the
/// habit is what keeps them safe.
fn run_git(args: &[&str]) -> Result<(i32, String, String), (&'static str, String)> {
    let mut c = Command::new("git");
    c.args(args).stdin(Stdio::null());
    crate::diff::git::no_window(&mut c);
    match c.output() {
        Ok(out) => Ok((
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
        )),
        // §7 #2: git missing is its own message, not a generic clone failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err((E_SOURCE_UNREACHABLE, NO_GIT_MSG.to_string()))
        }
        Err(e) => Err((E_SOURCE_UNREACHABLE, format!("git failed: {e}"))),
    }
}

fn clone_error(stderr: &str) -> String {
    let detail = clean_text(stderr, 200, false);
    if detail.is_empty() {
        "could not clone the repository".into()
    } else {
        format!("could not clone the repository: {detail}")
    }
}

fn looks_like_sha(r: &str) -> bool {
    (7..=40).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_hexdigit())
}

/// FR-4: resolve `name@version-or-tag` against the npm registry, returning
/// `(exact version, tarball url, integrity, shasum)`.
pub(crate) fn resolve_npm(
    name: &str,
    version: Option<&str>,
) -> Result<(String, String, Option<String>, Option<String>), (&'static str, String)> {
    let encoded = name.replace('/', "%2f");
    let doc: Value = ureq::get(&format!("https://registry.npmjs.org/{encoded}"))
        .timeout(std::time::Duration::from_millis(FETCH_TIMEOUT_MS))
        .call()
        .map_err(|e| (E_SOURCE_UNREACHABLE, npm_error(name, &e)))?
        .into_json()
        .map_err(|_| {
            (
                E_SOURCE_UNREACHABLE,
                "the npm registry returned an unreadable response".to_string(),
            )
        })?;

    let resolved = match version {
        None => tag_version(&doc, "latest"),
        Some(v) if is_exact_version(v) => Some(v.to_string()),
        Some(tag) => tag_version(&doc, tag),
    }
    .ok_or_else(|| {
        (
            E_SOURCE_UNREACHABLE,
            format!(
                "{} has no version \"{}\"",
                clean_text(name, 64, false),
                clean_text(version.unwrap_or("latest"), 64, false)
            ),
        )
    })?;

    let dist = doc
        .get("versions")
        .and_then(|v| v.get(&resolved))
        .and_then(|v| v.get("dist"))
        .ok_or_else(|| {
            (
                E_SOURCE_UNREACHABLE,
                format!(
                    "{}@{} is not published",
                    clean_text(name, 64, false),
                    clean_text(&resolved, 64, false)
                ),
            )
        })?;

    let tarball = dist
        .get("tarball")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            (
                E_SOURCE_UNREACHABLE,
                "the package has no tarball".to_string(),
            )
        })?;
    // The tarball URL comes from the registry, not the user — but it still has to
    // be https, or a compromised/mirrored registry could downgrade the download.
    if !tarball.starts_with("https://") {
        return Err((
            E_SOURCE_UNREACHABLE,
            "the package tarball is not served over https".to_string(),
        ));
    }
    Ok((
        resolved,
        tarball.to_string(),
        dist.get("integrity")
            .and_then(|v| v.as_str())
            .map(String::from),
        dist.get("shasum")
            .and_then(|v| v.as_str())
            .map(String::from),
    ))
}

fn tag_version(doc: &Value, tag: &str) -> Option<String> {
    doc.get("dist-tags")?.get(tag)?.as_str().map(String::from)
}

fn npm_error(name: &str, e: &ureq::Error) -> String {
    match e {
        ureq::Error::Status(404, _) => {
            format!("no npm package named \"{}\"", clean_text(name, 64, false))
        }
        _ => "could not reach the npm registry".to_string(),
    }
}

/// Download a tarball into memory under the total-size cap. 5 MB unpacked means a
/// compressed archive is smaller still, so holding it in RAM is bounded.
pub(crate) fn download_tarball(url: &str) -> Result<Vec<u8>, (&'static str, String)> {
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_millis(FETCH_TIMEOUT_MS))
        .call()
        .map_err(|_| {
            (
                E_SOURCE_UNREACHABLE,
                "could not download the package".to_string(),
            )
        })?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(UNPACK_MAX_TOTAL_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|_| {
            (
                E_SOURCE_UNREACHABLE,
                "could not download the package".to_string(),
            )
        })?;
    if buf.len() as u64 > UNPACK_MAX_TOTAL_BYTES {
        return Err((
            E_MANIFEST_INVALID,
            format!(
                "the package exceeds the {} MB limit",
                UNPACK_MAX_TOTAL_BYTES / (1024 * 1024)
            ),
        ));
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use crate::plugin::testutil::*;
    #[allow(unused_imports)]
    use serde_json::json;

    #[test]
    fn the_three_github_forms_parse_to_the_same_repo() {
        let expect = |git_ref: Option<&str>| ParsedSource::Github {
            owner: "acme".into(),
            repo: "francois-ci".into(),
            git_ref: git_ref.map(String::from),
        };
        for spec in [
            "acme/francois-ci",
            "https://github.com/acme/francois-ci",
            "https://github.com/acme/francois-ci.git",
            "https://github.com/acme/francois-ci/",
        ] {
            assert_eq!(parse_source(spec, None).unwrap(), expect(None), "{spec}");
        }
        for spec in [
            "acme/francois-ci@main",
            "https://github.com/acme/francois-ci@main",
            "https://github.com/acme/francois-ci.git@main",
        ] {
            assert_eq!(
                parse_source(spec, None).unwrap(),
                expect(Some("main")),
                "{spec}"
            );
        }
        // a SHA and a nested tag ref are both legal
        assert_eq!(
            parse_source("acme/francois-ci@8f2c1a9", None).unwrap(),
            expect(Some("8f2c1a9"))
        );
        assert_eq!(
            parse_source("acme/francois-ci@release/v1.2", None).unwrap(),
            expect(Some("release/v1.2"))
        );
    }

    #[test]
    fn npm_specs_parse_and_scoped_names_are_not_mistaken_for_owner_repo() {
        // The one genuinely ambiguous shape.
        assert_eq!(
            parse_source("@acme/fr-ci", None).unwrap(),
            ParsedSource::Npm {
                name: "@acme/fr-ci".into(),
                version: None
            }
        );
        assert_eq!(
            parse_source("@acme/fr-ci@1.2.0", None).unwrap(),
            ParsedSource::Npm {
                name: "@acme/fr-ci".into(),
                version: Some("1.2.0".into())
            }
        );
        assert_eq!(
            parse_source("francois-ci", None).unwrap(),
            ParsedSource::Npm {
                name: "francois-ci".into(),
                version: None
            }
        );
        assert_eq!(
            parse_source("francois-ci@latest", None).unwrap(),
            ParsedSource::Npm {
                name: "francois-ci".into(),
                version: Some("latest".into())
            }
        );
    }

    #[test]
    fn an_explicit_kind_overrides_the_shape_heuristic() {
        // `acme/francois-ci` auto-detects as github...
        assert!(matches!(
            parse_source("acme/francois-ci", None).unwrap(),
            ParsedSource::Github { .. }
        ));
        // ...and forcing npm really does take the npm branch, where a slash in an
        // UNSCOPED name is illegal — so the refusal is proof the kind was honored.
        assert!(parse_source("acme/francois-ci", Some(PluginSourceKind::Npm)).is_err());

        // the mirror case: a scoped npm name auto-detects as npm, and forcing
        // github refuses it because `@acme` is not a legal owner.
        assert!(matches!(
            parse_source("@acme/fr-ci", None).unwrap(),
            ParsedSource::Npm { .. }
        ));
        assert!(parse_source("@acme/fr-ci", Some(PluginSourceKind::Github)).is_err());
    }

    #[test]
    fn semver_ranges_are_refused_with_the_exact_message() {
        // §7 #4.
        for spec in [
            "pkg@^1.2.0",
            "pkg@~1.2.0",
            "pkg@>=1.0.0",
            "pkg@1.x",
            "pkg@*",
            "pkg@1.2",
            "pkg@1",
            "pkg@1.2.3 - 2.0.0",
        ] {
            let e = parse_source(spec, None).unwrap_err();
            assert_eq!(e, RANGE_MSG, "{spec}");
        }
        // ...while exact versions and dist-tags pass
        for spec in [
            "pkg@1.2.3",
            "pkg@1.2.3-beta.1",
            "pkg@1.2.3+build",
            "pkg@latest",
            "pkg@next",
        ] {
            assert!(parse_source(spec, None).is_ok(), "{spec}");
        }
    }

    #[test]
    fn a_spec_that_is_neither_shape_is_refused() {
        // §7 #1.
        for spec in [
            "",
            "   ",
            "not a package",
            "UPPER",
            "acme/repo/extra",
            "-acme/repo",
            "acme/../../etc",
            "acme/repo@--upload-pack=evil",
            "@noslash",
            "@/pkg",
            "@acme/",
        ] {
            assert!(parse_source(spec, None).is_err(), "should refuse {spec:?}");
        }
    }

    #[test]
    fn a_leading_dash_can_never_reach_git_as_a_flag() {
        // A repo or ref starting with `-` would be read by git as an option.
        assert!(parse_source("-x/repo", Some(PluginSourceKind::Github)).is_err());
        assert!(parse_source("acme/-repo", Some(PluginSourceKind::Github)).is_err());
        assert!(parse_source("acme/repo@-x", Some(PluginSourceKind::Github)).is_err());
        assert!(parse_source(
            "acme/repo@--upload-pack=touch x",
            Some(PluginSourceKind::Github)
        )
        .is_err());
    }

    #[test]
    fn a_tarball_verifies_against_sri_or_the_legacy_shasum() {
        let bytes = b"tarball bytes";
        let sha512 = format!("sha512-{}", B64.encode(digest_sha512(bytes)));
        let sha256 = format!("sha256-{}", B64.encode(digest_sha256(bytes)));
        let sha1_hex: String = digest_sha1(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();

        assert!(verify_integrity(bytes, Some(&sha512), None).is_ok());
        assert!(verify_integrity(bytes, Some(&sha256), None).is_ok());
        assert!(verify_integrity(bytes, None, Some(&sha1_hex)).is_ok());
        // a space-separated list is legal SRI
        assert!(verify_integrity(bytes, Some(&format!("{sha256} {sha512}")), None).is_ok());
    }

    #[test]
    fn a_mismatch_or_a_missing_digest_fails_rather_than_passing() {
        // §7 #5 — and "no digest at all" is exactly when a pin means nothing.
        let bytes = b"tarball bytes";
        let wrong = format!("sha512-{}", B64.encode(digest_sha512(b"other")));
        assert_eq!(
            verify_integrity(bytes, Some(&wrong), None).unwrap_err(),
            INTEGRITY_MSG
        );
        assert_eq!(
            verify_integrity(bytes, None, Some("00ff")).unwrap_err(),
            INTEGRITY_MSG
        );
        assert_eq!(
            verify_integrity(bytes, None, None).unwrap_err(),
            INTEGRITY_MSG
        );
        assert_eq!(
            verify_integrity(bytes, Some(""), Some("")).unwrap_err(),
            INTEGRITY_MSG
        );
        // an SRI we cannot evaluate must not silently pass
        assert!(verify_integrity(bytes, Some("md5-abc"), None).is_err());
        assert!(verify_integrity(bytes, Some("sha512-not base64!"), None).is_err());
    }
}
