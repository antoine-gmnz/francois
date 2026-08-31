//! FR-11..FR-17: the in-app login — a real `claude` TUI on a core-owned PTY,
//! plus the `<configDir>/.claude.json` identity poll that decides when it
//! succeeded.
//!
//! Raw passthrough, exactly like the SHELL tab: PTY bytes go out verbatim as
//! `account.login.data`, keystrokes come back through `account:loginWrite` and
//! geometry through `account:loginResize` (FR-12).
//!
//! Exactly one login runs at a time (FR-16), and exactly one of its four
//! possible finishers wins: the identity poller (success), the 5-minute deadline
//! (FR-15), the PTY reader's exit path (FR-15), and an explicit cancel (FR-16).
//! `claim` is what makes that exactly-once — it takes the handle OUT of the
//! state, so a second finisher finds nothing.

use super::*;
use crate::ipc::{AppError, ErrorCode};

use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// The geometry the login terminal starts at; the frontend resizes it to its
/// own once mounted (FR-12). Wide enough that the CLI's onboarding TUI is not
/// wrapped mid-box before the first resize arrives.
pub const LOGIN_COLS: u16 = 100;
pub const LOGIN_ROWS: u16 = 30;
/// FR-15: a login that neither succeeds nor is cancelled within 5 minutes fails.
pub const LOGIN_TIMEOUT_SECS: u64 = 300;
/// FR-13: how often `<configDir>/.claude.json` is checked for an identity.
const IDENTITY_POLL: Duration = Duration::from_secs(1);

// §7 — the exact user-facing message for each failure condition.
pub const MSG_TIMED_OUT: &str = "The login timed out before an account was authenticated.";
pub const MSG_EXITED: &str = "The login ended before an account was authenticated.";
pub const MSG_IN_FLIGHT: &str = "a login is already in progress";
pub const MSG_NO_LOGIN: &str = "no login is in progress";

/// FR-14: the duplicate identity is the feature's isolation check — it must fail
/// LOUDLY and say WHY, rather than silently bill the wrong account.
pub fn duplicate_message(email: &str) -> String {
    format!(
        "{email} is already registered in Francois. This platform's Claude Code credential \
         store may be shared between configuration directories, so this account cannot be \
         isolated from the one already using it."
    )
}

// ---------- spawning the login PTY (FR-11) ----------

/// A freshly spawned login, before its handle reaches the state. The reader and
/// the child are handed to the reader thread; everything else becomes the
/// `LoginHandle`.
pub struct LoginSpawn {
    handle: LoginHandle,
    threads: LoginThreads,
}

/// The half of a spawned login the background threads own. Split from the
/// handle so the caller can register the handle UNDER the same lock that
/// reserved the single-login slot (FR-16), and only then start the threads —
/// no finisher can then race a login the state does not know about yet.
pub struct LoginThreads {
    login_id: String,
    config_dir: String,
    /// Round-5 CRITICAL: the identity file's mtime at the moment this login was
    /// spawned — `None` if the file did not exist yet. A Re-login's `config_dir`
    /// commonly already holds a stale-but-non-empty `.claude.json` from before
    /// (FR-23: credentials expiring mid-turn never delete it), so "a non-empty
    /// identity" alone cannot mean success here; only an identity that is new or
    /// whose file has been rewritten since this baseline can.
    baseline_mtime: Option<SystemTime>,
    settled: Arc<AtomicBool>,
    reader: Box<dyn Read + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl LoginSpawn {
    /// `(login_id, handle, threads)` — the id is handed back separately because
    /// the handle moves into the state before the ack is built.
    pub fn split(self) -> (String, LoginHandle, LoginThreads) {
        (self.handle.login_id.clone(), self.handle, self.threads)
    }
}

/// FR-11: `claude` on a PTY with `CLAUDE_CONFIG_DIR=<config_dir>`,
/// `TERM=xterm-256color`, cwd = the user's home and the resolved claude PATH.
/// The runtime is ALWAYS native — one Windows-side config dir serves WSL too
/// (FR-24), so there is no `wsl.exe` wrapper here.
pub fn spawn_login(
    account_id: &str,
    config_dir: &str,
    label: Option<String>,
    existing: bool,
) -> Result<LoginSpawn, AppError> {
    // Round-5 CRITICAL: snapshot BEFORE the child spawns, so nothing the new
    // login itself writes can be mistaken for the pre-existing state.
    let baseline_mtime = crate::account::identity_mtime(config_dir);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: LOGIN_ROWS,
            cols: LOGIN_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::new(ErrorCode::PtyError, format!("could not open a pty: {e}")))?;

    let mut cmd = CommandBuilder::new("claude");
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("CLAUDE_CONFIG_DIR", config_dir);
    if let Some(path) = crate::process_util::login_shell_path_env() {
        cmd.env("PATH", path);
    }
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        AppError::new(
            ErrorCode::SpawnFailed,
            format!("could not start claude: {e}"),
        )
    })?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let writer = pair.master.take_writer().map_err(|e| {
        AppError::new(
            ErrorCode::PtyError,
            format!("could not open login input: {e}"),
        )
    })?;
    let reader = pair.master.try_clone_reader().map_err(|e| {
        AppError::new(
            ErrorCode::PtyError,
            format!("could not read the login output: {e}"),
        )
    })?;

    let login_id = crate::ids::uuid();
    let settled = Arc::new(AtomicBool::new(false));
    Ok(LoginSpawn {
        handle: LoginHandle {
            login_id: login_id.clone(),
            account_id: account_id.to_string(),
            label,
            config_dir: config_dir.to_string(),
            existing,
            writer,
            master: pair.master,
            killer,
            settled: settled.clone(),
        },
        threads: LoginThreads {
            login_id,
            config_dir: config_dir.to_string(),
            baseline_mtime,
            settled,
            reader,
            child,
        },
    })
}

/// Start the two threads that race to finish the login: the PTY reader (streams
/// `account.login.data`, and owns the FR-15 "exited without an identity" path)
/// and the identity poller (FR-13 success, FR-15 deadline). Called AFTER the
/// handle is in the state, so neither can settle a login nothing knows about.
pub fn start_login_threads(app: &AppHandle, threads: LoginThreads) {
    let LoginThreads {
        login_id,
        config_dir,
        baseline_mtime,
        settled,
        reader,
        child,
    } = threads;
    spawn_reader_thread(
        app.clone(),
        login_id.clone(),
        config_dir.clone(),
        baseline_mtime,
        settled.clone(),
        reader,
        child,
    );
    spawn_identity_poller(app.clone(), login_id, config_dir, baseline_mtime, settled);
}

/// Round-5 CRITICAL: an identity only this login could have produced — `None`
/// unless the file is new (no `baseline_mtime`) or has been rewritten since
/// (`baseline_mtime` is older than the file's current mtime). A Re-login's
/// `config_dir` commonly already carries a stale-but-non-empty `.claude.json`
/// from before (FR-23), so "a non-empty identity" alone is not evidence this
/// login succeeded — it could be the pre-existing invalid credentials the user
/// has not even had a chance to replace yet.
fn fresh_identity(
    config_dir: &str,
    baseline_mtime: Option<SystemTime>,
) -> Option<(String, Option<String>)> {
    let (email, organization) = read_identity(config_dir);
    let email = email?;
    let current_mtime = crate::account::identity_mtime(config_dir);
    let is_fresh = match (baseline_mtime, current_mtime) {
        (None, _) => true,        // no file at all before this login started
        (Some(_), None) => false, // the file vanished; nothing fresh to report
        (Some(base), Some(now)) => now > base,
    };
    is_fresh.then_some((email, organization))
}

fn spawn_reader_thread(
    app: AppHandle,
    login_id: String,
    config_dir: String,
    baseline_mtime: Option<SystemTime>,
    settled: Arc<AtomicBool>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if settled.load(Ordering::SeqCst) {
                        break;
                    }
                    // FR-12: verbatim bytes — the frontend renders them in xterm.js.
                    emit(
                        &app,
                        AccountEvent::LoginData {
                            login_id: login_id.clone(),
                            data: String::from_utf8_lossy(&buf[..n]).into_owned(),
                        },
                    );
                }
            }
        }
        let _ = child.wait();
        if settled.load(Ordering::SeqCst) {
            return;
        }
        // FR-13: one last identity check on PTY exit — the CLI may write
        // `.claude.json` and quit inside a single poll interval. Round-5
        // CRITICAL: must still be a FRESH identity, not the stale one a
        // Re-login's config dir may already have held.
        match fresh_identity(&config_dir, baseline_mtime) {
            Some((email, organization)) => settle_success(&app, &login_id, email, organization),
            None => settle_failure(
                &app,
                &login_id,
                ErrorCode::AccountLoginFailed,
                MSG_EXITED.into(),
            ),
        }
    });
}

fn spawn_identity_poller(
    app: AppHandle,
    login_id: String,
    config_dir: String,
    baseline_mtime: Option<SystemTime>,
    settled: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let deadline = crate::ids::now_ms() + LOGIN_TIMEOUT_SECS * 1_000;
        loop {
            std::thread::sleep(IDENTITY_POLL);
            if settled.load(Ordering::SeqCst) {
                return;
            }
            if let Some((email, organization)) = fresh_identity(&config_dir, baseline_mtime) {
                settle_success(&app, &login_id, email, organization);
                return;
            }
            if crate::ids::now_ms() >= deadline {
                settle_failure(
                    &app,
                    &login_id,
                    ErrorCode::AccountLoginFailed,
                    MSG_TIMED_OUT.into(),
                );
                return;
            }
        }
    });
}

// ---------- finishing a login (exactly once) ----------

/// Take the in-flight login OUT of the state, if it is still `login_id`'s. The
/// removal itself is the exactly-once claim; `settled` only lets the losing
/// threads stop early.
fn claim(app: &AppHandle, login_id: &str) -> Option<LoginHandle> {
    let state = app.try_state::<AccountState>()?;
    let mut inner = state.0.lock().ok()?;
    let matches = inner
        .login
        .as_ref()
        .map(|l| l.login_id == login_id)
        .unwrap_or(false);
    if !matches {
        return None;
    }
    let handle = inner.login.take()?;
    handle.settled.store(true, Ordering::SeqCst);
    Some(handle)
}

/// FR-16 / FR-15: kill the PTY and delete the half-written config dir. A
/// re-login (FR-17) keeps its registry ROW — only the directory goes, exactly as
/// for a fresh login, because credentials that were never completed must not be
/// left behind for a turn to spawn against.
fn discard(handle: &mut LoginHandle) {
    let _ = handle.killer.kill();
    let _ = std::fs::remove_dir_all(&handle.config_dir);
}

/// FR-13: an identity appeared — kill the PTY, register (or refresh, FR-17) the
/// row, then emit `account.login.done` followed by `account.list` (FR-7).
/// FR-14: an identity that is already registered fails instead, and the dir goes.
fn settle_success(app: &AppHandle, login_id: &str, email: String, organization: Option<String>) {
    let Some(mut handle) = claim(app, login_id) else {
        return;
    };
    let _ = handle.killer.kill();

    let Some(state) = app.try_state::<AccountState>() else {
        return;
    };
    // A poisoned lock must not brick the account domain — treat it as a login
    // failure (the dir goes, same as any other FR-15 failure) rather than
    // panicking.
    let Ok(mut inner) = state.0.lock() else {
        discard(&mut handle);
        emit(
            app,
            AccountEvent::LoginFailed {
                login_id: login_id.to_string(),
                error: crate::ipc::AppError {
                    code: ErrorCode::Internal,
                    message: "account state is unavailable".into(),
                    detail: None,
                },
            },
        );
        return;
    };
    let outcome = {
        // FR-14: the isolation check. A re-login into an existing row is
        // expected to report that row's own identity, so it skips itself.
        let skip = handle.existing.then(|| handle.account_id.clone());
        if duplicate_email(&inner, &email, skip.as_deref()) {
            Err(AppError::new(
                ErrorCode::AccountDuplicate,
                duplicate_message(&email),
            ))
        } else {
            match register(
                &mut inner,
                &handle.account_id,
                &handle.config_dir,
                handle.label.as_deref(),
                email,
                organization,
                handle.existing,
            ) {
                Some(account) => {
                    let persisted = persist(app, &inner);
                    Ok((account, build_list(&inner), persisted))
                }
                // Round-4 CRITICAL: the re-login's target row was removed
                // (FR-8) while this login was still in flight — refuse rather
                // than resurrecting it; the caller discards the handle below.
                None => Err(AppError::new(
                    ErrorCode::AccountNotFound,
                    "the account was removed before the login finished".to_string(),
                )),
            }
        }
    };

    match outcome {
        Err(AppError { code, message, .. }) => {
            discard(&mut handle); // FR-14: the dir is deleted
            emit(
                app,
                AccountEvent::LoginFailed {
                    login_id: login_id.to_string(),
                    error: crate::ipc::AppError {
                        code,
                        message,
                        detail: None,
                    },
                },
            );
        }
        Ok((account, accounts, persisted)) => {
            if let Err(msg) = persisted {
                // FR-1: a write failure is never fatal — the row lives for this
                // run and the next successful write records it.
                eprintln!("accounts: could not persist accounts.json: {msg}");
            }
            emit(
                app,
                AccountEvent::LoginDone {
                    login_id: login_id.to_string(),
                    account,
                },
            );
            emit(app, AccountEvent::List { accounts }); // FR-7
        }
    }
}

/// FR-15: no identity — kill the PTY, delete the dir, report it inline.
fn settle_failure(app: &AppHandle, login_id: &str, code: ErrorCode, message: String) {
    let Some(mut handle) = claim(app, login_id) else {
        return;
    };
    discard(&mut handle);
    emit(
        app,
        AccountEvent::LoginFailed {
            login_id: login_id.to_string(),
            error: crate::ipc::AppError {
                code,
                message,
                detail: None,
            },
        },
    );
}

/// FR-13/FR-17: insert the new row, or refresh the one a re-login targeted
/// (keeping its label unless this login carried a new one, and clearing the
/// FR-22/FR-23 auth flag — the credentials are good again).
///
/// Takes the login's fields rather than the `LoginHandle` itself: the handle
/// owns a live PTY, and this is the one part of the flow that is pure state.
///
/// `existing` is `handle.existing` (FR-17): `true` ⇔ this login was a
/// re-login into an ALREADY-registered row. Round-4 CRITICAL: `account_add`'s
/// reservation is released while it does its lock-free directory creation and
/// process spawn (commands.rs), with `inner.login` still `None` — a
/// concurrent `account_remove` of that same row during that window is not
/// caught by `cancel_login_for_account` (nothing to cancel yet). If the login
/// later succeeds anyway, treating the now-missing row as "insert a new one"
/// would resurrect the just-removed account under its old id. So a re-login
/// whose target row is gone by the time it tries to register is refused
/// (`None`) rather than resurrected — the caller discards it like any other
/// failed login.
fn register(
    inner: &mut AccountInner,
    account_id: &str,
    config_dir: &str,
    label: Option<&str>,
    email: String,
    organization: Option<String>,
    existing: bool,
) -> Option<Account> {
    let found = inner.records.iter().any(|r| r.id == account_id);
    if existing && !found {
        return None;
    }
    inner.auth_failed_at.remove(account_id);
    match inner.records.iter_mut().find(|r| r.id == account_id) {
        Some(record) => {
            if let Some(label) = label.map(str::trim).filter(|l| !l.is_empty()) {
                record.label = label.to_string();
            }
            record.email = Some(email);
            record.organization = organization;
        }
        None => {
            let label = label_fallback(label, Some(&email), inner.records.len());
            inner.records.push(AccountRecord {
                id: account_id.to_string(),
                label,
                email: Some(email),
                organization,
                config_dir: config_dir.to_string(),
                created_at: crate::ids::now_ms(),
                // multi-provider-seam FR-12: every login this module drives is
                // the Claude Code CLI OAuth flow — the only kind reachable here.
                kind: AccountKind::ClaudeCodeOauth,
                endpoint: None,
            });
        }
    }
    // The row was just inserted or updated above, so this lookup is expected to
    // always find it; still returned as an Option rather than `.expect()`ed, so
    // a future refactor that breaks the invariant fails soft (no row) instead of
    // panicking a background thread.
    build_list(inner).into_iter().find(|a| a.id == account_id)
}

// ---------- the passthrough surface (FR-12/FR-16) ----------

pub fn write_login(app: &AppHandle, login_id: &str, data: &str) -> Result<(), AppError> {
    let state = app
        .try_state::<AccountState>()
        .ok_or(AppError::new(ErrorCode::InvalidInput, MSG_NO_LOGIN))?;
    // `AccountLoginAck` (contract/multi-account.ts) documents only
    // `INVALID_INPUT`/`PTY_ERROR` for this ack — a poisoned lock reads as the
    // login terminal being gone, same as any other PTY failure on this path.
    let Ok(mut inner) = state.0.lock() else {
        return Err(AppError::new(
            ErrorCode::PtyError,
            "the login terminal is closed",
        ));
    };
    let Some(login) = inner.login.as_mut().filter(|l| l.login_id == login_id) else {
        return Err(AppError::new(ErrorCode::InvalidInput, MSG_NO_LOGIN));
    };
    login
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| login.writer.flush())
        .map_err(|_| AppError::new(ErrorCode::PtyError, "the login terminal is closed"))
}

pub fn resize_login(app: &AppHandle, login_id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
    if cols == 0 || rows == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "cols and rows must be positive",
        ));
    }
    let state = app
        .try_state::<AccountState>()
        .ok_or(AppError::new(ErrorCode::InvalidInput, MSG_NO_LOGIN))?;
    // Same normalization as `write_login`: the ack's contract shape has no
    // `INTERNAL` arm, so a poisoned lock reads as a PTY failure.
    let Ok(inner) = state.0.lock() else {
        return Err(AppError::new(
            ErrorCode::PtyError,
            "the login terminal is closed",
        ));
    };
    let Some(login) = inner.login.as_ref().filter(|l| l.login_id == login_id) else {
        return Err(AppError::new(ErrorCode::InvalidInput, MSG_NO_LOGIN));
    };
    login
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| AppError::new(ErrorCode::PtyError, "could not resize the login terminal"))
}

/// FR-16: cancel — kill the PTY, delete the dir. No event: the caller asked for
/// this, and the modal returns to the list on its own ack.
pub fn cancel_login(app: &AppHandle, login_id: &str) -> Result<(), AppError> {
    match claim(app, login_id) {
        Some(mut handle) => {
            discard(&mut handle);
            Ok(())
        }
        None => Err(AppError::new(ErrorCode::InvalidInput, MSG_NO_LOGIN)),
    }
}

/// FR-8 + FR-16: an account removed while a login into THAT row is in flight
/// cancels it, so a late success cannot resurrect the row that was just removed.
/// Called with the account lock already held (the removal's critical section).
pub fn cancel_login_for_account(inner: &mut AccountInner, account_id: &str) {
    let targeted = inner
        .login
        .as_ref()
        .map(|l| l.account_id == account_id)
        .unwrap_or(false);
    if !targeted {
        return;
    }
    if let Some(mut handle) = inner.login.take() {
        handle.settled.store(true, Ordering::SeqCst);
        discard(&mut handle);
    }
}

/// FR-16: app exit cancels the in-flight login the same way — no orphan PTY,
/// no orphan half-written config dir.
pub fn cancel_all_logins(app: &AppHandle) {
    let Some(state) = app.try_state::<AccountState>() else {
        return;
    };
    let Ok(mut inner) = state.0.lock() else {
        return;
    };
    if let Some(mut handle) = inner.login.take() {
        handle.settled.store(true, Ordering::SeqCst);
        discard(&mut handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::*;
    use serde_json::json;

    fn write_identity(dir: &std::path::Path, email: &str) {
        std::fs::write(
            dir.join(".claude.json"),
            json!({ "oauthAccount": { "emailAddress": email } }).to_string(),
        )
        .unwrap();
    }

    // ---------- Round-5 CRITICAL: fresh_identity vs. a stale Re-login dir ----------

    #[test]
    fn fresh_identity_is_none_without_any_email_regardless_of_baseline() {
        let dir = tmp_account_dir("fresh-none");
        assert_eq!(fresh_identity(&dir.to_string_lossy(), None), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fresh_identity_accepts_a_first_ever_identity_when_there_was_no_baseline_file() {
        // A fresh login (FR-11): the config dir was just created, so there is no
        // baseline file at all — any identity that appears is new by definition.
        let dir = tmp_account_dir("fresh-first-login");
        write_identity(&dir, "dev@acme.io");
        assert_eq!(
            fresh_identity(&dir.to_string_lossy(), None),
            Some(("dev@acme.io".to_string(), None))
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fresh_identity_rejects_the_stale_identity_a_relogin_dir_already_held() {
        // The exact bug: a Re-login's config_dir commonly already has a
        // non-empty (but invalid) .claude.json from before (FR-23). Without a
        // rewrite, the poller must NOT report success on that stale content —
        // it must keep waiting for the user to actually finish the TUI login.
        let dir = tmp_account_dir("fresh-stale-relogin");
        write_identity(&dir, "stale@acme.io");
        let baseline = crate::account::identity_mtime(&dir.to_string_lossy());
        assert!(baseline.is_some());

        assert_eq!(
            fresh_identity(&dir.to_string_lossy(), baseline),
            None,
            "the pre-existing identity must not settle the login as a success"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fresh_identity_accepts_a_relogin_identity_once_the_file_is_rewritten() {
        // Once the real login actually completes, the CLI rewrites
        // .claude.json — its mtime moves past the baseline, and the (possibly
        // unchanged) email is now legitimately fresh.
        let dir = tmp_account_dir("fresh-rewritten-relogin");
        write_identity(&dir, "stale@acme.io");
        let baseline = crate::account::identity_mtime(&dir.to_string_lossy());

        // Force the mtime strictly forward, since some filesystem clocks are
        // coarser than this test's runtime.
        let advanced = baseline.unwrap() + Duration::from_secs(1);
        write_identity(&dir, "dev@acme.io");
        std::fs::OpenOptions::new()
            .write(true)
            .open(dir.join(".claude.json"))
            .unwrap()
            .set_modified(advanced)
            .unwrap();

        assert_eq!(
            fresh_identity(&dir.to_string_lossy(), baseline),
            Some(("dev@acme.io".to_string(), None))
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_duplicate_message_names_the_shared_credential_store() {
        // FR-14: it must say WHY — a silent second row would bill the wrong account.
        let msg = duplicate_message("dev@acme.io");
        assert!(msg.contains("dev@acme.io"));
        assert!(msg.contains("credential"));
        assert!(msg.to_lowercase().contains("shared"));
    }

    #[test]
    fn the_login_deadline_is_five_minutes() {
        assert_eq!(LOGIN_TIMEOUT_SECS, 300); // FR-15
    }

    #[test]
    fn registering_a_fresh_identity_appends_a_row_with_the_email_as_its_label() {
        // FR-5/FR-13: label defaults to the email captured at login.
        let mut inner = inner_fixture(&[], "default");
        let account = register(
            &mut inner,
            "a1",
            "/tmp/accounts/a1",
            None,
            "dev@acme.io".into(),
            Some("Acme".into()),
            false, // a fresh login, not a re-login
        )
        .expect("a fresh login always registers");

        assert_eq!(inner.records.len(), 1);
        assert_eq!(inner.records[0].id, "a1");
        assert_eq!(inner.records[0].label, "dev@acme.io");
        assert_eq!(inner.records[0].config_dir, "/tmp/accounts/a1");
        assert_eq!(account.email.as_deref(), Some("dev@acme.io"));
        assert_eq!(account.organization.as_deref(), Some("Acme"));
        assert!(!account.built_in);
        assert!(!account.is_default, "FR-4: adding never steals the flag");
    }

    #[test]
    fn a_supplied_label_wins_over_the_email() {
        let mut inner = inner_fixture(&[], "default");
        register(
            &mut inner,
            "a1",
            "/tmp/accounts/a1",
            Some("work"),
            "dev@acme.io".into(),
            None,
            false,
        );
        assert_eq!(inner.records[0].label, "work");
    }

    #[test]
    fn a_relogin_refreshes_the_existing_row_and_clears_the_auth_flag() {
        // FR-17: re-login reuses the row AND its dir — never a second entry.
        let mut inner = inner_fixture(&["a1"], "a1");
        inner.records[0].email = Some("stale@acme.io".into());
        inner.auth_failed_at.insert("a1".into(), 1_234);

        let account = register(
            &mut inner,
            "a1",
            "/tmp/accounts/a1",
            None,
            "dev@acme.io".into(),
            None,
            true,
        )
        .expect("the row still exists");

        assert_eq!(inner.records.len(), 1, "no second row");
        assert_eq!(inner.records[0].email.as_deref(), Some("dev@acme.io"));
        assert_eq!(inner.records[0].label, "work", "the label is preserved");
        assert!(
            !inner.auth_failed_at.contains_key("a1"),
            "FR-22/FR-23: good credentials clear the flag"
        );
        assert!(account.auth_failed_at.is_none());
        assert!(account.is_default, "the row keeps whatever flag it had");
    }

    #[test]
    fn a_relogin_whose_target_row_was_removed_mid_flight_does_not_resurrect_it() {
        // Round-4 CRITICAL: `account_remove` can drop row `a1` (apply_remove)
        // while a re-login into that same id is still reserving/spawning —
        // `inner.login` is still `None` during that window (commands.rs
        // `account_add`), so `cancel_login_for_account` finds nothing to
        // cancel. When the login later succeeds, `register()`'s `existing`
        // flag must refuse to treat the missing row as "insert a new one":
        // that would resurrect the just-removed account under the same id,
        // violating FR-8/FR-35's "the row and its config dir are gone".
        let mut inner = inner_fixture(&[], "default"); // "a1" already removed
        let account = register(
            &mut inner,
            "a1",
            "/tmp/accounts/a1",
            None,
            "dev@acme.io".into(),
            None,
            true, // this was a re-login (FR-17), not a fresh one
        );
        assert!(
            account.is_none(),
            "a re-login must not resurrect a removed row"
        );
        assert!(inner.records.is_empty(), "no row was inserted");
    }
}
