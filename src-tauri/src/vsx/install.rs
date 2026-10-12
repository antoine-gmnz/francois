// vsx/install.rs — FR-4. Download the .vsix to a temp file streaming under a
// hard cap, verify its sha256 against `files.sha256`, open the zip, read
// `extension/package.json`, and extract ONLY that file, the files its
// declarative contributions reference, and the icon. Every entry path is
// normalised and must stay inside the archive (no absolute paths, `..`, drive
// prefixes); a referenced entry that is a symlink, or over a size cap, rejects
// the whole package. Extraction lands in a staging dir that is renamed into
// `<root>/<id>-<version>/`, replacing any other version, and only then is
// `installed.json` updated. No `main`/`browser` file is ever written.

use super::classify::{self, classify, str_field};
use super::{
    icons, install_dir, internal, invalid_package, normalize_rel, read_capped, store, Capped,
    ExtId, Registry, VsxInstalled, VsxResult, VsxSupport, DOWNLOAD_TIMEOUT, SHORT_TIMEOUT,
    VSX_MAX_EXTRACT_BYTES, VSX_MAX_FILE_BYTES, VSX_MAX_PACKAGE_BYTES,
};
use crate::ipc::{AppError, ErrorCode};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Removes its path on drop unless disarmed — a failed install leaves nothing behind.
struct Scratch(Option<PathBuf>);

impl Scratch {
    fn path(&self) -> &Path {
        self.0
            .as_deref()
            .expect("scratch path is live until disarmed")
    }
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(p) = &self.0 {
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(p);
            } else {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unsupported(id: &str) -> AppError {
    AppError::new(
        ErrorCode::VsxUnsupported,
        format!("{id} has nothing Francois can load — it needs VS Code to run."),
    )
}

/// Stream `reader` into `dest` with a hard cap, hashing as it goes.
pub(crate) fn save_capped(reader: impl Read, dest: &Path, cap: u64) -> VsxResult<String> {
    let mut f = std::fs::File::create(dest)
        .map_err(|e| internal("could not create the download file", e))?;
    let mut hasher = Sha256::new();
    let mut limited = reader.take(cap + 1);
    let mut buf = vec![0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = limited.read(&mut buf).map_err(|e| {
            AppError::new(
                ErrorCode::VsxUnreachable,
                format!("The download was interrupted: {e}"),
            )
        })?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > cap {
            return Err(invalid_package(format!(
                "the package is larger than {} MiB",
                cap / (1024 * 1024)
            )));
        }
        hasher.update(&buf[..n]);
        f.write_all(&buf[..n])
            .map_err(|e| internal("could not write the download", e))?;
    }
    f.sync_all()
        .map_err(|e| internal("could not write the download", e))?;
    Ok(hex(&hasher.finalize()))
}

/// The `.sha256` file is `<hex>`, optionally followed by whitespace and a file name.
pub(crate) fn parse_sha256(text: &str) -> Option<String> {
    let token = text.split_whitespace().next()?;
    (token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| token.to_ascii_lowercase())
}

/// Paths (relative to `extension/`) the declarative half needs: package.json,
/// grammar/snippet/configuration files and the icon — minus anything that is
/// code. A reference escaping the extension rejects the package.
pub(crate) fn referenced_paths(manifest: &Value) -> VsxResult<BTreeSet<String>> {
    let mut raw: Vec<&str> = Vec::new();
    raw.extend(
        classify::languages(manifest)
            .iter()
            .filter_map(|l| str_field(l, "configuration")),
    );
    raw.extend(
        classify::grammars(manifest)
            .iter()
            .filter_map(|g| str_field(g, "path")),
    );
    raw.extend(
        classify::snippets(manifest)
            .iter()
            .filter_map(|s| str_field(s, "path")),
    );
    raw.extend(str_field(manifest, "icon"));

    let code: BTreeSet<String> = classify::code_entries(manifest)
        .into_iter()
        .filter_map(normalize_rel)
        .flat_map(|c| [format!("{c}.js"), c])
        .collect();
    let mut out = BTreeSet::from(["package.json".to_string()]);
    for r in raw {
        let p = normalize_rel(r)
            .ok_or_else(|| invalid_package(format!("{r} points outside the extension")))?;
        if code.contains(&p) || is_executable(&p) {
            continue;
        }
        out.insert(p);
    }
    Ok(out)
}

fn is_executable(p: &str) -> bool {
    const EXEC: [&str; 11] = [
        ".js", ".mjs", ".cjs", ".node", ".exe", ".dll", ".so", ".dylib", ".wasm", ".bat", ".sh",
    ];
    let lower = p.to_ascii_lowercase();
    EXEC.iter().any(|e| lower.ends_with(e))
}

/// An archive entry name must be a plain relative path: no absolute/drive/UNC
/// prefix and no `..` segment at all (even one that would resolve inside).
fn safe_entry_name(name: &str) -> Option<String> {
    let flipped = name.replace('\\', "/");
    if flipped.split('/').any(|s| s == "..") {
        return None;
    }
    normalize_rel(&flipped)
}

/// FR-4 extraction from the downloaded file into `staging`. Returns the package.json.
pub(crate) fn extract(vsix: &Path, staging: &Path, id: &str) -> VsxResult<Value> {
    let file = std::fs::File::open(vsix).map_err(|e| internal("could not open the download", e))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| invalid_package(format!("not a zip archive ({e})")))?;

    // Every entry is vetted, kept or not: a package carrying a zip-slip name
    // is hostile, whatever Francois meant to take from it.
    let mut index: HashMap<String, usize> = HashMap::new();
    for i in 0..zip.len() {
        let entry = zip
            .by_index_raw(i)
            .map_err(|e| invalid_package(format!("unreadable entry ({e})")))?;
        let name = String::from_utf8_lossy(entry.name_raw()).into_owned();
        let Some(norm) = safe_entry_name(&name) else {
            return Err(invalid_package(format!("unsafe entry path {name:?}")));
        };
        if let Some(rel) = norm.strip_prefix("extension/") {
            index.entry(rel.to_string()).or_insert(i);
        }
    }

    let read_entry = |zip: &mut zip::ZipArchive<std::fs::File>,
                      rel: &str|
     -> VsxResult<Option<Vec<u8>>> {
        let Some(&i) = index.get(rel) else {
            return Ok(None);
        };
        let entry = zip
            .by_index(i)
            .map_err(|e| invalid_package(format!("unreadable entry {rel} ({e})")))?;
        if entry.is_symlink() {
            return Err(invalid_package(format!("{rel} is a symlink")));
        }
        if entry.is_dir() {
            return Ok(None);
        }
        if entry.size() > VSX_MAX_FILE_BYTES {
            return Err(invalid_package(format!("{rel} is over the per-file cap")));
        }
        match read_capped(entry, VSX_MAX_FILE_BYTES) {
            Ok(b) => Ok(Some(b)),
            Err(Capped::Over) => Err(invalid_package(format!("{rel} is over the per-file cap"))),
            Err(Capped::Io(e)) => Err(invalid_package(format!(
                "{rel} could not be decompressed ({e})"
            ))),
        }
    };

    let pkg = read_entry(&mut zip, "package.json")?
        .ok_or_else(|| invalid_package("no extension/package.json"))?;
    let manifest: Value = serde_json::from_slice(&pkg)
        .map_err(|e| invalid_package(format!("package.json is not JSON ({e})")))?;
    if classify(&manifest).support == VsxSupport::Unsupported {
        return Err(unsupported(id));
    }

    std::fs::create_dir_all(staging)
        .map_err(|e| internal("could not create the staging directory", e))?;
    let mut total: u64 = 0;
    for rel in referenced_paths(&manifest)? {
        let Some(bytes) = read_entry(&mut zip, &rel)? else {
            continue; // a dangling reference: contributions skip it later
        };
        total += bytes.len() as u64;
        if total > VSX_MAX_EXTRACT_BYTES {
            return Err(invalid_package(
                "the declarative files are over the total cap",
            ));
        }
        let dest = staging.join(&rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| internal("could not create a directory", e))?;
        }
        std::fs::write(&dest, &bytes)
            .map_err(|e| internal("could not write an extension file", e))?;
    }
    Ok(manifest)
}

/// The whole FR-4 flow. `cache` is the icon cache (fallback icon source).
pub(crate) fn install(
    reg: &Registry,
    root: &Path,
    cache: Option<&Path>,
    id: &str,
    version: Option<&str>,
    now_ms: u64,
) -> VsxResult<VsxInstalled> {
    let ext = ExtId::parse(id)?;
    let id = ext.id();
    let entry = reg.version(&ext, version)?;

    // Refuse before downloading when the registry's own package.json says so.
    if entry.files.manifest.is_some()
        && classify(&reg.manifest(&entry)?).support == VsxSupport::Unsupported
    {
        return Err(unsupported(&id));
    }
    let download = entry.files.download.as_deref().ok_or_else(|| {
        AppError::new(
            ErrorCode::VsxUnreachable,
            "Open VSX lists no download for this version.",
        )
    })?;
    let sha_url = entry
        .files
        .sha256
        .as_deref()
        .ok_or_else(|| invalid_package("Open VSX publishes no checksum for this version"))?;

    crate::fs_util::ensure_dir_0700(root)
        .map_err(|e| internal("could not create the vsx directory", e))?;
    let tmp = Scratch(Some(
        root.join(format!(".download-{}.vsix", uuid::Uuid::new_v4())),
    ));
    let reader = reg
        .fetch
        .get(download, DOWNLOAD_TIMEOUT)
        .map_err(super::fetch_error)?;
    let actual = save_capped(reader, tmp.path(), VSX_MAX_PACKAGE_BYTES)?;
    let sha_text = reg.get_bytes(sha_url, SHORT_TIMEOUT, 4096)?;
    let expected = parse_sha256(&String::from_utf8_lossy(&sha_text))
        .ok_or_else(|| invalid_package("the published checksum is unreadable"))?;
    if expected != actual {
        return Err(invalid_package("checksum mismatch"));
    }

    let mut staging = Scratch(Some(
        root.join(format!(".staging-{}", uuid::Uuid::new_v4())),
    ));
    let manifest = extract(tmp.path(), staging.path(), &id)?;
    let cls = classify(&manifest);
    let icon = str_field(&manifest, "icon")
        .and_then(normalize_rel)
        .and_then(|p| std::fs::read(staging.path().join(p)).ok())
        .and_then(|b| icons::data_url(&b))
        .or_else(|| {
            entry
                .files
                .icon
                .as_deref()
                .and_then(|u| icons::icon(reg, cache, u))
        });

    let record = VsxInstalled {
        id: id.clone(),
        display_name: entry.display_name.clone(),
        publisher: entry.publisher.clone(),
        description: entry.description.clone(),
        version: entry.version.clone(),
        icon,
        support: cls.support,
        contributions: cls.counts,
        language_ids: cls.language_ids,
        enabled: true,
        installed_at: now_ms,
    };

    let _g = store::lock();
    let target = install_dir(root, &id, &entry.version);
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| internal("could not replace the extension", e))?;
    }
    std::fs::rename(staging.path(), &target)
        .map_err(|e| internal("could not move the extension into place", e))?;
    staging.disarm();
    let previous: Vec<String> = store::load(root)
        .into_iter()
        .filter(|r| r.id == id && r.version != entry.version)
        .map(|r| r.version)
        .collect();
    store::upsert_locked(root, record.clone())?;
    for v in previous {
        let _ = std::fs::remove_dir_all(install_dir(root, &id, &v));
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::TempDir;
    use crate::vsx::testutil::{
        registry, toml_manifest, toml_vsix, zip_of, zip_with_symlink, FakeFetch, BASE,
    };
    use serde_json::json;

    fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    /// Publish `acme.toml@version` on the fake registry with the given .vsix bytes.
    fn publish(fake: &FakeFetch, version: &str, vsix: &[u8], checksum: Option<String>) {
        let files = json!({
            "download": format!("{BASE}/acme/toml/{version}/acme.toml-{version}.vsix"),
            "manifest": format!("{BASE}/acme/toml/{version}/package.json"),
            "sha256": format!("{BASE}/acme/toml/{version}/acme.toml-{version}.sha256"),
        });
        let doc = json!({
            "namespace": "acme", "name": "toml", "version": version,
            "displayName": "TOML", "description": "TOML support", "files": files
        });
        fake.json(&format!("{BASE}/api/acme/toml"), doc.clone());
        fake.json(&format!("{BASE}/api/acme/toml/{version}"), doc);
        fake.json(
            &format!("{BASE}/acme/toml/{version}/package.json"),
            toml_manifest(version),
        );
        fake.bytes(
            &format!("{BASE}/acme/toml/{version}/acme.toml-{version}.vsix"),
            vsix.to_vec(),
        );
        let sum = checksum
            .unwrap_or_else(|| format!("{}  acme.toml-{version}.vsix\n", sha(vsix).to_uppercase()));
        fake.bytes(
            &format!("{BASE}/acme/toml/{version}/acme.toml-{version}.sha256"),
            sum.into_bytes(),
        );
    }

    fn files_under(dir: &Path) -> BTreeSet<String> {
        fn walk(base: &Path, d: &Path, out: &mut BTreeSet<String>) {
            for e in std::fs::read_dir(d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(base, &p, out);
                } else {
                    out.insert(
                        p.strip_prefix(base)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        let mut out = BTreeSet::new();
        walk(dir, dir, &mut out);
        out
    }

    #[test]
    fn sha256_file_parses_with_or_without_a_file_name() {
        let h = "a".repeat(64);
        assert_eq!(parse_sha256(&h), Some(h.clone()));
        assert_eq!(
            parse_sha256(&format!("{}  x.vsix\n", h.to_uppercase())),
            Some(h.clone())
        );
        assert_eq!(parse_sha256("deadbeef"), None);
        assert_eq!(parse_sha256(""), None);
        assert_eq!(parse_sha256(&"g".repeat(64)), None);
    }

    #[test]
    fn referenced_paths_keep_declarative_files_and_drop_code() {
        let mut m = toml_manifest("1.0.0");
        m["main"] = json!("./out/extension");
        m["contributes"]["snippets"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "language": "toml", "path": "./out/extension.js" }));
        let refs = referenced_paths(&m).unwrap();
        assert_eq!(
            refs.into_iter().collect::<Vec<_>>(),
            vec![
                "images/icon.png",
                "language-configuration.json",
                "package.json",
                "snippets/toml.json",
                "syntaxes/md.tmLanguage",
                "syntaxes/toml.tmLanguage.json",
            ]
        );
        m["contributes"]["grammars"][0]["path"] = json!("../../etc/passwd");
        assert_eq!(
            referenced_paths(&m).unwrap_err().code,
            ErrorCode::VsxInvalidPackage
        );
    }

    #[test]
    fn unsafe_entry_names_are_rejected() {
        for bad in [
            "../evil",
            "/abs",
            "extension/../../x",
            "extension/../x",
            "C:/x",
            r"..\x",
            "extension\\..\\..\\x",
        ] {
            assert_eq!(safe_entry_name(bad), None, "{bad}");
        }
        assert_eq!(
            safe_entry_name("extension/./a.json").as_deref(),
            Some("extension/a.json")
        );
    }

    fn extract_bytes(zip: &[u8]) -> (TempDir, VsxResult<Value>) {
        let tmp = TempDir::new();
        let vsix = tmp.path().join("p.vsix");
        std::fs::write(&vsix, zip).unwrap();
        let r = extract(&vsix, &tmp.path().join("out"), "acme.toml");
        (tmp, r)
    }

    #[test]
    fn extraction_keeps_only_referenced_files() {
        let (tmp, r) = extract_bytes(&toml_vsix("1.0.0"));
        r.unwrap();
        assert_eq!(
            files_under(&tmp.path().join("out"))
                .into_iter()
                .collect::<Vec<_>>(),
            vec![
                "images/icon.png",
                "language-configuration.json",
                "package.json",
                "snippets/toml.json",
                "syntaxes/md.tmLanguage",
                "syntaxes/toml.tmLanguage.json",
            ]
        );
    }

    #[test]
    fn zip_slip_entries_reject_the_package() {
        let pkg = serde_json::to_vec(&toml_manifest("1.0.0")).unwrap();
        for evil in ["../evil", "/abs/evil", "extension/../../x"] {
            let (_t, r) = extract_bytes(&zip_of(&[("extension/package.json", &pkg), (evil, b"x")]));
            let e = r.unwrap_err();
            assert_eq!(e.code, ErrorCode::VsxInvalidPackage, "{evil}");
            assert!(e.detail.unwrap()["reason"]
                .as_str()
                .unwrap()
                .contains("unsafe"));
        }
    }

    #[test]
    fn a_referenced_symlink_rejects_the_package() {
        let pkg = serde_json::to_vec(&toml_manifest("1.0.0")).unwrap();
        let z = zip_with_symlink(
            &[("extension/package.json", &pkg)],
            "extension/syntaxes/toml.tmLanguage.json",
            "/etc/passwd",
        );
        let (_t, r) = extract_bytes(&z);
        let e = r.unwrap_err();
        assert_eq!(e.code, ErrorCode::VsxInvalidPackage);
        assert!(e.message.contains("symlink"), "{}", e.message);
    }

    #[test]
    fn missing_or_bad_package_json_and_non_zips_are_invalid() {
        let (_t, r) = extract_bytes(&zip_of(&[("extension/README.md", b"x")]));
        assert_eq!(r.unwrap_err().code, ErrorCode::VsxInvalidPackage);
        let (_t, r) = extract_bytes(&zip_of(&[("extension/package.json", b"{nope")]));
        assert_eq!(r.unwrap_err().code, ErrorCode::VsxInvalidPackage);
        let (_t, r) = extract_bytes(b"not a zip at all");
        assert_eq!(r.unwrap_err().code, ErrorCode::VsxInvalidPackage);
    }

    #[test]
    fn code_only_packages_are_unsupported() {
        let pkg =
            serde_json::to_vec(&json!({ "main": "./x.js", "contributes": { "commands": [] } }))
                .unwrap();
        let (_t, r) = extract_bytes(&zip_of(&[("extension/package.json", &pkg)]));
        assert_eq!(r.unwrap_err().code, ErrorCode::VsxUnsupported);
    }

    #[test]
    fn per_file_and_total_caps_are_enforced() {
        let pkg = serde_json::to_vec(&toml_manifest("1.0.0")).unwrap();
        let big = vec![b' '; VSX_MAX_FILE_BYTES as usize + 1];
        let (_t, r) = extract_bytes(&zip_of(&[
            ("extension/package.json", &pkg),
            ("extension/syntaxes/toml.tmLanguage.json", &big),
        ]));
        let e = r.unwrap_err();
        assert_eq!(e.code, ErrorCode::VsxInvalidPackage);
        assert!(e.message.contains("per-file"));

        let near = vec![b' '; VSX_MAX_FILE_BYTES as usize];
        let (_t, r) = extract_bytes(&zip_of(&[
            ("extension/package.json", &pkg),
            ("extension/syntaxes/toml.tmLanguage.json", &near),
            ("extension/syntaxes/md.tmLanguage", &near),
            ("extension/snippets/toml.json", &near),
            ("extension/language-configuration.json", &near),
        ]));
        let e = r.unwrap_err();
        assert_eq!(e.code, ErrorCode::VsxInvalidPackage);
        assert!(e.message.contains("total"));
    }

    #[test]
    fn download_cap_stops_streaming() {
        let tmp = TempDir::new();
        let dest = tmp.path().join("d");
        let e = save_capped(&[0u8; 11][..], &dest, 10).unwrap_err();
        assert_eq!(e.code, ErrorCode::VsxInvalidPackage);
        assert_eq!(save_capped(&b"abc"[..], &dest, 10).unwrap(), sha(b"abc"));
    }

    #[test]
    fn install_verifies_extracts_and_records() {
        let tmp = TempDir::new();
        let root = tmp.path().join("vsx");
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        let vsix = toml_vsix("1.0.0");
        publish(&fake, "1.0.0", &vsix, None);
        let rec = install(&reg, &root, None, "Acme.TOML", None, 42).unwrap();
        assert_eq!(rec.id, "acme.toml");
        assert_eq!(rec.version, "1.0.0");
        assert!(rec.enabled);
        assert_eq!(rec.installed_at, 42);
        assert_eq!(rec.support, VsxSupport::Full);
        assert_eq!(rec.contributions.grammars, 2);
        assert_eq!(rec.language_ids, vec!["toml"]);
        assert!(rec
            .icon
            .as_deref()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        let dir = install_dir(&root, "acme.toml", "1.0.0");
        assert!(dir.join("syntaxes/toml.tmLanguage.json").is_file());
        assert!(!dir.join("out").exists());
        assert_eq!(store::load(&root), vec![rec]);
        // no scratch left behind
        let names: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().all(|n| !n.starts_with('.')), "{names:?}");
    }

    #[test]
    fn checksum_mismatch_rejects_and_leaves_nothing() {
        let tmp = TempDir::new();
        let root = tmp.path().join("vsx");
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        publish(&fake, "1.0.0", &toml_vsix("1.0.0"), Some("0".repeat(64)));
        let e = install(&reg, &root, None, "acme.toml", None, 1).unwrap_err();
        assert_eq!(e.code, ErrorCode::VsxInvalidPackage);
        assert_eq!(e.detail.unwrap()["reason"], "checksum mismatch");
        assert!(store::load(&root).is_empty());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn installing_another_version_replaces_the_old_one() {
        let tmp = TempDir::new();
        let root = tmp.path().join("vsx");
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        publish(&fake, "1.0.0", &toml_vsix("1.0.0"), None);
        install(&reg, &root, None, "acme.toml", Some("1.0.0"), 1).unwrap();
        store::set_enabled(&root, "acme.toml", false).unwrap();
        publish(&fake, "2.0.0", &toml_vsix("2.0.0"), None);
        let rec = install(&reg, &root, None, "acme.toml", Some("2.0.0"), 2).unwrap();
        assert!(rec.enabled, "a (re)install is enabled");
        assert!(!install_dir(&root, "acme.toml", "1.0.0").exists());
        assert!(install_dir(&root, "acme.toml", "2.0.0").is_dir());
        let all = store::load(&root);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].version, "2.0.0");
        // same version again: replaced in place
        install(&reg, &root, None, "acme.toml", Some("2.0.0"), 3).unwrap();
        assert_eq!(store::load(&root)[0].installed_at, 3);
    }

    #[test]
    fn unsupported_is_refused_before_download() {
        let tmp = TempDir::new();
        let root = tmp.path().join("vsx");
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        publish(&fake, "1.0.0", &toml_vsix("1.0.0"), None);
        fake.json(
            &format!("{BASE}/acme/toml/1.0.0/package.json"),
            json!({ "main": "x.js" }),
        );
        let e = install(&reg, &root, None, "acme.toml", None, 1).unwrap_err();
        assert_eq!(e.code, ErrorCode::VsxUnsupported);
        assert_eq!(
            fake.hit_count(&format!("{BASE}/acme/toml/1.0.0/acme.toml-1.0.0.vsix")),
            0
        );
    }

    #[test]
    fn unknown_extension_is_not_found() {
        let tmp = TempDir::new();
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        fake.status(&format!("{BASE}/api/acme/nope"), 404);
        let e = install(&reg, tmp.path(), None, "acme.nope", None, 1).unwrap_err();
        assert_eq!(e.code, ErrorCode::VsxNotFound);
    }
}
