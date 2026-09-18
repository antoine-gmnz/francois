//! process-spawn plumbing shared by every turn/probe/create-time spawn: the
//! session-config validators, the claude argv/runtime wrapper, and the PATH /
//! window-flag helpers a spawned `claude` (or `wsl.exe`) child needs.
//!
//! `no_window` used to be re-exported from here: session/mod.rs carried its own
//! copy (a third one, alongside wsl.rs's and diff/git.rs's), and the re-export
//! kept every `crate::session::no_window` caller resolving after those were
//! collapsed into `crate::process_util`. core-architecture-wave3 FR-7 removed
//! the re-export with the last caller — window suppression is now one of the
//! four concerns `process_util::spawn` applies by construction, so no spawn site
//! names it at all.
//!
//! `spawn_claude` itself lives in `session/adapter/claude_code.rs`
//! (multi-provider-seam FR-3): it is turn-shaped (stdin/stdout wiring, the
//! NDJSON user line) AND Claude-CLI-shaped, rather than argv/env plumbing.

pub fn valid_effort(e: &str) -> bool {
    matches!(e, "low" | "medium" | "high" | "xhigh" | "max")
}

/// contract/common.ts PermissionMode. The CLI's `auto`/`dontAsk` are deliberately
/// excluded (auto aborts headless -p runs on classifier blocks; dontAsk needs a
/// paired allowedTools list).
pub fn valid_permission_mode(m: &str) -> bool {
    matches!(m, "default" | "plan" | "acceptEdits" | "bypassPermissions")
}

/// contract/common.ts ClaudeRuntime. 'wsl' is only accepted on Windows (create-time check).
pub fn valid_runtime(r: &str) -> bool {
    matches!(r, "native" | "wsl")
}

/// `--permission-mode` args for a turn. 'default' adds NOTHING — the turn inherits
/// the user's ~/.claude settings (permissions.defaultMode / allow rules), exactly
/// the pre-feature behavior. The flag does not persist across --resume, so every
/// invocation passes it explicitly.
pub fn permission_args(mode: &str) -> Vec<String> {
    match mode {
        "plan" | "acceptEdits" | "bypassPermissions" => {
            vec!["--permission-mode".into(), mode.into()]
        }
        _ => Vec::new(),
    }
}

/// (program, argv) launching `claude <claude_args>` under a session's runtime.
/// wsl: `wsl.exe [-d <distro>] --cd <dir> -- claude …` via `wsl_base_args` — a
/// WSL UNC cwd targets the distro named in the path (bare wsl.exe hits the
/// DEFAULT distro, wrong on multi-distro machines) with its pre-translated Linux
/// path (`--cd '\\wsl.localhost\…'` fails with Wsl/E_INVALIDARG — verified
/// live); a drive-letter cwd passes verbatim (wsl.exe maps it to /mnt/… itself).
/// native: plain `claude …`; the caller sets current_dir.
///
/// `distro`: session-worktree FR-10's stored `Session::worktree_distro`. When
/// `Some`, it OVERRIDES the UNC-derived distro — required for a WSL worktree
/// session, whose `cwd` is already a bare Linux path (no `\\wsl$\<distro>\…`
/// prefix left for `wsl_base_args` to recover the distro from) — `cwd` is then
/// passed to `--cd` verbatim, since it is already in the distro's own dialect.
/// `None` preserves the pre-existing UNC-derived behavior for every other
/// (non-worktree) WSL session.
pub fn claude_invocation(
    runtime: &str,
    cwd: &str,
    claude_args: Vec<String>,
    distro: Option<&str>,
) -> (String, Vec<String>) {
    if runtime == "wsl" {
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
        argv.push("claude".to_string());
        argv.extend(claude_args);
        ("wsl.exe".into(), argv)
    } else {
        ("claude".into(), claude_args)
    }
}

/// FR-1/FR-2 (ext-path-resolution): the login-shell PATH resolver moved
/// verbatim to `process_util::login_shell_path_env`, shared with the two
/// extension spawn sites. This re-export keeps every existing `claude` call
/// site (`session::claude_path_env`) resolving unchanged, with no filtering
/// applied to their PATH.
pub(crate) use crate::process_util::login_shell_path_env as claude_path_env;

/// wsl.exe children need environment variables forwarded across the distro
/// boundary explicitly: setting one on this (Windows-side) process's own env
/// does not cross wsl.exe's boundary; `WSLENV` does. Append (':'-joined) to any
/// existing `WSLENV` list rather than overwrite it — the inherited environment
/// may already carry one — and never add an entry whose variable is already
/// listed under any flag variant.
///
/// multi-account FR-24 generalized this from the single hard-coded `TERM/u` to
/// a list merge: an account's `CLAUDE_CONFIG_DIR` reaches the distro through
/// `CLAUDE_CONFIG_DIR/up` (`/u` = pass in, `/p` = translate the Windows path to
/// `/mnt/…`), merged exactly the same way. The previous single-purpose
/// `TERM`-only helper is gone — callers now pass `&["TERM/u"]` (or whatever
/// they need) straight into `wsl_env_list`/`account_env`.
pub(crate) fn wsl_env_list(entries: &[&str]) -> String {
    merge_wsl_env(std::env::var("WSLENV").ok().as_deref(), entries)
}

/// The pure half of `wsl_env_list`: merge `entries` into an existing `WSLENV`
/// value. Kept separate from the process environment so the merge rules are
/// unit-testable without mutating a global every other test can see.
pub(crate) fn merge_wsl_env(existing: Option<&str>, entries: &[&str]) -> String {
    let mut list: Vec<String> = existing
        .filter(|v| !v.is_empty())
        .map(|v| {
            v.trim_end_matches(':')
                .split(':')
                .filter(|e| !e.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    for entry in entries {
        // `NAME/flags` — an entry already forwarding this variable (whatever its
        // flags) wins, so we never emit the same variable twice.
        let name = entry.split('/').next().unwrap_or(entry);
        let already = list
            .iter()
            .any(|e| e == entry || e.split('/').next().unwrap_or(e) == name);
        if !already {
            list.push((*entry).to_string());
        }
    }
    list.join(":")
}

/// multi-account FR-21/FR-24: the environment EVERY spawn made on behalf of a
/// session must add — the turn spawn, the /usage-/cost side-probe, the
/// create-time claude probe, the remote-control PTY and the SHELL tab's PTY.
///
/// `config_dir` is the session's account's `configDir`: `None` (the built-in
/// `default` account) sets NOTHING at all, which is byte-for-byte the
/// pre-feature behavior. `extra_wslenv` carries entries the call site needs for
/// its own reasons (the two PTY sites pass `TERM/u`), merged into the same
/// `WSLENV` list so neither can clobber the other.
pub(crate) fn account_env(
    config_dir: Option<&str>,
    runtime: &str,
    extra_wslenv: &[&str],
) -> Vec<(String, String)> {
    account_env_for_kind(
        config_dir,
        crate::account::AccountKind::ClaudeCodeOauth,
        runtime,
        extra_wslenv,
    )
}

/// multi-provider-codex FR-18: the same environment, for whichever CLI the
/// account's kind names.
///
/// `account_env` above hard-coded `CLAUDE_CONFIG_DIR`, which was correct while
/// every config-dir account was a Claude one. A Codex account points the same
/// mechanism at `CODEX_HOME` instead — so the variable moved out of this
/// function and onto `AccountKind::config_dir_env_var`, where the `match` is
/// exhaustive and a fourth kind cannot silently inherit Claude's.
///
/// `account_env` is kept as the Claude-kind alias rather than being replaced at
/// all ~dozen call sites: those sites (the /usage probe, the create-time probe,
/// the remote-control PTY, the SHELL PTY) are Claude-shaped for reasons of their
/// own, and a Codex session reaching them would be a bug that a mechanical
/// find-and-replace would have hidden.
pub(crate) fn account_env_for_kind(
    config_dir: Option<&str>,
    kind: crate::account::AccountKind,
    runtime: &str,
    extra_wslenv: &[&str],
) -> Vec<(String, String)> {
    let var = kind.config_dir_env_var();
    let mut out: Vec<(String, String)> = Vec::new();
    if let (Some(dir), Some(var)) = (config_dir, var) {
        out.push((var.to_string(), dir.to_string()));
    }
    if runtime == "wsl" {
        let mut entries: Vec<String> = extra_wslenv.iter().map(|e| e.to_string()).collect();
        if let (true, Some(var)) = (config_dir.is_some(), var) {
            // `/u` passes it INTO the distro, `/p` translates the Windows path
            // to its `/mnt/…` form — the argv never carries the path (FR-24).
            entries.push(format!("{var}/up"));
        }
        if !entries.is_empty() {
            let refs: Vec<&str> = entries.iter().map(String::as_str).collect();
            out.push(("WSLENV".to_string(), wsl_env_list(&refs)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_args_only_for_explicit_modes() {
        assert!(permission_args("default").is_empty()); // inherit ~/.claude settings — no flag
        assert!(permission_args("garbage").is_empty());
        assert_eq!(permission_args("plan"), vec!["--permission-mode", "plan"]);
        assert_eq!(
            permission_args("acceptEdits"),
            vec!["--permission-mode", "acceptEdits"]
        );
        assert_eq!(
            permission_args("bypassPermissions"),
            vec!["--permission-mode", "bypassPermissions"]
        );
    }

    #[test]
    fn claude_invocation_wraps_wsl() {
        let (prog, args) =
            claude_invocation("native", "D:\\repo", vec!["-p".into(), "hi".into()], None);
        assert_eq!(prog, "claude");
        assert_eq!(args, vec!["-p", "hi"]);
        // wsl + drive cwd: wsl.exe maps it to /mnt/… itself — passed verbatim,
        // no -d (no distro info → default distro is the only sane target)
        let (prog, args) = claude_invocation("wsl", "D:\\repo", vec!["--version".into()], None);
        assert_eq!(prog, "wsl.exe");
        assert_eq!(args, vec!["--cd", "D:\\repo", "--", "claude", "--version"]);
        // wsl + WSL UNC cwd: MUST pre-translate (`--cd \\wsl…` = Wsl/E_INVALIDARG
        // live) AND target the distro named in the path — bare wsl.exe hits the
        // default distro, which need not be the one holding the repo.
        let (prog, args) = claude_invocation(
            "wsl",
            "\\\\wsl.localhost\\Ubuntu\\home\\u\\api",
            vec!["-p".into(), "hi".into()],
            None,
        );
        assert_eq!(prog, "wsl.exe");
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu",
                "--cd",
                "/home/u/api",
                "--",
                "claude",
                "-p",
                "hi"
            ]
        );
    }

    // ---- multi-account FR-21/FR-24: the per-account spawn environment ----

    #[test]
    fn the_default_account_adds_no_environment_at_all() {
        // FR-21: a null configDir sets NOTHING — byte-for-byte the pre-feature
        // spawn, for both runtimes.
        assert!(account_env(None, "native", &[]).is_empty());
        assert!(account_env(None, "wsl", &[]).is_empty());
        // …except what the call site itself needs (the PTY sites' TERM/u).
        // (Only the VARIABLE is asserted, never the flags: this reads the real
        // process WSLENV, which may already forward TERM under other flags.)
        let pty = account_env(None, "wsl", &["TERM/u"]);
        assert_eq!(pty.len(), 1);
        assert_eq!(pty[0].0, "WSLENV");
        assert!(pty[0].1.split(':').any(|e| e.starts_with("TERM/")));
    }

    #[test]
    fn a_native_spawn_only_sets_claude_config_dir() {
        let env = account_env(Some("D:\\francois\\accounts\\a1"), "native", &[]);
        assert_eq!(
            env,
            vec![(
                "CLAUDE_CONFIG_DIR".to_string(),
                "D:\\francois\\accounts\\a1".to_string()
            )]
        );
    }

    #[test]
    fn a_wsl_spawn_passes_the_config_dir_through_wslenv_not_the_argv() {
        // FR-24: CLAUDE_CONFIG_DIR keeps its WINDOWS value; `/u` passes it in and
        // `/p` translates it to /mnt/… inside the distro.
        let env = account_env(Some("D:\\francois\\accounts\\a1"), "wsl", &["TERM/u"]);
        let map: std::collections::HashMap<&str, &str> =
            env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(
            map["CLAUDE_CONFIG_DIR"], "D:\\francois\\accounts\\a1",
            "the Windows value is passed verbatim; WSL translates it"
        );
        let entries: Vec<&str> = map["WSLENV"].split(':').collect();
        assert!(entries.contains(&"CLAUDE_CONFIG_DIR/up"));
        assert!(
            entries.iter().any(|e| e.starts_with("TERM/")),
            "the caller's own TERM entry survives the merge: {entries:?}"
        );
    }

    // ---------- multi-provider-codex FR-18: the variable follows the KIND ----------

    #[test]
    fn a_codex_account_exports_codex_home_and_never_claude_config_dir() {
        use crate::account::AccountKind;
        let env = account_env_for_kind(
            Some("/data/accounts/a1"),
            AccountKind::CodexCli,
            "native",
            &[],
        );
        let map: std::collections::HashMap<&str, &str> =
            env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(map["CODEX_HOME"], "/data/accounts/a1");
        // The regression that matters: pointing `codex` at a CLAUDE_CONFIG_DIR
        // would silently run it against the wrong (or a non-existent) home, and
        // the turn would fail with an auth error that names neither.
        assert!(!map.contains_key("CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn a_claude_account_is_unchanged_by_the_generalization() {
        use crate::account::AccountKind;
        // `account_env` is now an alias — it must still produce byte-identical
        // output, since every pre-existing call site goes through it.
        assert_eq!(
            account_env(Some("/data/accounts/a1"), "wsl", &["TERM/u"]),
            account_env_for_kind(
                Some("/data/accounts/a1"),
                AccountKind::ClaudeCodeOauth,
                "wsl",
                &["TERM/u"]
            )
        );
    }

    #[test]
    fn a_codex_config_dir_rides_wslenv_under_its_own_name() {
        use crate::account::AccountKind;
        let env = account_env_for_kind(
            Some("D:\\francois\\accounts\\a1"),
            AccountKind::CodexCli,
            "wsl",
            &["TERM/u"],
        );
        let map: std::collections::HashMap<&str, &str> =
            env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let entries: Vec<&str> = map["WSLENV"].split(':').collect();
        assert!(entries.contains(&"CODEX_HOME/up"), "{entries:?}");
        assert!(!entries.contains(&"CLAUDE_CONFIG_DIR/up"), "{entries:?}");
        assert!(entries.iter().any(|e| e.starts_with("TERM/")));
    }

    #[test]
    fn an_endpoint_account_exports_no_config_dir_variable_at_all() {
        use crate::account::AccountKind;
        // Its credential is a sidecar key file, not a config dir — so there is
        // no CLI to point anywhere, and inventing a variable would be noise.
        assert!(account_env_for_kind(
            Some("/data/accounts/a1"),
            AccountKind::OpenAiCompatible,
            "native",
            &[]
        )
        .is_empty());
    }

    #[test]
    fn wslenv_merging_appends_without_clobbering_or_duplicating() {
        // The pre-feature TERM/u behavior, unchanged:
        assert_eq!(merge_wsl_env(None, &["TERM/u"]), "TERM/u");
        assert_eq!(merge_wsl_env(Some(""), &["TERM/u"]), "TERM/u");
        assert_eq!(merge_wsl_env(Some("FOO/u"), &["TERM/u"]), "FOO/u:TERM/u");
        assert_eq!(merge_wsl_env(Some("FOO/u:"), &["TERM/u"]), "FOO/u:TERM/u");
        // an entry already forwarding the variable wins, whatever its flags
        assert_eq!(merge_wsl_env(Some("TERM/u"), &["TERM/u"]), "TERM/u");
        assert_eq!(merge_wsl_env(Some("TERM/w"), &["TERM/u"]), "TERM/w");
        // FR-24: both entries land, in one list, exactly once each
        assert_eq!(
            merge_wsl_env(Some("FOO/u"), &["TERM/u", "CLAUDE_CONFIG_DIR/up"]),
            "FOO/u:TERM/u:CLAUDE_CONFIG_DIR/up"
        );
        assert_eq!(
            merge_wsl_env(
                Some("CLAUDE_CONFIG_DIR/up"),
                &["TERM/u", "CLAUDE_CONFIG_DIR/up"]
            ),
            "CLAUDE_CONFIG_DIR/up:TERM/u"
        );
    }

    #[test]
    fn claude_invocation_distro_override_targets_the_stored_distro_from_a_linux_path() {
        // session-worktree FR-10: a WSL worktree session's cwd is a bare Linux
        // path (no `\\wsl$\<distro>\…` prefix) — the stored distro must still
        // route to the repo's actual distro, not the machine's default one.
        let (prog, args) = claude_invocation(
            "wsl",
            "/home/u/.francois-worktrees/api/feat-x",
            vec!["--version".into()],
            Some("Ubuntu"),
        );
        assert_eq!(prog, "wsl.exe");
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu",
                "--cd",
                "/home/u/.francois-worktrees/api/feat-x",
                "--",
                "claude",
                "--version"
            ]
        );
    }
}
