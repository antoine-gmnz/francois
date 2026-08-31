//! FR-13/FR-14: tier paths and surgical read / merge / atomic write.

use super::*;

use crate::ipc::{AppError, ErrorCode};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

// core-architecture-wave3 FR-6: this module's fallible signatures are
// `Result<T, AppError>` and raise SETTINGS_WRITE_FAILED — the contract's one
// code for "settings.json could not be read-merged-written". A domain that
// surfaces these failures under a code of its own (session/mcp_approval.rs
// re-codes to MCP_ERROR) re-wraps at its own boundary; it does not get a
// second helper.
pub(crate) fn settings_err(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::SettingsWriteFailed, message)
}

// ---------- FR-13: tier paths ----------

/// FR-13: `<cwd>/.claude/settings.local.json` — the DEFAULT tier, so a trust
/// decision made in one repo never leaks into another (§2 goals).
pub fn local_settings_path(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".claude").join("settings.local.json")
}

/// FR-13: `<claude home>/.claude/settings.json`. For a `wsl` session that home is
/// the DISTRO's home, reached through the wsl-filesystem UNC root — a Windows
/// `~/.claude` is a file the session's claude never reads. `None` when the home
/// cannot be resolved (the global tier is then unavailable, §7 #4).
pub fn global_settings_path(cwd: &str, runtime: &str) -> Option<PathBuf> {
    // `dirs::home_dir()` and NOT a hand-rolled USERPROFILE/HOME probe: every other
    // home lookup in the crate (session.rs, usage.rs) uses it, and on Windows a
    // shell-set HOME would otherwise point the global tier at a `.claude` the rest
    // of the app never reads.
    let home = if runtime == "wsl" {
        crate::wsl::wsl_home_unc(cwd).map(PathBuf::from)
    } else {
        dirs::home_dir()
    }?;
    Some(home.join(".claude").join("settings.json"))
}

/// The Francois-owned disabled-rules sidecar next to a settings file (FR-15).
pub fn sidecar_path(settings: &Path) -> PathBuf {
    match settings.parent() {
        Some(dir) => dir.join(SIDECAR_NAME),
        None => PathBuf::from(SIDECAR_NAME),
    }
}

// ---------- FR-14: surgical read / merge / write ----------

/// Read a JSON object file. Missing or empty → `{}` (a read NEVER creates
/// anything, §7 #3). Unparseable or non-object → `Err` — the caller must refuse
/// to write rather than clobber a file it does not understand (§7 #2).
pub fn read_json_object(path: &Path) -> Result<Value, AppError> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Object(Map::new())),
        Err(e) => {
            return Err(settings_err(format!(
                "could not read {}: {e}",
                path.display()
            )))
        }
    };
    if content.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    match serde_json::from_str::<Value>(&content) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(settings_err(format!(
            "{} is not a JSON object",
            path.display()
        ))),
        Err(e) => Err(settings_err(format!(
            "{} is not valid JSON: {e}",
            path.display()
        ))),
    }
}

/// Write a JSON document back, 2-space pretty, via temp file + atomic rename so a
/// crash mid-write can never leave a torn settings.json.
///
/// The temp file INHERITS the target's permissions when the target exists, and is
/// created 0600 otherwise (Unix). This matters because the whole document is
/// rewritten: `~/.claude/settings.json` routinely carries secrets under `env`
/// (`ANTHROPIC_API_KEY` and friends), and a 0600 file silently becoming
/// umask-default 0644 on Francois's first write would leak them to every local
/// user.
pub fn write_json_atomic(path: &Path, doc: &Value) -> Result<(), AppError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| settings_err(format!("could not create {}: {e}", dir.display())))?;
    }
    let mut bytes = serde_json::to_vec_pretty(doc)
        .map_err(|e| settings_err(format!("could not serialize rules: {e}")))?;
    bytes.push(b'\n');
    let tmp = crate::fs_util::unique_temp_path(path, "json");
    // Clean up on the WRITE failure too, not just the rename — a full disk takes
    // this branch, and a leaked `.tmp` would sit next to the user's settings.json.
    if let Err(e) = write_private(&tmp, &bytes, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(settings_err(format!(
            "could not write {}: {e}",
            tmp.display()
        )));
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        settings_err(format!("could not write {}: {e}", path.display()))
    })
}

/// Create `tmp` with `bytes`, carrying over `target`'s permissions if it exists.
#[cfg(unix)]
pub(crate) fn write_private(tmp: &Path, bytes: &[u8], target: &Path) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    let mode = std::fs::metadata(target)
        .map(|m| m.permissions().mode() & 0o777)
        .unwrap_or(0o600); // a NEW settings file is private by default
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(tmp)?;
    f.write_all(bytes)?;
    // `mode` only applies at creation — a pre-existing temp file keeps its own.
    std::fs::set_permissions(tmp, std::fs::Permissions::from_mode(mode))?;
    f.sync_all()
}

/// Windows has no umask and no group/other bits to leak through; the ACL is
/// inherited from the directory, which is the same directory the target lives in.
#[cfg(not(unix))]
pub fn write_private(tmp: &Path, bytes: &[u8], target: &Path) -> std::io::Result<()> {
    std::fs::write(tmp, bytes)?;
    if let Ok(meta) = std::fs::metadata(target) {
        let _ = std::fs::set_permissions(tmp, meta.permissions()); // carries read-only
    }
    Ok(())
}

/// The `permissions.<effect>` array of a settings document, created on demand.
/// `None` for a non-object document — callers pass a `read_json_object` result so
/// that cannot happen today, but `merge_pattern`/`remove_pattern` are `pub` and a
/// panic here would land on the turn's reader thread.
pub fn effect_array<'a>(doc: &'a mut Value, effect: &str) -> Option<&'a mut Vec<Value>> {
    let root = doc.as_object_mut()?;
    let perms = root
        .entry("permissions")
        .or_insert_with(|| Value::Object(Map::new()));
    if !perms.is_object() {
        *perms = Value::Object(Map::new());
    }
    let po = perms.as_object_mut()?;
    let arr = po.entry(effect).or_insert_with(|| Value::Array(Vec::new()));
    if !arr.is_array() {
        *arr = Value::Array(Vec::new());
    }
    arr.as_array_mut()
}

/// FR-14: append the pattern to `permissions.<effect>` iff absent. Every other
/// key of the document — and every other entry of the array — is untouched.
/// Returns true when the document changed.
pub fn merge_pattern(doc: &mut Value, effect: &str, pattern: &str) -> bool {
    let Some(arr) = effect_array(doc, effect) else {
        return false; // non-object document — nothing to merge into
    };
    if arr.iter().any(|v| v.as_str() == Some(pattern)) {
        return false; // §7 #1: already trusted — idempotent
    }
    arr.push(Value::String(pattern.into()));
    true
}

/// FR-14: drop the pattern from `permissions.<effect>`. An array that empties is
/// left as `[]`, not deleted, so the file's shape stays stable across edits.
/// Returns true when the document changed.
pub fn remove_pattern(doc: &mut Value, effect: &str, pattern: &str) -> bool {
    let Some(arr) = doc
        .get_mut("permissions")
        .and_then(|p| p.get_mut(effect))
        .and_then(|a| a.as_array_mut())
    else {
        return false;
    };
    let before = arr.len();
    arr.retain(|v| v.as_str() != Some(pattern));
    before != arr.len()
}

/// Read the patterns of one effect off a settings document, skipping non-strings
/// (§7 #15 — they are preserved on write, just not listed).
pub fn patterns_of(doc: &Value, effect: &str) -> Vec<String> {
    doc.get("permissions")
        .and_then(|p| p.get(effect))
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::testutil::*;
    use serde_json::json;

    // ---- FR-14: surgical merge ----

    #[test]
    fn merge_preserves_every_other_key_and_is_idempotent() {
        let mut doc = json!({
            "env": { "FOO": "bar" },
            "model": "opus",
            "permissions": { "allow": ["Bash(ls:*)"], "deny": ["Bash(rm:*)"] }
        });
        assert!(merge_pattern(&mut doc, "allow", "Bash(npm test:*)"));
        assert!(!merge_pattern(&mut doc, "allow", "Bash(npm test:*)")); // §7 #1
        assert_eq!(doc["env"]["FOO"], "bar");
        assert_eq!(doc["model"], "opus");
        assert_eq!(doc["permissions"]["deny"], json!(["Bash(rm:*)"]));
        assert_eq!(
            doc["permissions"]["allow"],
            json!(["Bash(ls:*)", "Bash(npm test:*)"])
        );
    }

    #[test]
    fn merge_creates_the_permissions_object_on_a_bare_document() {
        let mut doc = json!({});
        assert!(merge_pattern(&mut doc, "deny", "Bash(rm:*)"));
        assert_eq!(doc, json!({ "permissions": { "deny": ["Bash(rm:*)"] } }));
    }

    #[test]
    fn remove_leaves_an_emptied_array_in_place() {
        let mut doc = json!({ "env": {}, "permissions": { "allow": ["A", "B"] } });
        assert!(remove_pattern(&mut doc, "allow", "A"));
        assert_eq!(doc["permissions"]["allow"], json!(["B"]));
        assert!(remove_pattern(&mut doc, "allow", "B"));
        assert_eq!(doc["permissions"]["allow"], json!([]));
        assert!(!remove_pattern(&mut doc, "allow", "B"));
        assert!(doc["env"].is_object());
    }

    #[test]
    fn non_string_entries_are_skipped_on_read_and_kept_on_write() {
        // §7 #15
        let mut doc = json!({ "permissions": { "allow": ["A", 7, { "x": 1 }] } });
        assert_eq!(patterns_of(&doc, "allow"), vec!["A".to_string()]);
        merge_pattern(&mut doc, "allow", "B");
        assert_eq!(
            doc["permissions"]["allow"],
            json!(["A", 7, { "x": 1 }, "B"])
        );
    }

    // ---- FR-14: read/write on disk ----

    #[test]
    fn read_json_object_treats_missing_and_empty_as_empty_and_refuses_garbage() {
        let dir = tmpdir("read");
        let missing = dir.join("nope.json");
        assert_eq!(read_json_object(&missing).unwrap(), json!({}));
        assert!(!missing.exists(), "a read never creates anything (§7 #3)");

        let empty = dir.join("empty.json");
        std::fs::write(&empty, "  \n").unwrap();
        assert_eq!(read_json_object(&empty).unwrap(), json!({}));

        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{ not json").unwrap();
        assert!(read_json_object(&bad).is_err());

        let arr = dir.join("arr.json");
        std::fs::write(&arr, "[]").unwrap();
        assert!(read_json_object(&arr).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-14: key order ----

    #[test]
    fn a_surgical_write_preserves_the_user_s_key_order() {
        // serde_json's default Map is a BTreeMap, which would alphabetize the
        // whole document on the first "always allow". FR-14 promises to preserve
        // what it does not touch.
        let dir = tmpdir("order");
        let settings = dir.join("settings.local.json");
        std::fs::write(
            &settings,
            r#"{"zzz":1,"model":"opus","aaa":2,"permissions":{"deny":["X"]}}"#,
        )
        .unwrap();
        write_rule(&settings, "local", "allow", "Bash(ls:*)").unwrap();
        let back = std::fs::read_to_string(&settings).unwrap();
        let (z, m, a) = (
            back.find("zzz").unwrap(),
            back.find("model").unwrap(),
            back.find("aaa").unwrap(),
        );
        assert!(z < m && m < a, "keys were reordered:\n{back}");
        // …and `deny` still precedes the newly created `allow` inside permissions.
        assert!(back.find("\"deny\"").unwrap() < back.find("\"allow\"").unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-13: tier paths ----

    #[test]
    fn local_tier_is_the_project_s_settings_local_json() {
        let p = local_settings_path("/repo");
        assert!(p.ends_with("settings.local.json"));
        assert_eq!(p.parent().unwrap().file_name().unwrap(), ".claude");
    }
}
