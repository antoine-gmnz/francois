//! the `francois:account:<verb>` Tauri command surface (§5).
//!
//! Every handler is glue: take the account lock, delegate to the pure helpers in
//! registry.rs / login.rs, persist, release the lock, THEN emit and (for
//! `account_remove`) touch the session engine. The account lock is never held
//! across `Engine.sessions` — that is the LEAF discipline documented in mod.rs.

use super::*;

use crate::ipc::{err, ok, IpcResult};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::ipc::{CommandArg, CommandItem, InvokeBody, InvokeError};
use tauri::{Runtime, State};

/// multi-provider-endpoint FR-7: a hand-written `CommandArg` — see
/// `ModelIdsUpdate`'s doc comment (endpoint.rs) for why Tauri's automatic
/// `Option<Option<Vec<String>>>` handling can't tell "the key was absent"
/// apart from "the key was explicitly `null`".
impl<'de, R: Runtime> CommandArg<'de, R> for ModelIdsUpdate {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        match command.message.payload() {
            InvokeBody::Json(args) => {
                model_ids_update_from(args, command.key).map_err(InvokeError::from)
            }
            // Every Francois command sends a JSON object; a raw-bytes payload
            // here would mean the call bypassed `invoke`'s normal JSON path —
            // reads as the key being absent rather than erroring.
            InvokeBody::Raw(_) => Ok(ModelIdsUpdate::Unset),
        }
    }
}

/// Mirrors `AccountLoginStarted` (§5) — what the modal needs to size its xterm.
#[derive(Serialize)]
pub struct AccountLoginStarted {
    #[serde(rename = "loginId")]
    login_id: String,
    cols: u16,
    rows: u16,
}

/// Snapshot the mutable half of the registry, so a failed accounts.json write can
/// be rolled back and memory and disk keep agreeing (projects' `commit` rule).
/// `auth_failed_at` is runtime-only and never persisted, but a mutation like
/// `account_remove` touches it alongside `records`/`default_account_id` — it must
/// roll back together with them or a failed persist leaves it stale.
fn commit(
    app: &AppHandle,
    inner: &mut AccountInner,
    previous: RegistrySnapshot,
) -> Result<(), String> {
    match persist(app, inner) {
        Ok(()) => Ok(()),
        Err(msg) => {
            inner.records = previous.0;
            inner.default_account_id = previous.1;
            inner.auth_failed_at = previous.2;
            Err(msg)
        }
    }
}

type RegistrySnapshot = (Vec<AccountRecord>, String, HashMap<String, u64>);

fn snapshot(inner: &AccountInner) -> RegistrySnapshot {
    (
        inner.records.clone(),
        inner.default_account_id.clone(),
        inner.auth_failed_at.clone(),
    )
}

/// Release the FR-16 reservation `account_add` takes before its lock-free
/// directory creation + process spawn, on any failure path — including one
/// AFTER the spawn has already produced a live PTY / config dir, so this alone
/// is never enough cleanup on its own (see `account_add`). Lives on the
/// `AtomicBool` half of `AccountState` (mod.rs), never the mutex: it must be
/// clearable even when the mutex itself is poisoned.
fn clear_login_pending(state: &State<'_, AccountState>) {
    state.1.store(false, Ordering::SeqCst);
}

/// francois:account:list (FR-2). Never fails for registry reasons — the registry
/// is already in memory, and the built-in row exists even on a first run.
#[tauri::command(async)]
pub fn account_list(state: State<'_, AccountState>) -> IpcResult<Vec<Account>> {
    match state.0.lock() {
        Ok(inner) => ok(build_list(&inner)),
        Err(_) => err("INTERNAL", "account state is unavailable"),
    }
}

/// francois:account:add (FR-11/FR-16/FR-17) — start an interactive login. With
/// `account_id`, this is a Re-login into an existing row, reusing its config dir.
#[tauri::command(async)]
pub fn account_add(
    app: AppHandle,
    state: State<'_, AccountState>,
    label: Option<String>,
    account_id: Option<String>,
) -> IpcResult<AccountLoginStarted> {
    // FR-5: a supplied label must survive trimming.
    let label = match label.as_deref().map(validate_label) {
        Some(Err(msg)) => return err("INVALID_INPUT", msg),
        Some(Ok(l)) => Some(l),
        None => None,
    };

    // FR-16 is enforced across the WHOLE reserve → spawn → register sequence,
    // but only the reservation itself runs under the lock: `login_pending` holds
    // the slot while the blocking directory creation and process spawn run
    // lock-free, so `account_list`/`account_rename`/`account_set_default`/
    // `account_remove` are never blocked on either. The lock is retaken only to
    // clear the reservation (on failure) or to register the handle (on success);
    // no finisher can race a login the state does not know about yet, because
    // `start_login_threads` runs after that final registration.
    let (id, config_dir, existing) = {
        let Ok(inner) = state.0.lock() else {
            return err("INTERNAL", "account state is unavailable");
        };
        // FR-16: at most one login at a time; the first one is untouched. The
        // mutex still serializes this check-then-reserve against a second
        // concurrent `account_add`, even though the flag itself lives outside
        // the mutex (see `AccountState`, mod.rs).
        if inner.login.is_some() || state.1.load(Ordering::SeqCst) {
            return err("INVALID_INPUT", MSG_IN_FLIGHT);
        }

        // FR-17: re-login reuses the row AND its directory; a fresh login mints
        // a uuid-v4 id and owns `<app_data>/accounts/<accountId>` (FR-6).
        let (id, config_dir, existing) = match account_id.as_deref() {
            Some(id) => match inner.records.iter().find(|r| r.id == id) {
                Some(record) => (record.id.clone(), record.config_dir.clone(), true),
                None => return err("INVALID_INPUT", NOT_FOUND_MSG),
            },
            None => {
                let id = crate::session::uuid();
                let Some(dir) = accounts_dir(&app) else {
                    return err("INTERNAL", "could not resolve the app data directory");
                };
                (
                    id.clone(),
                    dir.join(&id).to_string_lossy().into_owned(),
                    false,
                )
            }
        };
        state.1.store(true, Ordering::SeqCst);
        (id, config_dir, existing)
    };

    if let Err(e) = std::fs::create_dir_all(&config_dir) {
        clear_login_pending(&state);
        return err("INTERNAL", format!("could not create {config_dir}: {e}"));
    }
    // Seed the fresh dir from `~/.claude` BEFORE the login PTY starts, so the
    // `claude` process this account first meets already sees the user's
    // commands, agents, skills and hooks (mirror.rs). Best-effort by design —
    // an un-mirrored account still logs in fine.
    crate::account::mirror_global(std::path::Path::new(&config_dir));

    let spawn = match spawn_login(&id, &config_dir, label, existing) {
        Ok(spawn) => spawn,
        Err((code, message)) => {
            if !existing {
                let _ = std::fs::remove_dir_all(&config_dir); // no half-written dir
            }
            clear_login_pending(&state);
            return err(code, message);
        }
    };
    let (login_id, mut handle, threads) = spawn.split();
    {
        let Ok(mut inner) = state.0.lock() else {
            // The mutex is poisoned: nothing can ever observe this handle again,
            // so it must not leak a live PTY or a half-registered config dir.
            // `clear_login_pending` alone is not enough cleanup here — the spawn
            // already succeeded by this point, unlike the earlier failure paths
            // above.
            let _ = handle.killer.kill();
            if !existing {
                let _ = std::fs::remove_dir_all(&config_dir);
            }
            clear_login_pending(&state);
            return err("INTERNAL", "account state is unavailable");
        };
        inner.login = Some(handle);
    }
    clear_login_pending(&state);

    start_login_threads(&app, threads);
    ok(AccountLoginStarted {
        login_id,
        cols: LOGIN_COLS,
        rows: LOGIN_ROWS,
    })
}

/// francois:account:loginWrite (FR-12) — raw keystrokes into the login TUI.
#[tauri::command(async)]
pub fn account_login_write(app: AppHandle, login_id: String, data: String) -> IpcResult<()> {
    match write_login(&app, &login_id, &data) {
        Ok(()) => ok(()),
        Err((code, msg)) => err(code, msg),
    }
}

/// francois:account:loginResize (FR-12).
#[tauri::command(async)]
pub fn account_login_resize(
    app: AppHandle,
    login_id: String,
    cols: u16,
    rows: u16,
) -> IpcResult<()> {
    match resize_login(&app, &login_id, cols, rows) {
        Ok(()) => ok(()),
        Err((code, msg)) => err(code, msg),
    }
}

/// francois:account:loginCancel (FR-16) — kill the PTY, delete the dir.
#[tauri::command(async)]
pub fn account_login_cancel(app: AppHandle, login_id: String) -> IpcResult<()> {
    match cancel_login(&app, &login_id) {
        Ok(()) => ok(()),
        Err((code, msg)) => err(code, msg),
    }
}

/// francois:account:rename (FR-5/FR-7).
#[tauri::command(async)]
pub fn account_rename(
    app: AppHandle,
    state: State<'_, AccountState>,
    account_id: String,
    label: String,
) -> IpcResult<Vec<Account>> {
    let label = match validate_label(&label) {
        Ok(l) => l,
        Err(msg) => return err("INVALID_INPUT", msg),
    };
    let accounts = {
        let Ok(mut inner) = state.0.lock() else {
            return err("INTERNAL", "account state is unavailable");
        };
        let previous = snapshot(&inner);
        if let Err((code, msg)) = apply_rename(&mut inner, &account_id, label) {
            return err(code, msg);
        }
        if let Err(msg) = commit(&app, &mut inner, previous) {
            return err("INTERNAL", msg);
        }
        build_list(&inner)
    };
    emit(
        &app,
        AccountEvent::List {
            accounts: accounts.clone(),
        },
    ); // FR-7
    ok(accounts)
}

/// francois:account:setDefault (FR-4/FR-7).
#[tauri::command(async)]
pub fn account_set_default(
    app: AppHandle,
    state: State<'_, AccountState>,
    account_id: String,
) -> IpcResult<Vec<Account>> {
    let accounts = {
        let Ok(mut inner) = state.0.lock() else {
            return err("INTERNAL", "account state is unavailable");
        };
        let previous = snapshot(&inner);
        if let Err((code, msg)) = apply_set_default(&mut inner, &account_id) {
            return err(code, msg);
        }
        if let Err(msg) = commit(&app, &mut inner, previous) {
            return err("INTERNAL", msg);
        }
        build_list(&inner)
    };
    emit(
        &app,
        AccountEvent::List {
            accounts: accounts.clone(),
        },
    ); // FR-7
    ok(accounts)
}

/// francois:account:remove (FR-8/FR-9): drop the row, delete its config dir
/// (credentials included), then repoint every session that was bound to it onto
/// `default` — with the account lock already released (mod.rs LOCK ORDER).
#[tauri::command(async)]
pub fn account_remove(
    app: AppHandle,
    state: State<'_, AccountState>,
    account_id: String,
) -> IpcResult<AccountRemoveData> {
    let (accounts, config_dir) = {
        let Ok(mut inner) = state.0.lock() else {
            return err("INTERNAL", "account state is unavailable");
        };
        let previous = snapshot(&inner);
        let removed = match apply_remove(&mut inner, &account_id) {
            Ok(r) => r,
            Err((code, msg)) => return err(code, msg),
        };
        if let Err(msg) = commit(&app, &mut inner, previous) {
            return err("INTERNAL", msg);
        }
        // A login in flight for the row just removed must not resurrect it.
        cancel_login_for_account(&mut inner, &account_id);
        (build_list(&inner), removed.config_dir)
    };

    // FR-8: the directory goes with the row — credentials included. A delete
    // failure is never fatal to the removal itself (the row is already gone
    // from the registry), but it is logged rather than silently discarded, so
    // a leftover credential directory is at least visible somewhere.
    if let Err(e) = std::fs::remove_dir_all(&config_dir) {
        eprintln!("accounts: could not remove {config_dir}: {e}");
    }
    // FR-9: driven from here, never from under the account lock.
    let reassigned_sessions = crate::session::reassign_account_sessions(&app, &account_id);
    emit(
        &app,
        AccountEvent::List {
            accounts: accounts.clone(),
        },
    ); // FR-7

    ok(AccountRemoveData {
        accounts,
        reassigned_sessions,
    })
}

// ---------- multi-provider-endpoint FR-6..FR-10 ----------

/// francois:account:addEndpoint (FR-6). Validates (FR-4), mints an id, creates
/// the config dir, writes the key when one was supplied, appends the record
/// and returns the freshly-read list.
#[tauri::command(async)]
pub fn account_add_endpoint(
    app: AppHandle,
    state: State<'_, AccountState>,
    label: String,
    base_url: String,
    api_key: Option<String>,
    model_ids: Option<Vec<String>>,
) -> IpcResult<Vec<Account>> {
    let label = match validate_label(&label) {
        Ok(l) => l,
        Err(msg) => return err("INVALID_INPUT", msg),
    };
    let base_url = match validate_base_url(&base_url) {
        Ok(u) => u,
        Err(msg) => return err("INVALID_INPUT", msg),
    };
    if let Some(ids) = &model_ids {
        if ids.is_empty() {
            return err("INVALID_INPUT", "modelIds cannot be empty when present");
        }
    }

    let id = crate::session::uuid();
    let Some(config_dir) = accounts_dir(&app).map(|d| d.join(&id)) else {
        return err("INTERNAL", "could not resolve the app data directory");
    };
    if let Err(e) = std::fs::create_dir_all(&config_dir) {
        return err(
            "INTERNAL",
            format!("could not create {}: {e}", config_dir.display()),
        );
    }
    // §7: a key that cannot be written must leave no keyless row behind — the
    // dir goes with it, and the registry is never touched.
    if let Some(key) = api_key.as_deref().filter(|k| !k.is_empty()) {
        if let Err(msg) = write_key(&config_dir.to_string_lossy(), key) {
            let _ = std::fs::remove_dir_all(&config_dir);
            return err("ACCOUNT_KEY_WRITE_FAILED", msg);
        }
    }

    let accounts = {
        let Ok(mut inner) = state.0.lock() else {
            let _ = std::fs::remove_dir_all(&config_dir);
            return err("INTERNAL", "account state is unavailable");
        };
        apply_add_endpoint(
            &mut inner,
            id,
            config_dir.to_string_lossy().into_owned(),
            label,
            base_url,
            model_ids,
        );
        // FR-1 of the ORIGINAL multi-account spec: a write failure is never
        // fatal — the row lives for this run and the next successful write
        // records it (same as every other mutation here).
        if let Err(msg) = persist(&app, &inner) {
            eprintln!("accounts: could not persist accounts.json: {msg}");
        }
        build_list(&inner)
    };
    emit(
        &app,
        AccountEvent::List {
            accounts: accounts.clone(),
        },
    ); // FR-7 (of multi-account) / present on every add-endpoint too
    ok(accounts)
}

/// francois:account:updateEndpoint (FR-7): a partial update. `apiKey` +
/// `clearKey` together is refused before anything else runs.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn account_update_endpoint(
    app: AppHandle,
    state: State<'_, AccountState>,
    account_id: String,
    label: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    clear_key: Option<bool>,
    model_ids: ModelIdsUpdate,
) -> IpcResult<Vec<Account>> {
    let clear_key = clear_key.unwrap_or(false);
    if api_key.is_some() && clear_key {
        return err("INVALID_INPUT", "apiKey and clearKey cannot both be set");
    }
    let label = match label.as_deref().map(validate_label) {
        Some(Err(msg)) => return err("INVALID_INPUT", msg),
        Some(Ok(l)) => Some(l),
        None => None,
    };
    let base_url = match base_url.as_deref().map(validate_base_url) {
        Some(Err(msg)) => return err("INVALID_INPUT", msg),
        Some(Ok(u)) => Some(u),
        None => None,
    };
    if let ModelIdsUpdate::Set(ids) = &model_ids {
        if ids.is_empty() {
            return err("INVALID_INPUT", "modelIds cannot be empty");
        }
    }

    let config_dir = {
        let Ok(inner) = state.0.lock() else {
            return err("INTERNAL", "account state is unavailable");
        };
        match inner.records.iter().find(|r| r.id == account_id) {
            None => return err("ACCOUNT_NOT_FOUND", NOT_FOUND_MSG),
            Some(r) if r.kind != AccountKind::OpenAiCompatible => {
                return err("INVALID_INPUT", NOT_AN_ENDPOINT_MSG)
            }
            Some(r) => r.config_dir.clone(),
        }
    };

    // Key-file I/O runs BEFORE the registry mutation, same ordering as
    // account_add_endpoint — a failure here leaves the row entirely untouched,
    // no rollback needed.
    // §7: an empty `apiKey` reads the same as an absent one — "leaving it
    // empty keeps the stored key" (design brief §2) — same filter
    // `account_add_endpoint` applies, so `apiKey: ""` never writes a 0-byte
    // key file that would make `hasKey` lie.
    if let Some(key) = api_key.as_deref().filter(|k| !k.is_empty()) {
        if let Err(msg) = write_key(&config_dir, key) {
            return err("ACCOUNT_KEY_WRITE_FAILED", msg);
        }
    } else if clear_key {
        if let Err(msg) = remove_key(&config_dir) {
            return err("ACCOUNT_KEY_WRITE_FAILED", msg);
        }
    }

    let accounts = {
        let Ok(mut inner) = state.0.lock() else {
            return err("INTERNAL", "account state is unavailable");
        };
        if let Err((code, msg)) =
            apply_update_endpoint(&mut inner, &account_id, label, base_url, model_ids)
        {
            return err(code, msg);
        }
        if let Err(msg) = persist(&app, &inner) {
            eprintln!("accounts: could not persist accounts.json: {msg}");
        }
        build_list(&inner)
    };
    emit(
        &app,
        AccountEvent::List {
            accounts: accounts.clone(),
        },
    );
    ok(accounts)
}

/// francois:account:testEndpoint (FR-8/FR-9): stateless — writes nothing,
/// never mutates the registry. `accountId` with no `apiKey` probes with that
/// account's STORED key.
#[tauri::command(async)]
pub fn account_test_endpoint(
    state: State<'_, AccountState>,
    base_url: String,
    api_key: Option<String>,
    account_id: Option<String>,
) -> IpcResult<EndpointProbe> {
    let base_url = match validate_base_url(&base_url) {
        Ok(u) => u,
        Err(msg) => return err("INVALID_INPUT", msg),
    };
    let key = match api_key {
        Some(k) => Some(k),
        None => match account_id.as_deref() {
            None => None,
            Some(id) => {
                let Ok(inner) = state.0.lock() else {
                    return err("INTERNAL", "account state is unavailable");
                };
                // Mirrors `apply_update_endpoint`'s check: an `accountId` that
                // does not resolve to an `openai-compatible` row (unknown id,
                // OAuth row, or the built-in account) is `INVALID_INPUT`, not
                // a silent "no stored key" — pointing Test at the wrong kind
                // of account must not read as "this endpoint needs no key".
                match inner.records.iter().find(|r| r.id == id) {
                    None => return err("INVALID_INPUT", NOT_FOUND_MSG),
                    Some(r) if r.kind != AccountKind::OpenAiCompatible => {
                        return err("INVALID_INPUT", NOT_AN_ENDPOINT_MSG)
                    }
                    Some(r) => {
                        let dir = r.config_dir.clone();
                        drop(inner);
                        read_key(&dir)
                    }
                }
            }
        },
    };
    match probe(&base_url, key.as_deref()) {
        Ok(p) => ok(p),
        Err((code, msg)) => err(code, msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::*;

    #[test]
    fn login_started_serializes_to_the_contract_shape() {
        let v = serde_json::to_value(AccountLoginStarted {
            login_id: "l1".into(),
            cols: LOGIN_COLS,
            rows: LOGIN_ROWS,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "loginId": "l1", "cols": LOGIN_COLS, "rows": LOGIN_ROWS })
        );
    }

    #[test]
    fn remove_data_serializes_to_the_contract_shape() {
        let v = serde_json::to_value(AccountRemoveData {
            accounts: build_list(&inner_fixture(&["a1"], "default")),
            reassigned_sessions: vec!["s1".into(), "s2".into()],
        })
        .unwrap();
        assert_eq!(v["reassignedSessions"], serde_json::json!(["s1", "s2"]));
        assert_eq!(v["accounts"][0]["id"], "default");
        assert_eq!(v["accounts"][1]["id"], "a1");
    }

    #[test]
    fn a_failed_persist_rolls_the_registry_back() {
        // `commit`'s contract: memory and disk agree, or nothing changed. The
        // AppHandle-free half is exercised here by rolling back explicitly.
        let mut inner = inner_fixture(&["a1"], "a1");
        let previous = snapshot(&inner);
        apply_remove(&mut inner, "a1").unwrap();
        assert!(inner.records.is_empty());
        inner.records = previous.0;
        inner.default_account_id = previous.1;
        assert_eq!(inner.records.len(), 1);
        assert_eq!(inner.default_account_id, "a1");
    }
}
