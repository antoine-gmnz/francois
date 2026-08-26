//! `GrokAdapter` — the fourth `SessionAdapter` (multi-provider-grok FR-3).
//!
//! Structurally this is `CodexAdapter` again — a vendor CLI, a relocatable
//! config home (`GROK_HOME`), a non-interactive turn, sandbox-as-enforcement —
//! and it deliberately reuses that shape (§1 of the spec). Two differences,
//! each an absence-or-addition rather than a workaround:
//!
//! 1. **Real text deltas.** `codex exec --json` hands back a whole
//!    `agent_message` in one `item.completed`; Grok's `streaming-json` streams
//!    `{"type":"text","data":"…"}` chunks, so a reply types itself in (FR-14).
//! 2. **The session id is ours from turn one.** Codex mints its own
//!    `thread_id` on `thread.started` and we capture it; Grok's `-s
//!    <uuid>`/`--resume <uuid>` both take OUR `SessionId` directly (FR-8), so
//!    there is no anchor to capture at all — `claude_session_id` is set once,
//!    up front, and never re-derived from the stream.
//!
//! **Wire format — reconciled against the real CLI, not the frozen contract
//! (build-step FR-11).** `grok` 1.0.5 (`@xai-official/grok`) was installed and
//! runnable in this environment, but no xAI account/API key was available to
//! authenticate a real turn — `grok -p … --output-format streaming-json`
//! reaches the model and never completes one. Two things WERE verified live,
//! against the real binary:
//!
//! - An unauthenticated invocation still emits real `streaming-json` NDJSON on
//!   stdout before failing: `{"type":"error","message":"Not signed in. …"}` —
//!   a flat `type`-tagged object, NOT the JSON-RPC 2.0 / ACP envelope
//!   (`{"jsonrpc":"2.0","method":"session/update",…}`) `contract/
//!   multi-provider-grok.ts` assumes throughout. That contract was authored
//!   PROVISIONAL, from docs.x.ai and the ACP standard, before this CLI was
//!   installed — the two disagree on the top-level envelope, and this parser
//!   follows the real binary.
//! - `grok --help` / `grok agent --help` confirm the flag surface `args.rs`
//!   documents (`-s` mints a NEW session only; `--resume` is the follow-up
//!   verb; `--sandbox`/`--always-approve`/`--no-auto-update` are all real).
//!
//! For the event vocabulary itself (`text`/`tool_call`/`tool_call_update`/
//! `usage`/`end`/`error`), this parser follows `grok`'s OWN bundled
//! documentation shipped inside the installed CLI's `GROK_HOME`
//! (`~/.grok/docs/user-guide/14-headless-mode.md`, xAI's committed reference
//! for exactly this build) rather than the frozen contract's ACP-JSON-RPC
//! guess — see `wire.rs`'s module doc for the full reconciliation and
//! `fixtures/exec_turn.jsonl` for its provenance. **This is reported as a
//! spec/contract finding in the handoff, not silently coded around** (FR-11).

mod args;
mod models;
mod runner;
mod wire;

use super::*;
use crate::ipc::{AppError, ErrorCode};
use crate::session::*;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

// core-architecture-wave3 FR-9: moved to `process_util` alongside
// `codex_program`, for the reason documented there. Re-exported, so nothing
// that already says `grok_program()` or `GROK_BIN` changes.
#[allow(unused_imports)] // GROK_BIN is named by this module's own tests
pub use crate::process_util::{grok_program, GROK_BIN};

/// FR-24: what a user sees when the CLI is not installed.
const GROK_MISSING_HINT: &str =
    "could not start grok — install it with `npm i -g @xai-official/grok`, then sign in from the Accounts modal";

pub struct GrokAdapter;

/// FR-10: the live turn. A `Child` and an interrupt flag, and deliberately
/// nothing else — `grok -p` is one-shot and non-interactive (`--always-approve`
/// on every invocation, FR-6), so nothing on this transport is ever pending.
pub struct GrokTurnHandle {
    child: Arc<Mutex<std::process::Child>>,
    interrupted: Arc<AtomicBool>,
}

impl TurnControl for GrokTurnHandle {
    fn interrupt(&self) {
        self.interrupted
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    /// FR-10: no ask is ever asked on this transport (§2 non-goal), so no id
    /// can ever be pending.
    fn answer_question(&self, _id: &str, _answers: &serde_json::Value) -> ControlAck {
        ControlAck::NotPending
    }

    /// FR-10, same reasoning: enforcement is the sandbox (FR-9).
    fn decide_permission(&self, _id: &str, _decision: PermissionDecision) -> ControlAck {
        ControlAck::NotPending
    }

    /// `None` is also the authorization gate on a rule write
    /// (permission-guardrails FR-7) — a Grok session must never author an
    /// `*Always` rule, since it has no ask to authorize one.
    fn pending_permission_pattern(&self, _id: &str) -> Option<String> {
        None
    }

    fn pending_counts(&self) -> PendingCounts {
        PendingCounts::default()
    }

    fn drain_pending(&self) -> (Vec<String>, Vec<String>) {
        (Vec::new(), Vec::new())
    }
}

impl SessionAdapter for GrokAdapter {
    fn agent_runtime(&self) -> AgentRuntime {
        AgentRuntime::Grok
    }

    /// FR-23: signed in iff the account's `GROK_HOME` holds an `auth.json` —
    /// derived, never persisted, mirroring the Codex adapter's preflight.
    fn preflight(&self, app: &tauri::AppHandle, ctx: &TurnContext) -> Result<(), AppError> {
        let config_dir = crate::account::config_dir_of(app, &ctx.account_id);
        if let Some(dir) = config_dir.as_deref() {
            if !crate::account::grok_auth_file_exists(dir) {
                crate::account::mark_auth_failed(app, &ctx.account_id);
                return Err(AppError {
                    code: ErrorCode::AccountNotAuthenticated,
                    message: "this session's account is not signed in to Grok — use Sign in in the Accounts modal"
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

    /// FR-25: `$GROK_HOME/config.toml`'s `[models]`/`[model."<id>"]` catalog,
    /// falling back to xAI's static default list.
    fn models(&self, app: &tauri::AppHandle, account_id: &str) -> Vec<ModelInfo> {
        let config_dir = crate::account::config_dir_of(app, account_id);
        models::catalog_for_home(config_dir.as_deref().map(std::path::Path::new))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_adapter_reports_its_runtime() {
        assert_eq!(GrokAdapter.agent_runtime(), AgentRuntime::Grok);
    }

    /// Same regression `codex_program`'s test guards against: the resolver
    /// must never hand back a bare, extensionless name on Windows when a shim
    /// exists.
    #[test]
    fn the_resolved_program_is_runnable_or_honestly_absent() {
        let program = grok_program();
        assert!(program.to_lowercase().contains("grok"));
        assert_eq!(program, grok_program());

        if cfg!(windows) {
            let found_on_path = std::env::var_os("PATH")
                .map(|path| {
                    std::env::split_paths(&path).any(|dir| {
                        ["grok.exe", "grok.cmd", "grok.bat"]
                            .iter()
                            .any(|n| dir.join(n).is_file())
                    })
                })
                .unwrap_or(false);
            if found_on_path {
                let p = std::path::Path::new(&program);
                assert!(p.is_file(), "resolved to something that exists: {program}");
                assert!(
                    p.extension().is_some(),
                    "and to a form CreateProcessW can launch: {program}"
                );
            } else {
                assert_eq!(program, GROK_BIN);
            }
        } else {
            assert_eq!(program, GROK_BIN);
        }
    }

    /// FR-10 as a whole, on the real handle: a Grok turn answers "nothing
    /// pending" to every control question.
    #[test]
    fn a_grok_turn_never_has_anything_pending() {
        let handle = GrokTurnHandle {
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
        assert_eq!(handle.pending_permission_pattern("b1"), None);
        assert_eq!(handle.drain_pending(), (Vec::new(), Vec::new()));

        handle.interrupt();
        assert!(handle.interrupted.load(std::sync::atomic::Ordering::SeqCst));
        handle.kill();
    }
}
