//! pi-provider-auth FR-4: the executable-configuration fingerprint — the value
//! that answers "is this the configuration the user actually consented to
//! execute?". Split out of `pi/mod.rs` (which keeps the trust MODEL that reads
//! it) as its own concern, the same "one concern per child" shape `add`/`env`/
//! `refresh`/`setup` already follow.

use sha2::{Digest, Sha256};
use std::path::Path;

/// pi-provider-auth §6/FR-4: the top-level files inside a Pi `configDir` that
/// can carry EXECUTABLE configuration — a custom/local provider naming a
/// command Pi runs to resolve a credential (`specs/research/
/// pi-integration-audit.md`'s "Models"/"Provider authentication" rows).
/// `auth.json` is deliberately EXCLUDED: Pi's own OAuth refresh rewrites it on
/// an ordinary token refresh, and FR-4 requires that a refresh ALONE never
/// invalidates consent.
///
/// The audit ran no live Pi install/capture, so these exact filenames are not
/// independently confirmed — see the feature handoff for this limit and what
/// would replace it (a captured fixture naming the certified release's real
/// executable-config surface, recorded in the Pi adapter's manifest per §6).
const CONFIG_FINGERPRINT_FILES: &[&str] = &["config.json", "models.json", "providers.json"];

/// The fingerprint FORMAT, carried as a prefix on every value. A stored
/// fingerprint from an older format can then only ever read as "changed"
/// (→ reconfirmation, FR-4) rather than accidentally comparing equal to a
/// value the current code computes a different way. Bump it whenever anything
/// below changes what gets hashed.
///
/// `v2` is the first content hash; `v1` was a `DefaultHasher` over
/// `(name, exists, len, mtime_secs)`, which could not see a same-size edit
/// with a restored mtime, was not stable across Rust releases, and emitted a
/// bare 16-hex-digit value — so it can never collide with a `v2:` one.
const FINGERPRINT_VERSION: &str = "v2";

/// What a REFUSED fingerprint renders as — never what it compares as (see
/// `Fingerprint`).
const UNFINGERPRINTABLE: &str = "v2:unfingerprintable";

/// What `compute_fingerprint` answers with — a newtype over `Option<String>`
/// for one reason worth writing down: the two readers want different things
/// from a refusal. `session::adapter::pi::models`'s per-account catalog
/// `cache_key` interpolates this value into a string and still needs a stable
/// bucket when the configuration cannot be fingerprinted; the FR-4 trust model
/// must never be able to read that same rendering back as a baseline.
/// `Display` serves the first, `into_baseline` the second, and nothing can
/// confuse the two.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Fingerprint(Option<String>);

impl Fingerprint {
    /// The value trust may be recorded against and compared to — `None` when
    /// the configuration could not be fingerprinted at all.
    pub(crate) fn into_baseline(self) -> Option<String> {
        self.0
    }
}

impl std::fmt::Display for Fingerprint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0.as_deref().unwrap_or(UNFINGERPRINTABLE))
    }
}

/// The per-input read cap. An input past it REFUSES the fingerprint rather
/// than being summarized or skipped: hashing a prefix would leave the tail
/// free to change, and hashing the length alone is exactly the metadata-only
/// weakness this format replaces. A provider/model config file this large is
/// not a configuration Francois can honestly say it fingerprinted.
const MAX_INPUT_BYTES: u64 = 1024 * 1024;

/// FR-4: a stable content fingerprint of `CONFIG_FINGERPRINT_FILES` inside
/// `config_dir`. Two directories whose candidate files have identical bytes
/// hash the same; any change to one of them — including a same-size edit with
/// the mtime put back — changes the hash.
///
/// A REFUSED fingerprint (`Fingerprint::into_baseline() == None`) means "this
/// configuration cannot be fingerprinted", which is not the same as "it
/// changed": the caller must never GRANT trust off one (`apply_trust_pi`) and
/// must never read one as still-trusted (`effective_trust`). It happens when
///
///  * `config_dir` is gone, is not a directory, or a symlink now stands where
///    the canonical directory was registered (§7: "Missing directory marks
///    account unavailable");
///  * a candidate input is a SYMLINK. Following it would let the link be
///    repointed at different content behind an unchanged fingerprint, and
///    hashing the link target's path instead would leave that target's own
///    content unwatched — neither can back FR-4's "changed executable
///    configuration requires reconfirmation", so a symlinked input is refused
///    outright. `symlink_metadata` is what keeps this from being decided by a
///    followed link;
///  * an input is larger than `MAX_INPUT_BYTES`.
///
/// Unlike the metadata-only predecessor this DOES read the candidate files'
/// bytes. Reading is not executing, so FR-4's "registering/discovering a
/// directory executes nothing until user trust is recorded" still holds; and
/// metadata alone provably cannot detect the edit that matters. Only the three
/// fixed names directly inside `config_dir` are ever opened, never followed
/// through a symlink, and never past the cap.
pub(crate) fn compute_fingerprint(config_dir: &str) -> Fingerprint {
    Fingerprint(hash_config_dir(config_dir))
}

fn hash_config_dir(config_dir: &str) -> Option<String> {
    let dir = Path::new(config_dir);
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => {}
        _ => return None,
    }
    let mut hasher = Sha256::new();
    feed(&mut hasher, FINGERPRINT_VERSION.as_bytes());
    for name in CONFIG_FINGERPRINT_FILES {
        feed(&mut hasher, name.as_bytes());
        let path = dir.join(name);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                feed(&mut hasher, b"absent");
                continue;
            }
            // Present but unstattable (a permission change on the directory,
            // a name the OS refuses) — its own state, never folded into
            // "absent": a file that becomes unreadable IS a change.
            Err(_) => {
                feed(&mut hasher, b"unreadable");
                continue;
            }
        };
        let file_type = meta.file_type();
        if file_type.is_symlink() {
            return None;
        }
        if file_type.is_dir() {
            feed(&mut hasher, b"directory");
            continue;
        }
        if meta.len() > MAX_INPUT_BYTES {
            return None;
        }
        match std::fs::read(&path) {
            // Grown past the cap between the stat and the read.
            Ok(bytes) if bytes.len() as u64 > MAX_INPUT_BYTES => return None,
            // An EMPTY file is `("file", [])` — distinct from `("absent")`,
            // which is what makes an empty directory and a deleted one two
            // different answers rather than one.
            Ok(bytes) => {
                feed(&mut hasher, b"file");
                feed(&mut hasher, &bytes);
            }
            Err(_) => feed(&mut hasher, b"unreadable"),
        }
    }
    Some(format!("{FINGERPRINT_VERSION}:{}", hex(&hasher.finalize())))
}

/// Every piece goes in LENGTH-PREFIXED, so no two different (name, state,
/// content) sequences can produce the same byte stream — without it, a file
/// named `a` holding `bc` and one named `ab` holding `c` would hash alike.
fn feed(hasher: &mut Sha256, piece: &[u8]) {
    hasher.update((piece.len() as u64).to_le_bytes());
    hasher.update(piece);
}

/// `extensions::manifest`'s `hex_encode` is the same four lines, but it is
/// private to that module and naming it here would add an `account` →
/// `extensions` domain edge for a fold over bytes.
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::*;

    /// The trust half of the value — `None` is a refusal. Every assertion
    /// below is about this rather than the `Display` rendering, because this
    /// is what FR-4 compares.
    fn baseline(dir: &Path) -> Option<String> {
        compute_fingerprint(&dir.to_string_lossy()).into_baseline()
    }

    #[test]
    fn an_empty_directory_fingerprints_deterministically() {
        let dir = tmp_account_dir("pi-fp-empty");
        let a = baseline(&dir);
        assert_eq!(a, baseline(&dir));
        assert!(a.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn adding_a_candidate_config_file_changes_the_fingerprint() {
        let dir = tmp_account_dir("pi-fp-add");
        let before = baseline(&dir);
        std::fs::write(dir.join("models.json"), "{}").unwrap();
        assert_ne!(before, baseline(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_token_refresh_in_auth_json_never_changes_the_fingerprint() {
        // FR-4: "token refresh alone does not invalidate consent" — auth.json
        // is deliberately excluded from the fingerprint inputs.
        let dir = tmp_account_dir("pi-fp-auth-refresh");
        std::fs::write(dir.join("auth.json"), r#"{"token":"a"}"#).unwrap();
        let before = baseline(&dir);
        std::fs::write(dir.join("auth.json"), r#"{"token":"b-refreshed"}"#).unwrap();
        assert_eq!(before, baseline(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn two_directories_with_the_same_configuration_fingerprint_identically() {
        let a = tmp_account_dir("pi-fp-cross-a");
        let b = tmp_account_dir("pi-fp-cross-b");
        std::fs::write(a.join("config.json"), "same").unwrap();
        std::fs::write(b.join("config.json"), "same").unwrap();
        // Two distinct directories with byte-identical candidate files hash
        // the same — the fingerprint proves "this configuration", not "this
        // path"; cross-account isolation is `configDir` itself (FR-1/9), not
        // this value.
        assert_eq!(baseline(&a), baseline(&b));
        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    #[test]
    fn a_same_size_edit_with_a_restored_mtime_changes_the_fingerprint() {
        // The metadata-only predecessor — (exists, len, mtime) — could not see
        // an edit that keeps the size and puts the mtime back, which is
        // exactly the shape a swapped credential-helper command takes.
        let dir = tmp_account_dir("pi-fp-same-size");
        let path = dir.join("providers.json");
        std::fs::write(&path, r#"{"cmd":"aaa"}"#).unwrap();
        let at = std::fs::metadata(&path).unwrap().modified().unwrap();
        let before = baseline(&dir);
        std::fs::write(&path, r#"{"cmd":"bbb"}"#).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(at)
            .unwrap();
        assert_ne!(before, baseline(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_removed_config_dir_refuses_rather_than_fingerprinting_like_an_empty_one() {
        // "Every candidate file is missing" is what an empty directory and a
        // DELETED one both look like from the files alone.
        let dir = tmp_account_dir("pi-fp-gone");
        assert!(baseline(&dir).is_some());
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(baseline(&dir), None);
    }

    #[test]
    fn an_empty_input_file_never_fingerprints_like_a_missing_one() {
        let dir = tmp_account_dir("pi-fp-empty-file");
        let missing = baseline(&dir);
        std::fs::write(dir.join("config.json"), "").unwrap();
        assert_ne!(missing, baseline(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_directory_standing_where_an_input_file_belongs_is_its_own_state() {
        let dir = tmp_account_dir("pi-fp-dir-input");
        let missing = baseline(&dir);
        std::fs::create_dir(dir.join("models.json")).unwrap();
        let as_dir = baseline(&dir);
        assert!(as_dir.is_some());
        assert_ne!(missing, as_dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_oversized_input_refuses_the_fingerprint_rather_than_skipping_it() {
        let dir = tmp_account_dir("pi-fp-oversized");
        std::fs::write(
            dir.join("models.json"),
            vec![b'x'; MAX_INPUT_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(baseline(&dir), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_value_carries_its_format_version_so_a_legacy_fingerprint_reads_as_changed() {
        let dir = tmp_account_dir("pi-fp-version");
        let fp = baseline(&dir).unwrap();
        assert!(fp.starts_with("v2:"), "{fp}");
        // A `v1` value was a bare 16-hex-digit DefaultHasher output, so no
        // stored one can ever compare equal to a value this format produces.
        assert_eq!(fp.len(), "v2:".len() + 64);
        assert_ne!(fp.len(), 16);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_refusal_still_renders_a_stable_cache_key_but_is_never_a_baseline() {
        // `session::adapter::pi::models::cache_key` interpolates this value.
        let dir = tmp_account_dir("pi-fp-refusal-render");
        std::fs::remove_dir_all(&dir).unwrap();
        let fp = compute_fingerprint(&dir.to_string_lossy());
        assert_eq!(fp.to_string(), UNFINGERPRINTABLE);
        assert_eq!(fp.into_baseline(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_input_refuses_the_fingerprint() {
        let dir = tmp_account_dir("pi-fp-symlink");
        let target = dir.join("real-providers.json");
        std::fs::write(&target, r#"{"cmd":"aaa"}"#).unwrap();
        std::os::unix::fs::symlink(&target, dir.join("providers.json")).unwrap();
        assert_eq!(baseline(&dir), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_input_is_its_own_state() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_account_dir("pi-fp-unreadable");
        let missing = baseline(&dir);
        let path = dir.join("config.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Running as root, the mode is advisory and there is nothing to prove.
        if std::fs::read(&path).is_ok() {
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        let unreadable = baseline(&dir);
        assert!(unreadable.is_some());
        assert_ne!(missing, unreadable);
        std::fs::remove_dir_all(&dir).ok();
    }
}
