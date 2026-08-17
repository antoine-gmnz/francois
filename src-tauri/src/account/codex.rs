//! `codex-cli` accounts (multi-provider-codex FR-18..FR-21a): a per-account
//! `CODEX_HOME` that `codex login` fills in.
//!
//! **Why this is not `login.rs`.** The Claude login runs a full interactive TUI
//! on a PTY — theme pickers, arrow keys, an identity to scrape out of
//! `.claude.json` afterwards — which is why that file carries a PTY pair, a
//! reader thread, a writer, a resizer and an identity poller. `codex login`
//! does none of that: it opens the system browser, waits for the callback, and
//! writes `auth.json`. There is no terminal for the user to interact with and no
//! identity to extract, so this is a spawn plus a poll, and re-using the PTY
//! machinery would mean carrying five mechanisms to use none of them.
//!
//! What it DOES share is the outcome: the refreshed account list on
//! `francois://account/event`, so the modal updates itself the same way.

use super::registry::build_list;
use super::{emit, AccountEvent, AccountInner, AccountKind, AccountRecord, AccountState};
use crate::account::Account;

use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How long to wait for the browser round-trip before giving up on the poll.
/// Generous: it includes the user finding the window, signing in, and possibly
/// picking an organization.
const LOGIN_TIMEOUT_SECS: u64 = 300;
const POLL: Duration = Duration::from_millis(500);

/// FR-18: append a freshly-minted Codex row. The caller has already validated
/// the label, minted `id` and created `config_dir` on disk — this only touches
/// the in-memory registry, mirroring `apply_add_endpoint`.
///
/// FR-19: **no mirror of `~/.claude`**, and no seeding of any kind. The dir
/// starts empty and `codex login` is what fills it; copying an existing
/// `~/.codex` in would silently share one credential across rows that the user
/// created precisely to keep apart.
pub(crate) fn apply_add_codex(
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
        kind: AccountKind::CodexCli,
        endpoint: None,
    });
    build_list(inner)
        .into_iter()
        .find(|a| a.id == id)
        .expect("just inserted")
}

/// FR-25: run `codex login` against one account's `CODEX_HOME`.
///
/// Returns as soon as the process is spawned — the browser round-trip happens
/// out of band, and the poller below publishes the refreshed list once
/// `auth.json` lands (which is what flips the row's `signedIn`, FR-21a).
pub(crate) fn spawn_codex_login(
    config_dir: &str,
) -> Result<std::process::Child, (&'static str, String)> {
    let mut cmd = std::process::Command::new(crate::session::codex_program());
    cmd.arg("login");
    cmd.env("CODEX_HOME", config_dir);
    // A GUI-launched app inherits launchd's minimal PATH on macOS, not the login
    // shell's — so an npm-installed `codex` would be invisible here even though
    // it runs fine in a terminal. Same helper every `claude` spawn uses.
    if let Some(path) = crate::session::claude_path_env() {
        cmd.env("PATH", path);
    }
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    crate::session::no_window(&mut cmd);
    // **`null`, not `piped`.** Nothing here ever reads codex's output — the
    // browser is the UI — and a piped stream with no reader is not merely
    // wasteful, it is fatal: `codex login` announces "Starting local login
    // server on http://localhost:1455" on stdout the moment it starts, and once
    // this side drops the read end that write is a broken pipe. The process died
    // with a panic (exit 101) within a second, so the OAuth callback the browser
    // was then sent to had nothing listening on 1455 and the sign-in failed
    // AFTER the user had already authenticated on the web page.
    //
    // `null` discards the output without ever blocking or breaking, which is
    // what "we don't want codex's output in Francois' stdout" actually needs;
    // `piped` was the wrong instrument for that intent.
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            (
                "SPAWN_FAILED",
                "could not start codex — install it with `npm i -g @openai/codex`".to_string(),
            )
        } else {
            ("SPAWN_FAILED", format!("could not start codex login: {e}"))
        }
    })
}

/// Watch for `auth.json` and republish the account list when it appears, so the
/// row flips from *Sign in* to signed-in without the user reopening the modal.
///
/// **Owns the child.** Not just tidiness: holding it here is what reaps the
/// process instead of leaving a zombie (dropping a `Child` in std does NOT
/// wait), and it is what lets the loop stop the moment `codex login` exits
/// rather than polling a dead process for the full five minutes. The child
/// outliving this function is also why the handle must not be dropped at the
/// command — see `spawn_codex_login`'s note on stdio.
///
/// Best-effort otherwise: it holds no lock, owns no registry state, and its only
/// side effect is an event that recomputes what `account_list` would have
/// returned anyway. Giving up costs nothing — the next `account_list` derives
/// the same truth from the same file (FR-20).
pub(crate) fn start_codex_login_poller(
    app: &AppHandle,
    config_dir: String,
    mut child: std::process::Child,
) {
    let app = app.clone();
    std::thread::spawn(move || {
        let deadline = crate::session::now_ms() + LOGIN_TIMEOUT_SECS * 1_000;
        loop {
            std::thread::sleep(POLL);
            let signed_in = super::codex_auth_file_exists(&config_dir);
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

/// One tick of the login poll. Pure, so the ordering below is pinned by a test
/// rather than by reading the loop.
///
/// **`signed_in` is checked before `exited`, and that order is the whole point.**
/// `codex login` exits as soon as it has written `auth.json`, so the successful
/// case is very often "credential present AND process gone" in the same tick.
/// Testing liveness first would read that as a failed login and never publish —
/// the row would sit on "Sign in" until something else refreshed the list, for a
/// login that had in fact just succeeded.
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

/// FR-25: a re-login must not race a still-running one. `codex login` writes
/// `auth.json` atomically enough that two concurrent runs would not corrupt it,
/// but two browser tabs for the same row is a confusing UI, so the caller checks
/// this first.
pub(crate) fn codex_login_in_flight(state: &AccountState) -> bool {
    state.1.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::inner_fixture;

    #[test]
    fn a_codex_row_is_added_with_its_kind_and_no_endpoint() {
        let mut inner = inner_fixture(&[], "default");
        let account = apply_add_codex(
            &mut inner,
            "acct-1".into(),
            "/tmp/codex-home".into(),
            "Work ChatGPT".into(),
        );
        assert_eq!(account.id, "acct-1");
        assert_eq!(account.label, "Work ChatGPT");
        assert_eq!(account.kind, AccountKind::CodexCli);
        // FR-1 of multi-provider-endpoint: `endpoint` is present iff the kind is
        // OpenAiCompatible — the registry invariant drops any record that
        // violates it, so a Codex row carrying one would vanish on reload.
        assert!(account.endpoint.is_none());
        assert_eq!(inner.records.len(), 1);
        assert_eq!(inner.records[0].kind, AccountKind::CodexCli);
    }

    /// FR-21a: a brand-new Codex account is NOT signed in, and says so straight
    /// away rather than waiting for a turn to fail.
    #[test]
    fn a_fresh_codex_row_reports_signed_in_false() {
        let dir = std::env::temp_dir().join("francois-codex-acct-fresh");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut inner = inner_fixture(&[], "default");
        let account = apply_add_codex(
            &mut inner,
            "acct-1".into(),
            dir.to_string_lossy().into_owned(),
            "Work".into(),
        );
        assert_eq!(account.signed_in, Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// FR-20: derived from the file, so it flips the moment `codex login`
    /// finishes — and would flip back if the user ran `codex logout`.
    #[test]
    fn signed_in_follows_the_auth_file_rather_than_anything_persisted() {
        let dir = std::env::temp_dir().join("francois-codex-acct-auth");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut inner = inner_fixture(&[], "default");
        apply_add_codex(
            &mut inner,
            "acct-1".into(),
            dir.to_string_lossy().into_owned(),
            "Work".into(),
        );
        assert_eq!(find(&inner, "acct-1").signed_in, Some(false));

        std::fs::write(dir.join("auth.json"), r#"{"tokens":{}}"#).unwrap();
        assert_eq!(find(&inner, "acct-1").signed_in, Some(true));

        // …and back again. Nothing was persisted, so nothing goes stale.
        std::fs::remove_file(dir.join("auth.json")).unwrap();
        assert_eq!(find(&inner, "acct-1").signed_in, Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The field must not appear on rows it says nothing about — a Claude row
    /// with `signedIn: false` would render a Sign in action for the wrong CLI.
    #[test]
    fn only_codex_rows_carry_signed_in() {
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(AccountRecord {
            id: "claude-1".into(),
            label: "Personal".into(),
            email: None,
            organization: None,
            config_dir: "/tmp/claude-home".into(),
            created_at: 0,
            kind: AccountKind::ClaudeCodeOauth,
            endpoint: None,
        });
        apply_add_codex(
            &mut inner,
            "codex-1".into(),
            "/tmp/codex-home".into(),
            "Work".into(),
        );
        let list = build_list(&inner);
        // The built-in `default` row too.
        assert_eq!(find_in(&list, "default").signed_in, None);
        assert_eq!(find_in(&list, "claude-1").signed_in, None);
        assert!(find_in(&list, "codex-1").signed_in.is_some());
    }

    fn find(inner: &AccountInner, id: &str) -> Account {
        find_in(&build_list(inner), id)
    }

    // ---------- FR-25: the login poll ----------

    /// The regression that cost a real sign-in: `codex login` writes
    /// `auth.json` and exits immediately, so success routinely arrives as
    /// "credential present AND process gone" in one tick. Checking liveness
    /// first would call that a failure and never publish.
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
        // The user cancelled the browser flow, or codex failed. Nothing to
        // publish: the row still reads Sign in, which is the truth.
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
