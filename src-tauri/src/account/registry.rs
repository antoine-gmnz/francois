//! FR-1..FR-10: accounts.json, the built-in `default` row, ordering, default
//! resolution, label rules and the identity read.
//!
//! Everything here is pure over `AccountInner` / byte slices so it is testable
//! without a Tauri AppHandle (Cargo does not enable tauri's `test` feature);
//! the handlers in commands.rs are lock → delegate → persist → emit glue.

use super::*;

use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// FR-5: a label is user-editable and non-empty after trimming.
pub(crate) const BAD_LABEL_MSG: &str = "an account label cannot be empty";
pub(crate) const NOT_FOUND_MSG: &str = "no such account";
pub(crate) const NOT_REMOVABLE_MSG: &str = "the default account cannot be removed";

// ---------- paths ----------

pub(crate) fn accounts_json_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("accounts.json"))
}

/// FR-6: `<app_data>/accounts` — the parent of every added account's config dir.
pub(crate) fn accounts_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("accounts"))
}

/// FR-6: an account id must be a uuid-charset token, so a config dir path built
/// from it can never escape `<app_data>/accounts` (defense-in-depth against a
/// hand-edited accounts.json). `default` is reserved and never a directory.
pub(crate) fn valid_account_id(id: &str) -> bool {
    !id.is_empty()
        && id != DEFAULT_ACCOUNT_ID
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

// ---------- FR-1: persistence ----------

/// FR-1: a missing, empty or unparseable document yields an EMPTY registry and
/// is never fatal; a single undeserializable entry is skipped, not fatal.
/// Returns the records plus the persisted `defaultAccountId` (unresolved — the
/// caller resolves it against the records with `resolve_default`).
pub(crate) fn parse_registry(bytes: &[u8]) -> (Vec<AccountRecord>, Option<String>) {
    let Ok(doc) = serde_json::from_slice::<Value>(bytes) else {
        return (Vec::new(), None);
    };
    let Some(list) = doc.get("accounts").and_then(|v| v.as_array()) else {
        return (Vec::new(), None);
    };
    let records: Vec<AccountRecord> = list
        .iter()
        .filter_map(|e| serde_json::from_value::<AccountRecord>(e.clone()).ok())
        .filter(|r| valid_account_id(&r.id))
        .collect();
    let default_id = doc
        .get("defaultAccountId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(String::from);
    (records, default_id)
}

/// FR-4: exactly one account is `isDefault`. A persisted id that no longer
/// resolves — or none at all — hands the flag back to the built-in account.
pub(crate) fn resolve_default(records: &[AccountRecord], persisted: Option<&str>) -> String {
    match persisted {
        Some(id) if id == DEFAULT_ACCOUNT_ID => DEFAULT_ACCOUNT_ID.to_string(),
        Some(id) if records.iter().any(|r| r.id == id) => id.to_string(),
        _ => DEFAULT_ACCOUNT_ID.to_string(),
    }
}

/// FR-1: `{ "version": 1, "accounts": [ … ], "defaultAccountId": "…" }`. The
/// built-in row is NEVER written (FR-2) — it is synthesized on every read.
pub(crate) fn registry_doc(records: &[AccountRecord], default_id: &str) -> Value {
    serde_json::json!({
        "version": 1,
        "accounts": records,
        "defaultAccountId": default_id,
    })
}

pub(crate) fn persist(app: &AppHandle, inner: &AccountInner) -> Result<(), String> {
    let path = accounts_json_path(app)
        .ok_or_else(|| "could not resolve the app data directory".to_string())?;
    crate::permissions::write_json_atomic(
        &path,
        &registry_doc(&inner.records, &inner.default_account_id),
    )
}

// ---------- FR-2/FR-4: the list ----------

/// FR-2/FR-4: the built-in `default` account first, then every added row in
/// registration order. Exactly one entry carries `isDefault`.
pub(crate) fn build_list(inner: &AccountInner) -> Vec<Account> {
    let mut out = vec![Account {
        id: DEFAULT_ACCOUNT_ID.to_string(),
        // FR-3: the built-in row is always labeled `Default`; its identity, when
        // readable, rides `email`/`organization` alongside.
        label: "Default".to_string(),
        email: inner.default_email.clone(),
        organization: inner.default_organization.clone(),
        config_dir: None,
        built_in: true,
        is_default: inner.default_account_id == DEFAULT_ACCOUNT_ID,
        created_at: 0,
        auth_failed_at: inner.auth_failed_at.get(DEFAULT_ACCOUNT_ID).copied(),
    }];
    out.extend(inner.records.iter().map(|r| Account {
        id: r.id.clone(),
        label: r.label.clone(),
        email: r.email.clone(),
        organization: r.organization.clone(),
        config_dir: Some(r.config_dir.clone()),
        built_in: false,
        is_default: inner.default_account_id == r.id,
        created_at: r.created_at,
        auth_failed_at: inner.auth_failed_at.get(&r.id).copied(),
    }));
    out
}

/// Does this id name an account the registry knows (built-in included)?
pub(crate) fn exists(inner: &AccountInner, id: &str) -> bool {
    id == DEFAULT_ACCOUNT_ID || inner.records.iter().any(|r| r.id == id)
}

// ---------- FR-5: labels ----------

pub(crate) fn validate_label(raw: &str) -> Result<String, &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(BAD_LABEL_MSG);
    }
    Ok(trimmed.to_string())
}

/// FR-5: the label of a freshly registered account — the caller's, else the
/// email captured at login, else `Account <n>` (n = the new row's position).
pub(crate) fn label_fallback(label: Option<&str>, email: Option<&str>, existing: usize) -> String {
    if let Some(l) = label.map(str::trim).filter(|l| !l.is_empty()) {
        return l.to_string();
    }
    if let Some(e) = email.map(str::trim).filter(|e| !e.is_empty()) {
        return e.to_string();
    }
    format!("Account {}", existing + 1)
}

// ---------- FR-5/FR-4/FR-8: the mutations ----------

/// FR-5: rename a row. The BUILT-IN account is not renameable — its label is
/// synthesized (`Default`, FR-3) and accounts.json holds no row for it, so there
/// would be nowhere to keep a new one. Reported as `INVALID_INPUT` rather than
/// `ACCOUNT_NOT_FOUND`: the account exists, the operation does not apply to it.
pub(crate) fn apply_rename(
    inner: &mut AccountInner,
    id: &str,
    label: String,
) -> Result<(), (&'static str, &'static str)> {
    if id == DEFAULT_ACCOUNT_ID {
        return Err(("INVALID_INPUT", "the default account cannot be renamed"));
    }
    let record = inner
        .records
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or(("ACCOUNT_NOT_FOUND", NOT_FOUND_MSG))?;
    record.label = label;
    Ok(())
}

/// FR-4: move the `isDefault` flag. Setting a new one clears the previous by
/// construction — the flag is a single stored id, not a per-row boolean.
pub(crate) fn apply_set_default(
    inner: &mut AccountInner,
    id: &str,
) -> Result<(), (&'static str, &'static str)> {
    if !exists(inner, id) {
        return Err(("ACCOUNT_NOT_FOUND", NOT_FOUND_MSG));
    }
    inner.default_account_id = id.to_string();
    Ok(())
}

/// FR-8: drop a row. The built-in account is never removable; removing the row
/// that carries `isDefault` hands the flag back to `default`. Returns the
/// removed record — the caller deletes its config dir (FR-8) and repoints its
/// sessions (FR-9) once the registry write has landed.
pub(crate) fn apply_remove(
    inner: &mut AccountInner,
    id: &str,
) -> Result<AccountRecord, (&'static str, &'static str)> {
    if id == DEFAULT_ACCOUNT_ID {
        return Err(("ACCOUNT_NOT_REMOVABLE", NOT_REMOVABLE_MSG));
    }
    let idx = inner
        .records
        .iter()
        .position(|r| r.id == id)
        .ok_or(("ACCOUNT_NOT_FOUND", NOT_FOUND_MSG))?;
    let removed = inner.records.remove(idx);
    inner.auth_failed_at.remove(id);
    if inner.default_account_id == id {
        inner.default_account_id = DEFAULT_ACCOUNT_ID.to_string();
    }
    Ok(removed)
}

// ---------- FR-14: the isolation check ----------

/// FR-14: is this identity already registered? `skip` excludes the row a
/// re-login (FR-17) is refreshing, whose own email is expected to match.
pub(crate) fn duplicate_email(inner: &AccountInner, email: &str, skip: Option<&str>) -> bool {
    let same = |a: &str| a.trim().eq_ignore_ascii_case(email.trim());
    if skip != Some(DEFAULT_ACCOUNT_ID) {
        if let Some(d) = &inner.default_email {
            if same(d) {
                return true;
            }
        }
    }
    inner
        .records
        .iter()
        .filter(|r| Some(r.id.as_str()) != skip)
        .any(|r| r.email.as_deref().map(same).unwrap_or(false))
}

// ---------- FR-3/FR-13: the identity on disk ----------

/// `oauthAccount.emailAddress` / `.organizationName` of a `.claude.json`
/// document. An empty email reads as no identity at all (FR-13's "first
/// NON-EMPTY value").
pub(crate) fn parse_oauth_account(doc: &Value) -> (Option<String>, Option<String>) {
    let Some(oauth) = doc.get("oauthAccount") else {
        return (None, None);
    };
    let pick = |key: &str| {
        oauth
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    (pick("emailAddress"), pick("organizationName"))
}

fn read_identity_file(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(bytes) = std::fs::read(path) else {
        return (None, None);
    };
    let Ok(doc) = serde_json::from_slice::<Value>(&bytes) else {
        return (None, None);
    };
    parse_oauth_account(&doc)
}

/// FR-13: the identity an account's own config dir reports, if any.
pub(crate) fn read_identity(config_dir: &str) -> (Option<String>, Option<String>) {
    read_identity_file(&Path::new(config_dir).join(".claude.json"))
}

/// Round-5 CRITICAL: the mtime of an account's `.claude.json`, if it exists —
/// login.rs snapshots this before starting a Re-login (FR-17) so the identity
/// poller can tell a freshly-written identity apart from a stale one already
/// sitting in the config dir (FR-22/FR-23: credentials expiring mid-turn never
/// delete the file, only flag `authFailedAt`). `None` means no file at all, so
/// ANY identity appearing later is new by definition.
pub(crate) fn identity_mtime(config_dir: &str) -> Option<std::time::SystemTime> {
    std::fs::metadata(Path::new(config_dir).join(".claude.json"))
        .ok()?
        .modified()
        .ok()
}

/// FR-3: the BUILT-IN account's identity, from `~/.claude.json`. Best-effort —
/// unreadable means both absent and the row simply reads `Default`.
pub(crate) fn read_default_identity() -> (Option<String>, Option<String>) {
    match dirs::home_dir() {
        Some(home) => read_identity_file(&home.join(".claude.json")),
        None => (None, None),
    }
}

// ---------- startup ----------

/// security: never trust a persisted `configDir` — a hand-edited accounts.json
/// could point it anywhere, and `account_remove` later `remove_dir_all`s this
/// path. Every row's config dir is derived from its id, not read off disk, so a
/// spoofed value can never survive a load.
pub(crate) fn sanitize_config_dirs(records: &mut [AccountRecord], accounts_dir: &Path) {
    for r in records.iter_mut() {
        r.config_dir = accounts_dir.join(&r.id).to_string_lossy().into_owned();
    }
}

/// FR-1: load the registry once, at startup — BEFORE `session::load_persisted`,
/// which prunes session links against it (FR-10). A missing/corrupt file leaves
/// an empty registry (built-in `default` only) and is overwritten by the next
/// successful write.
pub fn load_accounts(app: &AppHandle) {
    let (mut records, persisted_default) = accounts_json_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .map(|b| parse_registry(&b))
        .unwrap_or_else(|| (Vec::new(), None));
    if let Some(dir) = accounts_dir(app) {
        sanitize_config_dirs(&mut records, &dir);
    }
    let (email, organization) = read_default_identity(); // FR-3
    let Some(state) = app.try_state::<AccountState>() else {
        return;
    };
    // A poisoned lock must not brick the account domain — leave the registry
    // empty (built-in `default` only) rather than panicking on a load.
    let Ok(mut inner) = state.0.lock() else {
        return;
    };
    inner.default_account_id = resolve_default(&records, persisted_default.as_deref());
    inner.records = records;
    inner.default_email = email;
    inner.default_organization = organization;
}

/// The label an account renders under — used by `session_create`'s FR-25
/// message, which must NAME the offending account.
pub fn label_of(app: &AppHandle, account_id: &str) -> Option<String> {
    if account_id == DEFAULT_ACCOUNT_ID {
        return Some("Default".to_string());
    }
    app.try_state::<AccountState>().and_then(|s| {
        let Ok(inner) = s.0.lock() else {
            return None;
        };
        inner
            .records
            .iter()
            .find(|r| r.id == account_id)
            .map(|r| r.label.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::*;
    use serde_json::json;

    // ---------- FR-1: load tolerance + round trip ----------

    #[test]
    fn a_missing_empty_or_corrupt_registry_loads_as_empty() {
        // FR-1 / §7: never fatal — the built-in `default` account is all there is.
        for bytes in [
            &b""[..],
            &b"   \n"[..],
            &b"{ not json"[..],
            &b"[]"[..],
            &br#"{"version":1}"#[..],
        ] {
            let (records, default_id) = parse_registry(bytes);
            assert!(records.is_empty(), "bytes: {bytes:?}");
            assert_eq!(resolve_default(&records, default_id.as_deref()), "default");
        }
    }

    #[test]
    fn the_registry_round_trips_and_never_persists_the_built_in_row() {
        let records = vec![record_fixture("a1", "work"), record_fixture("a2", "perso")];
        let doc = registry_doc(&records, "a2");
        let raw = doc.to_string();
        assert!(
            !raw.contains("\"default\""),
            "FR-2: the built-in row is synthesized, never persisted:\n{raw}"
        );
        let (back, default_id) = parse_registry(raw.as_bytes());
        assert_eq!(back, records);
        assert_eq!(resolve_default(&back, default_id.as_deref()), "a2");
        assert_eq!(doc["version"], 1);
    }

    #[test]
    fn one_undeserializable_or_reserved_entry_is_skipped_not_fatal() {
        let doc = json!({
            "version": 1,
            "accounts": [
                { "id": "a1", "label": "keep", "configDir": "/x/a1", "createdAt": 5 },
                { "label": "no id" },
                "not even an object",
                // FR-6: `default` is reserved — a hand-edited file cannot mint it
                { "id": "default", "label": "impostor", "configDir": "/x/d" },
                { "id": "../escape", "label": "traversal", "configDir": "/x/e" },
                { "id": "a2", "label": "also keep", "configDir": "/x/a2" },
            ],
            "defaultAccountId": "gone",
        });
        let (records, default_id) = parse_registry(doc.to_string().as_bytes());
        assert_eq!(
            records.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["a1", "a2"]
        );
        // FR-4: a persisted default that no longer resolves hands the flag back
        assert_eq!(resolve_default(&records, default_id.as_deref()), "default");
        assert_eq!(records[1].created_at, 0); // missing timestamp degrades to 0
    }

    // ---------- FR-2/FR-4: the list ----------

    #[test]
    fn the_list_always_leads_with_the_built_in_account() {
        // FR-2: present even on a first run with no accounts.json at all.
        let empty = build_list(&inner_fixture(&[], "default"));
        assert_eq!(empty.len(), 1);
        assert_eq!(empty[0].id, "default");
        assert!(empty[0].built_in);
        assert!(empty[0].is_default);
        assert_eq!(empty[0].config_dir, None);
        assert_eq!(empty[0].created_at, 0);

        let list = build_list(&inner_fixture(&["a1", "a2"], "a1"));
        assert_eq!(
            list.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            vec!["default", "a1", "a2"]
        );
        // FR-4: exactly one isDefault across the whole list
        assert_eq!(list.iter().filter(|a| a.is_default).count(), 1);
        assert!(list[1].is_default);
        assert!(!list[1].built_in);
        assert_eq!(list[1].config_dir.as_deref(), Some("/tmp/accounts/a1"));
    }

    #[test]
    fn account_serializes_to_the_contract_shape() {
        let mut inner = inner_fixture(&["a1"], "default");
        inner.records[0].email = Some("dev@acme.io".into());
        inner.records[0].organization = Some("Acme".into());
        inner.auth_failed_at.insert("a1".into(), 4_242);
        let list = build_list(&inner);

        // the built-in row: configDir is JSON null (never omitted), and the
        // optional identity fields are OMITTED rather than null (FR-3).
        let built_in = serde_json::to_value(&list[0]).unwrap();
        assert_eq!(
            built_in,
            json!({ "id": "default", "label": "Default", "configDir": null,
                    "builtIn": true, "isDefault": true, "createdAt": 0 })
        );

        let added = serde_json::to_value(&list[1]).unwrap();
        assert_eq!(
            added,
            json!({ "id": "a1", "label": "work", "email": "dev@acme.io",
                    "organization": "Acme", "configDir": "/tmp/accounts/a1",
                    "builtIn": false, "isDefault": false, "createdAt": 1_000,
                    "authFailedAt": 4_242 })
        );
    }

    #[test]
    fn the_built_in_identity_rides_the_row_when_readable() {
        // FR-3: `~/.claude.json` → oauthAccount; unreadable ⇒ both absent.
        let mut inner = inner_fixture(&[], "default");
        inner.default_email = Some("me@acme.io".into());
        inner.default_organization = Some("Acme".into());
        let v = serde_json::to_value(&build_list(&inner)[0]).unwrap();
        assert_eq!(v["email"], "me@acme.io");
        assert_eq!(v["organization"], "Acme");
        assert_eq!(v["label"], "Default");
    }

    #[test]
    fn exists_covers_the_built_in_id_and_every_record() {
        let inner = inner_fixture(&["a1"], "default");
        assert!(exists(&inner, "default"));
        assert!(exists(&inner, "a1"));
        assert!(!exists(&inner, "nope"));
    }

    // ---------- FR-5: labels ----------

    #[test]
    fn label_validation_requires_a_non_empty_trimmed_value() {
        assert_eq!(validate_label("  work  "), Ok("work".to_string()));
        assert_eq!(validate_label("   "), Err(BAD_LABEL_MSG));
        assert_eq!(validate_label(""), Err(BAD_LABEL_MSG));
    }

    #[test]
    fn label_falls_back_to_the_email_then_to_a_numbered_name() {
        assert_eq!(
            label_fallback(Some(" work "), Some("dev@acme.io"), 0),
            "work"
        );
        assert_eq!(
            label_fallback(None, Some("dev@acme.io"), 0),
            "dev@acme.io",
            "FR-5: defaults to the email captured at login"
        );
        assert_eq!(label_fallback(Some("  "), None, 0), "Account 1");
        assert_eq!(label_fallback(None, None, 2), "Account 3");
    }

    // ---------- FR-4/FR-5/FR-8: the mutations ----------

    #[test]
    fn setting_a_new_default_clears_the_previous_one() {
        let mut inner = inner_fixture(&["a1", "a2"], "default");
        apply_set_default(&mut inner, "a2").unwrap();
        let list = build_list(&inner);
        assert_eq!(list.iter().filter(|a| a.is_default).count(), 1);
        assert!(list.iter().find(|a| a.id == "a2").unwrap().is_default);
        // and back to the built-in account
        apply_set_default(&mut inner, "default").unwrap();
        assert!(build_list(&inner)[0].is_default);
        assert_eq!(
            apply_set_default(&mut inner, "nope").unwrap_err(),
            ("ACCOUNT_NOT_FOUND", NOT_FOUND_MSG)
        );
    }

    #[test]
    fn rename_updates_the_row_and_refuses_the_built_in_account() {
        let mut inner = inner_fixture(&["a1"], "default");
        apply_rename(&mut inner, "a1", "client".into()).unwrap();
        assert_eq!(inner.records[0].label, "client");
        assert_eq!(
            apply_rename(&mut inner, "nope", "x".into()).unwrap_err(),
            ("ACCOUNT_NOT_FOUND", NOT_FOUND_MSG)
        );
        // FR-2/FR-3: the built-in row's label is synthesized, so there is nowhere
        // to keep a new one — the account exists, the operation does not apply.
        assert_eq!(
            apply_rename(&mut inner, "default", "x".into())
                .unwrap_err()
                .0,
            "INVALID_INPUT"
        );
    }

    #[test]
    fn removing_the_default_account_is_refused() {
        // FR-8 / §7: the built-in row is never removable.
        let mut inner = inner_fixture(&["a1"], "default");
        assert_eq!(
            apply_remove(&mut inner, "default").unwrap_err(),
            ("ACCOUNT_NOT_REMOVABLE", NOT_REMOVABLE_MSG)
        );
        assert_eq!(
            apply_remove(&mut inner, "nope").unwrap_err(),
            ("ACCOUNT_NOT_FOUND", NOT_FOUND_MSG)
        );
        assert_eq!(inner.records.len(), 1, "nothing was removed");
    }

    #[test]
    fn removing_the_is_default_row_hands_the_flag_back_to_default() {
        // FR-8: the flag moves to `default`, and the removed row's config dir is
        // handed back so the caller can delete it (credentials included).
        let mut inner = inner_fixture(&["a1", "a2"], "a1");
        inner.auth_failed_at.insert("a1".into(), 7);
        let removed = apply_remove(&mut inner, "a1").unwrap();

        assert_eq!(removed.config_dir, "/tmp/accounts/a1");
        assert_eq!(inner.default_account_id, "default");
        assert!(!inner.auth_failed_at.contains_key("a1"));
        let list = build_list(&inner);
        assert_eq!(
            list.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            vec!["default", "a2"]
        );
        assert!(list[0].is_default);

        // removing a NON-default row leaves the flag where it is
        let mut inner = inner_fixture(&["a1", "a2"], "a2");
        apply_remove(&mut inner, "a1").unwrap();
        assert_eq!(inner.default_account_id, "a2");
    }

    // ---------- FR-14: the duplicate identity check ----------

    #[test]
    fn duplicate_email_covers_added_rows_and_the_default_account() {
        let mut inner = inner_fixture(&["a1"], "default");
        inner.records[0].email = Some("dev@acme.io".into());
        inner.default_email = Some("me@acme.io".into());

        assert!(duplicate_email(&inner, "dev@acme.io", None));
        assert!(
            duplicate_email(&inner, "DEV@ACME.IO", None),
            "an identity is the same identity whatever its casing"
        );
        // FR-14 explicitly includes the default account's own identity
        assert!(duplicate_email(&inner, "me@acme.io", None));
        assert!(!duplicate_email(&inner, "other@acme.io", None));
        // FR-17: a re-login into a row must not collide with itself
        assert!(!duplicate_email(&inner, "dev@acme.io", Some("a1")));
    }

    // ---------- FR-3/FR-13: identity parsing ----------

    #[test]
    fn oauth_account_parsing_ignores_blank_and_missing_fields() {
        let full = json!({ "oauthAccount": { "emailAddress": " dev@acme.io ",
            "organizationName": "Acme" }, "other": 1 });
        assert_eq!(
            parse_oauth_account(&full),
            (Some("dev@acme.io".to_string()), Some("Acme".to_string()))
        );
        // FR-13: an empty email is NOT an identity — the poll keeps waiting
        let blank = json!({ "oauthAccount": { "emailAddress": "" } });
        assert_eq!(parse_oauth_account(&blank), (None, None));
        assert_eq!(parse_oauth_account(&json!({})), (None, None));
        assert_eq!(
            parse_oauth_account(&json!({ "oauthAccount": { "organizationName": "Acme" } })),
            (None, Some("Acme".to_string()))
        );
    }

    #[test]
    fn identity_is_read_from_the_accounts_own_config_dir() {
        let dir = tmp_account_dir("identity");
        // FR-17/FR-22: no file at all ⇒ unauthenticated, never an error.
        assert_eq!(read_identity(&dir.to_string_lossy()), (None, None));
        assert!(!crate::account::identity_file_exists(
            &dir.to_string_lossy()
        ));

        std::fs::write(
            dir.join(".claude.json"),
            json!({ "oauthAccount": { "emailAddress": "dev@acme.io" } }).to_string(),
        )
        .unwrap();
        assert_eq!(
            read_identity(&dir.to_string_lossy()),
            (Some("dev@acme.io".to_string()), None)
        );
        assert!(crate::account::identity_file_exists(&dir.to_string_lossy()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn identity_mtime_is_none_without_a_file_and_advances_when_the_file_is_rewritten() {
        // Round-5 CRITICAL: a Re-login must be able to tell a freshly-written
        // identity apart from the stale one already in the dir.
        let dir = tmp_account_dir("identity-mtime");
        assert_eq!(identity_mtime(&dir.to_string_lossy()), None);

        std::fs::write(
            dir.join(".claude.json"),
            json!({ "oauthAccount": { "emailAddress": "stale@acme.io" } }).to_string(),
        )
        .unwrap();
        let baseline = identity_mtime(&dir.to_string_lossy());
        assert!(baseline.is_some());

        // Rewriting bumps mtime forward on every real filesystem clock; force it
        // ahead explicitly so the assertion holds even where the clock's
        // resolution is coarser than this test's runtime.
        let advanced = baseline.unwrap() + std::time::Duration::from_secs(1);
        let file = std::fs::File::create(dir.join(".claude.json")).unwrap();
        file.set_modified(advanced).unwrap();
        let refreshed = identity_mtime(&dir.to_string_lossy());
        assert!(refreshed.unwrap() > baseline.unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sanitize_config_dirs_overwrites_a_spoofed_persisted_value() {
        // security: account_remove `remove_dir_all`s this path, so a hand-edited
        // accounts.json cannot be trusted to name it — it is always re-derived
        // from `<accounts_dir>/<id>`, never read off disk.
        let mut records = vec![record_fixture("a1", "work"), record_fixture("a2", "perso")];
        records[0].config_dir = "C:\\Windows\\System32".into(); // spoofed
        let dir = Path::new("/app-data/accounts");
        sanitize_config_dirs(&mut records, dir);
        assert_eq!(
            records[0].config_dir,
            dir.join("a1").to_string_lossy().into_owned()
        );
        assert_eq!(
            records[1].config_dir,
            dir.join("a2").to_string_lossy().into_owned()
        );
    }

    #[test]
    fn account_id_charset_blocks_traversal_and_the_reserved_id() {
        assert!(valid_account_id("11111111-2222-3333-4444-555555555555"));
        assert!(!valid_account_id("default")); // FR-6: reserved
        assert!(!valid_account_id("../../etc"));
        assert!(!valid_account_id("a/b"));
        assert!(!valid_account_id(""));
    }
}
