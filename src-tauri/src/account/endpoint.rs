//! multi-provider-endpoint FR-1..FR-10: the `openai-compatible` account's
//! storage half.
//!
//! * base-URL normalization/validation (FR-4), applied identically wherever a
//!   URL is accepted (add, update, test).
//! * the sidecar key file — `<configDir>/endpoint-key`, `0600`/ACL-restricted
//!   via `fs_util::write_user_only_file` (FR-2) — and everything that reads or
//!   removes it. The key NEVER rides `AccountRecord`/`Account`; `hasKey`
//!   (`account_endpoint`) is the only signal that crosses (FR-3).
//! * the pure `AccountInner` mutations for add/update (FR-6/FR-7), mirroring
//!   registry.rs's `apply_*` shape so commands.rs stays lock → delegate →
//!   persist → emit glue.
//! * the stateless connection probe (FR-8/FR-9/FR-10) — a single `GET
//!   <baseUrl>/models`, 10s timeout, no retry, over `ureq` (already a
//!   dependency for the update-check and cloud-sessions probes).

use super::*;
use crate::ipc::{AppError, ErrorCode};

use std::path::{Path, PathBuf};
use std::time::Duration;

pub const KEY_FILE_NAME: &str = "endpoint-key";
pub const NOT_AN_ENDPOINT_MSG: &str = "not an endpoint account";
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

// ---------- FR-2: the sidecar key file ----------

/// The key's ONLY location. security: never persisted, never derived from
/// anything a caller supplies — always `<configDir>/endpoint-key`, and
/// `config_dir` itself is always the registry's own (sanitized, FR-6 of
/// multi-account) value, never a client-controlled path.
pub(crate) fn key_path(config_dir: &str) -> PathBuf {
    Path::new(config_dir).join(KEY_FILE_NAME)
}

pub(crate) fn key_file_exists(config_dir: &str) -> bool {
    key_path(config_dir).is_file()
}

/// FR-2: the file holds the raw key and nothing else — no JSON, no trailing
/// newline.
pub fn write_key(config_dir: &str, key: &str) -> Result<(), AppError> {
    crate::fs_util::write_user_only_file(&key_path(config_dir), key.as_bytes()).map_err(|e| {
        // core-architecture-wave3 FR-6: the code both call sites used to stamp,
        // raised where the write actually fails.
        AppError::new(
            ErrorCode::AccountKeyWriteFailed,
            format!("could not write the key file: {e}"),
        )
    })
}

/// FR-5/FR-7 (`clearKey`): a missing file is success, not a failure — the
/// caller's intent ("no key here") is already satisfied.
pub fn remove_key(config_dir: &str) -> Result<(), AppError> {
    match std::fs::remove_file(key_path(config_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::new(
            ErrorCode::AccountKeyWriteFailed,
            format!("could not remove the key file: {e}"),
        )),
    }
}

/// FR-9: the stored key for an account that already has one — an empty file
/// (should never happen, `write_key` never writes one) reads as no key,
/// exactly like a missing file, rather than sending an empty bearer token.
pub fn read_key(config_dir: &str) -> Option<String> {
    std::fs::read_to_string(key_path(config_dir))
        .ok()
        .filter(|s| !s.is_empty())
}

/// The contract-facing `AccountEndpoint` for one persisted `EndpointRecord`.
/// `has_key` is computed live off the filesystem (FR-3) — never off anything
/// in `EndpointRecord` itself, which carries no key material at all.
pub(crate) fn account_endpoint(record: &EndpointRecord, config_dir: &str) -> AccountEndpoint {
    AccountEndpoint {
        base_url: record.base_url.clone(),
        has_key: key_file_exists(config_dir),
        model_ids: record.model_ids.clone(),
    }
}

// ---------- FR-4: base URL validation ----------

/// FR-4: absolute, scheme `https` (or `http` on a loopback literal), no
/// query, no fragment, trailing slashes trimmed. Returns the normalized
/// value. No `url` crate: the rule set is narrow enough that hand-rolling it
/// avoids a new dependency for five checks.
pub fn validate_base_url(raw: &str) -> Result<String, AppError> {
    // core-architecture-wave3 FR-6: every rejection here is the INVALID_INPUT
    // its three call sites used to stamp by hand.
    let invalid = |m: &str| AppError::new(ErrorCode::InvalidInput, m);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("base URL cannot be empty"));
    }
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err(invalid("base URL must be absolute (missing a scheme)"));
    };
    if scheme != "https" && scheme != "http" {
        return Err(invalid("base URL must use https or http"));
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() {
        return Err(invalid("base URL is missing a host"));
    }
    if rest[authority_end..].contains('?') || rest[authority_end..].contains('#') {
        return Err(invalid("base URL must not contain a query or fragment"));
    }
    if scheme == "http" && !is_loopback_authority(authority) {
        return Err(invalid(
            "base URL must be https (http is allowed on localhost only)",
        ));
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

/// `authority` is `host` or `host:port`; `host` may be an IPv6 literal in
/// brackets. Loopback per FR-4: `localhost`, `127.0.0.1`, `[::1]`.
fn is_loopback_authority(authority: &str) -> bool {
    let host = if authority.starts_with('[') {
        // Index into `authority` itself (not a stripped copy) — otherwise the
        // bracket's own offset throws the slice off by one.
        match authority.find(']') {
            Some(i) => &authority[..=i],
            None => authority,
        }
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

// ---------- FR-6/FR-7: the pure registry mutations ----------

/// FR-6: append a freshly-minted endpoint row. The caller has already
/// validated the base URL (FR-4), minted `id`, created `config_dir` on disk
/// and written the key file if one was supplied — this only touches the
/// in-memory registry. Returns the row's contract shape.
pub fn apply_add_endpoint(
    inner: &mut AccountInner,
    id: String,
    config_dir: String,
    label: String,
    base_url: String,
    model_ids: Option<Vec<String>>,
) -> Account {
    inner.records.push(AccountRecord {
        id: id.clone(),
        label,
        email: None,
        organization: None,
        config_dir,
        created_at: crate::ids::now_ms(),
        kind: AccountKind::OpenAiCompatible,
        endpoint: Some(EndpointRecord {
            base_url,
            model_ids,
        }),
    });
    build_list(inner)
        .into_iter()
        .find(|a| a.id == id)
        .expect("just inserted")
}

/// Tri-state `modelIds` input for `account_update_endpoint` (contract:
/// `modelIds?: string[] | null`).
///
/// This can't be a plain `Option<Option<Vec<String>>>` command argument:
/// Tauri's blanket `CommandArg` impl for `Option<T>` treats a MISSING key and
/// an explicit JSON `null` identically (`CommandItem::deserialize_option`
/// calls the same `visitor.visit_none()` either way — see
/// `tauri::ipc::command::CommandItem`'s `Deserializer` impl), which collapses
/// exactly the distinction FR-7 needs ("absent ⇒ no change" vs "null ⇒
/// clear"). `commands.rs` implements `CommandArg` for this type directly, by
/// hand, so it can tell the two apart — `model_ids_update_from` is the pure
/// half of that, so the distinction is unit-testable without a live Tauri app
/// (this crate doesn't enable tauri's `test` feature, see account/mod.rs).
#[derive(Debug, Clone, PartialEq)]
pub enum ModelIdsUpdate {
    /// The key was absent from the invoke payload — leave the stored override
    /// alone.
    Unset,
    /// The key was present as `null` — clear the override.
    Clear,
    /// The key was present as an array — replace the override with it
    /// (validated non-empty by the caller, FR-7).
    Set(Vec<String>),
}

/// Pure half of the `ModelIdsUpdate` `CommandArg` impl (commands.rs): given
/// the whole invoke args object and this argument's key, decide which of the
/// three states applies.
pub fn model_ids_update_from(
    args: &serde_json::Value,
    key: &str,
) -> Result<ModelIdsUpdate, AppError> {
    match args.get(key) {
        None => Ok(ModelIdsUpdate::Unset),
        Some(serde_json::Value::Null) => Ok(ModelIdsUpdate::Clear),
        Some(v) => serde_json::from_value::<Vec<String>>(v.clone())
            .map(ModelIdsUpdate::Set)
            .map_err(|e| {
                AppError::new(
                    ErrorCode::InvalidInput,
                    format!("modelIds must be an array of strings: {e}"),
                )
            }),
    }
}

/// FR-7: `apiKey` and `clearKey` cannot both be set on an update — ambiguous
/// intent (write a new key vs remove the key in the same call). Same
/// (code, message) convention as `apply_update_endpoint` below, so
/// `commands.rs` can handle every one of these guards with the same
/// `Err(e) => return err(e.code, e.message)` shape.
pub fn validate_key_clear_conflict(
    api_key: &Option<String>,
    clear_key: bool,
) -> Result<(), AppError> {
    if api_key.is_some() && clear_key {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "apiKey and clearKey cannot both be set",
        ));
    }
    Ok(())
}

/// FR-7: `modelIds: []` on add is refused — a present-but-empty override
/// would claim the account allows no models at all.
pub fn validate_model_ids_on_add(model_ids: &Option<Vec<String>>) -> Result<(), AppError> {
    if let Some(ids) = model_ids {
        if ids.is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "modelIds cannot be empty when present",
            ));
        }
    }
    Ok(())
}

/// FR-7: `modelIds` present-but-empty on update is refused the same way —
/// only the `Set` arm of the tri-state can be empty; `Unset`/`Clear` are
/// always fine.
pub fn validate_model_ids_on_update(model_ids: &ModelIdsUpdate) -> Result<(), AppError> {
    if let ModelIdsUpdate::Set(ids) = model_ids {
        if ids.is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "modelIds cannot be empty",
            ));
        }
    }
    Ok(())
}

/// FR-7: partial update. An absent `label`/`base_url` leaves the row
/// unchanged; `model_ids` is the tri-state above. Addressing a non-endpoint
/// account is `INVALID_INPUT`, not `ACCOUNT_NOT_FOUND` — the account exists,
/// the operation does not apply to it (same reasoning as `apply_rename`'s
/// built-in-account refusal in registry.rs).
pub fn apply_update_endpoint(
    inner: &mut AccountInner,
    id: &str,
    label: Option<String>,
    base_url: Option<String>,
    model_ids: ModelIdsUpdate,
) -> Result<(), AppError> {
    let record = inner
        .records
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or(AppError::new(ErrorCode::AccountNotFound, NOT_FOUND_MSG))?;
    if record.kind != AccountKind::OpenAiCompatible {
        return Err(AppError::new(ErrorCode::InvalidInput, NOT_AN_ENDPOINT_MSG));
    }
    if let Some(l) = label {
        record.label = l;
    }
    // Invariant (FR-1): kind == OpenAiCompatible ⇒ endpoint is Some, just
    // checked above — `.expect` documents that rather than silently no-op-ing
    // on a corrupted in-memory record a future refactor might introduce.
    let ep = record
        .endpoint
        .as_mut()
        .expect("OpenAiCompatible record without an endpoint violates FR-1");
    if let Some(b) = base_url {
        ep.base_url = b;
    }
    match model_ids {
        ModelIdsUpdate::Unset => {}
        ModelIdsUpdate::Clear => ep.model_ids = None,
        ModelIdsUpdate::Set(ids) => ep.model_ids = Some(ids),
    }
    Ok(())
}

// ---------- FR-8/FR-9/FR-10: the stateless probe ----------

#[derive(serde::Serialize, Debug)]
pub struct EndpointProbe {
    pub(crate) models: Vec<crate::ipc::ModelInfo>,
    #[serde(rename = "modelCount")]
    pub model_count: usize,
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(PROBE_TIMEOUT)
        .timeout(PROBE_TIMEOUT)
        .build()
}

/// FR-8: `GET <baseUrl>/models`, `Authorization: Bearer <key>` when a key is
/// in play, 10s timeout, no retry (a single `.call()`). FR-9: takes form
/// values only — writes nothing, never touches the registry.
pub fn probe(base_url: &str, api_key: Option<&str>) -> Result<EndpointProbe, AppError> {
    let url = format!("{base_url}/models");
    let mut req = http_agent().get(&url);
    if let Some(key) = api_key {
        req = req.set("Authorization", &format!("Bearer {key}"));
    }
    match req.call() {
        Ok(resp) => {
            let json: serde_json::Value = resp.into_json().map_err(|e| {
                AppError::new(
                    ErrorCode::AccountEndpointUnreachable,
                    format!("the endpoint's response could not be read: {e}"),
                )
            })?;
            parse_probe_response(&json).ok_or_else(|| {
                AppError::new(
                    ErrorCode::AccountEndpointUnreachable,
                    "the endpoint did not return the expected model list shape".to_string(),
                )
            })
        }
        Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => Err(AppError::new(
            ErrorCode::AccountEndpointUnauthorized,
            "the endpoint rejected the API key".to_string(),
        )),
        Err(ureq::Error::Status(code, _)) => Err(AppError::new(
            ErrorCode::AccountEndpointUnreachable,
            format!("the endpoint returned HTTP {code}"),
        )),
        Err(ureq::Error::Transport(t)) => Err(AppError::new(
            ErrorCode::AccountEndpointUnreachable,
            format!("could not reach the endpoint: {t}"),
        )),
    }
}

/// FR-10: `{ data: [{ id }] }` → `ModelInfo { id, label: id, .. }`.
/// `contextTokens`/`efforts` stay unset — the OpenAI dialect's `/models`
/// carries neither (`multi-provider-openai` decides what to do about context
/// windows). `None` when `data` is missing or not an array — a body that is
/// not this shape at all, as opposed to a well-shaped-but-empty catalog
/// (`{"data": []}`, which succeeds with `modelCount: 0`, §7).
fn parse_probe_response(json: &serde_json::Value) -> Option<EndpointProbe> {
    let data = json.get("data")?.as_array()?;
    let models: Vec<crate::ipc::ModelInfo> = data
        .iter()
        .filter_map(|entry| entry.get("id")?.as_str())
        .map(|id| crate::ipc::model(id, id))
        .collect();
    Some(EndpointProbe {
        model_count: models.len(),
        models,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::*;
    use serde_json::json;

    // ---------- FR-4: base URL validation ----------

    #[test]
    fn accepts_a_well_formed_https_url_unchanged() {
        assert_eq!(
            validate_base_url("https://api.openai.com/v1"),
            Ok("https://api.openai.com/v1".to_string())
        );
    }

    #[test]
    fn accepts_http_on_loopback_literals_only() {
        assert_eq!(
            validate_base_url("http://localhost:11434/v1"),
            Ok("http://localhost:11434/v1".to_string())
        );
        assert_eq!(
            validate_base_url("http://127.0.0.1:8000/v1"),
            Ok("http://127.0.0.1:8000/v1".to_string())
        );
        assert_eq!(
            validate_base_url("http://[::1]:8000/v1"),
            Ok("http://[::1]:8000/v1".to_string())
        );
        let rejected = validate_base_url("http://example.com/v1").unwrap_err();
        assert_eq!(rejected.code, ErrorCode::InvalidInput);
        assert!(rejected.message.contains("https"));
    }

    #[test]
    fn trims_trailing_slashes_and_keeps_a_trailing_v1_verbatim() {
        assert_eq!(
            validate_base_url("https://api.openai.com/v1/"),
            Ok("https://api.openai.com/v1".to_string())
        );
        assert_eq!(
            validate_base_url("https://api.openai.com//"),
            Ok("https://api.openai.com".to_string())
        );
    }

    #[test]
    fn rejects_non_absolute_bad_scheme_query_and_fragment() {
        assert!(validate_base_url("api.openai.com/v1").is_err());
        assert!(validate_base_url("ftp://api.openai.com/v1").is_err());
        assert!(validate_base_url("https://api.openai.com/v1?key=1").is_err());
        assert!(validate_base_url("https://api.openai.com/v1#frag").is_err());
        assert!(validate_base_url("").is_err());
        assert!(validate_base_url("   ").is_err());
        assert!(validate_base_url("https://").is_err());
    }

    // ---------- FR-2/FR-3: the sidecar key file ----------

    #[test]
    fn the_key_file_holds_exactly_the_key_and_has_key_follows_its_existence() {
        let dir = tmp_account_dir("key-lifecycle");
        let dir_str = dir.to_string_lossy().into_owned();
        assert!(!key_file_exists(&dir_str));

        write_key(&dir_str, "sk-test-123").unwrap();
        assert!(key_file_exists(&dir_str));
        assert_eq!(std::fs::read(key_path(&dir_str)).unwrap(), b"sk-test-123");
        assert_eq!(read_key(&dir_str), Some("sk-test-123".to_string()));

        remove_key(&dir_str).unwrap();
        assert!(!key_file_exists(&dir_str));
        assert_eq!(read_key(&dir_str), None);
        // FR-5/FR-7: removing an already-absent key is success, not an error.
        remove_key(&dir_str).unwrap();

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn full_account_serialization_never_leaks_the_key() {
        // FR-3, the WIDER assertion: not just `AccountEndpoint` in isolation
        // (above) — the actual `Account` a keyed endpoint row serializes to
        // over `account.list`/`account_list` must not carry the key either.
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(endpoint_record_fixture(
            "e1",
            "work",
            "https://api.example.com/v1",
        ));
        let dir = inner.records[0].config_dir.clone();
        write_key(&dir, "sk-super-secret-full-account-value").unwrap();

        let list = build_list(&inner);
        let account = list.iter().find(|a| a.id == "e1").unwrap();
        assert!(account.endpoint.as_ref().unwrap().has_key);
        let raw = serde_json::to_value(account).unwrap().to_string();
        assert!(!raw.contains("sk-super-secret-full-account-value"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_key_write_failure_error_never_carries_the_key_anywhere() {
        // Force a REAL `write_key` failure: point it at a config dir whose
        // path is blocked by an existing plain file, so `create_dir_all` for
        // the key file's parent fails with a genuine `io::Error` — no
        // fabricated message. Neither the resulting `Err(String)` nor the
        // `AppError` commands.rs wraps it in (message or `detail`) may carry
        // any fragment of the key that failed to write.
        let dir = tmp_account_dir("key-write-fails");
        let blocker = dir.join("blocked");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let blocker_str = blocker.to_string_lossy().into_owned();

        let failure = write_key(&blocker_str, "sk-should-never-appear-anywhere").unwrap_err();
        assert_eq!(failure.code, ErrorCode::AccountKeyWriteFailed);
        assert!(!failure.message.contains("sk-should-never-appear-anywhere"));

        let ipc_err: crate::ipc::IpcResult<()> = failure.into();
        let v = serde_json::to_value(&ipc_err).unwrap();
        // `err()` never attaches a `detail` — the `AppError` struct skips a
        // `None` one on serialization, so it must be entirely absent here.
        assert!(v.get("detail").is_none());
        assert!(!v.to_string().contains("sk-should-never-appear-anywhere"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn account_endpoint_never_carries_the_key_only_has_key() {
        // FR-3: a test asserting the serialized shape carries no fragment of
        // the key — this is the narrowest form of that assertion, at the
        // `AccountEndpoint` boundary itself.
        let dir = tmp_account_dir("no-leak");
        let dir_str = dir.to_string_lossy().into_owned();
        write_key(&dir_str, "sk-super-secret-value").unwrap();

        let record = EndpointRecord {
            base_url: "https://api.example.com/v1".into(),
            model_ids: None,
        };
        let ep = account_endpoint(&record, &dir_str);
        assert!(ep.has_key);
        let v = serde_json::to_value(&ep).unwrap();
        let raw = v.to_string();
        assert!(!raw.contains("sk-super-secret-value"));
        assert_eq!(
            v,
            json!({ "baseUrl": "https://api.example.com/v1", "hasKey": true })
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- FR-1: the load-time invariant ----------

    #[test]
    fn a_record_whose_endpoint_presence_disagrees_with_its_kind_is_dropped() {
        // openai-compatible with no endpoint payload at all (hand-edited JSON).
        let doc = json!({ "version": 1, "accounts": [
            { "id": "a1", "label": "bad", "configDir": "/x/a1", "kind": "openai-compatible" },
            { "id": "a2", "label": "good", "configDir": "/x/a2", "kind": "openai-compatible",
              "endpoint": { "baseUrl": "https://api.example.com/v1" } },
        ] });
        let (records, _) = parse_registry(doc.to_string().as_bytes());
        assert_eq!(
            records.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["a2"]
        );
    }

    // ---------- FR-6/FR-7: the pure mutations ----------

    #[test]
    fn add_endpoint_appends_a_row_with_the_openai_compatible_kind() {
        let mut inner = inner_fixture(&[], "default");
        let account = apply_add_endpoint(
            &mut inner,
            "e1".into(),
            "/tmp/accounts/e1".into(),
            "My endpoint".into(),
            "https://api.example.com/v1".into(),
            Some(vec!["gpt-x".into()]),
        );
        assert_eq!(inner.records.len(), 1);
        assert_eq!(inner.records[0].kind, AccountKind::OpenAiCompatible);
        assert_eq!(
            inner.records[0].endpoint.as_ref().unwrap().base_url,
            "https://api.example.com/v1"
        );
        assert_eq!(account.kind, AccountKind::OpenAiCompatible);
        assert_eq!(
            account.endpoint.as_ref().unwrap().base_url,
            "https://api.example.com/v1"
        );
        assert!(!account.endpoint.as_ref().unwrap().has_key);
    }

    #[test]
    fn update_endpoint_is_partial_and_refuses_a_non_endpoint_account() {
        let mut inner = inner_fixture(&["a1"], "default"); // a1 = claude-code-oauth
        inner.records.push(endpoint_record_fixture(
            "e1",
            "work",
            "https://api.example.com/v1",
        ));

        // Refuses the OAuth row.
        assert_eq!(
            apply_update_endpoint(
                &mut inner,
                "a1",
                Some("x".into()),
                None,
                ModelIdsUpdate::Unset
            )
            .unwrap_err(),
            AppError::new(ErrorCode::InvalidInput, NOT_AN_ENDPOINT_MSG)
        );
        // Unknown id.
        assert_eq!(
            apply_update_endpoint(&mut inner, "nope", None, None, ModelIdsUpdate::Unset)
                .unwrap_err(),
            AppError::new(ErrorCode::AccountNotFound, NOT_FOUND_MSG)
        );

        // Label only — base URL and model_ids untouched.
        apply_update_endpoint(
            &mut inner,
            "e1",
            Some("renamed".into()),
            None,
            ModelIdsUpdate::Unset,
        )
        .unwrap();
        let record = inner.records.iter().find(|r| r.id == "e1").unwrap();
        assert_eq!(record.label, "renamed");
        assert_eq!(
            record.endpoint.as_ref().unwrap().base_url,
            "https://api.example.com/v1"
        );

        // Base URL only.
        apply_update_endpoint(
            &mut inner,
            "e1",
            None,
            Some("https://api.new.com/v1".into()),
            ModelIdsUpdate::Unset,
        )
        .unwrap();
        assert_eq!(
            inner
                .records
                .iter()
                .find(|r| r.id == "e1")
                .unwrap()
                .endpoint
                .as_ref()
                .unwrap()
                .base_url,
            "https://api.new.com/v1"
        );

        // Set then clear the model_ids override.
        apply_update_endpoint(
            &mut inner,
            "e1",
            None,
            None,
            ModelIdsUpdate::Set(vec!["m1".into()]),
        )
        .unwrap();
        assert_eq!(
            inner
                .records
                .iter()
                .find(|r| r.id == "e1")
                .unwrap()
                .endpoint
                .as_ref()
                .unwrap()
                .model_ids,
            Some(vec!["m1".to_string()])
        );
        apply_update_endpoint(&mut inner, "e1", None, None, ModelIdsUpdate::Clear).unwrap();
        assert_eq!(
            inner
                .records
                .iter()
                .find(|r| r.id == "e1")
                .unwrap()
                .endpoint
                .as_ref()
                .unwrap()
                .model_ids,
            None
        );

        let dir = inner
            .records
            .iter()
            .find(|r| r.id == "e1")
            .unwrap()
            .config_dir
            .clone();
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- FR-7: the three commands.rs INVALID_INPUT guards ----------

    #[test]
    fn key_clear_conflict_is_rejected_only_when_both_are_set() {
        assert_eq!(
            validate_key_clear_conflict(&Some("sk-x".to_string()), true).unwrap_err(),
            AppError::new(
                ErrorCode::InvalidInput,
                "apiKey and clearKey cannot both be set"
            )
        );
        assert!(validate_key_clear_conflict(&Some("sk-x".to_string()), false).is_ok());
        assert!(validate_key_clear_conflict(&None, true).is_ok());
        assert!(validate_key_clear_conflict(&None, false).is_ok());
    }

    #[test]
    fn model_ids_on_add_rejects_an_empty_array_but_allows_absent_or_populated() {
        assert_eq!(
            validate_model_ids_on_add(&Some(vec![])).unwrap_err(),
            AppError::new(
                ErrorCode::InvalidInput,
                "modelIds cannot be empty when present"
            )
        );
        assert!(validate_model_ids_on_add(&None).is_ok());
        assert!(validate_model_ids_on_add(&Some(vec!["gpt-4o".to_string()])).is_ok());
    }

    #[test]
    fn model_ids_on_update_rejects_an_empty_set_but_allows_unset_clear_and_populated() {
        assert_eq!(
            validate_model_ids_on_update(&ModelIdsUpdate::Set(vec![])).unwrap_err(),
            AppError::new(ErrorCode::InvalidInput, "modelIds cannot be empty")
        );
        assert!(validate_model_ids_on_update(&ModelIdsUpdate::Unset).is_ok());
        assert!(validate_model_ids_on_update(&ModelIdsUpdate::Clear).is_ok());
        assert!(validate_model_ids_on_update(&ModelIdsUpdate::Set(vec!["m1".to_string()])).is_ok());
    }

    // ---------- FR-7: the modelIds tri-state ----------

    #[test]
    fn model_ids_update_distinguishes_absent_null_and_array() {
        let absent = json!({ "accountId": "e1" });
        assert_eq!(
            model_ids_update_from(&absent, "modelIds").unwrap(),
            ModelIdsUpdate::Unset
        );

        let cleared = json!({ "accountId": "e1", "modelIds": null });
        assert_eq!(
            model_ids_update_from(&cleared, "modelIds").unwrap(),
            ModelIdsUpdate::Clear
        );

        let set = json!({ "accountId": "e1", "modelIds": ["m1", "m2"] });
        assert_eq!(
            model_ids_update_from(&set, "modelIds").unwrap(),
            ModelIdsUpdate::Set(vec!["m1".into(), "m2".into()])
        );

        // FR-7: [] is a distinct SET state — the caller (commands.rs) is what
        // turns an empty array into INVALID_INPUT, not this parser.
        let empty = json!({ "modelIds": [] });
        assert_eq!(
            model_ids_update_from(&empty, "modelIds").unwrap(),
            ModelIdsUpdate::Set(vec![])
        );

        let malformed = json!({ "modelIds": "not-an-array" });
        assert!(model_ids_update_from(&malformed, "modelIds").is_err());
    }

    // ---------- FR-8: `probe` against a real HTTP stub ----------
    //
    // `parse_probe_response` (below) is unit-tested directly, but the status
    // → error-code mapping lives in `probe` itself, wrapped around `ureq`'s
    // own `Error` enum — so it needs a REAL response to round-trip through,
    // not a hand-built `ureq::Error`. These bind an ephemeral loopback port,
    // answer exactly one connection with a canned HTTP/1.1 response, then let
    // `probe` hit it for real.

    /// Binds an ephemeral `127.0.0.1` port, accepts exactly one connection,
    /// drains whatever the client sends, then writes `response` back verbatim
    /// (a full `HTTP/1.1 ...` status line + headers + body). Returns the
    /// stub's `http://` base URL and the accepting thread's `JoinHandle` so
    /// the caller can `.join()` after `probe()` returns.
    fn spawn_stub_server(response: &'static str) -> (String, std::thread::JoinHandle<()>) {
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral loopback port");
        let addr = listener.local_addr().expect("resolve the bound address");
        let handle = std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf); // the request itself is irrelevant here
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn probe_maps_401_to_unauthorized_against_a_real_response() {
        let (base_url, handle) = spawn_stub_server(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let code = probe(&base_url, Some("sk-bad")).unwrap_err().code;
        assert_eq!(code, ErrorCode::AccountEndpointUnauthorized);
        handle.join().unwrap();
    }

    #[test]
    fn probe_maps_403_to_unauthorized_against_a_real_response() {
        let (base_url, handle) = spawn_stub_server(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let code = probe(&base_url, None).unwrap_err().code;
        assert_eq!(code, ErrorCode::AccountEndpointUnauthorized);
        handle.join().unwrap();
    }

    #[test]
    fn probe_maps_other_non_2xx_to_unreachable_against_a_real_response() {
        let (base_url, handle) = spawn_stub_server(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let AppError {
            code, message: msg, ..
        } = probe(&base_url, None).unwrap_err();
        assert_eq!(code, ErrorCode::AccountEndpointUnreachable);
        assert!(
            msg.contains("500"),
            "message should carry the status: {msg}"
        );
        handle.join().unwrap();
    }

    #[test]
    fn probe_maps_a_transport_failure_to_unreachable() {
        // Bind then immediately drop the listener: the port is real (so the
        // URL is well-formed) but nothing answers — `ureq` fails to connect,
        // a `Transport` error rather than a `Status` one.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let code = probe(&format!("http://{addr}"), None).unwrap_err().code;
        assert_eq!(code, ErrorCode::AccountEndpointUnreachable);
    }

    #[test]
    fn probe_resolves_on_a_real_2xx_response() {
        let (base_url, handle) = spawn_stub_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n\
             {\"data\":[{\"id\":\"gpt-4o\"}]}",
        );
        let p = probe(&base_url, None).unwrap();
        assert_eq!(p.model_count, 1);
        assert_eq!(p.models[0].id, "gpt-4o");
        handle.join().unwrap();
    }

    // ---------- FR-10: the probe response parser ----------

    #[test]
    fn parses_a_populated_model_list() {
        let json = json!({ "data": [ { "id": "gpt-4o" }, { "id": "gpt-4o-mini" } ] });
        let probe = parse_probe_response(&json).unwrap();
        assert_eq!(probe.model_count, 2);
        assert_eq!(probe.models[0].id, "gpt-4o");
        assert_eq!(probe.models[0].label, "gpt-4o"); // FR-10: label = id verbatim
        assert!(probe.models[0].context_tokens.is_none());
    }

    #[test]
    fn an_empty_catalog_is_a_success_with_zero_models() {
        // §7: `{data: []}` is NOT an error.
        let probe = parse_probe_response(&json!({ "data": [] })).unwrap();
        assert_eq!(probe.model_count, 0);
        assert!(probe.models.is_empty());
    }

    #[test]
    fn a_body_missing_the_data_array_fails_to_parse() {
        assert!(parse_probe_response(&json!({ "models": [] })).is_none());
        assert!(parse_probe_response(&json!({ "data": "not-an-array" })).is_none());
    }

    #[test]
    fn probe_serializes_to_the_contract_shape() {
        let probe = EndpointProbe {
            models: vec![crate::ipc::model("gpt-4o", "gpt-4o")],
            model_count: 1,
        };
        let v = serde_json::to_value(&probe).unwrap();
        assert_eq!(v["modelCount"], 1);
        assert_eq!(v["models"][0]["id"], "gpt-4o");
        assert_eq!(v["models"][0]["label"], "gpt-4o");
        assert!(v["models"][0].get("contextTokens").is_none());
        assert!(v["models"][0].get("efforts").is_none());
    }
}
