//! Native Codex App Server session adapter and retained read-model probes.

mod args;
mod catalog;
pub(crate) mod models;
pub(crate) use catalog::{get as model_catalog, invalidate as invalidate_catalog};
mod runner;
mod translate;
pub(crate) mod usage;
mod wire;

mod native;
pub(crate) fn session_runtime() -> std::sync::Arc<dyn crate::session::application::SessionRuntime> {
    native::session_runtime()
}

use crate::ipc::{AppError, ErrorCode};
use crate::session::application::{TurnContext, TurnControl};
#[cfg(test)]
use crate::session::{AgentRuntime, SessionAdapter};

use std::sync::Arc;

// core-architecture-wave3 FR-9: the name and the program resolver moved to
// `process_util`, beside the PATH scan they were already delegating to — so
// `account/codex.rs` can ask "which file is codex?" without naming the session
// engine. Re-exported: every existing `codex_program()` / `CODEX_BIN` reference,
// here and in `crate::session`, resolves unchanged.
#[allow(unused_imports)] // CODEX_BIN is named by this module's own tests
pub use crate::process_util::{codex_program, CODEX_BIN};

/// FR-7 §7: what a user sees when the CLI is not installed. Names the package,
/// because "could not start codex" alone sends people to the wrong search.
const CODEX_MISSING_HINT: &str =
    "could not start codex — install it with `npm i -g @openai/codex`, then sign in from the Accounts modal";

pub struct CodexAdapter;

impl crate::session::application::RuntimePort for CodexAdapter {
    fn preflight(&self, ctx: &TurnContext) -> Result<(), AppError> {
        if !ctx.execution.account_authenticated {
            return Err(AppError::new(ErrorCode::AccountNotAuthenticated, "this session's account is not signed in to Codex — use Sign in in the Accounts modal"));
        }
        Ok(())
    }
    fn begin_turn(
        &self,
        ctx: TurnContext,
        sink: Arc<dyn crate::session::application::RuntimeEventSink>,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        let _ = (ctx, sink);
        Err(AppError::new(
            ErrorCode::RuntimeUnsupported,
            "Codex turns require a session-owned native connection",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_adapter_reports_its_runtime() {
        assert_eq!(CodexAdapter.agent_runtime(), AgentRuntime::Codex);
    }

    /// §7: the resolver must never hand back a bare, extensionless name on
    /// Windows when a shim exists — `Command::new("codex")` fails with
    /// `NotFound` there (Rust appends `.exe` only), which surfaced to a user as
    /// "install it with npm i -g @openai/codex" on a machine where codex was
    /// installed and working in every terminal.
    #[test]
    fn the_resolved_program_is_runnable_or_honestly_absent() {
        let program = codex_program();
        assert!(program.to_lowercase().contains("codex"));
        // Stable across calls — the login spawn and the turn spawn must not be
        // able to resolve differently.
        assert_eq!(program, codex_program());

        if cfg!(windows) {
            let found_on_path = std::env::var_os("PATH")
                .map(|path| {
                    std::env::split_paths(&path).any(|dir| {
                        ["codex.exe", "codex.cmd", "codex.bat"]
                            .iter()
                            .any(|n| dir.join(n).is_file())
                    })
                })
                .unwrap_or(false);
            if found_on_path {
                // Resolved: an absolute path carrying a real extension.
                let p = std::path::Path::new(&program);
                assert!(p.is_file(), "resolved to something that exists: {program}");
                assert!(
                    p.extension().is_some(),
                    "and to a form CreateProcessW can launch: {program}"
                );
            } else {
                // Not installed: fall back to the bare name so the spawn fails
                // with NotFound and the "install it" message is then TRUE.
                assert_eq!(program, CODEX_BIN);
            }
        } else {
            assert_eq!(program, CODEX_BIN);
        }
    }
}
