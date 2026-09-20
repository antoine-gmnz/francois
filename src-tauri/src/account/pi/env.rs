//! pi-provider-auth FR-5: the spawn-environment isolation rule. Split out of
//! `pi/mod.rs` purely for CLAUDE.md's ~1000-line file cap — `setup.rs` is
//! this child's only caller today (see `pi_account_env`'s own doc for the
//! second, not-yet-wired caller).

/// FR-5: the environment a Pi-runtime spawn (session connect, `piSetup`,
/// `piRefresh`'s probe) should use. Pure over an explicit `ambient` snapshot
/// — rather than reading `std::env::vars()` itself — so cross-account
/// leakage is testable without mutating the real process environment. Lives
/// in `account` (not `session`, despite serving the session-scoped RPC
/// connect too) because a `session` → `account` dependency already exists
/// crate-wide and the reverse would be a NEW module cycle the conventions
/// gate rejects — this function needs nothing session-shaped anyway (no
/// `TurnContext`/`RuntimeConnectContext`), only an account's own config
/// dir and its `inheritEnvironmentCredentials` choice.
///
/// `inherit_environment_credentials=false` (MVP default, FR-5): starts from
/// `process_util::ENV_ALLOWLIST` — the same OS-baseline scrub every other
/// scrubbed child in this crate uses (`PATH`, `HOME`/`USERPROFILE`,
/// `SystemRoot`/`TEMP`/`TMP`/…) — never NOTHING but `PATH`. A `PATH`-only
/// baseline silently drops `SystemRoot` on Windows, and a child with no
/// `SystemRoot` cannot resolve `cmd.exe`/DLL search paths at all — this is
/// not a credential and never was one; the allowlist itself already excludes
/// every provider credential (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) by
/// construction. `true`: starts from the full `ambient` snapshot, with
/// `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME` still cleared either way
/// (FR-5: "Clear Claude/Codex/Grok config overrides") — an inherited key is
/// Pi's OWN resolution rules to make sense of, never another Francois
/// runtime's config directory. `PI_CODING_AGENT_DIR` is set either way, and
/// always to THIS account's directory — never a stale prior value.
///
/// Called from `setup::spawn_pi_setup` (the FR-3 setup PTY), and — since
/// pi-session-durability made `session::adapter::pi::recovery::
/// reconnect_session` the connect path's first production caller —
/// `session::adapter::pi::process::spawn` too. `RuntimeConnectContext` now
/// carries `configDir`/`inheritEnvironmentCredentials`, populated by
/// `recovery::run_reconnect` from `pi_execution_preflight_for` (the
/// Pi-specific accessor next to `config_dir_of` in `account::mod.rs`) before
/// `process::spawn` ever runs; `spawn` clears the child's inherited
/// environment and applies exactly this function's output (never the
/// unfiltered ambient one) through `process_util::CommandBuilder::exact_env`.
/// This function was unit-tested on its own from the start, so FR-5's
/// isolation rule had coverage before that wiring landed, not only after.
///
/// **`runtime`/`extra_wslenv` (PR #142 §5)**: setting `PI_CODING_AGENT_DIR`
/// here only reaches a NATIVE child. `wsl.exe` forwards exactly the variables
/// `WSLENV` names, so a `wsl` account's spawn gets an entry for it — `/u`
/// alone when the value is already a path inside the distro (the shape a WSL
/// Pi account stores), `/up` when it is a drive-letter Windows path wsl.exe
/// must translate. Without that entry the child fell back to the distro's
/// AMBIENT Pi directory, which is another account's credentials. Call sites
/// pass their own extra entries (the setup PTY needs `TERM/u`) so the one
/// `WSLENV` list carries everything rather than two of them clobbering.
pub(crate) fn pi_account_env(
    ambient: &[(String, String)],
    config_dir: &str,
    inherit_environment_credentials: bool,
    runtime: &str,
    extra_wslenv: &[&str],
) -> Vec<(String, String)> {
    const CLEARED: [&str; 3] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"];
    // Every name comparison here goes through `env_name_eq` for the same
    // reason `scrub_env` does: on Windows `claude_config_dir` and
    // `CLAUDE_CONFIG_DIR` are ONE variable, and a case-sensitive compare would
    // leave an inherited one standing (FR-5) or push a second
    // `PI_CODING_AGENT_DIR` alongside a differently-cased ambient one.
    use crate::process_util::env_name_eq;
    let cleared = |k: &str| CLEARED.iter().any(|c| env_name_eq(c, k));
    let mut out: Vec<(String, String)> = if inherit_environment_credentials {
        ambient
            .iter()
            .filter(|(k, _)| !cleared(k))
            .cloned()
            .collect()
    } else {
        crate::process_util::scrub_env(ambient.iter().cloned())
            .into_iter()
            .filter(|(k, _)| !cleared(k))
            .collect()
    };
    out.retain(|(k, _)| !env_name_eq(k, "PI_CODING_AGENT_DIR"));
    if runtime != "wsl" {
        out.push(("PI_CODING_AGENT_DIR".to_string(), config_dir.to_string()));
        return out;
    }
    let (value, flags) = wsl_config_dir_entry(config_dir);
    out.push(("PI_CODING_AGENT_DIR".to_string(), value));
    let mut entries: Vec<String> = extra_wslenv.iter().map(|e| (*e).to_string()).collect();
    entries.push(format!("PI_CODING_AGENT_DIR{flags}"));
    let refs: Vec<&str> = entries.iter().map(String::as_str).collect();
    // Merged against the list that SURVIVED the filter above, not the ambient
    // one: with `inheritEnvironmentCredentials=false` the scrub already
    // dropped `WSLENV`, and re-importing it here would forward variables this
    // child was deliberately not given.
    let existing = out
        .iter()
        .find(|(k, _)| env_name_eq(k, "WSLENV"))
        .map(|(_, v)| v.clone());
    let merged = crate::wsl::merge_wsl_env(existing.as_deref(), &refs);
    out.retain(|(k, _)| !env_name_eq(k, "WSLENV"));
    out.push(("WSLENV".to_string(), merged));
    out
}

/// The value `PI_CODING_AGENT_DIR` carries across the `wsl.exe` boundary and
/// the `WSLENV` flags that get it there. Three shapes reach this:
///
///  * a WSL UNC path (`\\wsl.localhost\Ubuntu\home\u\.pi`) — a WINDOWS
///    spelling of a directory that already lives in the distro. wsl.exe cannot
///    `/p`-translate a UNC path at all, so the value is rewritten to what the
///    distro itself calls it and passed through with `/u`;
///  * a Linux path — what a `wsl` Pi account stores (FR-1), already in the
///    distro's dialect: `/u`, untouched;
///  * anything else (a drive-letter Windows path): `/p` is what maps it onto
///    `/mnt/…` inside the distro, so `/up`.
fn wsl_config_dir_entry(config_dir: &str) -> (String, &'static str) {
    if let Some((_, linux)) = crate::wsl::wsl_unc_to_linux(config_dir) {
        (linux, "/u")
    } else if config_dir.starts_with('/') {
        (config_dir.to_string(), "/u")
    } else {
        (config_dir.to_string(), "/up")
    }
}

/// The same environment, over THIS process's ambient snapshot — the shape all
/// three Pi spawn sites (the FR-3 setup PTY, the FR-7 refresh probe, and a
/// session's RPC child) actually call, so the login-shell PATH override is
/// resolved identically at each rather than copied three times.
///
/// The PATH override (ext-path-resolution) is applied BEFORE the filter, so
/// the `inheritEnvironmentCredentials=false` branch still gets the resolved
/// value rather than whatever bare PATH a GUI process inherited.
pub(crate) fn pi_spawn_env(
    config_dir: &str,
    inherit_environment_credentials: bool,
    runtime: &str,
    extra_wslenv: &[&str],
) -> Vec<(String, String)> {
    pi_account_env(
        &pi_spawn_ambient(),
        config_dir,
        inherit_environment_credentials,
        runtime,
        extra_wslenv,
    )
}

/// This process's own environment, with the login-shell PATH
/// (ext-path-resolution) folded in — the `ambient` snapshot every Pi spawn
/// site starts from. Separate from `pi_spawn_env` only because
/// `session::adapter::pi::process` pins its own filtering step as a testable,
/// ambient-taking function (see `connect_env` there).
pub(crate) fn pi_spawn_ambient() -> Vec<(String, String)> {
    use crate::process_util::env_name_eq;
    let mut ambient: Vec<(String, String)> = std::env::vars().collect();
    if let Some(path) = crate::process_util::login_shell_path_env() {
        // Replaced under the name the environment ALREADY spells it with: on
        // Windows that is `Path`, and pushing a `PATH` next to it hands the
        // child two spellings of one (case-insensitive) variable.
        let name = ambient
            .iter()
            .find(|(k, _)| env_name_eq(k, "PATH"))
            .map(|(k, _)| k.clone())
            .unwrap_or_else(|| "PATH".to_string());
        ambient.retain(|(k, _)| !env_name_eq(k, "PATH"));
        ambient.push((name, path));
    }
    ambient
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A realistic ambient snapshot: the OS-baseline vars every process
    /// carries alongside provider credentials and other runtimes' config
    /// overrides. A 3-4 var fixture hides a baseline regression (the CRITICAL
    /// this file exists to guard against) because it never gives
    /// `SystemRoot`/`HOME`/`TEMP` a chance to be dropped.
    ///
    /// POSIX casing throughout — `windows_ambient` below is the same snapshot
    /// spelled the way Windows really spells it, which is a DIFFERENT test:
    /// this one would pass under a case-sensitive allowlist match, and that
    /// one is what catches it.
    fn realistic_ambient() -> Vec<(String, String)> {
        vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("HOME".to_string(), "/home/carol".to_string()),
            ("USER".to_string(), "carol".to_string()),
            ("LANG".to_string(), "en_US.UTF-8".to_string()),
            ("TMPDIR".to_string(), "/tmp".to_string()),
            ("SystemRoot".to_string(), "C:\\Windows".to_string()),
            ("windir".to_string(), "C:\\Windows".to_string()),
            ("PATHEXT".to_string(), ".COM;.EXE".to_string()),
            ("COMSPEC".to_string(), "C:\\Windows\\cmd.exe".to_string()),
            (
                "TEMP".to_string(),
                "C:\\Users\\carol\\AppData\\Temp".to_string(),
            ),
            (
                "TMP".to_string(),
                "C:\\Users\\carol\\AppData\\Temp".to_string(),
            ),
            ("USERPROFILE".to_string(), "C:\\Users\\carol".to_string()),
            ("HOMEDRIVE".to_string(), "C:".to_string()),
            ("HOMEPATH".to_string(), "\\Users\\carol".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "secret-claude".to_string()),
            ("OPENAI_API_KEY".to_string(), "secret-openai".to_string()),
            (
                "CLAUDE_CONFIG_DIR".to_string(),
                "/accounts/other".to_string(),
            ),
        ]
    }

    /// The env block a real Windows process carries: `Path`, not `PATH`;
    /// `ComSpec`, not `COMSPEC`. Taken from `cmd.exe /C set` — the casing is
    /// the whole point of the fixture. Gated like the tests that read it:
    /// elsewhere it has no caller, and dead code is an error under CI's lints.
    #[cfg(windows)]
    fn windows_ambient() -> Vec<(String, String)> {
        vec![
            ("Path".to_string(), r"C:\Windows\system32".to_string()),
            ("ComSpec".to_string(), r"C:\Windows\cmd.exe".to_string()),
            ("SystemRoot".to_string(), r"C:\Windows".to_string()),
            (
                "TEMP".to_string(),
                r"C:\Users\carol\AppData\Temp".to_string(),
            ),
            ("USERPROFILE".to_string(), r"C:\Users\carol".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "secret-claude".to_string()),
        ]
    }

    #[test]
    fn no_inherit_keeps_the_os_baseline_but_drops_credentials_and_other_runtime_overrides() {
        let ambient = realistic_ambient();
        let env = pi_account_env(&ambient, "/pi/a", false, "native", &[]);
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(map.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(
            map.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/pi/a")
        );
        assert!(!map.contains_key("ANTHROPIC_API_KEY"));
        assert!(!map.contains_key("OPENAI_API_KEY"));
        assert!(!map.contains_key("CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn no_inherit_still_carries_the_os_baseline_a_windows_child_needs_to_start() {
        // CRITICAL regression guard: a PATH-only baseline leaves a Windows
        // child with no SystemRoot/TEMP/USERPROFILE/HOME, which breaks
        // basic process startup (cmd.exe/DLL search path resolution) —
        // these are not credentials and must survive even with
        // inheritEnvironmentCredentials=false.
        let ambient = realistic_ambient();
        let env = pi_account_env(&ambient, "/pi/a", false, "native", &[]);
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(
            map.get("SystemRoot").map(String::as_str),
            Some("C:\\Windows")
        );
        assert_eq!(map.get("HOME").map(String::as_str), Some("/home/carol"));
        assert_eq!(
            map.get("TEMP").map(String::as_str),
            Some("C:\\Users\\carol\\AppData\\Temp")
        );
        assert_eq!(
            map.get("USERPROFILE").map(String::as_str),
            Some("C:\\Users\\carol")
        );
    }

    #[cfg(windows)]
    #[test]
    fn no_inherit_keeps_the_baseline_under_the_casing_windows_actually_uses() {
        // The regression the POSIX-cased fixture above could never catch: a
        // case-SENSITIVE allowlist match drops `Path` and `ComSpec` outright,
        // so the setup PTY starts with no PATH at all.
        let env = pi_account_env(&windows_ambient(), "/pi/a", false, "native", &[]);
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(
            map.get("Path").map(String::as_str),
            Some(r"C:\Windows\system32"),
            "kept under its own casing"
        );
        assert_eq!(
            map.get("ComSpec").map(String::as_str),
            Some(r"C:\Windows\cmd.exe")
        );
        assert!(!map.contains_key("ANTHROPIC_API_KEY"));
    }

    #[cfg(windows)]
    #[test]
    fn a_differently_cased_ambient_entry_is_still_cleared_and_never_duplicated() {
        // Windows env names are case-insensitive, so these ARE the variables
        // FR-5 clears and the one this function owns.
        let ambient = vec![
            (
                "claude_config_dir".to_string(),
                "/accounts/other".to_string(),
            ),
            ("Pi_Coding_Agent_Dir".to_string(), "/some/other".to_string()),
        ];
        let env = pi_account_env(&ambient, "/pi/real", true, "native", &[]);
        assert!(!env
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("CLAUDE_CONFIG_DIR")));
        let dirs: Vec<&str> = env
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("PI_CODING_AGENT_DIR"))
            .map(|(_, v)| v.as_str())
            .collect();
        assert_eq!(dirs, vec!["/pi/real"]);
    }

    #[test]
    fn inherit_carries_ambient_credentials_but_still_clears_the_other_runtimes_directories() {
        let ambient = vec![
            (
                "SOME_LOCAL_MODEL_KEY".to_string(),
                "local-secret".to_string(),
            ),
            ("CODEX_HOME".to_string(), "/accounts/codex".to_string()),
            ("GROK_HOME".to_string(), "/accounts/grok".to_string()),
        ];
        let env = pi_account_env(&ambient, "/pi/b", true, "native", &[]);
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(
            map.get("SOME_LOCAL_MODEL_KEY").map(String::as_str),
            Some("local-secret"),
            "FR-5: an explicit opt-in inherits the ambient environment"
        );
        assert!(
            !map.contains_key("CODEX_HOME"),
            "FR-5: Claude/Codex/Grok config overrides are cleared either way"
        );
        assert!(!map.contains_key("GROK_HOME"));
        assert_eq!(
            map.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/pi/b")
        );
    }

    #[test]
    fn two_accounts_from_the_same_ambient_snapshot_never_cross_each_others_directory() {
        // pi-provider-auth FR-5 acceptance: "tested for cross-account leakage".
        let ambient = vec![("PATH".to_string(), "/usr/bin".to_string())];
        let a = pi_account_env(&ambient, "/pi/a", false, "native", &[]);
        let b = pi_account_env(&ambient, "/pi/b", false, "native", &[]);
        let dir_of = |env: &[(String, String)]| {
            env.iter()
                .find(|(k, _)| k == "PI_CODING_AGENT_DIR")
                .map(|(_, v)| v.clone())
        };
        assert_eq!(dir_of(&a), Some("/pi/a".to_string()));
        assert_eq!(dir_of(&b), Some("/pi/b".to_string()));
        assert_ne!(dir_of(&a), dir_of(&b));
    }

    #[test]
    fn a_stale_ambient_pi_dir_entry_is_never_carried_through() {
        // Defensive: even if the ambient snapshot somehow already carried a
        // PI_CODING_AGENT_DIR (a nested spawn, an inherited shell), the
        // account's OWN directory always wins and is never duplicated.
        let ambient = vec![(
            "PI_CODING_AGENT_DIR".to_string(),
            "/some/other/dir".to_string(),
        )];
        let env = pi_account_env(&ambient, "/pi/real", true, "native", &[]);
        let dirs: Vec<&str> = env
            .iter()
            .filter(|(k, _)| k == "PI_CODING_AGENT_DIR")
            .map(|(_, v)| v.as_str())
            .collect();
        assert_eq!(dirs, vec!["/pi/real"]);
    }

    // ---------- PR #142 §5: the same environment, across the WSL boundary ----------
    //
    // A variable set on the Windows side does NOT reach a `wsl.exe` child on
    // its own: `WSLENV` is what names the ones that cross. Without an entry
    // here, a WSL Pi account's spawn ran against the distro's AMBIENT Pi
    // directory — a different account's credentials, silently.

    fn map_of(env: Vec<(String, String)>) -> std::collections::HashMap<String, String> {
        env.into_iter().collect()
    }

    #[test]
    fn a_native_spawn_never_gains_a_wslenv_entry() {
        // The unchanged half: `runtime: 'native'` is byte-identical on every
        // platform, `extra_wslenv` or not — those entries only mean anything
        // to `wsl.exe`.
        let ambient = vec![("PATH".to_string(), "/usr/bin".to_string())];
        let native = pi_account_env(&ambient, "/pi/a", false, "native", &["TERM/u"]);
        assert!(!native.iter().any(|(k, _)| k == "WSLENV"));
        assert_eq!(
            native,
            pi_account_env(&ambient, "/pi/a", false, "native", &[])
        );
    }

    #[test]
    fn a_wsl_spawn_names_the_pi_directory_in_wslenv_and_keeps_it_a_linux_path() {
        // The account's configDir is a path INSIDE the distro, so it needs no
        // translation — `/u` passes the value through untouched. A `/p` here
        // would mangle it into a `/mnt/…` spelling of a Windows path that does
        // not exist.
        let ambient = vec![("PATH".to_string(), "/usr/bin".to_string())];
        let map = map_of(pi_account_env(
            &ambient,
            "/home/u/.pi",
            false,
            "wsl",
            &["TERM/u"],
        ));
        assert_eq!(
            map.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/home/u/.pi")
        );
        let entries: Vec<&str> = map["WSLENV"].split(':').collect();
        assert!(entries.contains(&"PI_CODING_AGENT_DIR/u"), "{entries:?}");
        assert!(
            entries.contains(&"TERM/u"),
            "the caller's own entry survives"
        );
    }

    #[test]
    fn a_wsl_spawn_asks_for_translation_only_for_a_windows_side_directory() {
        // A drive-letter configDir IS a Windows path — `/p` is what turns it
        // into the `/mnt/d/…` the distro can open.
        let map = map_of(pi_account_env(&[], "D:\\pi\\home", false, "wsl", &[]));
        assert_eq!(
            map.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("D:\\pi\\home")
        );
        assert!(map["WSLENV"]
            .split(':')
            .any(|e| e == "PI_CODING_AGENT_DIR/up"));
    }

    #[test]
    fn a_unc_spelling_of_an_in_distro_directory_crosses_as_its_linux_path() {
        // `\\wsl.localhost\Ubuntu\home\u\.pi` is a Windows spelling of a path
        // that already lives in the distro: wsl.exe cannot `/p`-translate a UNC
        // path at all, so the value is rewritten to what the distro calls it.
        let map = map_of(pi_account_env(
            &[],
            "\\\\wsl.localhost\\Ubuntu\\home\\u\\.pi",
            false,
            "wsl",
            &[],
        ));
        assert_eq!(
            map.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/home/u/.pi")
        );
        assert!(map["WSLENV"]
            .split(':')
            .any(|e| e == "PI_CODING_AGENT_DIR/u"));
    }

    #[test]
    fn an_inherited_wslenv_list_is_merged_never_clobbered_and_is_scrubbed_by_default() {
        let ambient = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("WSLENV".to_string(), "FOO/u".to_string()),
        ];
        // inherit: the user's own forwarding survives alongside ours.
        let inherited = map_of(pi_account_env(&ambient, "/home/u/.pi", true, "wsl", &[]));
        let entries: Vec<&str> = inherited["WSLENV"].split(':').collect();
        assert!(entries.contains(&"FOO/u"), "{entries:?}");
        assert!(entries.contains(&"PI_CODING_AGENT_DIR/u"), "{entries:?}");
        // no-inherit: `WSLENV` is not on the allowlist, so the ambient list is
        // gone and the child crosses with exactly the entry we put there.
        let scrubbed = map_of(pi_account_env(&ambient, "/home/u/.pi", false, "wsl", &[]));
        assert_eq!(scrubbed["WSLENV"], "PI_CODING_AGENT_DIR/u");
    }

    #[test]
    fn pi_spawn_env_carries_exactly_one_path_variable() {
        // The login-shell PATH override must REPLACE the inherited entry, not
        // sit next to it: on Windows the ambient name is `Path`, so replacing
        // `PATH` case-sensitively left the child with two spellings of one
        // variable and no guarantee which one it reads.
        let env = pi_spawn_env("/pi/a", false, "native", &[]);
        let paths = env
            .iter()
            .filter(|(k, _)| crate::process_util::env_name_eq(k, "PATH"))
            .count();
        assert!(paths <= 1, "{env:?}");
        assert!(env
            .iter()
            .any(|(k, v)| k == "PI_CODING_AGENT_DIR" && v == "/pi/a"));
    }
}
