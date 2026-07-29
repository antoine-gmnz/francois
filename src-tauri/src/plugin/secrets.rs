//! FR-65/FR-66 — settings-secret obfuscation at rest.
//!
//! **This is obfuscation, not secrecy, and the spec says so out loud.** The key
//! lives in `<app data>/secret.key`, right next to the `plugins.json` holding the
//! ciphertext. That defends a leaked registry file, a backup, or a screen share —
//! it defends nothing at all against local malware or anyone who can read the app
//! data directory. The Plugins modal states this in one line beneath the field so
//! the user's mental model matches the guarantee.
//!
//! Envelope: `enc:v1:<base64 nonce>:<base64 ciphertext>` (FR-65). The `v1` is a
//! real version tag — a future scheme adds `enc:v2:` and `open` keeps reading v1.

// Only the tests reach into the parent module (for SETTING_MAX_STRING); the
// non-test build needs nothing from it, so a plain import warns.
#[allow(unused_imports)]
use super::*;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// The `enc:v1:` marker. A stored value that does NOT start with this is
/// plaintext — that is how a non-secret setting and a secret share one map (FR-65).
pub(crate) const ENVELOPE_PREFIX: &str = "enc:v1:";

/// XChaCha20-Poly1305's nonce is 24 bytes, and a fresh random one is drawn per
/// value (FR-66) — reusing a nonce under one key is the failure mode that would
/// turn this from weak into broken.
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;

pub(crate) fn secret_key_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("secret.key"))
}

/// True when a stored settings value is a sealed envelope rather than plaintext.
pub(crate) fn is_envelope(raw: &str) -> bool {
    raw.starts_with(ENVELOPE_PREFIX)
}

/// Read `<app data>/secret.key`, creating it on first use. On unix the file is
/// created `0600`; on Windows it inherits the app-data ACL, which is per-user
/// already (FR-66).
///
/// A file of the wrong length is treated as CORRUPT and is **not** replaced —
/// silently minting a new key would make every stored secret unreadable forever
/// with no signal. §7 #42 wants those settings to read as unset instead.
pub(crate) fn load_or_create_key(path: &Path) -> Result<[u8; KEY_LEN], String> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() == KEY_LEN => {
            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(&bytes);
            Ok(key)
        }
        Ok(bytes) => Err(format!(
            "secret.key is {} bytes, expected {KEY_LEN}",
            bytes.len()
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_key(path),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

fn create_key(path: &Path) -> Result<[u8; KEY_LEN], String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    // The AEAD's own CSPRNG — the same source the nonces come from.
    let key = XChaCha20Poly1305::generate_key(&mut OsRng);
    write_key(path, key.as_slice())?;
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(key.as_slice());
    Ok(out)
}

#[cfg(unix)]
fn write_key(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    // Create with 0600 from the START — a create-then-chmod leaves a window in
    // which the key is world-readable.
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("could not create {}: {e}", path.display()))?;
    f.write_all(bytes)
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn write_key(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Seal a plaintext secret into the `enc:v1:` envelope (FR-65).
pub(crate) fn seal(key: &[u8; KEY_LEN], plaintext: &str) -> Result<String, String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|_| "could not seal the value".to_string())?;
    Ok(format!(
        "{ENVELOPE_PREFIX}{}:{}",
        B64.encode(nonce),
        B64.encode(ct)
    ))
}

/// Open an `enc:v1:` envelope. Every failure — wrong prefix, bad base64, wrong
/// nonce length, failed tag check, non-UTF-8 plaintext — returns `Err`, and the
/// caller turns that into "this setting reads as unset" (§7 #42). The error text
/// never contains any part of the ciphertext.
pub(crate) fn open(key: &[u8; KEY_LEN], envelope: &str) -> Result<String, String> {
    let body = envelope
        .strip_prefix(ENVELOPE_PREFIX)
        .ok_or_else(|| "not a sealed value".to_string())?;
    let (nonce_b64, ct_b64) = body
        .split_once(':')
        .ok_or_else(|| "malformed sealed value".to_string())?;
    let nonce_bytes = B64
        .decode(nonce_b64)
        .map_err(|_| "malformed sealed value".to_string())?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err("malformed sealed value".into());
    }
    let ct = B64
        .decode(ct_b64)
        .map_err(|_| "malformed sealed value".to_string())?;
    let plain = XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(&nonce_bytes), ct.as_ref())
        .map_err(|_| "could not open the sealed value".to_string())?;
    String::from_utf8(plain).map_err(|_| "sealed value is not valid text".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::tmp_dir;

    fn key_fixture() -> [u8; KEY_LEN] {
        [7u8; KEY_LEN]
    }

    #[test]
    fn a_sealed_value_round_trips_and_wears_the_v1_envelope() {
        let key = key_fixture();
        let sealed = seal(&key, "ghp_supersecret").unwrap();
        assert!(is_envelope(&sealed), "FR-65: `enc:v1:` prefix");
        assert_eq!(sealed.matches(':').count(), 3, "enc : v1 : nonce : ct");
        assert!(
            !sealed.contains("ghp_supersecret"),
            "the plaintext must not survive in the envelope: {sealed}"
        );
        assert_eq!(open(&key, &sealed).unwrap(), "ghp_supersecret");
    }

    #[test]
    fn every_seal_draws_a_fresh_nonce() {
        // FR-66: nonce reuse under one key is what would make this broken rather
        // than merely weak, so two seals of the SAME value must differ.
        let key = key_fixture();
        let a = seal(&key, "same").unwrap();
        let b = seal(&key, "same").unwrap();
        assert_ne!(a, b);
        assert_eq!(open(&key, &a).unwrap(), open(&key, &b).unwrap());
    }

    #[test]
    fn empty_and_unicode_secrets_survive() {
        let key = key_fixture();
        for value in ["", "héllo 🌍", &"x".repeat(SETTING_MAX_STRING)] {
            let sealed = seal(&key, value).unwrap();
            assert_eq!(open(&key, &sealed).unwrap(), value);
        }
    }

    #[test]
    fn a_wrong_key_or_a_tampered_envelope_fails_rather_than_returning_garbage() {
        // §7 #42: the caller turns each of these into "reads as unset".
        let key = key_fixture();
        let sealed = seal(&key, "token").unwrap();

        assert!(open(&[9u8; KEY_LEN], &sealed).is_err(), "wrong key");

        // flip the last base64 char of the ciphertext — the Poly1305 tag must catch it
        let mut tampered = sealed.clone();
        let last = tampered.pop().unwrap();
        tampered.push(if last == 'A' { 'B' } else { 'A' });
        assert!(open(&key, &tampered).is_err(), "tampered ciphertext");

        for bad in [
            "plaintext",             // no prefix at all
            "enc:v1:",               // no separator
            "enc:v1:notbase64!:abc", // undecodable nonce
            "enc:v1:AAAA:AAAA",      // nonce of the wrong length
            "enc:v2:AAAA:AAAA",      // a future scheme this version cannot read
        ] {
            assert!(open(&key, bad).is_err(), "should reject: {bad}");
        }
    }

    #[test]
    fn the_key_file_is_created_once_and_then_reused() {
        let dir = tmp_dir("secret-key");
        let path = dir.join("secret.key");
        assert!(!path.exists());

        let first = load_or_create_key(&path).unwrap();
        assert!(path.exists());
        assert_eq!(std::fs::read(&path).unwrap().len(), KEY_LEN);
        // A second call must NOT mint a new key — that would orphan every value
        // sealed under the first one.
        assert_eq!(load_or_create_key(&path).unwrap(), first);

        // ...and a value sealed under the loaded key opens under the reloaded one
        let sealed = seal(&first, "token").unwrap();
        assert_eq!(
            open(&load_or_create_key(&path).unwrap(), &sealed).unwrap(),
            "token"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_key_file_is_created_inside_a_directory_that_does_not_exist_yet() {
        // First run on a fresh machine: the app data dir may not be there.
        let dir = tmp_dir("secret-mkdir");
        let path = dir.join("nested").join("deeper").join("secret.key");
        assert!(load_or_create_key(&path).is_ok());
        assert!(path.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_truncated_key_file_is_an_error_and_is_never_silently_replaced() {
        // §7 #42: replacing it would destroy every stored secret with no signal.
        let dir = tmp_dir("secret-corrupt");
        let path = dir.join("secret.key");
        std::fs::write(&path, b"too short").unwrap();
        assert!(load_or_create_key(&path).is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"too short",
            "the corrupt file is left exactly as found"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn the_key_file_is_created_0600() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tmp_dir("secret-mode");
        let path = dir.join("secret.key");
        load_or_create_key(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "FR-66: owner-only");
        std::fs::remove_dir_all(&dir).ok();
    }
}
