//! The `grok` argv and the permission-mode → sandbox mapping (multi-provider-grok
//! FR-5..FR-9). Pure: no process, no filesystem, no `AppHandle` — same shape as
//! `codex::args`.
//!
//! **Reconciled against the real CLI (build-step FR-11), not the spec's
//! provisional argv table.** `grok --help` and the bundled
//! `docs/user-guide/14-headless-mode.md` (installed grok 1.0.5,
//! `@xai-official/grok`) were both read live in this environment. Three
//! things the spec's table got wrong:
//!
//! - **The prompt is a flag VALUE, not stdin.** `-p, --single <PROMPT>` (long
//!   form `--single`) takes the prompt as its argument; `--help` shows it as a
//!   required value, and "Headless mode does not read piped stdin into the
//!   prompt" is explicit in the docs. This is still safe against shell
//!   injection/quoting the way the spec's stdin design was aiming for: `Command`
//!   passes argv elements straight to `CreateProcess`/`execve` with no shell in
//!   between, so multi-line text, quotes, and metacharacters all ride the
//!   argument verbatim regardless of which channel carries them.
//! - **`-s`/`--session-id` mints a NEW session only — it errors on an id that
//!   already exists.** Per `--help`: "Does not resume existing sessions — use
//!   `--resume`/`--continue` instead." So FR-8's "same argv on every turn"
//!   assumption doesn't hold: this is the exact trap `codex exec`/`codex exec
//!   resume` set (FR-11(1) called it), and the fix is the same shape — `-s
//!   <id>` on the FIRST turn, `--resume <id>` on every turn after, both naming
//!   Francois' own `SessionId` (never a foreign/captured one, so there is no
//!   separate anchor to lose — `grok/mod.rs`'s doc explains why).
//! - **`--cwd <PATH>` is a real flag**, documented for headless mode with no
//!   fresh/resume distinction. This module still sets the child's OWN working
//!   directory (`Command::current_dir`, in `runner.rs`) rather than passing
//!   `--cwd` — matching `codex`'s precedent of preferring the process-level
//!   mechanism, which cannot have a resume-only flag-compat trap because it
//!   is not a CLI flag at all.
//!
//! `--always-approve`, `--no-auto-update` and `--sandbox <PROFILE>` are all
//! confirmed real (the sandbox profile names — `off`/`workspace`/`devbox`/
//! `read-only`/`strict` — match `docs/user-guide/18-sandbox.md` exactly, which
//! is what FR-9's table already assumed).

use crate::session::adapter::grok::grok_program;

/// FR-9: Grok's sandbox vocabulary. Mirrors `GrokSandbox` in
/// contract/multi-provider-grok.ts — confirmed against the CLI's own sandbox
/// docs, so this part of the provisional contract needed no correction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Sandbox {
    Off,
    Workspace,
    ReadOnly,
    /// FR-9: named for contract completeness (`GrokSandbox` carries all five
    /// xAI profiles) but never SELECTED by `sandbox_for` — a container-only
    /// profile with no Francois `permissionMode` equivalent.
    #[allow(dead_code)]
    Devbox,
    /// FR-9: same reasoning as `Devbox` — adds child-network restriction no
    /// `permissionMode` expresses. Naming it here (rather than omitting it)
    /// is how a reader knows it was considered, not missed.
    #[allow(dead_code)]
    Strict,
}

impl Sandbox {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Sandbox::Off => "off",
            Sandbox::Workspace => "workspace",
            Sandbox::ReadOnly => "read-only",
            Sandbox::Devbox => "devbox",
            Sandbox::Strict => "strict",
        }
    }
}

/// FR-9: Francois' `permissionMode` → Grok's sandbox profile.
///
/// **Fail closed.** An unrecognised mode is `read-only`, matching `codex`'s
/// identical gate for the identical reason: a mode string that reaches here
/// unrecognised means something upstream is wrong, and "I don't know what
/// you're allowed to do" reads safely as "not much". `devbox` and `strict`
/// (beyond the fail-closed default) are named in the spec but never selected
/// by a `permissionMode` — `devbox` is a container-only profile with no
/// Francois equivalent, and `strict` adds child-network restriction no mode
/// expresses; `strict` IS reachable, but only as the fail-closed default,
/// never as `strict`'s own row (`plan` maps to `read-only`, not `strict`,
/// matching the spec's table exactly).
pub(super) fn sandbox_for(permission_mode: &str) -> Sandbox {
    match permission_mode {
        "acceptEdits" => Sandbox::Workspace,
        "bypassPermissions" => Sandbox::Off,
        "default" | "plan" => Sandbox::ReadOnly,
        _ => Sandbox::ReadOnly,
    }
}

/// FR-5/FR-8: the argv for one turn, after the program name. `session_id` is
/// ALWAYS Francois' own `SessionId` (never a foreign/vendor-minted one) —
/// `resume` only selects which flag carries it.
pub(super) fn turn_args(
    prompt: &str,
    model_id: &str,
    session_id: &str,
    resume: bool,
    permission_mode: &str,
) -> Vec<String> {
    let sandbox = sandbox_for(permission_mode);
    let mut args: Vec<String> = vec!["-p".into(), prompt.into()];
    args.push("--output-format".into());
    args.push("streaming-json".into());

    // FR-8: `-s` mints a NEW session and errors if the id already exists;
    // `--resume` is the only verb that continues one. Same id either way.
    if resume {
        args.push("--resume".into());
    } else {
        args.push("-s".into());
    }
    args.push(session_id.into());

    args.push("-m".into());
    args.push(model_id.into());

    // FR-9: pinned on every invocation so the user's own config.toml cannot
    // silently widen it.
    args.push("--sandbox".into());
    args.push(sandbox.as_str().into());

    // FR-6/FR-7: on every invocation, no exceptions.
    args.push("--always-approve".into());
    args.push("--no-auto-update".into());

    args
}

/// The full invocation, program included — mirrors `codex_invocation`.
pub(super) fn grok_invocation(
    prompt: &str,
    model_id: &str,
    session_id: &str,
    resume: bool,
    permission_mode: &str,
) -> (String, Vec<String>) {
    (
        grok_program(),
        turn_args(prompt, model_id, session_id, resume, permission_mode),
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
        assert_eq!(sandbox_for("acceptEdits"), Sandbox::Workspace);
        assert_eq!(sandbox_for("bypassPermissions"), Sandbox::Off);
    }

    #[test]
    fn an_unrecognised_permission_mode_fails_closed_to_read_only() {
        assert_eq!(sandbox_for("yolo"), Sandbox::ReadOnly);
        assert_eq!(sandbox_for(""), Sandbox::ReadOnly);
        assert_eq!(sandbox_for("BYPASSPERMISSIONS"), Sandbox::ReadOnly);
    }

    #[test]
    fn sandbox_strings_are_groks_vocabulary() {
        assert_eq!(Sandbox::Off.as_str(), "off");
        assert_eq!(Sandbox::Workspace.as_str(), "workspace");
        assert_eq!(Sandbox::ReadOnly.as_str(), "read-only");
        assert_eq!(Sandbox::Devbox.as_str(), "devbox");
        assert_eq!(Sandbox::Strict.as_str(), "strict");
    }

    // ---------- FR-5: the fresh turn ----------

    #[test]
    fn a_fresh_turn_carries_the_prompt_as_a_flag_value_and_mints_the_session() {
        let args = turn_args(
            "list the files here",
            "grok-4.6",
            "sess-1",
            false,
            "default",
        );
        assert!(pair(&args, "-p", "list the files here"));
        assert!(pair(&args, "--output-format", "streaming-json"));
        assert!(pair(&args, "-s", "sess-1"));
        assert!(!args.iter().any(|a| a == "--resume"));
        assert!(pair(&args, "-m", "grok-4.6"));
        assert!(pair(&args, "--sandbox", "read-only"));
        assert!(args.iter().any(|a| a == "--always-approve"));
        assert!(args.iter().any(|a| a == "--no-auto-update"));
    }

    // ---------- FR-8: the resuming turn ----------

    #[test]
    fn a_resuming_turn_uses_resume_never_session_id_for_the_same_id() {
        // The regression that matters most in this file: `-s` on a second turn
        // errors "already in use" against the real CLI — this must never happen.
        let args = turn_args("continue", "grok-4.6", "sess-1", true, "acceptEdits");
        assert!(!args.iter().any(|a| a == "-s"));
        assert!(pair(&args, "--resume", "sess-1"));
        assert!(pair(&args, "--sandbox", "workspace"));
    }

    #[test]
    fn both_forms_apply_the_same_sandbox_for_the_same_mode() {
        for mode in [
            "default",
            "plan",
            "acceptEdits",
            "bypassPermissions",
            "nonsense",
        ] {
            let fresh = turn_args("hi", "m", "s1", false, mode);
            let resumed = turn_args("hi", "m", "s1", true, mode);
            let want = sandbox_for(mode).as_str();
            assert!(pair(&fresh, "--sandbox", want), "{mode}: {fresh:?}");
            assert!(pair(&resumed, "--sandbox", want), "{mode}: {resumed:?}");
        }
    }

    #[test]
    fn no_positional_prompt_leaks_into_argv_unescaped() {
        // Multi-line text and shell metacharacters ride the -p VALUE untouched —
        // Command never invokes a shell, so this is safe either way, but the
        // value must still be exactly what was passed, not split on whitespace.
        let text = "line one\nline two `rm -rf /` $HOME";
        let args = turn_args(text, "m", "s1", false, "default");
        assert_eq!(args[0], "-p");
        assert_eq!(args[1], text);
    }

    #[test]
    fn the_invocation_names_the_resolved_grok_binary() {
        let (program, args) = grok_invocation("hi", "m", "s1", false, "default");
        assert_eq!(program, grok_program());
        assert!(
            std::path::Path::new(&program)
                .file_stem()
                .is_some_and(|s| s.eq_ignore_ascii_case("grok")),
            "whatever it resolves to must still BE grok: {program}"
        );
        assert_eq!(args[0], "-p");
        if cfg!(windows) && program.contains(std::path::MAIN_SEPARATOR) {
            assert!(
                std::path::Path::new(&program).extension().is_some(),
                "a resolved Windows path must carry its extension: {program}"
            );
        }
    }
}
