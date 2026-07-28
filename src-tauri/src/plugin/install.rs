//! FR-1..FR-15 — sources, staging, unpack limits, and the update swap.
//!
//! This module runs BEFORE any plugin code exists as far as the isolate is
//! concerned: it turns a string the user typed into a verified tree on disk. Two
//! things it must never do — write outside `<app data>/plugins/` (FR-8), and let
//! an archive decide where its own bytes land (FR-6).
//!
//! The unpack path is the sharp edge. A tar entry names its own destination, so
//! `../../.claude/settings.json` is a perfectly legal thing for an archive to
//! contain and a catastrophic thing to honor. Every entry therefore goes through
//! `safe_relative_path`, which works on the STRING, rejects rather than
//! sanitizes, and never consults the filesystem (a `..` that resolves harmlessly
//! today may not tomorrow). Symlinks are refused outright for the same reason:
//! a link is a path that gets resolved later, by something that is not this code.

use super::*;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

/// §7 #2/#3/#4/#5/#7 — the messages the install field shows verbatim.
pub(crate) const NO_MANIFEST_MSG: &str = "no francois-plugin.json at the repo root";
pub(crate) const NO_GIT_MSG: &str = "git is required to install from github";
pub(crate) const RANGE_MSG: &str = "use an exact version or a dist-tag";
pub(crate) const INTEGRITY_MSG: &str = "package integrity check failed";
pub(crate) const BAD_SPEC_MSG: &str = "not a github repo or npm package";

// ============================================================================
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

// ============================================================================
// FR-6/FR-7 — path safety
// ============================================================================

/// The single gate every archive-supplied path passes through.
///
/// It rejects rather than sanitizes: stripping a `..` from
/// `../../evil` would silently produce `evil`, writing a file the archive did not
/// ask for. It also never touches the filesystem — a lexical decision cannot be
/// raced by a symlink appearing mid-unpack.
///
/// Backslash is treated as a separator HERE even on unix, because the archive may
/// have been produced on Windows and `..\..\x` must not read as one innocent
/// filename.
pub(crate) fn safe_relative_path(raw: &str) -> Option<PathBuf> {
    if raw.is_empty() || raw.len() > 1024 {
        return None;
    }
    // An absolute path in any spelling: `/x`, `\x`, `C:\x`, `\\server\share`.
    if raw.starts_with('/') || raw.starts_with('\\') {
        return None;
    }
    if raw.len() >= 2 && raw.as_bytes()[1] == b':' && raw.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    // NUL and other control bytes have no business in a path.
    if raw.bytes().any(|b| b < 0x20) {
        return None;
    }
    let mut out = PathBuf::new();
    for segment in raw.split(['/', '\\']) {
        match segment {
            "" | "." => continue, // a trailing slash or a `./` prefix is harmless
            ".." => return None,  // FR-6: never, in any position
            s => out.push(s),
        }
    }
    // Belt and braces: whatever the platform's own parser makes of the result
    // must still be a plain relative path.
    if out.as_os_str().is_empty() || out.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(out)
}

/// FR-7: `entry` must be a relative POSIX path inside the tree, ending in `.js`.
pub(crate) fn validate_entry_path(entry: &str) -> Result<PathBuf, String> {
    // POSIX means forward slashes — a manifest is authored, not generated, so a
    // backslash here is a portability bug worth reporting rather than accepting.
    if entry.contains('\\') {
        return Err("entry must be a relative POSIX path ending in .js".into());
    }
    let path = safe_relative_path(entry)
        .ok_or("entry must be a relative POSIX path ending in .js".to_string())?;
    if !entry.ends_with(".js") {
        return Err("entry must be a relative POSIX path ending in .js".into());
    }
    Ok(path)
}

// ============================================================================
// FR-1/FR-2/FR-61 — manifest validation
// ============================================================================

/// FR-1: everything the manifest must satisfy before a consent card is even
/// drawn. Every failure is `PLUGIN_MANIFEST_INVALID`.
pub(crate) fn validate_manifest(m: &PluginManifest) -> Result<(), String> {
    if m.manifest_version != 1 {
        return Err(format!(
            "unsupported manifestVersion {} — this Francois understands 1",
            m.manifest_version
        ));
    }
    if !valid_plugin_id(&m.id) {
        return Err("id must be lower-case letters, digits and dashes (2–64 chars)".into());
    }
    if m.name.trim().is_empty() || m.name.chars().count() > 48 {
        return Err("name must be 1–48 characters".into());
    }
    if m.version.trim().is_empty() || m.version.chars().count() > 64 {
        return Err("version must be 1–64 characters".into());
    }
    if m.description.chars().count() > 200 {
        return Err("description must be at most 200 characters".into());
    }
    if m.author.as_ref().is_some_and(|a| a.chars().count() > 64) {
        return Err("author must be at most 64 characters".into());
    }
    validate_entry_path(&m.entry)?;
    validate_contributes(&m.contributes)?;
    validate_configuration(m.configuration())?;
    validate_capabilities(&m.capabilities)?;
    Ok(())
}

fn validate_contributes(c: &PluginContributes) -> Result<(), String> {
    if let Some(panel) = &c.panel {
        if panel.title.trim().is_empty() {
            return Err("contributes.panel.title must not be empty".into());
        }
    }
    if let Some(tab) = &c.tab {
        if tab.title.trim().is_empty() {
            return Err("contributes.tab.title must not be empty".into());
        }
    }
    let mut seen = std::collections::HashSet::new();
    for cmd in c.commands() {
        if cmd.id.trim().is_empty() || cmd.id.chars().count() > 64 {
            return Err("a command id must be 1–64 characters".into());
        }
        if !cmd
            .id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(format!(
                "command id \"{}\" must be kebab-case",
                clean_text(&cmd.id, 64, false)
            ));
        }
        if !seen.insert(cmd.id.clone()) {
            return Err(format!(
                "duplicate command id \"{}\"",
                clean_text(&cmd.id, 64, false)
            ));
        }
        if cmd.title.trim().is_empty() || cmd.title.chars().count() > 64 {
            return Err("a command title must be 1–64 characters".into());
        }
        // FR-50: the glyph is rendered as-is in the palette and in actions — one
        // grapheme, so it cannot blow out the row.
        if cmd.glyph.as_ref().is_some_and(|g| g.chars().count() > 2) {
            return Err("a command glyph must be a single character".into());
        }
    }
    Ok(())
}

fn validate_configuration(config: &[PluginSettingDescriptor]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for d in config {
        if !valid_setting_key(&d.key) {
            return Err(format!(
                "setting key \"{}\" must start with a letter and use letters, digits, _ or -",
                clean_text(&d.key, 64, false)
            ));
        }
        if !seen.insert(d.key.clone()) {
            return Err(format!(
                "duplicate setting key \"{}\"",
                clean_text(&d.key, 64, false)
            ));
        }
        if d.label.trim().is_empty() || d.label.chars().count() > 48 {
            return Err("a setting label must be 1–48 characters".into());
        }
        if d.description
            .as_ref()
            .is_some_and(|s| s.chars().count() > 200)
        {
            return Err("a setting description must be at most 200 characters".into());
        }
        if d.placeholder
            .as_ref()
            .is_some_and(|s| s.chars().count() > 48)
        {
            return Err("a setting placeholder must be at most 48 characters".into());
        }
        match d.kind {
            PluginSettingType::Select => {
                let options = d.options.as_deref().unwrap_or(&[]);
                if options.is_empty() {
                    return Err(format!(
                        "setting \"{}\" is a select and needs a non-empty options list",
                        clean_text(&d.key, 64, false)
                    ));
                }
            }
            PluginSettingType::Secret => {
                // FR-61: a default would be a credential committed to a repo.
                if d.default.is_some() {
                    return Err(format!(
                        "setting \"{}\" is a secret and cannot declare a default",
                        clean_text(&d.key, 64, false)
                    ));
                }
            }
            PluginSettingType::Number => {
                if let (Some(min), Some(max)) = (d.min, d.max) {
                    if min > max {
                        return Err(format!(
                            "setting \"{}\" has min greater than max",
                            clean_text(&d.key, 64, false)
                        ));
                    }
                }
            }
            _ => {}
        }
        if d.kind != PluginSettingType::Number && (d.min.is_some() || d.max.is_some()) {
            return Err(format!(
                "setting \"{}\" declares min/max but is not a number",
                clean_text(&d.key, 64, false)
            ));
        }
        if d.kind != PluginSettingType::Select && d.options.is_some() {
            return Err(format!(
                "setting \"{}\" declares options but is not a select",
                clean_text(&d.key, 64, false)
            ));
        }
    }
    Ok(())
}

fn validate_capabilities(c: &PluginCapabilities) -> Result<(), String> {
    let Some(network) = &c.network else {
        return Ok(());
    };
    if network.hosts.is_empty() {
        return Err("capabilities.network declares no hosts".into());
    }
    if network.hosts.len() > 64 {
        return Err("capabilities.network declares too many hosts".into());
    }
    for host in &network.hosts {
        // The consent card shows these verbatim (FR-11), so they must be
        // renderable and must not contain a scheme, a path or a port the user
        // would read as part of the host.
        let body = host.strip_prefix("*.").unwrap_or(host);
        if body.is_empty()
            || host.len() > 253
            || !body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b':' | b'[' | b']'))
        {
            return Err(format!(
                "\"{}\" is not a valid host",
                clean_text(host, 64, false)
            ));
        }
    }
    Ok(())
}

/// FR-70: clamped, or `None` when the manifest declares no polling.
pub(crate) fn refresh_interval(m: &PluginManifest) -> Option<u64> {
    m.refresh_interval_ms
        .map(|ms| ms.clamp(REFRESH_INTERVAL_MIN_MS, REFRESH_INTERVAL_MAX_MS))
}

// ============================================================================
// FR-6 — unpacking under limits
// ============================================================================

/// Running totals for one unpack, so the caller gets the same accounting whether
/// the source was a tarball or a clone.
#[derive(Default, Debug)]
pub(crate) struct UnpackTally {
    pub entries: usize,
    pub bytes: u64,
}

impl UnpackTally {
    fn add(&mut self, size: u64) -> Result<(), String> {
        self.entries += 1;
        if self.entries > UNPACK_MAX_ENTRIES {
            return Err(format!(
                "archive has more than {UNPACK_MAX_ENTRIES} entries"
            ));
        }
        if size > UNPACK_MAX_FILE_BYTES {
            return Err(format!(
                "a file exceeds the {} MB per-file limit",
                UNPACK_MAX_FILE_BYTES / (1024 * 1024)
            ));
        }
        self.bytes += size;
        if self.bytes > UNPACK_MAX_TOTAL_BYTES {
            return Err(format!(
                "the tree exceeds the {} MB limit",
                UNPACK_MAX_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        Ok(())
    }
}

/// FR-6: unpack a gzipped tar into `dest`, enforcing every limit and refusing
/// anything that is not a plain file or a directory.
///
/// `strip_root` drops the archive's single leading component, which is how npm
/// tarballs are shaped (everything lives under `package/`).
pub(crate) fn unpack_tar_gz<R: std::io::Read>(
    reader: R,
    dest: &Path,
    strip_root: bool,
) -> Result<UnpackTally, String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(reader));
    let mut tally = UnpackTally::default();
    std::fs::create_dir_all(dest).map_err(|e| format!("could not stage the tree: {e}"))?;

    let entries = archive
        .entries()
        .map_err(|e| format!("could not read the archive: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("could not read the archive: {e}"))?;
        let raw = entry
            .path()
            .map_err(|_| "unsafe archive entry".to_string())?
            .to_string_lossy()
            .into_owned();

        // FR-6: only regular files and directories. A symlink, hardlink, device
        // node or fifo is refused — each is a path resolved later by something
        // that is not this code.
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(format!(
                "unsafe archive entry: {}",
                clean_text(&raw, 120, false)
            ));
        }

        let relative = match safe_relative_path(&raw) {
            Some(p) => p,
            None => {
                return Err(format!(
                    "unsafe archive entry: {}",
                    clean_text(&raw, 120, false)
                ))
            }
        };
        let relative = if strip_root {
            // `package/x` → `x`. An entry that IS the root component contributes
            // nothing and is skipped.
            let mut comps = relative.components();
            comps.next();
            let rest: PathBuf = comps.collect();
            if rest.as_os_str().is_empty() {
                continue;
            }
            rest
        } else {
            relative
        };

        let target = dest.join(&relative);
        // A last defensive check: after joining, the result must still be under
        // `dest`. This cannot fail given safe_relative_path, which is exactly why
        // it is cheap to assert.
        if !target.starts_with(dest) {
            return Err(format!(
                "unsafe archive entry: {}",
                clean_text(&raw, 120, false)
            ));
        }

        if kind.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("could not stage {}: {e}", relative.display()))?;
            continue;
        }
        tally.add(entry.header().size().unwrap_or(0))?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not stage {}: {e}", relative.display()))?;
        }
        // Copy through a capped reader so a header that lies about its size
        // cannot blow past the per-file limit.
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("could not stage {}: {e}", relative.display()))?;
        let written = std::io::copy(
            &mut entry.by_ref().take(UNPACK_MAX_FILE_BYTES + 1),
            &mut out,
        )
        .map_err(|e| format!("could not stage {}: {e}", relative.display()))?;
        if written > UNPACK_MAX_FILE_BYTES {
            return Err(format!(
                "a file exceeds the {} MB per-file limit",
                UNPACK_MAX_FILE_BYTES / (1024 * 1024)
            ));
        }
    }
    Ok(tally)
}

/// FR-6 for a CLONED tree: the same limits, applied by walking what git wrote.
/// Symlinks are refused here too — `git clone` will happily materialize one.
pub(crate) fn scan_tree(root: &Path) -> Result<UnpackTally, String> {
    let mut tally = UnpackTally::default();
    scan_dir(root, root, &mut tally)?;
    Ok(tally)
}

fn scan_dir(root: &Path, dir: &Path, tally: &mut UnpackTally) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("could not read the tree: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("could not read the tree: {e}"))?;
        let path = entry.path();
        let meta = entry
            .metadata() // symlink_metadata semantics: read_dir's metadata does NOT follow
            .map_err(|e| format!("could not read the tree: {e}"))?;
        let shown = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
        if meta.file_type().is_symlink() {
            return Err(format!(
                "unsafe archive entry: {}",
                clean_text(&shown, 120, false)
            ));
        }
        if meta.is_dir() {
            scan_dir(root, &path, tally)?;
        } else if meta.is_file() {
            tally.add(meta.len())?;
        } else {
            return Err(format!(
                "unsafe archive entry: {}",
                clean_text(&shown, 120, false)
            ));
        }
    }
    Ok(())
}

/// FR-8: a Francois plugin never registers anything with Claude Code, so these
/// directories are dropped from the staged tree before it goes live. Dropping
/// beats ignoring: a tree on disk that LOOKS like a Claude Code plugin invites
/// some future code path to treat it as one.
pub(crate) fn strip_claude_dirs(root: &Path) {
    for name in ["skills", "commands", ".claude", ".claude-plugin"] {
        let _ = std::fs::remove_dir_all(root.join(name));
    }
}

// ============================================================================
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

// ============================================================================
// FR-5/FR-15 — staging and the swap
// ============================================================================

/// Read and validate the manifest at the root of a staged tree (FR-1/FR-7).
pub(crate) fn read_staged_manifest(dir: &Path) -> Result<PluginManifest, (&'static str, String)> {
    let bytes = std::fs::read(dir.join(MANIFEST_FILENAME))
        .map_err(|_| (E_MANIFEST_INVALID, NO_MANIFEST_MSG.to_string()))?;
    let manifest: PluginManifest = serde_json::from_slice(&bytes).map_err(|e| {
        (
            E_MANIFEST_INVALID,
            format!(
                "francois-plugin.json is not valid: {}",
                clean_text(&e.to_string(), 160, false)
            ),
        )
    })?;
    validate_manifest(&manifest).map_err(|m| (E_MANIFEST_INVALID, m))?;
    // FR-7: the entry must actually be there — a manifest pointing at a file the
    // tree does not contain fails now, not at first render.
    let entry_path = validate_entry_path(&manifest.entry).map_err(|m| (E_MANIFEST_INVALID, m))?;
    if !dir.join(&entry_path).is_file() {
        return Err((
            E_MANIFEST_INVALID,
            format!(
                "entry \"{}\" is not in the package",
                clean_text(&manifest.entry, 120, false)
            ),
        ));
    }
    Ok(manifest)
}

/// FR-5: delete every staged tree the in-memory map does not still claim.
pub(crate) fn sweep_staging(dir: &Path, live: &std::collections::HashSet<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if live.contains(&name) {
            continue;
        }
        // Anything NOT tracked in memory is abandoned: staging is not persisted
        // (§6), so an untracked directory is either debris from a previous run or
        // a staging the caller already dropped. Age does not enter into it — a
        // TTL check here would leave a fresh orphan on disk until the next sweep
        // happened to run ten minutes later.
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

/// FR-15: replace `install` with `staged` atomically enough that a failure leaves
/// the previous version live.
///
/// A cross-directory rename is the only genuinely atomic step available, and even
/// that is not atomic on Windows when the destination exists. So: move the old
/// aside FIRST, move the new in, and put the old back if that fails. The window
/// where neither is in place is two renames wide and recoverable.
pub(crate) fn swap_install(staged: &Path, install: &Path) -> Result<(), String> {
    let backup = install.with_extension("previous");
    let _ = std::fs::remove_dir_all(&backup);

    let had_previous = install.exists();
    if had_previous {
        std::fs::rename(install, &backup)
            .map_err(|e| format!("could not replace the previous version: {e}"))?;
    }
    if let Err(e) = std::fs::rename(staged, install) {
        // §7 #38: put the old one back — the plugin keeps running on its pin.
        if had_previous {
            let _ = std::fs::rename(&backup, install);
        }
        return Err(format!("could not install the new version: {e}"));
    }
    let _ = std::fs::remove_dir_all(&backup);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::*;
    use serde_json::json;

    // ---------- FR-3/FR-4: source parsing ----------

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

    // ---------- FR-6: path safety ----------

    #[test]
    fn every_traversal_and_absolute_spelling_is_refused() {
        // §7 #6 — the archive must never choose where its bytes land.
        for raw in [
            "../evil",
            "a/../../evil",
            "..",
            "a/..",
            "./../x",
            "/etc/passwd",
            "\\windows\\system32",
            "C:/Windows/x",
            "c:x",
            "..\\..\\evil",
            "a\\..\\..\\b",
            "\\\\server\\share\\x",
            "",
            "a\0b",
            "a\nb",
        ] {
            assert!(safe_relative_path(raw).is_none(), "should refuse {raw:?}");
        }
    }

    #[test]
    fn ordinary_relative_paths_survive_and_normalize() {
        assert_eq!(
            safe_relative_path("plugin.js"),
            Some(PathBuf::from("plugin.js"))
        );
        assert_eq!(
            safe_relative_path("dist/plugin.js"),
            Some(PathBuf::from("dist").join("plugin.js"))
        );
        assert_eq!(
            safe_relative_path("./dist//plugin.js"),
            Some(PathBuf::from("dist").join("plugin.js"))
        );
        // a name that merely CONTAINS dots is fine
        assert!(safe_relative_path("a..b/c").is_some());
        assert!(safe_relative_path("...hidden").is_some());
    }

    #[test]
    fn the_entry_must_be_a_relative_posix_js_path() {
        // FR-7.
        assert!(validate_entry_path("plugin.js").is_ok());
        assert!(validate_entry_path("dist/plugin.js").is_ok());
        for bad in [
            "plugin.mjs",
            "plugin.ts",
            "plugin",
            "dist/plugin.js/",
            "../plugin.js",
            "/abs/plugin.js",
            "C:\\p.js",
            "dist\\plugin.js",
            "",
        ] {
            assert!(validate_entry_path(bad).is_err(), "should refuse {bad:?}");
        }
    }

    // ---------- FR-1/FR-2/FR-61: manifest validation ----------

    #[test]
    fn the_fixture_manifest_is_valid_so_a_mutation_is_always_the_cause() {
        assert!(validate_manifest(&manifest_fixture("acme-ci")).is_ok());
    }

    #[test]
    fn manifest_identity_fields_are_bounded() {
        let bad = |f: fn(&mut PluginManifest)| {
            let mut m = manifest_fixture("acme-ci");
            f(&mut m);
            assert!(validate_manifest(&m).is_err());
        };
        bad(|m| m.manifest_version = 2);
        bad(|m| m.id = "Acme".into());
        bad(|m| m.id = "../evil".into());
        bad(|m| m.id = "a".into());
        bad(|m| m.name = "  ".into());
        bad(|m| m.name = "x".repeat(49));
        bad(|m| m.version = String::new());
        bad(|m| m.description = "x".repeat(201));
        bad(|m| m.author = Some("x".repeat(65)));
        bad(|m| m.entry = "../escape.js".into());
    }

    #[test]
    fn contributed_commands_must_be_unique_kebab_case_and_titled() {
        let with = |cmds: Vec<PluginCommandContribution>| {
            let mut m = manifest_fixture("acme-ci");
            m.contributes.commands = Some(cmds);
            validate_manifest(&m)
        };
        let cmd = |id: &str, title: &str| PluginCommandContribution {
            id: id.into(),
            title: title.into(),
            glyph: None,
            palette: None,
        };
        assert!(with(vec![cmd("open-run", "Open")]).is_ok());
        assert!(
            with(vec![cmd("open-run", "Open"), cmd("open-run", "Again")]).is_err(),
            "duplicate"
        );
        assert!(
            with(vec![cmd("Open_Run", "Open")]).is_err(),
            "not kebab-case"
        );
        assert!(with(vec![cmd("open-run", "")]).is_err(), "no title");
        assert!(with(vec![cmd("", "Open")]).is_err());
    }

    #[test]
    fn setting_descriptors_are_checked_against_their_own_type() {
        let with = |d: PluginSettingDescriptor| {
            let mut m = manifest_fixture("acme-ci");
            m.configuration = Some(vec![d]);
            validate_manifest(&m)
        };
        let base = |key: &str, kind: PluginSettingType| PluginSettingDescriptor {
            key: key.into(),
            kind,
            label: "L".into(),
            description: None,
            default: None,
            placeholder: None,
            options: None,
            min: None,
            max: None,
        };

        assert!(with(base("token", PluginSettingType::Secret)).is_ok());
        // FR-61: a secret default would be a credential committed to a repo
        assert!(with(PluginSettingDescriptor {
            default: Some(json!("ghp_x")),
            ..base("token", PluginSettingType::Secret)
        })
        .is_err());
        // a select needs options; a non-select must not declare them
        assert!(with(base("mode", PluginSettingType::Select)).is_err());
        assert!(with(PluginSettingDescriptor {
            options: Some(vec![]),
            ..base("mode", PluginSettingType::Select)
        })
        .is_err());
        assert!(with(PluginSettingDescriptor {
            options: Some(vec![PluginSettingOption {
                value: "a".into(),
                label: "A".into()
            }]),
            ..base("s", PluginSettingType::String)
        })
        .is_err());
        // min/max belong to numbers only, and must be ordered
        assert!(with(PluginSettingDescriptor {
            min: Some(1.0),
            ..base("s", PluginSettingType::String)
        })
        .is_err());
        assert!(with(PluginSettingDescriptor {
            min: Some(9.0),
            max: Some(1.0),
            ..base("n", PluginSettingType::Number)
        })
        .is_err());
        assert!(with(PluginSettingDescriptor {
            min: Some(1.0),
            max: Some(9.0),
            ..base("n", PluginSettingType::Number)
        })
        .is_ok());
        // keys follow the contract pattern and must be unique
        assert!(with(base("9lives", PluginSettingType::String)).is_err());
        let mut m = manifest_fixture("acme-ci");
        m.configuration = Some(vec![
            base("dup", PluginSettingType::String),
            base("dup", PluginSettingType::Number),
        ]);
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn a_network_capability_must_declare_usable_hosts() {
        let with = |hosts: &[&str]| {
            let mut m = manifest_fixture("acme-ci");
            m.capabilities = caps(false, false, hosts);
            validate_manifest(&m)
        };
        assert!(with(&["api.github.com", "*.acme.dev", "127.0.0.1"]).is_ok());
        for bad in [
            vec!["https://api.github.com"], // a scheme is not a host
            vec!["acme.dev/path"],
            vec![""],
            vec!["*."],
        ] {
            assert!(with(&bad).is_err(), "should refuse {bad:?}");
        }
        // an EMPTY network block is a declaration that grants nothing — refuse it
        // rather than showing the user a network consent line for no hosts.
        let mut m = manifest_fixture("acme-ci");
        m.capabilities.network = Some(PluginNetwork { hosts: vec![] });
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn the_refresh_interval_is_clamped_to_its_declared_band() {
        // FR-70.
        let mut m = manifest_fixture("acme-ci");
        assert_eq!(refresh_interval(&m), None, "absent ⇒ no polling");
        for (declared, expect) in [
            (0, REFRESH_INTERVAL_MIN_MS),
            (1_000, REFRESH_INTERVAL_MIN_MS),
            (30_000, 30_000),
            (u64::MAX, REFRESH_INTERVAL_MAX_MS),
        ] {
            m.refresh_interval_ms = Some(declared);
            assert_eq!(refresh_interval(&m), Some(expect));
        }
    }

    // ---------- FR-4: integrity ----------

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

    // ---------- FR-6: unpacking ----------

    /// Build a gzipped tar in memory from `(path, kind, bytes)` triples.
    fn tar_gz(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, kind, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_entry_type(*kind);
            header.set_mode(0o644);
            if *kind == tar::EntryType::Symlink {
                header.set_link_name("../../../etc/passwd").unwrap();
            }
            builder.append_data(&mut header, path, *body).unwrap();
        }
        gzip(builder.into_inner().unwrap())
    }

    /// A tar whose entry names are written into the header BYTE FOR BYTE.
    ///
    /// `Builder::append_data` refuses to emit `../evil` or `/etc/passwd` — it is a
    /// well-behaved writer. A hostile archive is not built with one, so testing
    /// the unpack defense means forging the header the way an attacker would.
    fn tar_gz_raw(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        for (path, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            let name = &mut header.as_old_mut().name;
            let bytes = path.as_bytes();
            assert!(bytes.len() <= name.len(), "raw fixture name too long");
            name[..bytes.len()].copy_from_slice(bytes);
            header.set_cksum();

            out.extend_from_slice(header.as_bytes());
            out.extend_from_slice(body);
            out.resize(out.len().div_ceil(512) * 512, 0); // pad to the block size
        }
        out.extend_from_slice(&[0u8; 1024]); // two empty blocks end the archive
        gzip(out)
    }

    fn gzip(bytes: Vec<u8>) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &bytes).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn an_npm_tarball_unpacks_with_its_package_prefix_stripped() {
        let dir = tmp_dir("unpack-ok");
        let dest = dir.join("staged");
        let archive = tar_gz(&[
            (
                "package/francois-plugin.json",
                tar::EntryType::Regular,
                b"{}",
            ),
            (
                "package/dist/plugin.js",
                tar::EntryType::Regular,
                b"export default {}",
            ),
        ]);
        let tally = unpack_tar_gz(archive.as_slice(), &dest, true).unwrap();
        assert_eq!(tally.entries, 2);
        assert!(dest.join("francois-plugin.json").is_file());
        assert!(dest.join("dist").join("plugin.js").is_file());
        assert!(!dest.join("package").exists(), "the prefix is stripped");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_traversing_entry_aborts_the_unpack_and_writes_nothing_outside() {
        // §7 #6 — the single most important test in this module.
        let dir = tmp_dir("unpack-escape");
        let dest = dir.join("staged");
        let canary = dir.join("owned.txt");

        for path in [
            "package/../../owned.txt",
            "../owned.txt",
            "/tmp/owned.txt",
            "..\\..\\owned.txt",
            "package/../../../../../../../../etc/owned.txt",
        ] {
            let archive = tar_gz_raw(&[(path, b"pwned")]);
            let err = unpack_tar_gz(archive.as_slice(), &dest, true).unwrap_err();
            assert!(err.starts_with("unsafe archive entry"), "{path} → {err}");
            assert!(!canary.exists(), "{path} escaped the destination");
        }
        // The whole unpack aborts, so a hostile entry cannot ride along behind a
        // legitimate one and be written before the refusal lands.
        let mixed = tar_gz_raw(&[("package/ok.js", b"fine"), ("../owned.txt", b"pwned")]);
        assert!(unpack_tar_gz(mixed.as_slice(), &dest, true).is_err());
        assert!(!canary.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_symlink_entry_is_refused_outright() {
        // FR-6: a link is a path resolved later, by something that is not us.
        let dir = tmp_dir("unpack-symlink");
        let archive = tar_gz(&[("package/link", tar::EntryType::Symlink, b"")]);
        let err = unpack_tar_gz(archive.as_slice(), &dir.join("staged"), true).unwrap_err();
        assert!(err.starts_with("unsafe archive entry"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_entry_count_and_size_limits_are_enforced() {
        // §7 #7.
        let dir = tmp_dir("unpack-limits");

        let many: Vec<(String, tar::EntryType, Vec<u8>)> = (0..UNPACK_MAX_ENTRIES + 1)
            .map(|i| {
                (
                    format!("package/f{i}.js"),
                    tar::EntryType::Regular,
                    b"x".to_vec(),
                )
            })
            .collect();
        let refs: Vec<(&str, tar::EntryType, &[u8])> = many
            .iter()
            .map(|(p, k, b)| (p.as_str(), *k, b.as_slice()))
            .collect();
        let err = unpack_tar_gz(tar_gz(&refs).as_slice(), &dir.join("a"), true).unwrap_err();
        assert!(err.contains("entries"), "{err}");

        let big = vec![b'x'; (UNPACK_MAX_FILE_BYTES + 1) as usize];
        let err = unpack_tar_gz(
            tar_gz(&[("package/big.js", tar::EntryType::Regular, &big)]).as_slice(),
            &dir.join("b"),
            true,
        )
        .unwrap_err();
        assert!(err.contains("per-file limit"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_cloned_tree_is_measured_under_the_same_limits() {
        let dir = tmp_dir("scan");
        let tree = dir.join("tree");
        std::fs::create_dir_all(tree.join("dist")).unwrap();
        std::fs::write(tree.join("francois-plugin.json"), b"{}").unwrap();
        std::fs::write(tree.join("dist").join("plugin.js"), b"export default {}").unwrap();

        let tally = scan_tree(&tree).unwrap();
        assert_eq!(tally.entries, 2);
        assert!(tally.bytes > 0);

        std::fs::write(
            tree.join("big.bin"),
            vec![b'x'; (UNPACK_MAX_FILE_BYTES + 1) as usize],
        )
        .unwrap();
        assert!(scan_tree(&tree).unwrap_err().contains("per-file limit"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_code_directories_are_removed_from_the_staged_tree() {
        // FR-8 / §7 #50: nothing is ever registered with Claude Code.
        let dir = tmp_dir("strip-claude");
        for name in ["skills", "commands", ".claude", ".claude-plugin", "dist"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
            std::fs::write(dir.join(name).join("x"), b"x").unwrap();
        }
        strip_claude_dirs(&dir);
        for gone in ["skills", "commands", ".claude", ".claude-plugin"] {
            assert!(!dir.join(gone).exists(), "{gone} should be dropped");
        }
        assert!(
            dir.join("dist").exists(),
            "the plugin's own code is untouched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- FR-1: reading a staged manifest ----------

    #[test]
    fn a_staged_tree_yields_its_manifest_or_a_specific_refusal() {
        let dir = tmp_dir("staged-manifest");

        let good = dir.join("good");
        write_plugin_tree(&good, "acme-ci", "export default {}");
        assert_eq!(read_staged_manifest(&good).unwrap().id, "acme-ci");

        // §7 #3: no manifest at all
        let bare = dir.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(read_staged_manifest(&bare).unwrap_err().1, NO_MANIFEST_MSG);

        // unparseable
        let broken = dir.join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join(MANIFEST_FILENAME), b"{ not json").unwrap();
        assert_eq!(
            read_staged_manifest(&broken).unwrap_err().0,
            E_MANIFEST_INVALID
        );

        // FR-7: the entry file named by a valid manifest is not in the tree
        let missing = dir.join("missing-entry");
        write_plugin_tree(&missing, "acme-ci", "x");
        std::fs::remove_file(missing.join("plugin.js")).unwrap();
        let e = read_staged_manifest(&missing).unwrap_err();
        assert!(e.1.contains("not in the package"), "{}", e.1);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- FR-15: the swap ----------

    #[test]
    fn a_swap_replaces_the_tree_and_a_failed_swap_leaves_the_old_one_live() {
        // §7 #38.
        let dir = tmp_dir("swap");
        let install = dir.join("acme-ci");
        let staged = dir.join("staged");
        write_plugin_tree(&install, "acme-ci", "// v1");
        write_plugin_tree(&staged, "acme-ci", "// v2");

        swap_install(&staged, &install).unwrap();
        assert_eq!(
            std::fs::read_to_string(install.join("plugin.js")).unwrap(),
            "// v2"
        );
        assert!(!staged.exists());
        assert!(!install.with_extension("previous").exists(), "no debris");

        // a staged tree that is not there at all: the old version survives
        let err = swap_install(&dir.join("nothing-here"), &install);
        assert!(err.is_err());
        assert_eq!(
            std::fs::read_to_string(install.join("plugin.js")).unwrap(),
            "// v2",
            "the previous version is still live"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_first_install_swaps_into_a_path_that_does_not_exist_yet() {
        let dir = tmp_dir("swap-fresh");
        let staged = dir.join("staged");
        write_plugin_tree(&staged, "acme-ci", "// v1");
        swap_install(&staged, &dir.join("acme-ci")).unwrap();
        assert!(dir.join("acme-ci").join("plugin.js").is_file());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- FR-5: staging sweep ----------

    #[test]
    fn the_sweep_keeps_live_stagings_and_removes_everything_else() {
        let dir = tmp_dir("sweep");
        for name in ["live", "orphan"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
        }
        let live: std::collections::HashSet<String> = ["live".to_string()].into_iter().collect();

        // A tree from a PREVIOUS run is untracked and goes regardless of age —
        // staging is not persisted (§6), so untracked means abandoned.
        sweep_staging(&dir, &live);
        assert!(dir.join("live").exists());
        assert!(!dir.join("orphan").exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
