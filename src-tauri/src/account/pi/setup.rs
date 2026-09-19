//! pi-provider-auth FR-3: the Pi setup PTY — resolve the certified binary,
//! launch it on a login-shaped PTY, stream its bytes verbatim, and settle
//! once it closes. Split out of `pi/mod.rs` purely for CLAUDE.md's ~1000-line
//! file cap — `mod.rs` (FR-1/FR-4/FR-7/FR-9) is this child's only caller.

use super::*;
use crate::ipc::{AppError, ErrorCode};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// The geometry the setup terminal starts at — same as the Claude login's
/// (login.rs `LOGIN_COLS`/`LOGIN_ROWS`); the frontend resizes it once mounted.
pub const SETUP_COLS: u16 = 100;
pub const SETUP_ROWS: u16 = 30;

/// What `resolve_pi_setup_program` settled on, before it is handed to
/// `portable_pty`. Split out so the argv it produces (`pi_setup_argv`) is
/// testable without a real spawn or a real PATH.
#[derive(Debug)]
pub(crate) enum PiSetupProgram {
    Native(std::path::PathBuf),
    Wsl { distro: String },
}

/// FR-1/FR-8: resolve which binary a Pi setup PTY should run, for the
/// account's OWN runtime/distro — never the ambient default, mirroring
/// `session::adapter::pi::discovery`'s own "no implicit cross-environment
/// fallback" rule (kept independent here since that resolver is private to
/// its module).
pub(crate) fn resolve_pi_setup_program(
    runtime: &str,
    distro: Option<&str>,
) -> Result<PiSetupProgram, AppError> {
    if runtime == "wsl" {
        let distro = distro
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::Internal,
                    "a wsl Pi account is missing its distro",
                )
            })?;
        Ok(PiSetupProgram::Wsl {
            distro: distro.to_string(),
        })
    } else {
        crate::process_util::resolve_program("pi")
            .map(PiSetupProgram::Native)
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::SpawnFailed,
                    "could not start pi — install the certified Pi release and ensure `pi` is on PATH",
                )
            })
    }
}

/// FR-3: the resolved argv. `--no-extensions` per the audit's CLI-arguments
/// row — it disables discovery, but an explicit extension path would still
/// load, so Francois never passes one (deny arbitrary extra args in MVP).
pub(crate) fn pi_setup_argv(program: &PiSetupProgram) -> (String, Vec<String>) {
    match program {
        PiSetupProgram::Native(path) => (
            path.to_string_lossy().into_owned(),
            vec!["--no-extensions".to_string()],
        ),
        PiSetupProgram::Wsl { distro } => (
            "wsl.exe".to_string(),
            vec![
                "-d".to_string(),
                distro.clone(),
                "--".to_string(),
                "pi".to_string(),
                "--no-extensions".to_string(),
            ],
        ),
    }
}

/// FR-3: launch the certified Pi interactive binary from a neutral, app-owned
/// cwd (the user's home — never the account's own `configDir`, and never a
/// project directory) with extensions disabled. The returned handle is NOT
/// yet registered anywhere; the caller inserts it into `pi_setups` under the
/// account lock, same discipline as `spawn_login`/`account_add`.
///
/// FR-5: the child's environment is built through the SAME
/// `session::pi_account_env` filter a live Pi session connect uses — never
/// the ambient environment verbatim — so `inheritEnvironmentCredentials=false`
/// (the MVP default) really does start the setup PTY from nothing but `PATH`,
/// not just the session's own turns.
pub(crate) fn spawn_pi_setup(
    account_id: &str,
    config_dir: &str,
    runtime: &str,
    distro: Option<&str>,
    inherit_environment_credentials: bool,
) -> Result<
    (
        LoginHandle,
        Box<dyn std::io::Read + Send>,
        Box<dyn portable_pty::Child + Send + Sync>,
    ),
    AppError,
> {
    let program = resolve_pi_setup_program(runtime, distro)?;
    let (bin, args) = pi_setup_argv(&program);

    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize {
            rows: SETUP_ROWS,
            cols: SETUP_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::new(ErrorCode::PtyError, format!("could not open a pty: {e}")))?;

    // The login-shell PATH (ext-path-resolution) wins over whatever ambient
    // PATH this process happens to carry — resolved BEFORE filtering, so the
    // `inheritEnvironmentCredentials=false` branch (PATH-only) still gets the
    // resolved value rather than a bare `argv0`'s ambient one.
    let mut ambient: Vec<(String, String)> = std::env::vars().collect();
    if let Some(path) = crate::process_util::login_shell_path_env() {
        ambient.retain(|(k, _)| k != "PATH");
        ambient.push(("PATH".to_string(), path));
    }

    let mut cmd = portable_pty::CommandBuilder::new(bin);
    cmd.args(args);
    // FR-5: a clean slate — `CommandBuilder::new` seeds its own base
    // environment from this process's ambient vars (plus, on Windows, the
    // registry), which `pi_account_env` must fully own the outcome for,
    // never merge on top of. Removed by key, one at a time, rather than
    // process_util.rs's own crate-wide clearing primitive (see its
    // "the facade holds the only [...] in the crate" test) — a PTY spawn
    // cannot route through that std::process::Command-based facade at all,
    // so this stays its own distinct, narrower removal rather than a second
    // copy of that one.
    let desired = pi_account_env(&ambient, config_dir, inherit_environment_credentials);
    let keep: std::collections::HashSet<&str> = desired.iter().map(|(k, _)| k.as_str()).collect();
    let seeded: Vec<String> = cmd
        .iter_full_env_as_str()
        .map(|(k, _)| k.to_string())
        .collect();
    for k in seeded {
        if !keep.contains(k.as_str()) {
            cmd.env_remove(&k);
        }
    }
    for (k, v) in desired {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::new(ErrorCode::SpawnFailed, format!("could not start pi: {e}")))?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let writer = pair.master.take_writer().map_err(|e| {
        AppError::new(
            ErrorCode::PtyError,
            format!("could not open setup input: {e}"),
        )
    })?;
    let reader = pair.master.try_clone_reader().map_err(|e| {
        AppError::new(
            ErrorCode::PtyError,
            format!("could not read the setup output: {e}"),
        )
    })?;

    let handle = LoginHandle {
        login_id: crate::ids::uuid(),
        account_id: account_id.to_string(),
        label: None,
        config_dir: config_dir.to_string(),
        existing: true,
        writer,
        master: pair.master,
        killer,
        settled: Arc::new(AtomicBool::new(false)),
        kind: AccountKind::Pi,
    };
    Ok((handle, reader, child))
}

/// FR-3: stream PTY bytes verbatim (never captured/persisted — same
/// passthrough discipline as `login.rs`'s reader thread) until the process
/// exits, then settle. No identity poller: Pi's native `/login` is opaque to
/// Francois, so nothing here ever infers success from PTY content.
pub(crate) fn start_pi_setup_thread(
    app: AppHandle,
    login_id: String,
    settled: Arc<AtomicBool>,
    mut reader: Box<dyn std::io::Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
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
        settle_pi_setup(&app, &login_id);
    });
}

/// FR-3: the PTY closed (the user exited it, or the process ended on its
/// own). Closing setup NEVER implies auth succeeded — this reports the
/// account UNCHANGED via `account.login.done`, running no identity check and
/// no registry mutation. `account.login.failed` only if the row is somehow
/// gone by now (defensive: `sessions_currently_use`/removal's own preflight
/// already keeps `account_remove` from reaching a Pi account mid-setup in
/// practice).
fn settle_pi_setup(app: &AppHandle, login_id: &str) {
    let Some(mut handle) = claim_pi_setup(app, login_id) else {
        return;
    };
    let _ = handle.killer.kill();
    let Some(state) = app.try_state::<AccountState>() else {
        return;
    };
    let Ok(inner) = state.0.lock() else {
        return;
    };
    match build_list(&inner)
        .into_iter()
        .find(|a| a.id == handle.account_id)
    {
        Some(account) => emit(
            app,
            AccountEvent::LoginDone {
                login_id: login_id.to_string(),
                account,
            },
        ),
        None => emit(
            app,
            AccountEvent::LoginFailed {
                login_id: login_id.to_string(),
                error: AppError::new(
                    ErrorCode::AccountNotFound,
                    "the account was removed while setup was open",
                ),
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_setup_argv_disables_extensions() {
        let program = PiSetupProgram::Native("/usr/local/bin/pi".into());
        let (bin, args) = pi_setup_argv(&program);
        assert_eq!(bin, "/usr/local/bin/pi");
        assert_eq!(args, vec!["--no-extensions".to_string()]);
    }

    #[test]
    fn wsl_setup_argv_targets_the_explicit_distro_and_disables_extensions() {
        let program = PiSetupProgram::Wsl {
            distro: "Ubuntu".into(),
        };
        let (bin, args) = pi_setup_argv(&program);
        assert_eq!(bin, "wsl.exe");
        assert_eq!(
            args,
            vec![
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--".to_string(),
                "pi".to_string(),
                "--no-extensions".to_string(),
            ]
        );
    }

    #[test]
    fn resolving_a_wsl_setup_program_without_a_distro_is_an_internal_error() {
        assert_eq!(
            resolve_pi_setup_program("wsl", None).unwrap_err().code,
            ErrorCode::Internal
        );
    }
}
