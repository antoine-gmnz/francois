//! francois:account:addPi/trustPi/piSetup/piRefresh — the Tauri command
//! surface for `pi` accounts (pi-provider-auth §5).
//!
//! A SIBLING of commands.rs, not a section inside it: commands.rs was already
//! near CLAUDE.md's ~1000-line file cap, and Pi's four commands plus their
//! preflight (drift reconciliation, trust/in-use checks) push it well past —
//! the same "split by concern" rule `session/commands/` already follows
//! (lifecycle.rs/decisions.rs/queries.rs/turn.rs) for the same reason. The
//! domain logic these commands call into (validation, fingerprinting, the PTY
//! spawn) stays in pi/; this file is glue only, matching commands.rs's own
//! "lock → delegate → persist → emit" discipline.

use super::*;
use crate::ipc::{err, ok, ErrorCode, IpcResult};
use tauri::{AppHandle, Manager};

/// francois:account:addPi (pi-provider-auth FR-1). A directory must already
/// exist — unlike Codex/Grok there is no separate first-login step: pointing
/// at the directory IS registering it, and trusting it to execute is the
/// distinct FR-4 step `account_trust_pi` covers.
// FR-6: a canonicalize + registry-write pair on a sync command blocks the
// MAIN thread — same rationale as diff/commands.rs:48-56.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn account_add_pi(
    app: AppHandle,
    label: String,
    config_dir: String,
    runtime: String,
    distro: Option<String>,
    inherit_environment_credentials: bool,
    trust_configuration: bool,
) -> IpcResult<Vec<Account>> {
    let state = app.state::<AccountState>();
    let label = match validate_pi_label(&label) {
        Ok(l) => l,
        Err(e) => return e.into(),
    };
    // PR #142 §5: the runtime/distro pair is settled FIRST — for `wsl` it is
    // what decides WHERE `configDir` is canonicalized (inside that distro,
    // never with `std::fs` on the Windows side).
    let distro = match validate_pi_runtime(&runtime, distro.as_deref()) {
        Ok(d) => d,
        Err(e) => return e.into(),
    };
    let config_dir = match canonicalize_config_dir_for(&config_dir, &runtime, distro.as_deref()) {
        Ok(d) => d,
        Err(e) => return e.into(),
    };

    // FR-2/FR-9: resolved before the lock (it touches the path API, not the
    // registry); `None` only if the app data directory cannot be resolved at
    // all, in which case there is no app-data overlap to check against.
    let app_data = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.to_string_lossy().into_owned());

    let accounts = {
        let Ok(mut inner) = state.0.lock() else {
            return err(ErrorCode::Internal, "account state is unavailable");
        };
        // FR-1/FR-2: not Francois's own app data, and not another account's
        // credential directory.
        if let Err(e) = validate_config_dir_location(
            &config_dir,
            &runtime,
            distro.as_deref(),
            app_data.as_deref(),
            &inner,
        ) {
            return e.into();
        }
        // FR-1: "same directory/environment cannot be registered twice".
        if duplicate_pi_directory(&inner, &config_dir, &runtime, distro.as_deref()) {
            return err(
                ErrorCode::InvalidInput,
                "this directory is already registered for this runtime",
            );
        }
        let id = crate::ids::uuid();
        apply_add_pi(
            &mut inner,
            id,
            label,
            config_dir,
            runtime,
            distro,
            inherit_environment_credentials,
            trust_configuration,
        );
        // A write failure is never fatal — the row lives for this run and the
        // next successful write records it (same as every other add-command).
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

/// francois:account:trustPi (pi-provider-auth FR-4): fingerprint the
/// account's current executable configuration and record (or revoke) trust.
/// Refused while the account has a connected session or an open setup PTY, so
/// trust can never flip under a running turn.
///
/// Three-phase, deliberately: `sessions_currently_use` locks `Engine.sessions`,
/// and that must never happen while `AccountState` is already held — see its
/// doc comment (pi/mod.rs) for the established `Engine.sessions` → `AccountState`
/// order this would otherwise invert. So the session check runs with NO
/// account lock held, both before AND immediately after the write (the
/// mutating lock in between covers `trust_pi_gate` plus the mutation itself).
/// The second, post-write check is what closes MOST of the TOCTOU window a
/// single pre-write check leaves open: a session that starts using this
/// account between the first check and the write is caught here and the
/// write is rolled back to its exact previous value before returning
/// `ACCOUNT_IN_USE` — nesting the check inside the mutating lock itself is
/// not an option (see `trust_pi_gate`'s doc), so a vanishingly small window
/// between this second check and a session actually reading the new value is
/// the residual, architecturally-accepted gap.
#[tauri::command(async)]
pub fn account_trust_pi(
    app: AppHandle,
    account_id: String,
    trust_configuration: bool,
) -> IpcResult<Vec<Account>> {
    let state = app.state::<AccountState>();
    {
        let Ok(inner) = state.0.lock() else {
            return err(ErrorCode::Internal, "account state is unavailable");
        };
        if let Err(e) = trust_pi_gate(&inner, &account_id) {
            return e.into();
        }
    }
    if sessions_currently_use(&app, &account_id) {
        return err(
            ErrorCode::AccountInUse,
            "stop sessions using this account before changing its trust",
        );
    }
    let previous = {
        let Ok(mut inner) = state.0.lock() else {
            return err(ErrorCode::Internal, "account state is unavailable");
        };
        if let Err(e) = trust_pi_gate(&inner, &account_id) {
            return e.into();
        }
        let previous = find_pi_record(&inner, &account_id)
            .expect("checked by trust_pi_gate above")
            .pi
            .clone()
            .expect("kind==Pi invariant");
        if let Err(e) = apply_trust_pi(&mut inner, &account_id, trust_configuration) {
            return e.into();
        }
        if let Err(msg) = persist(&app, &inner) {
            eprintln!("accounts: could not persist accounts.json: {msg}");
        }
        previous
    };
    // pi-models-metrics FR-2/FR-9: trust just changed in EITHER direction, so
    // the per-account model catalogue cached under the old fingerprint must
    // not be served back by FR-9's keep-the-last-snapshot fallback. Announced,
    // never called directly — `session` owns that cache (see
    // `notify_credentials_changing`).
    notify_credentials_changing(&account_id);
    if sessions_currently_use(&app, &account_id) {
        let accounts = {
            let Ok(mut inner) = state.0.lock() else {
                return err(ErrorCode::Internal, "account state is unavailable");
            };
            if let Some(record) = inner.records.iter_mut().find(|r| r.id == account_id) {
                record.pi = Some(previous);
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
        return err(
            ErrorCode::AccountInUse,
            "stop sessions using this account before changing its trust",
        );
    }
    let accounts = {
        let Ok(inner) = state.0.lock() else {
            return err(ErrorCode::Internal, "account state is unavailable");
        };
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

/// francois:account:piSetup (pi-provider-auth FR-3): launch the certified Pi
/// interactive binary on a login-shaped PTY, reusing the raw passthrough
/// (`account_login_write`/`account_login_resize`/`account_login_cancel`) —
/// never the Claude-specific identity poll. Resolves as soon as the PTY is
/// spawned; closing setup never by itself implies auth succeeded.
#[tauri::command(async)]
pub fn account_pi_setup(app: AppHandle, account_id: String) -> IpcResult<AccountLoginStarted> {
    let state = app.state::<AccountState>();
    let (config_dir, runtime, distro, inherit_environment_credentials) = {
        let Ok(mut inner) = state.0.lock() else {
            return err(ErrorCode::Internal, "account state is unavailable");
        };
        if find_pi_record(&inner, &account_id).is_err() {
            return err(ErrorCode::AccountNotFound, NOT_FOUND_MSG);
        }
        // FR-4: reconcile drift right here — a configuration changed since
        // the last explicit trust must block setup exactly like a
        // never-trusted row, not just the next time the list happens to load.
        let drifted = reconcile_trust_drift(&mut inner, &account_id);
        if drifted {
            if let Err(msg) = persist(&app, &inner) {
                eprintln!("accounts: could not persist accounts.json: {msg}");
            }
            // The configuration this account's models were probed under is
            // gone (pi-models-metrics FR-2/FR-9) — drop its catalogue too.
            notify_credentials_changing(&account_id);
        }
        match pi_execution_preflight(&inner, &account_id, "running setup", drifted) {
            Ok(v) => v,
            Err(e) => return e.into(),
        }
    };

    let (mut handle, reader, child) = match spawn_pi_setup(
        &account_id,
        &config_dir,
        &runtime,
        distro.as_deref(),
        inherit_environment_credentials,
    ) {
        Ok(v) => v,
        Err(e) => return e.into(),
    };
    let login_id = handle.login_id.clone();
    let settled = handle.settled.clone();
    {
        let Ok(mut inner) = state.0.lock() else {
            // The mutex is poisoned: nothing can ever observe this handle
            // again, so the live child must not leak — but FR-8 still holds,
            // `spawn_pi_setup` created nothing on disk to clean up.
            let _ = handle.killer.kill();
            return err(ErrorCode::Internal, "account state is unavailable");
        };
        inner.pi_setups.insert(login_id.clone(), handle);
    }
    start_pi_setup_thread(app.clone(), login_id.clone(), settled, reader, child);
    ok(AccountLoginStarted {
        login_id,
        cols: SETUP_COLS,
        rows: SETUP_ROWS,
    })
}

/// francois:account:piRefresh (pi-provider-auth FR-7/FR-9): probe this
/// account's provider/model state under the same launch policy a session
/// would use, with no cross-account cache.
#[tauri::command(async)]
pub fn account_pi_refresh(
    app: AppHandle,
    account_id: String,
) -> IpcResult<Vec<PiProviderAuthObservation>> {
    let state = app.state::<AccountState>();
    let (config_dir, runtime, distro, inherit_environment_credentials) = {
        let Ok(mut inner) = state.0.lock() else {
            return err(ErrorCode::Internal, "account state is unavailable");
        };
        if find_pi_record(&inner, &account_id).is_err() {
            return err(ErrorCode::AccountNotFound, NOT_FOUND_MSG);
        }
        let drifted = reconcile_trust_drift(&mut inner, &account_id);
        if drifted {
            if let Err(msg) = persist(&app, &inner) {
                eprintln!("accounts: could not persist accounts.json: {msg}");
            }
            notify_credentials_changing(&account_id);
        }
        match pi_execution_preflight(&inner, &account_id, "refreshing it", drifted) {
            Ok(v) => v,
            Err(e) => return e.into(),
        }
    };
    // PR #142 §5: the probe runs in THIS account's environment, not the
    // ambient one — `configDir` and the inherit choice both ride along.
    match probe_provider_auth(
        &app.state::<PiInstallProbe>(),
        &runtime,
        distro.as_deref(),
        &config_dir,
        inherit_environment_credentials,
    ) {
        Ok(observations) => ok(observations),
        Err(e) => e.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::*;

    // These four are Tauri commands (they take `AppHandle`/`State`), so — like
    // every other command in commands.rs — they are not unit tested directly;
    // the pure decisions they delegate to (validation, fingerprinting,
    // trust/in-use gating, the argv/env the PTY spawn builds) are tested in
    // pi/mod.rs, and the wire shapes below pin what actually crosses IPC.

    #[test]
    fn a_fresh_pi_row_carries_no_endpoint_and_no_signed_in_flag() {
        // Confidence check for this file's own return type: `account_add_pi`
        // hands back the SAME `Vec<Account>` shape every other add-command
        // does — this is `apply_add_pi` + `build_list`, exercised through the
        // exact call shape the command uses.
        let mut inner = inner_fixture(&[], "default");
        apply_add_pi(
            &mut inner,
            "p1".into(),
            "Home Pi".into(),
            "/pi/home".into(),
            "native".into(),
            None,
            false,
            false,
        );
        let list = build_list(&inner);
        let v = serde_json::to_value(&list[1]).unwrap();
        assert_eq!(v["kind"], "pi");
        assert!(v.get("endpoint").is_none());
        assert!(v.get("signedIn").is_none());
    }
}
