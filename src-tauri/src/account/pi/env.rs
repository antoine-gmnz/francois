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
/// Called from `setup::spawn_pi_setup` (the FR-3 setup PTY) today.
/// `session::adapter::pi::process::spawn` — the session-scoped RPC connect
/// this function is EQUALLY meant for — still builds its child's environment
/// unfiltered: `RuntimeConnectContext` carries no `configDir`/
/// `inheritEnvironmentCredentials` yet, and its only caller,
/// `connect_runtime` (session/runtime.rs), is itself still
/// `#[allow(dead_code)]` — no production path creates a live Pi session
/// today, so there is no real construction site to thread those two fields
/// through yet. Wire this in (add the two fields to `RuntimeConnectContext`,
/// populate them from `config_dir_of`/a new Pi-specific accessor at that
/// construction site, and call `crate::account::pi_account_env` in
/// `process::spawn`) in the SAME change that gives `connect_runtime` its
/// first real caller — see this feature's handoff. This function is
/// unit-tested on its own so FR-5's isolation rule has coverage now rather
/// than only once that wiring lands.
pub(crate) fn pi_account_env(
    ambient: &[(String, String)],
    config_dir: &str,
    inherit_environment_credentials: bool,
) -> Vec<(String, String)> {
    const CLEARED: [&str; 3] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"];
    let mut out: Vec<(String, String)> = if inherit_environment_credentials {
        ambient
            .iter()
            .filter(|(k, _)| !CLEARED.contains(&k.as_str()))
            .cloned()
            .collect()
    } else {
        crate::process_util::scrub_env(ambient.iter().cloned())
            .into_iter()
            .filter(|(k, _)| !CLEARED.contains(&k.as_str()))
            .collect()
    };
    out.retain(|(k, _)| k != "PI_CODING_AGENT_DIR");
    out.push(("PI_CODING_AGENT_DIR".to_string(), config_dir.to_string()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A realistic ambient snapshot: the OS-baseline vars every process
    /// carries (Windows and POSIX both represented) alongside provider
    /// credentials and other runtimes' config overrides. A 3-4 var fixture
    /// hides a baseline regression (the CRITICAL this file exists to guard
    /// against) because it never gives `SystemRoot`/`HOME`/`TEMP` a chance
    /// to be dropped.
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

    #[test]
    fn no_inherit_keeps_the_os_baseline_but_drops_credentials_and_other_runtime_overrides() {
        let ambient = realistic_ambient();
        let env = pi_account_env(&ambient, "/pi/a", false);
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
        let env = pi_account_env(&ambient, "/pi/a", false);
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
        let env = pi_account_env(&ambient, "/pi/b", true);
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
        let a = pi_account_env(&ambient, "/pi/a", false);
        let b = pi_account_env(&ambient, "/pi/b", false);
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
        let env = pi_account_env(&ambient, "/pi/real", true);
        let dirs: Vec<&str> = env
            .iter()
            .filter(|(k, _)| k == "PI_CODING_AGENT_DIR")
            .map(|(_, v)| v.as_str())
            .collect();
        assert_eq!(dirs, vec!["/pi/real"]);
    }
}
