//! `grok-cli` accounts (multi-provider-grok FR-19..FR-22): a per-account
//! `GROK_HOME` that `grok login` fills in.
//!
//! Structurally identical to codex.rs (see that file's doc comment for the
//! "why not login.rs" reasoning — `grok login` is the same shape: no
//! interactive TUI, no identity to scrape, just a browser round-trip that
//! writes `auth.json`). This file exists as codex.rs's sibling rather than
//! folded into it because a third vendor CLI inside one file would stop
//! reading as "the Codex account half" and start reading as "the generic
//! vendor-CLI account half with two copies pasted in" — the module boundary
//! is the CLI, matching `session/adapter/{codex,grok}/`.

use super::registry::build_list;
use super::{emit, AccountEvent, AccountInner, AccountKind, AccountRecord, AccountState};
use crate::account::Account;

use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How long to wait for the browser round-trip before giving up on the poll.
/// Same value as the Codex poll — the browser round-trip takes about as long
/// whichever vendor's OAuth page it opens.
const LOGIN_TIMEOUT_SECS: u64 = 300;
const POLL: Duration = Duration::from_millis(500);

/// FR-20: append a freshly-minted Grok row. The caller has already validated
/// the label, minted `id` and created `config_dir` on disk — this only touches
/// the in-memory registry, mirroring `apply_add_codex`.
///
/// FR-19: **no mirror of `~/.claude`**, and no seeding of any kind. The dir
/// starts empty and `grok login` is what fills it.
pub(crate) fn apply_add_grok(
    inner: &mut AccountInner,
    id: String,
    config_dir: String,
    label: String,
) -> Account {
    inner.records.push(AccountRecord {
        id: id.clone(),
        label,
        email: None,
        organization: None,
        config_dir,
        created_at: crate::session::now_ms(),
        kind: AccountKind::GrokCli,
        endpoint: None,
    });
    build_list(inner)
        .into_iter()
        .find(|a| a.id == id)
        .expect("just inserted")
}

/// FR-21: run `grok login` against one account's `GROK_HOME`.
///
/// Returns as soon as the process is spawned — the browser round-trip happens
/// out of band, and the poller below publishes the refreshed list once
/// `auth.json` lands (which is what flips the row's `signedIn`, FR-22).
pub(crate) fn spawn_grok_login(
    config_dir: &str,
) -> Result<std::process::Child, (&'static str, String)> {
    let mut cmd = std::process::Command::new(crate::session::grok_program());
    cmd.arg("login");
    cmd.env("GROK_HOME", config_dir);
    // Same reasoning as `spawn_codex_login`: a GUI-launched app inherits
    // launchd's minimal PATH on macOS, not the login shell's.
    if let Some(path) = crate::session::claude_path_env() {
        cmd.env("PATH", path);
    }
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    crate::session::no_window(&mut cmd);
    // `null`, not `piped` — same trap `spawn_codex_login` documents: nothing
    // here reads grok's output, and a piped stream with no reader can turn an
    // early status line into a broken pipe that kills the login before the
    // browser round-trip finishes.
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            (
                "SPAWN_FAILED",
                "could not start grok — install it with `npm i -g @xai-official/grok`".to_string(),
            )
        } else {
            ("SPAWN_FAILED", format!("could not start grok login: {e}"))
        }
    })
}

/// Watch for `auth.json` and republish the account list when it appears —
/// identical shape and reasoning to `start_codex_login_poller`.
pub(crate) fn start_grok_login_poller(
    app: &AppHandle,
    config_dir: String,
    mut child: std::process::Child,
) {
    let app = app.clone();
    std::thread::spawn(move || {
        let deadline = crate::session::now_ms() + LOGIN_TIMEOUT_SECS * 1_000;
        loop {
            std::thread::sleep(POLL);
            let signed_in = super::grok_auth_file_exists(&config_dir);
            let exited = matches!(child.try_wait(), Ok(Some(_)) | Err(_));
            let expired = crate::session::now_ms() >= deadline;
            match poll_step(signed_in, exited, expired) {
                PollStep::Continue => continue,
                PollStep::Publish => {
                    publish(&app);
                    let _ = child.wait();
                    return;
                }
                PollStep::Stop => {
                    let _ = child.wait();
                    return;
                }
            }
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PollStep {
    Continue,
    /// `auth.json` landed — republish so the row flips.
    Publish,
    /// Give up: the process is gone without a credential, or time ran out.
    Stop,
}

/// One tick of the login poll — same "credential wins over liveness" ordering
/// `codex.rs::poll_step` documents, and for the same reason: `grok login`
/// exits the moment it has written `auth.json`, so the successful case is
/// routinely "credential present AND process gone" in the same tick.
fn poll_step(signed_in: bool, exited: bool, expired: bool) -> PollStep {
    if signed_in {
        return PollStep::Publish;
    }
    if exited || expired {
        return PollStep::Stop;
    }
    PollStep::Continue
}

fn publish(app: &AppHandle) {
    let Some(state) = app.try_state::<AccountState>() else {
        return;
    };
    let Ok(inner) = state.0.lock() else {
        return;
    };
    let accounts = build_list(&inner);
    drop(inner);
    emit(app, AccountEvent::List { accounts });
}

/// FR-21: a re-login must not race a still-running one. Shares the SAME
/// in-flight flag as the Codex path (`AccountState.1`) — two browser tabs for
/// two different vendor logins is exactly as confusing a UI as two for the
/// same one, and one reservation flag covers every interactive login this
/// module drives.
pub(crate) fn grok_login_in_flight(state: &AccountState) -> bool {
    state.1.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::inner_fixture;

    #[test]
    fn a_grok_row_is_added_with_its_kind_and_no_endpoint() {
        let mut inner = inner_fixture(&[], "default");
        let account = apply_add_grok(
            &mut inner,
            "acct-1".into(),
            "/tmp/grok-home".into(),
            "Personal xAI".into(),
        );
        assert_eq!(account.id, "acct-1");
        assert_eq!(account.label, "Personal xAI");
        assert_eq!(account.kind, AccountKind::GrokCli);
        assert!(account.endpoint.is_none());
        assert_eq!(inner.records.len(), 1);
        assert_eq!(inner.records[0].kind, AccountKind::GrokCli);
    }

    /// FR-22: a brand-new Grok account is NOT signed in, and says so straight
    /// away rather than waiting for a turn to fail.
    #[test]
    fn a_fresh_grok_row_reports_signed_in_false() {
        let dir = std::env::temp_dir().join("francois-grok-acct-fresh");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut inner = inner_fixture(&[], "default");
        let account = apply_add_grok(
            &mut inner,
            "acct-1".into(),
            dir.to_string_lossy().into_owned(),
            "Personal".into(),
        );
        assert_eq!(account.signed_in, Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// FR-19/FR-22: derived from the file, so it flips the moment `grok login`
    /// finishes — and would flip back if the user ran `grok logout`.
    #[test]
    fn signed_in_follows_the_auth_file_rather_than_anything_persisted() {
        let dir = std::env::temp_dir().join("francois-grok-acct-auth");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut inner = inner_fixture(&[], "default");
        apply_add_grok(
            &mut inner,
            "acct-1".into(),
            dir.to_string_lossy().into_owned(),
            "Personal".into(),
        );
        assert_eq!(find(&inner, "acct-1").signed_in, Some(false));

        std::fs::write(dir.join("auth.json"), r#"{"tokens":{}}"#).unwrap();
        assert_eq!(find(&inner, "acct-1").signed_in, Some(true));

        std::fs::remove_file(dir.join("auth.json")).unwrap();
        assert_eq!(find(&inner, "acct-1").signed_in, Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A Codex row and a Grok row must not bleed `signedIn` into each other —
    /// each is derived from its OWN `configDir`.
    #[test]
    fn codex_and_grok_rows_derive_signed_in_independently() {
        let codex_dir = std::env::temp_dir().join("francois-grok-vs-codex-codex");
        let grok_dir = std::env::temp_dir().join("francois-grok-vs-codex-grok");
        let _ = std::fs::remove_dir_all(&codex_dir);
        let _ = std::fs::remove_dir_all(&grok_dir);
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::create_dir_all(&grok_dir).unwrap();

        let mut inner = inner_fixture(&[], "default");
        super::super::apply_add_codex(
            &mut inner,
            "codex-1".into(),
            codex_dir.to_string_lossy().into_owned(),
            "Work".into(),
        );
        apply_add_grok(
            &mut inner,
            "grok-1".into(),
            grok_dir.to_string_lossy().into_owned(),
            "Personal".into(),
        );
        std::fs::write(grok_dir.join("auth.json"), "{}").unwrap();

        assert_eq!(find(&inner, "codex-1").signed_in, Some(false));
        assert_eq!(find(&inner, "grok-1").signed_in, Some(true));

        let _ = std::fs::remove_dir_all(&codex_dir);
        let _ = std::fs::remove_dir_all(&grok_dir);
    }

    fn find(inner: &AccountInner, id: &str) -> Account {
        find_in(&build_list(inner), id)
    }

    // ---------- FR-21: the login poll ----------

    #[test]
    fn a_login_that_succeeds_and_exits_in_the_same_tick_still_publishes() {
        assert_eq!(poll_step(true, true, false), PollStep::Publish);
        assert_eq!(poll_step(true, true, true), PollStep::Publish);
    }

    #[test]
    fn a_credential_always_wins_over_the_deadline() {
        assert_eq!(poll_step(true, false, true), PollStep::Publish);
    }

    #[test]
    fn a_dead_process_with_no_credential_stops_rather_than_polling_on() {
        assert_eq!(poll_step(false, true, false), PollStep::Stop);
    }

    #[test]
    fn the_deadline_stops_a_login_the_user_never_finished() {
        assert_eq!(poll_step(false, false, true), PollStep::Stop);
    }

    #[test]
    fn a_live_process_with_no_credential_yet_keeps_waiting() {
        assert_eq!(poll_step(false, false, false), PollStep::Continue);
    }

    fn find_in(list: &[Account], id: &str) -> Account {
        list.iter()
            .find(|a| a.id == id)
            .expect("row exists")
            .clone()
    }
}
