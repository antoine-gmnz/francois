//! FR-6/FR-7/FR-15 — bytes onto disk, under limits, and the update swap.
//!
//! The sharp edge of the whole feature. A tar entry names its own destination,
//! so `../../.claude/settings.json` is a perfectly legal thing for an archive to
//! contain and a catastrophic thing to honor. Every entry therefore goes through
//! `safe_relative_path`, which works on the STRING, rejects rather than
//! sanitizes, and never consults the filesystem (a `..` that resolves harmlessly
//! today may not tomorrow). Symlinks are refused outright for the same reason: a
//! link is a path that gets resolved later, by something that is not this code.

use super::*;

use std::io::Read as _;
use std::path::{Component, Path, PathBuf};

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
    // NOT `with_extension`: that replaces everything after the last dot, so it is
    // only correct while FR-2 forbids a dot in an id. Appending keeps the backup
    // a sibling of THIS directory whatever the charset does later.
    let backup = match install.file_name().and_then(|n| n.to_str()) {
        Some(name) => install.with_file_name(format!("{name}.previous")),
        None => return Err("the install path has no directory name".into()),
    };
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
    #[allow(unused_imports)]
    use serde_json::json;

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
