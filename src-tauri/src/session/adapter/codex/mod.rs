//! `CodexAdapter` — the third `SessionAdapter` (multi-provider-codex FR-3).
//!
//! Where `ClaudeCodeAdapter` wraps a CLI that owns its loop, and `OpenAiAdapter`
//! *is* a loop, this wraps a **different** CLI that owns its own:
//! `codex exec --json`. That similarity to the Claude adapter is the point — the
//! seam was built so a second loop-owning runner costs an argv builder, a line
//! parser and a translation table, not an engine change.
//!
//! Three things make it genuinely different from the Claude path, and each shows
//! up as an absence rather than a workaround:
//!
//! 1. **No control channel.** `codex exec` takes its prompt on stdin and stdin
//!    then closes. There is nothing to write an approval or a question answer
//!    back into, so `CodexTurnHandle` carries no pending maps and no `ChildStdin`
//!    (FR-10), and enforcement is the sandbox `permissionMode` picks (FR-9).
//! 2. **No text deltas.** `agent_message` arrives whole in one `item.completed`,
//!    so a reply is finalized in one step instead of streamed. Tool activity is
//!    still live.
//! 3. **No model fetch.** The catalog is Codex's own on-disk cache (`models.rs`).
//!
//! Module shape follows the domain convention: the model and the adapter here,
//! one concern per child (`args` · `wire` · `models` · `runner`).

mod args;
mod models;
mod runner;
mod translate;
mod wire;

use super::*;
use crate::ipc::{AppError, ErrorCode};
use crate::session::*;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

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

/// FR-10: the live turn. A `Child` and an interrupt flag, and **deliberately
/// nothing else** — every other `TurnControl` member answers "nothing is
/// pending", because on this transport nothing ever can be.
pub struct CodexTurnHandle {
    child: Arc<Mutex<std::process::Child>>,
    interrupted: Arc<AtomicBool>,
}

impl TurnControl for CodexTurnHandle {
    fn interrupt(&self) {
        // Codex has no interrupt protocol over this transport and stdin is
        // already closed, so the flag is what the reader checks to stop
        // translating; `kill` is what actually ends the child.
        self.interrupted
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    /// FR-10. Not "unimplemented": on a Codex session no question is ever asked,
    /// so no id can ever be pending, and `NotPending` is the correct — not the
    /// placeholder — answer. `session_answer_question` already maps it to
    /// `QUESTION_NOT_PENDING`.
    fn answer_question(&self, _id: &str, _answers: &serde_json::Value) -> ControlAck {
        ControlAck::NotPending
    }

    /// FR-10, same reasoning: enforcement is the sandbox (FR-9), so no approval
    /// card exists to decide.
    fn decide_permission(&self, _id: &str, _decision: PermissionDecision) -> ControlAck {
        ControlAck::NotPending
    }

    /// FR-10. `None` is also the authorization gate on a rule write
    /// (permission-guardrails FR-7) — a Codex session must never be able to
    /// author an `*Always` rule, since it has no ask to authorize one.
    fn pending_permission_pattern(&self, _id: &str) -> Option<String> {
        None
    }

    /// FR-10: a Codex session never parks, so `refresh_parked_status` derives
    /// "not waiting" from this with no special case anywhere.
    fn pending_counts(&self) -> PendingCounts {
        PendingCounts::default()
    }

    fn drain_pending(&self) -> (Vec<String>, Vec<String>) {
        (Vec::new(), Vec::new())
    }
}

impl SessionAdapter for CodexAdapter {
    fn agent_runtime(&self) -> AgentRuntime {
        AgentRuntime::Codex
    }

    /// FR-20: signed in iff the account's `CODEX_HOME` holds an `auth.json` —
    /// derived, never persisted, mirroring `identity_file_exists` for Claude
    /// accounts. Same error code and same `mark_auth_failed` side effect as the
    /// Claude adapter; only the copy names Codex.
    fn preflight(&self, app: &tauri::AppHandle, ctx: &TurnContext) -> Result<(), AppError> {
        let config_dir = crate::account::config_dir_of(app, &ctx.account_id);
        if let Some(dir) = config_dir.as_deref() {
            if !crate::account::codex_auth_file_exists(dir) {
                crate::account::mark_auth_failed(app, &ctx.account_id);
                return Err(AppError {
                    code: ErrorCode::AccountNotAuthenticated,
                    message: "this session's account is not signed in to Codex — use Sign in in the Accounts modal"
                        .into(),
                    detail: None,
                });
            }
        }
        Ok(())
    }

    fn begin_turn(
        &self,
        app: &tauri::AppHandle,
        ctx: TurnContext,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        runner::begin_turn(app, ctx)
    }

    /// FR-17: Codex's own `models_cache.json`, under the account's `CODEX_HOME`.
    fn models(&self, app: &tauri::AppHandle, account_id: &str) -> Vec<ModelInfo> {
        let config_dir = crate::account::config_dir_of(app, account_id);
        models::catalog_for_home(config_dir.as_deref().map(std::path::Path::new))
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

    /// FR-10 as a whole, on the real handle rather than on a fake: a Codex turn
    /// answers "nothing pending" to every control question. If any of these ever
    /// starts returning `Applied`, a card was created that nothing can resolve
    /// and the session would park forever.
    #[test]
    fn a_codex_turn_never_has_anything_pending() {
        let handle = CodexTurnHandle {
            // A process that is already finished — this test never touches it,
            // and `kill` on a dead child is a no-op by design.
            child: Arc::new(Mutex::new(
                crate::process_util::spawn(if cfg!(windows) { "cmd" } else { "true" })
                    .args(if cfg!(windows) {
                        vec!["/C", "exit"]
                    } else {
                        vec![]
                    })
                    .start()
                    .expect("spawns a trivial process"),
            )),
            interrupted: Arc::new(AtomicBool::new(false)),
        };

        assert_eq!(handle.pending_counts().questions, 0);
        assert_eq!(handle.pending_counts().permissions, 0);
        assert_eq!(
            handle.answer_question("b1", &serde_json::json!({})),
            ControlAck::NotPending
        );
        assert_eq!(
            handle.decide_permission("b1", PermissionDecision::Allow),
            ControlAck::NotPending
        );
        // permission-guardrails FR-7: no ask ⇒ no authorization to write a rule.
        assert_eq!(handle.pending_permission_pattern("b1"), None);
        assert_eq!(handle.drain_pending(), (Vec::new(), Vec::new()));

        handle.interrupt();
        assert!(handle.interrupted.load(std::sync::atomic::Ordering::SeqCst));
        handle.kill();
    }
}
