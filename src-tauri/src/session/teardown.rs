//! core-architecture-wave3 FR-9 — the `session ↔ shell` inversion.
//!
//! Removing a session has to release what other domains hold for it. The PTYs
//! are the case that mattered: `session_remove` must not leave an orphan shell
//! running, so it called `shell::dispose_session_shells`.
//!
//! That call used to be laundered through a crate-root re-export
//! (`pub(crate) use shell::dispose_session_shells;` in `lib.rs`, with a comment
//! saying it let `session` call it "without depending on the shell module
//! directly"). It did no such thing: it moved the import path and left the
//! coupling exactly where it was — `session` still could not be reasoned about,
//! or compiled, without `shell`.
//!
//! The inversion is the ordinary one. `session` declares what it needs done and
//! knows nothing about who does it; `shell` implements that and depends on
//! `session`, which it already did. The crate root — the one place that
//! legitimately knows about both — wires them together at startup.
//!
//! **No new lock edge** (FR-9's constraint): the hook list is a `OnceLock`
//! written once during `.setup()` and only ever read afterwards, so it adds no
//! mutex to the documented hierarchy. Each hook takes its own domain's lock, as
//! it did when it was called directly.

use std::sync::OnceLock;
use tauri::AppHandle;

/// A domain that holds per-session resources and can release them.
///
/// `dispose_session` returns how many resources it released, matching what
/// `dispose_session_shells` has always returned — nothing branches on it, but a
/// hook that silently released nothing and one that had nothing to release are
/// worth telling apart from a log.
pub trait SessionTeardown: Send + Sync {
    fn dispose_session(&self, app: &AppHandle, session_id: &str) -> usize;
}

static HOOKS: OnceLock<Vec<Box<dyn SessionTeardown>>> = OnceLock::new();

/// Register the teardown hooks. Called ONCE, from the crate root's `.setup()`,
/// before any command can run. A second call is ignored rather than a panic:
/// there is exactly one caller, and a startup panic is a worse failure than a
/// duplicate registration that could only come from a future second caller.
pub fn register_teardown(hooks: Vec<Box<dyn SessionTeardown>>) {
    let _ = HOOKS.set(hooks);
}

/// Release every registered domain's resources for `session_id`. Returns the
/// total released.
///
/// Zero when nothing is registered — which is the case in every unit test and
/// is correct there: a test that never started a PTY has no PTY to orphan.
pub fn dispose_session_resources(app: &AppHandle, session_id: &str) -> usize {
    HOOKS
        .get()
        .map(|hooks| {
            hooks
                .iter()
                .map(|hook| hook.dispose_session(app, session_id))
                .sum()
        })
        .unwrap_or(0)
}

/// core-architecture-wave3 FR-9, the other half: `account_remove`'s side-effect
/// on sessions, arriving as a notification instead of as a direct call into this
/// domain. `reassign_account_sessions` is unchanged — only who reaches it is.
pub struct SessionAccountObserver;

impl crate::account::AccountRemovalObserver for SessionAccountObserver {
    fn account_removed(&self, app: &AppHandle, account_id: &str) -> Vec<String> {
        super::reassign_account_sessions(app, account_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The seam itself, without an `AppHandle`: registration is the only piece
    /// with state, and the only piece that can silently be forgotten.
    ///
    /// This is the ONLY test that touches `HOOKS` — the `OnceLock` is
    /// process-global, so a second test registering its own hooks would make
    /// both non-deterministic under the parallel runner.
    #[test]
    fn registration_is_once_and_the_second_call_is_ignored() {
        struct Noop;
        impl SessionTeardown for Noop {
            fn dispose_session(&self, _app: &AppHandle, _session_id: &str) -> usize {
                0
            }
        }
        register_teardown(vec![Box::new(Noop)]);
        assert_eq!(HOOKS.get().map(|h| h.len()), Some(1));
        register_teardown(vec![Box::new(Noop), Box::new(Noop)]);
        assert_eq!(
            HOOKS.get().map(|h| h.len()),
            Some(1),
            "a second registration must not replace the wiring the app booted with"
        );
    }
}
