//! The `codex exec` argv and the permission-mode → sandbox mapping
//! (multi-provider-codex FR-5..FR-7, FR-9). Pure: no process, no filesystem, no
//! `AppHandle` — the whole of this feature's command-line surface is decided
//! here and pinned by the tests below, the same way `claude_code::turn_args` is.
//!
//! **Both argv shapes were verified against a live `codex-cli` 0.147.0 on
//! 2026-08-17.** That matters more than usual here, because the fresh and the
//! resuming form are NOT the same flag set and the difference is not documented
//! anywhere except `--help`:
//!
//! - `codex exec` accepts `-C/--cd` and `-s/--sandbox`.
//! - `codex exec resume` accepts **neither**. Passing `--sandbox` there is a hard
//!   `error: unexpected argument`, which would break every follow-up turn while
//!   the first one worked — the worst possible failure shape. The sandbox goes
//!   through `-c sandbox_mode="…"` instead (verified working), which is what
//!   `-s` is sugar for, and the cwd comes from the spawned child's own working
//!   directory rather than a flag.

use crate::session::adapter::codex::codex_program;

/// FR-9: Codex's sandbox vocabulary. Mirrors `CodexSandbox` in
/// contract/multi-provider-codex.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Sandbox {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl Sandbox {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Sandbox::ReadOnly => "read-only",
            Sandbox::WorkspaceWrite => "workspace-write",
            Sandbox::DangerFullAccess => "danger-full-access",
        }
    }
}

/// FR-9: Francois' `permissionMode` → Codex's sandbox policy.
///
/// **Fail closed.** An unrecognised mode is `read-only`, matching the half
/// `multi-provider-openai`'s gate pins for the same reason: a mode string that
/// reaches here unrecognised means something upstream is wrong, and the safe
/// reading of "I don't know what you're allowed to do" is "not much".
///
/// `plan` maps to `read-only` rather than to anything weaker because Codex has
/// no plan mode of its own — read-only IS what plan mode means operationally
/// (look, don't touch), and it is enforced by the OS rather than by asking the
/// model nicely.
pub(super) fn sandbox_for(permission_mode: &str) -> Sandbox {
    match permission_mode {
        "acceptEdits" => Sandbox::WorkspaceWrite,
        "bypassPermissions" => Sandbox::DangerFullAccess,
        "default" | "plan" => Sandbox::ReadOnly,
        _ => Sandbox::ReadOnly,
    }
}

/// FR-5/FR-6: the argv for one turn, after the program name.
///
/// `resume` is the Codex `thread_id` from a previous turn's `thread.started`
/// (FR-8); `None` starts a fresh thread.
///
/// The prompt is NOT here. Codex reads its instructions from stdin when no
/// positional prompt is given, and the caller writes them there — which keeps
/// multi-line text, quotes and shell metacharacters out of argv entirely. Same
/// reasoning `claude -p` with no positional prompt already follows.
pub(super) fn turn_args(
    model_id: &str,
    resume: Option<&str>,
    effort: Option<&str>,
    permission_mode: &str,
) -> Vec<String> {
    let sandbox = sandbox_for(permission_mode);
    let mut args: Vec<String> = vec!["exec".into()];

    // `resume <thread_id>` is a SUBCOMMAND of exec and its positional must come
    // before the flags it accepts, so it goes on immediately.
    if let Some(thread_id) = resume {
        args.push("resume".into());
        args.push(thread_id.into());
    }

    args.push("--json".into());
    // Francois sessions are not required to sit in a git repo; Codex refuses to
    // run outside one unless told otherwise.
    args.push("--skip-git-repo-check".into());

    // FR-7: stated on EVERY invocation, never inherited from the user's
    // ~/.codex/config.toml. Their model providers and AGENTS.md are theirs; the
    // two settings that decide what Codex may do to the filesystem are ours.
    args.push("-c".into());
    args.push("approval_policy=\"never\"".into());

    if resume.is_some() {
        // `exec resume` rejects `-s` outright (verified) — the config override is
        // the only channel, and it is the same setting.
        args.push("-c".into());
        args.push(format!("sandbox_mode=\"{}\"", sandbox.as_str()));
    } else {
        args.push("-s".into());
        args.push(sandbox.as_str().into());
    }

    args.push("-m".into());
    args.push(model_id.into());

    if let Some(e) = effort {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort=\"{e}\""));
    }

    args
}

/// The full invocation, program included. Split from `turn_args` so the argv
/// tests do not have to know the program name, and so a future WSL/wrapper
/// variant has one place to change — mirroring `claude_invocation`.
pub(super) fn codex_invocation(
    model_id: &str,
    resume: Option<&str>,
    effort: Option<&str>,
    permission_mode: &str,
) -> (String, Vec<String>) {
    (
        codex_program(),
        turn_args(model_id, resume, effort, permission_mode),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    // ---------- FR-9: the sandbox mapping ----------

    #[test]
    fn every_permission_mode_maps_to_its_sandbox() {
        assert_eq!(sandbox_for("default"), Sandbox::ReadOnly);
        assert_eq!(sandbox_for("plan"), Sandbox::ReadOnly);
        assert_eq!(sandbox_for("acceptEdits"), Sandbox::WorkspaceWrite);
        assert_eq!(sandbox_for("bypassPermissions"), Sandbox::DangerFullAccess);
    }

    #[test]
    fn an_unrecognised_permission_mode_fails_closed_to_read_only() {
        // The whole point: a mode we do not understand must not widen access.
        assert_eq!(sandbox_for("yolo"), Sandbox::ReadOnly);
        assert_eq!(sandbox_for(""), Sandbox::ReadOnly);
        assert_eq!(sandbox_for("BYPASSPERMISSIONS"), Sandbox::ReadOnly);
    }

    #[test]
    fn sandbox_strings_are_codex_vocabulary() {
        assert_eq!(Sandbox::ReadOnly.as_str(), "read-only");
        assert_eq!(Sandbox::WorkspaceWrite.as_str(), "workspace-write");
        assert_eq!(Sandbox::DangerFullAccess.as_str(), "danger-full-access");
    }

    // ---------- FR-5: the fresh turn ----------

    #[test]
    fn a_fresh_turn_is_exec_json_with_no_positional_prompt() {
        let args = turn_args("gpt-5.6-terra", None, None, "default");
        assert_eq!(args[0], "exec");
        // No positional prompt: everything after the subcommand is a flag or a
        // flag's value. The prompt rides stdin (FR-5).
        assert_eq!(args[1], "--json");
        assert!(args.iter().any(|a| a == "--skip-git-repo-check"));
        assert!(pair(&args, "-s", "read-only"));
        assert!(pair(&args, "-m", "gpt-5.6-terra"));
        assert!(!args.iter().any(|a| a == "resume"));
    }

    #[test]
    fn a_fresh_turn_pins_the_approval_policy_rather_than_inheriting_it() {
        // FR-7: the user's own config.toml must not be able to make this
        // interactive — nothing could answer a prompt on this transport.
        let args = turn_args("gpt-5.6-terra", None, None, "acceptEdits");
        assert!(pair(&args, "-c", "approval_policy=\"never\""));
    }

    #[test]
    fn the_sandbox_flag_follows_the_permission_mode() {
        let args = turn_args("m", None, None, "acceptEdits");
        assert!(pair(&args, "-s", "workspace-write"));
        let args = turn_args("m", None, None, "bypassPermissions");
        assert!(pair(&args, "-s", "danger-full-access"));
    }

    // ---------- FR-6: the resuming turn ----------

    #[test]
    fn a_resuming_turn_names_the_thread_id_positionally_after_resume() {
        let args = turn_args("gpt-5.6-terra", Some("01a00f3d-6d04"), None, "default");
        assert_eq!(args[0], "exec");
        assert_eq!(args[1], "resume");
        assert_eq!(args[2], "01a00f3d-6d04");
        assert!(args.iter().any(|a| a == "--json"));
    }

    /// The regression that matters most in this file. `codex exec resume` does
    /// not accept `-s/--sandbox` — it exits `error: unexpected argument` — so a
    /// build that passed it would work on the FIRST turn of every session and
    /// fail on every turn after, which reads as "resume is broken" rather than
    /// "the flag is wrong". Verified against 0.147.0.
    #[test]
    fn a_resuming_turn_never_passes_the_sandbox_flag_resume_rejects() {
        let args = turn_args("m", Some("t1"), None, "acceptEdits");
        assert!(!args.iter().any(|a| a == "-s" || a == "--sandbox"));
        assert!(!args.iter().any(|a| a == "-C" || a == "--cd"));
        // …but the sandbox is still applied, through the channel resume accepts.
        assert!(pair(&args, "-c", "sandbox_mode=\"workspace-write\""));
    }

    #[test]
    fn resume_still_pins_the_approval_policy() {
        let args = turn_args("m", Some("t1"), None, "default");
        assert!(pair(&args, "-c", "approval_policy=\"never\""));
        assert!(pair(&args, "-c", "sandbox_mode=\"read-only\""));
    }

    #[test]
    fn both_forms_apply_the_same_sandbox_for_the_same_mode() {
        // The two argv shapes differ in FLAG, never in effect — if these ever
        // diverge, a session's permissions would change on its second turn.
        for mode in [
            "default",
            "plan",
            "acceptEdits",
            "bypassPermissions",
            "nonsense",
        ] {
            let fresh = turn_args("m", None, None, mode);
            let resumed = turn_args("m", Some("t1"), None, mode);
            let want = sandbox_for(mode).as_str();
            assert!(
                pair(&fresh, "-s", want),
                "fresh turn for {mode} should carry -s {want}: {fresh:?}"
            );
            assert!(
                pair(&resumed, "-c", &format!("sandbox_mode=\"{want}\"")),
                "resumed turn for {mode} should carry sandbox_mode={want}: {resumed:?}"
            );
        }
    }

    // ---------- effort ----------

    #[test]
    fn effort_rides_a_config_override_and_is_omitted_when_absent() {
        let args = turn_args("m", None, Some("high"), "default");
        assert!(pair(&args, "-c", "model_reasoning_effort=\"high\""));
        let args = turn_args("m", None, None, "default");
        assert!(!args.iter().any(|a| a.starts_with("model_reasoning_effort")));
    }

    /// The program is whatever `codex_program()` resolved — a full path to
    /// `codex.exe`/`codex.cmd` on Windows, the bare name elsewhere. Asserting
    /// the resolver's output rather than a literal, because pinning `"codex"`
    /// here is exactly the assumption that produced a `NotFound` on a machine
    /// where codex was installed (npm ships shims, not an exe, on Windows).
    #[test]
    fn the_invocation_names_the_resolved_codex_binary() {
        let (program, args) = codex_invocation("m", None, None, "default");
        assert_eq!(program, codex_program());
        assert!(
            std::path::Path::new(&program)
                .file_stem()
                .is_some_and(|s| s.eq_ignore_ascii_case("codex")),
            "whatever it resolves to must still BE codex: {program}"
        );
        assert_eq!(args[0], "exec");
        // Never an extensionless bare name on Windows — that is the bug.
        if cfg!(windows) && program.contains(std::path::MAIN_SEPARATOR) {
            assert!(
                std::path::Path::new(&program).extension().is_some(),
                "a resolved Windows path must carry its extension: {program}"
            );
        }
    }
}
