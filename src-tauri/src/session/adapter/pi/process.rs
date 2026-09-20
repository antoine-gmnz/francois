//! session/adapter/pi/process.rs — FR-1/FR-7/FR-10: turning a
//! `RuntimeConnectContext` into a running, certified Pi child. `discovery`
//! (pi-runtime-distribution) already answers "is a compatible Pi installed
//! and where" — this module only spends that answer: resolve the certified
//! path, build the baseline-locked-down argv, spawn it through
//! `process_util`'s facade (login-shell PATH, `CREATE_NO_WINDOW`, its own
//! process group so `process_util::kill_tree` can reach grandchildren), and
//! hand the dispatcher plain `Read`/`Write` handles plus a `wait`/`kill` pair
//! — it never sees a `Child` itself.

use crate::ipc::{AppError, ErrorCode};
use crate::session::adapter::RuntimeConnectContext;
use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// FR-2/FR-8: the sanitized stderr ring's cap. Diagnostics only — never the
/// stdout wire protocol, and never surfaced to the frontend verbatim.
const STDERR_RING_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------- argv

/// FR-1/FR-6/FR-10: the baseline, locked-down Pi RPC argv. The absence of
/// any `-e`/raw argv/config-path override is unconditional (FR-10: "Do not
/// invoke `pi install`/`pi update`" and never pass extension args in this
/// MVP). `--no-extensions`/`--no-approve` are now the session's own pinned
/// launch policy's call, not a hardcoded pair — pi-skills-capabilities
/// FR-6/FR-7's ONE call into `resources::resolve_launch_args` (which runs
/// FR-7's preflight before returning FR-6's policy-derived flags). A
/// connect context with no pinned policy is a wiring bug (`session_create`
/// requires one for every Pi account) and refuses rather than silently
/// falling back to the old unconditional pair. `ctx.resume` carries FR-6's
/// recorded reference for a reconnect — its absence means a fresh Pi
/// conversation, never a silent new-thread fallback disguised as a resume.
pub(crate) fn pi_args(ctx: &RuntimeConnectContext) -> Result<Vec<String>, AppError> {
    let mut args = vec![
        "--mode".into(),
        "rpc".into(),
        "--provider".into(),
        ctx.model.provider_id.clone(),
        "--model".into(),
        ctx.model.model_id.clone(),
    ];
    let policy = ctx.resource_policy.as_ref().ok_or_else(|| {
        AppError::new(
            ErrorCode::Internal,
            "this Pi connection carries no pinned resource policy",
        )
    })?;
    args.extend(super::resources::resolve_launch_args(policy, &ctx.cwd)?);
    if let Some(reference) = &ctx.resume {
        args.push("--resume".into());
        args.push(reference.clone());
    }
    Ok(args)
}

/// pi-migration-rollout FR-3/FR-5: the ONE call into the profile argv
/// builder, split out of `spawn` so it is testable without depending on
/// whether the test host happens to have a certified Pi installed (same
/// reasoning `certified_executable`'s own doc gives for its split). `None`
/// (no profile at all, or no creation-time override) means Pi launches with
/// its own defaults — the baseline argv is returned unchanged.
///
/// FR-3 (read-once fix): the prompt text itself is NEVER read from disk
/// here — `ctx.pi_launch_prompt` is the snapshot resolved once at creation
/// (or lazily once for a pre-fix persisted session, see `recovery.rs`) and
/// carried through unchanged. Only `skillPaths` are re-validated on every
/// connect, per the contract's own "validated before spawn" rule for them.
fn full_pi_args(ctx: &RuntimeConnectContext) -> Result<Vec<String>, AppError> {
    let mut args = pi_args(ctx)?;
    if let Some(settings) = &ctx.pi_profile_settings {
        super::profile_args::validate_skill_paths(settings)?;
        let prompt = ctx.pi_launch_prompt.clone().unwrap_or_default();
        args.extend(super::profile_args::build_pi_profile_args(
            settings, &prompt,
        ));
    }
    Ok(args)
}

// ---------------------------------------------------------------- spawn

/// What the dispatcher needs from a spawned child: its two pipes as trait
/// objects (so tests can substitute an in-memory duplex with no real process
/// at all — see `dispatcher`'s tests), plus a `wait`/`kill` pair over the
/// TRACKED process tree (FR-7).
pub(crate) struct ProcessHandle {
    pub(crate) stdin: Box<dyn std::io::Write + Send>,
    pub(crate) stdout: Box<dyn Read + Send>,
    /// FR-7: block up to `timeout` for the child to exit on its own; `true`
    /// if it had (or already had, if called again).
    pub(crate) wait_timeout: Box<dyn FnMut(Duration) -> bool + Send>,
    /// FR-7: terminate the TRACKED process tree, not just the direct child.
    pub(crate) kill: Box<dyn FnMut() + Send>,
    /// FR-2/FR-8: the bounded, sanitized stderr ring — read for diagnostics
    /// only, never for wire-protocol data.
    pub(crate) stderr_ring: Arc<Mutex<Vec<u8>>>,
}

/// pi-session-durability HIGH remediation (pi-provider-auth FR-5 wiring):
/// the environment THIS connect gives its child — delegates entirely to
/// `crate::account::pi_account_env` (already exhaustively unit-tested
/// there), but pinned here too as its OWN test: this is the one call site
/// that reads a `RuntimeConnectContext`'s pinned `config_dir`/
/// `inherit_environment_credentials`, so a future change to either field's
/// plumbing fails a test in THIS module, not only in `account::pi::env`.
/// Pure over an explicit `ambient` snapshot — never reads `std::env::vars()`
/// itself — so it needs no real process to test.
pub(crate) fn connect_env(
    ambient: &[(String, String)],
    config_dir: &str,
    inherit_environment_credentials: bool,
    runtime: &str,
) -> Vec<(String, String)> {
    crate::account::pi_account_env(
        ambient,
        config_dir,
        inherit_environment_credentials,
        runtime,
        &[],
    )
}

/// PR #142 §5: (program, argv, Windows-side cwd) launching the resolved Pi
/// binary under the session's runtime — the Pi counterpart of
/// `session::spawn::claude_invocation`, and the piece whose absence made a
/// `wsl` Pi session run an IN-DISTRO path natively (`/home/u/.nvm/…/pi`, or
/// its `\\wsl.localhost\…` spelling, handed straight to CreateProcess).
///
/// `exe` is whatever `discovery` resolved: for `wsl` that is the distro's own
/// path, spelled as a UNC path when the FR-3 root was discoverable and as a
/// bare Linux path when it was not — both are translated back to the Linux
/// spelling `wsl.exe` needs after `--`.
///
/// The cwd is the other half: a `wsl.exe` child cannot take a Linux (or UNC)
/// path as its WINDOWS working directory, so for `wsl` the session's cwd rides
/// `--cd` inside the distro and the Windows side inherits ours — `None`. A
/// stored `distro` (session-worktree FR-10) overrides the one a UNC cwd names,
/// exactly as it does for `claude`.
pub(crate) fn pi_invocation(
    runtime: &str,
    cwd: &str,
    distro: Option<&str>,
    exe: &str,
    args: Vec<String>,
) -> (String, Vec<String>, Option<String>) {
    if runtime != "wsl" {
        return (exe.to_string(), args, Some(cwd.to_string()));
    }
    let mut argv = match distro {
        Some(d) => vec![
            "-d".to_string(),
            d.to_string(),
            "--cd".to_string(),
            cwd.to_string(),
        ],
        None => crate::wsl::wsl_base_args(cwd),
    };
    argv.push("--".to_string());
    argv.push(
        crate::wsl::wsl_unc_to_linux(exe).map_or_else(|| exe.to_string(), |(_, linux)| linux),
    );
    argv.extend(args);
    ("wsl.exe".to_string(), argv, None)
}

/// FR-1: resolve the certified executable, build the baseline argv, and
/// spawn it in `ctx.cwd` — the session's OWN working directory/worktree,
/// which is what makes it an "owned session directory": no two concurrent
/// Pi children ever share one. Never touches the session lock (it doesn't
/// have one) and never blocks past the spawn itself.
///
/// pi-session-durability HIGH remediation: the child's environment is never
/// the ambient one — `connect_env` (`account::pi_account_env`) builds the
/// isolated set FR-5 requires from the pinned account's `config_dir`/
/// `inherit_environment_credentials` (populated on `ctx` by the execution
/// gate, `account::pi_execution_preflight_for`, before a connect is ever
/// attempted), and `exact_env` clears whatever this process would otherwise
/// hand the child before applying exactly that set. The login-shell `PATH`
/// resolution `process_util` provides for locating binaries is preserved by
/// folding it into `ambient` first (`account::pi_spawn_ambient`), the same
/// snapshot `setup::spawn_pi_setup` and the refresh probe start from.
///
/// PR #142 §5: a `wsl` session does NOT spawn the resolved path natively —
/// `pi_invocation` wraps it as `wsl.exe -d <distro> --cd <dir> -- <pi> …`,
/// and `connect_env` puts `PI_CODING_AGENT_DIR` in `WSLENV` so the account's
/// directory crosses the boundary with it.
pub(crate) fn spawn(ctx: &RuntimeConnectContext) -> Result<ProcessHandle, AppError> {
    // Checked before any I/O (installation discovery included) — a missing
    // pinned directory is a wiring bug, not something worth a live probe to
    // discover, and it keeps this failure mode host-independent to test.
    let config_dir = ctx.config_dir.as_deref().ok_or_else(|| {
        AppError::new(
            ErrorCode::Internal,
            "this Pi connection carries no pinned account configuration directory",
        )
    })?;
    let status =
        super::discovery::probe_installation(&ctx.runtime, ctx.worktree_distro.as_deref(), false)?;
    let exe = certified_executable(status)?;

    let env = connect_env(
        &crate::account::pi_spawn_ambient(),
        config_dir,
        ctx.inherit_environment_credentials,
        &ctx.runtime,
    );
    let (program, argv, spawn_cwd) = pi_invocation(
        &ctx.runtime,
        &ctx.cwd,
        ctx.worktree_distro.as_deref(),
        &exe,
        full_pi_args(ctx)?,
    );

    let mut command = crate::process_util::spawn(&program)
        .args(argv)
        .exact_env(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .configure(crate::process_util::own_process_group);
    if let Some(cwd) = spawn_cwd {
        command = command.current_dir(cwd);
    }
    let mut child = command.start().map_err(|e| {
        AppError::new(
            ErrorCode::RuntimeUnavailable,
            format!("could not start pi: {e}"),
        )
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::new(ErrorCode::RuntimeProtocolError, "pi child has no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new(ErrorCode::RuntimeProtocolError, "pi child has no stdout"))?;
    let stderr = child.stderr.take();

    let stderr_ring: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = stderr {
        let ring = stderr_ring.clone();
        std::thread::spawn(move || drain_stderr_ring(stderr, ring));
    }

    let child = Arc::new(Mutex::new(child));
    let wait_child = child.clone();
    let kill_child = child.clone();
    Ok(ProcessHandle {
        stdin: Box::new(stdin),
        stdout: Box::new(stdout),
        wait_timeout: Box::new(move |timeout| wait_for_exit(&wait_child, timeout)),
        kill: Box::new(move || crate::process_util::kill_tree(&mut kill_child.lock().unwrap())),
        stderr_ring,
    })
}

/// FR-1: spend discovery's verdict — only a `Ready` status with a resolved
/// path may be spawned; anything else fails with discovery's own error.
/// Split out of `spawn` so the verdict branch is testable without depending
/// on whether the test host happens to have Pi installed.
fn certified_executable(
    status: super::discovery::RuntimeInstallStatus,
) -> Result<String, AppError> {
    if status.state != super::discovery::InstallState::Ready {
        return Err(status.error.unwrap_or_else(|| {
            AppError::new(ErrorCode::RuntimeUnavailable, "Pi is not available")
        }));
    }
    status.executable_path.ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeUnavailable,
            "Pi reported ready with no resolved executable path",
        )
    })
}

/// FR-7's "waits up to 5s": poll `try_wait` rather than the blocking `wait`,
/// so the caller keeps its own deadline rather than trusting the OS to honor
/// one.
fn wait_for_exit(child: &Arc<Mutex<Child>>, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if matches!(child.lock().unwrap().try_wait(), Ok(Some(_))) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// FR-2/FR-8: drain stderr on its own thread (so a chatty child can never
/// block stdout draining) into a bounded ring — oldest bytes drop first, the
/// diagnostics reader only ever wants the tail.
fn drain_stderr_ring(mut stderr: impl Read, ring: Arc<Mutex<Vec<u8>>>) {
    let mut buf = [0u8; 4096];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut r = ring.lock().unwrap();
                r.extend_from_slice(&buf[..n]);
                if r.len() > STDERR_RING_BYTES {
                    let drop = r.len() - STDERR_RING_BYTES;
                    r.drain(..drop);
                }
            }
        }
    }
}

/// FR-8: a bounded, control-character-free snippet safe to write to the
/// diagnostics log — never the raw ring content, never prompt text.
///
/// pi-transcript-events (review remediation): also strips bidi override
/// characters (`crate::ipc::is_bidi_control`) — every caller of this helper
/// includes `normalize::on_retry`/`on_unknown`, whose output rides straight
/// into a rendered `Notice` block, and a bidi override is not
/// `char::is_control` (it's Unicode category `Cf`, not `Cc`).
pub(crate) fn sanitize_diagnostic(text: &str, max_chars: usize) -> String {
    text.chars()
        .filter(|c| (!c.is_control() || *c == ' ') && !crate::ipc::is_bidi_control(*c))
        .take(max_chars)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::adapter::pi::discovery::{InstallState, Provenance, RuntimeInstallStatus};
    use crate::session::adapter::pi::resources::{ExtensionsPolicy, ProjectResources};
    use crate::session::adapter::pi::RuntimeResourcePolicy;
    use crate::session::adapter::{RuntimeLaunchPolicy, RuntimeModelRef, RuntimeProfileSnapshot};

    fn ctx(resume: Option<&str>) -> RuntimeConnectContext {
        RuntimeConnectContext {
            session_id: crate::ids::uuid(),
            cwd: env!("CARGO_MANIFEST_DIR").into(),
            runtime: "native".into(),
            worktree_distro: None,
            account_id: crate::ids::uuid(),
            launch_policy: RuntimeLaunchPolicy {
                permission_mode: "default".into(),
                allow_git: false,
            },
            profile_snapshot: RuntimeProfileSnapshot {
                system_prompt: None,
                extra_args: Vec::new(),
            },
            model: RuntimeModelRef {
                provider_id: "anthropic".into(),
                model_id: "claude-x".into(),
            },
            resume: resume.map(String::from),
            config_dir: Some("/pi/acct".into()),
            inherit_environment_credentials: false,
            pi_profile_settings: None,
            pi_launch_prompt: None,
            resource_policy: Some(RuntimeResourcePolicy {
                project_resources: ProjectResources::Ignore,
                extensions: ExtensionsPolicy::Disabled,
                acknowledged_unrestricted_tools: true,
            }),
        }
    }

    #[test]
    fn baseline_argv_always_locks_extensions_and_approval_off() {
        let args = pi_args(&ctx(None)).unwrap();
        assert!(args.windows(2).any(|w| w == ["--mode", "rpc"]));
        assert!(args.windows(2).any(|w| w == ["--provider", "anthropic"]));
        assert!(args.windows(2).any(|w| w == ["--model", "claude-x"]));
        assert!(args.iter().any(|a| a == "--no-extensions"));
        assert!(args.iter().any(|a| a == "--no-approve"));
        assert!(!args.iter().any(|a| a == "-e"));
        assert!(!args.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn a_recorded_reference_becomes_an_explicit_resume_flag() {
        let args = pi_args(&ctx(Some("pi-ref-1"))).unwrap();
        assert!(args.windows(2).any(|w| w == ["--resume", "pi-ref-1"]));
    }

    /// pi-skills-capabilities FR-6/FR-7: `pi_args` refuses a context with no
    /// pinned policy — the same defensive shape `spawn` already applies to
    /// a missing `config_dir`.
    #[test]
    fn pi_args_refuses_a_context_with_no_pinned_resource_policy() {
        let mut bare = ctx(None);
        bare.resource_policy = None;
        let err = pi_args(&bare).unwrap_err();
        assert_eq!(err.code, ErrorCode::Internal);
    }

    /// pi-skills-capabilities FR-7: `projectResources: 'allow'` drops
    /// `--no-approve` but never `--no-extensions`.
    #[test]
    fn pi_args_drops_no_approve_only_when_the_pinned_policy_allows_project_resources() {
        let mut allowed = ctx(None);
        allowed.resource_policy = Some(RuntimeResourcePolicy {
            project_resources: ProjectResources::Allow,
            extensions: ExtensionsPolicy::Disabled,
            acknowledged_unrestricted_tools: true,
        });
        let args = pi_args(&allowed).unwrap();
        assert!(args.iter().any(|a| a == "--no-extensions"));
        assert!(!args.iter().any(|a| a == "--no-approve"));
    }

    /// pi-skills-capabilities FR-7: a preflight failure refuses the WHOLE
    /// argv build — never a partial/best-effort flag set.
    #[test]
    fn pi_args_propagates_a_preflight_failure() {
        let dir =
            std::env::temp_dir().join(format!("francois-pi-args-preflight-{}", crate::ids::uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"postinstall":"node ./setup.js"}}"#,
        )
        .unwrap();
        let mut hostile = ctx(None);
        hostile.cwd = dir.to_string_lossy().to_string();
        hostile.resource_policy = Some(RuntimeResourcePolicy {
            project_resources: ProjectResources::Allow,
            extensions: ExtensionsPolicy::Disabled,
            acknowledged_unrestricted_tools: true,
        });
        let err = pi_args(&hostile).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// pi-migration-rollout FR-5: no profile at all means Pi launches with
    /// its own defaults — `full_pi_args` is the baseline argv, unchanged.
    #[test]
    fn full_pi_args_with_no_profile_is_the_baseline_argv() {
        let bare = ctx(None);
        assert_eq!(full_pi_args(&bare).unwrap(), pi_args(&bare).unwrap());
    }

    /// The ONE call into the profile argv builder: a resolved settings
    /// snapshot's tools/skills/prompt flags ride on the SAME argv as the
    /// baseline `--mode`/`--provider`/`--model` flags.
    #[test]
    fn full_pi_args_appends_the_resolved_profile_argv() {
        use crate::profiles::{
            PiBuiltinTool, PiProfileSettings, PiProjectResources, PiSystemPromptMode,
        };
        let mut with_profile = ctx(None);
        with_profile.pi_profile_settings = Some(PiProfileSettings {
            system_prompt_mode: PiSystemPromptMode::Default,
            system_prompt: None,
            instruction_paths: Vec::new(),
            skill_paths: Vec::new(),
            tools: vec![PiBuiltinTool::Read],
            project_resources: PiProjectResources::Ignore,
        });
        let args = full_pi_args(&with_profile).unwrap();
        assert!(
            args.windows(2).any(|w| w == ["--mode", "rpc"]),
            "keeps the baseline argv"
        );
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--allow-tool" && w[1] == "read"));
    }

    /// A profile referencing a skill path that no longer exists must refuse
    /// the whole spawn — never silently drop the flag or launch unrestricted.
    #[test]
    fn full_pi_args_propagates_a_missing_skill_path_as_an_error() {
        use crate::profiles::{PiProfileSettings, PiProjectResources, PiSystemPromptMode};
        let mut with_profile = ctx(None);
        let missing = std::env::temp_dir().join("francois-process-missing-skill.md");
        with_profile.pi_profile_settings = Some(PiProfileSettings {
            system_prompt_mode: PiSystemPromptMode::Default,
            system_prompt: None,
            instruction_paths: Vec::new(),
            skill_paths: vec![missing.to_string_lossy().to_string()],
            tools: Vec::new(),
            project_resources: PiProjectResources::Ignore,
        });
        let err = full_pi_args(&with_profile).expect_err("missing skill path");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    /// pi-session-durability HIGH remediation: `connect_env` pins the
    /// account's own directory and respects its inherit flag — the exact
    /// two fields `spawn` reads off `RuntimeConnectContext` — with no real
    /// process at all.
    #[test]
    fn connect_env_pins_the_account_directory_and_drops_credentials_by_default() {
        let ambient = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "secret-claude".to_string()),
            (
                "CLAUDE_CONFIG_DIR".to_string(),
                "/accounts/other".to_string(),
            ),
        ];
        let env = connect_env(&ambient, "/pi/acct-a", false, "native");
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(
            map.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/pi/acct-a")
        );
        assert!(!map.contains_key("ANTHROPIC_API_KEY"));
        assert!(!map.contains_key("CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn connect_env_inherits_ambient_credentials_only_when_opted_in() {
        let ambient = vec![("OPENAI_API_KEY".to_string(), "secret-openai".to_string())];
        let env = connect_env(&ambient, "/pi/acct-b", true, "native");
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(
            map.get("OPENAI_API_KEY").map(String::as_str),
            Some("secret-openai")
        );
        assert_eq!(
            map.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/pi/acct-b")
        );
    }

    /// PR #142 §5: a `wsl` session's child is `wsl.exe`, its cwd rides `--cd`
    /// INSIDE the distro (a Linux path cannot be a Windows working directory),
    /// and the in-distro Pi path is spelled the way the distro spells it —
    /// whichever way `discovery` happened to report it.
    #[test]
    fn a_wsl_session_launches_pi_inside_the_distro_never_natively() {
        let (program, argv, cwd) = pi_invocation(
            "wsl",
            "\\\\wsl.localhost\\Ubuntu\\home\\u\\api",
            None,
            "\\\\wsl.localhost\\Ubuntu\\home\\u\\.nvm\\bin\\pi",
            vec!["--mode".into(), "rpc".into()],
        );
        assert_eq!(program, "wsl.exe");
        assert_eq!(
            argv,
            vec![
                "-d",
                "Ubuntu",
                "--cd",
                "/home/u/api",
                "--",
                "/home/u/.nvm/bin/pi",
                "--mode",
                "rpc"
            ]
        );
        assert!(cwd.is_none(), "a Linux cwd is never a Windows cwd");
    }

    #[test]
    fn a_wsl_worktree_session_targets_its_stored_distro_with_the_paths_it_already_has() {
        // session-worktree FR-10: the cwd is a bare Linux path with no distro
        // in it, and `discovery` fell back to the Linux path for the binary
        // because the FR-3 UNC root could not be discovered. Both pass through.
        let (program, argv, cwd) = pi_invocation(
            "wsl",
            "/home/u/.francois-worktrees/api/feat-x",
            Some("Debian"),
            "/usr/local/bin/pi",
            vec!["--mode".into()],
        );
        assert_eq!(program, "wsl.exe");
        assert_eq!(
            argv,
            vec![
                "-d",
                "Debian",
                "--cd",
                "/home/u/.francois-worktrees/api/feat-x",
                "--",
                "/usr/local/bin/pi",
                "--mode"
            ]
        );
        assert!(cwd.is_none());
    }

    #[test]
    fn a_native_session_spawns_the_resolved_binary_in_its_own_cwd_unchanged() {
        let (program, argv, cwd) = pi_invocation(
            "native",
            "D:\\acme-api",
            None,
            "C:\\bin\\pi.cmd",
            vec!["--mode".into(), "rpc".into()],
        );
        assert_eq!(program, "C:\\bin\\pi.cmd");
        assert_eq!(argv, vec!["--mode", "rpc"]);
        assert_eq!(cwd.as_deref(), Some("D:\\acme-api"));
    }

    /// A `ctx` with no pinned account directory (a test-only shape —
    /// production never builds one, see the field's own doc) must never
    /// silently fall back to spawning with the ambient environment.
    #[test]
    fn spawn_refuses_a_context_with_no_pinned_account_directory() {
        let mut bare = ctx(None);
        bare.config_dir = None;
        // `ProcessHandle` carries no `Debug` impl (its closures cannot derive
        // one), so match rather than `unwrap_err()`.
        match spawn(&bare) {
            Err(err) => assert_eq!(err.code, ErrorCode::Internal),
            Ok(_) => panic!("expected spawn to refuse a context with no pinned account directory"),
        }
    }

    fn status(
        state: InstallState,
        executable_path: Option<&str>,
        error: Option<AppError>,
    ) -> RuntimeInstallStatus {
        RuntimeInstallStatus {
            state,
            executable_path: executable_path.map(String::from),
            detected_version: None,
            node_version: None,
            supported_versions: Vec::new(),
            provenance: Provenance::Unknown,
            checked_at: 0,
            install_command: String::new(),
            error,
        }
    }

    // Built from a constructed verdict, not a live probe: whether the test
    // host has a certified Pi installed must not decide the outcome.
    #[test]
    fn a_missing_certified_pi_fails_spawn_with_the_discovery_verdict() {
        let missing = AppError::new(ErrorCode::RuntimeUnavailable, "Pi is not installed.");
        let err =
            certified_executable(status(InstallState::Missing, None, Some(missing))).unwrap_err();
        assert_eq!(err.code, ErrorCode::RuntimeUnavailable);
        assert_eq!(err.message, "Pi is not installed.");

        let incompatible = AppError::new(ErrorCode::RuntimeIncompatible, "not certified");
        let err = certified_executable(status(
            InstallState::Incompatible,
            Some("/bin/pi"),
            Some(incompatible),
        ))
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::RuntimeIncompatible);
    }

    #[test]
    fn a_ready_verdict_yields_its_path_and_a_pathless_one_is_unavailable() {
        assert_eq!(
            certified_executable(status(InstallState::Ready, Some("/bin/pi"), None)).unwrap(),
            "/bin/pi"
        );
        let err = certified_executable(status(InstallState::Ready, None, None)).unwrap_err();
        assert_eq!(err.code, ErrorCode::RuntimeUnavailable);
    }

    /// FR-2/FR-8 + acceptance §9 "stderr flood remain[s] bounded":
    /// `drain_stderr_ring` must never let the ring grow past
    /// `STDERR_RING_BYTES`, and must keep the TAIL (most recent bytes) once
    /// it starts dropping, not the head.
    #[test]
    fn drain_stderr_ring_stays_bounded_under_a_flood_and_keeps_the_tail() {
        struct Flood {
            remaining: usize,
        }
        impl Read for Flood {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.remaining == 0 {
                    return Ok(0); // EOF
                }
                let n = buf.len().min(self.remaining);
                // Fill with an ascending byte pattern so the tail is
                // identifiable once the ring has been trimmed.
                for (i, b) in buf[..n].iter_mut().enumerate() {
                    let offset = (STDERR_RING_BYTES * 3 - self.remaining + i) % 256;
                    *b = offset as u8;
                }
                self.remaining -= n;
                Ok(n)
            }
        }
        let total = STDERR_RING_BYTES * 3;
        let ring: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        drain_stderr_ring(Flood { remaining: total }, ring.clone());
        let bytes = ring.lock().unwrap();
        assert!(bytes.len() <= STDERR_RING_BYTES);
        assert!(!bytes.is_empty());
        // The last byte written by the flood must be the last byte in the
        // ring — proof the TAIL survived, not an arbitrary earlier chunk.
        let expected_last = ((total - 1) % 256) as u8;
        assert_eq!(*bytes.last().unwrap(), expected_last);
    }

    #[test]
    fn sanitize_diagnostic_strips_control_characters_and_bounds_length() {
        let out = sanitize_diagnostic("safe\ntext\x07here", 100);
        assert!(!out.contains('\n'));
        assert!(!out.contains('\u{7}'));
        assert_eq!(sanitize_diagnostic(&"x".repeat(50), 10).len(), 10);
    }

    /// pi-transcript-events (review remediation): a bidi override character
    /// is category `Cf`, not `Cc` — `char::is_control` alone lets it through,
    /// and this diagnostic feeds straight into a rendered Notice block
    /// (`normalize::on_retry`/`on_unknown`).
    #[test]
    fn sanitize_diagnostic_strips_bidi_override_characters() {
        let out = sanitize_diagnostic("safe\u{202e}text\u{2066}here", 100);
        assert!(!out.contains('\u{202e}'));
        assert!(!out.contains('\u{2066}'));
        assert_eq!(out, "safetexthere");
    }
}
