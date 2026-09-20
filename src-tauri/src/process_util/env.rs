//! The environment half of the spawn facade (core-architecture-wave3 FR-7):
//! WHAT a scrubbed child may keep, and how two environment variable names are
//! compared at all. Split out of `process_util.rs` for CLAUDE.md's ~1000-line
//! file cap — the facade methods that APPLY this (`scrubbed_env`/`exact_env`)
//! stay in the parent, which is also the only file in the crate allowed to
//! clear a child's environment.

/// The allowlist a scrubbed child keeps. Everything else — API keys, tokens,
/// `ANTHROPIC_*`, the user's whole shell environment — is dropped, so a
/// third-party binary this app spawns on the user's behalf cannot read a
/// credential out of its own environment. `PATH` is a member, so overriding it
/// with the login shell's is a value change rather than a widening.
///
/// Spelled in the POSIX casing; [`env_name_eq`] is what makes the Windows
/// spellings (`Path`, `ComSpec`, …) members of it too.
pub const ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "TMPDIR",
    "SystemRoot",
    "windir",
    "PATHEXT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
];

/// Do these two environment variable NAMES refer to the same variable?
///
/// Windows' environment block is case-INSENSITIVE, and the names it really
/// carries are `Path` and `ComSpec` — not `PATH`/`COMSPEC`. Comparing them
/// case-sensitively dropped both from every scrubbed child on Windows, which
/// leaves it with no PATH at all (so a bare `argv0` cannot resolve) and no
/// `ComSpec` (so nothing that shells out can find `cmd.exe`). Everywhere else
/// names are case-SENSITIVE — `Path` and `PATH` are two different variables
/// there — so the comparison stays exact.
pub fn env_name_eq(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// The pure half of the scrub: keep only [`ENV_ALLOWLIST`] members, in order
/// and under the name the environment actually spells them with — a kept
/// `Path` goes to the child as `Path`, never renamed to `PATH`.
pub fn scrub_env<I: IntoIterator<Item = (String, String)>>(vars: I) -> Vec<(String, String)> {
    vars.into_iter()
        .filter(|(k, _)| ENV_ALLOWLIST.iter().any(|a| env_name_eq(a, k)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scrub is the security-relevant half: a secret in this process's
    /// environment must not reach a child spawned on the user's behalf.
    #[test]
    fn scrubbing_keeps_the_allowlist_and_drops_everything_else() {
        let kept = scrub_env([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "sk-leak".to_string()),
            ("HOME".to_string(), "/home/u".to_string()),
        ]);
        assert_eq!(
            kept,
            vec![
                ("PATH".to_string(), "/usr/bin".to_string()),
                ("HOME".to_string(), "/home/u".to_string()),
            ]
        );
    }

    /// The names Windows really uses, matched the way that platform names
    /// them — and NOT matched anywhere else, where they are different
    /// variables from the allowlisted ones.
    #[test]
    fn the_windows_spelling_of_a_member_is_kept_on_windows_and_only_there() {
        let kept = scrub_env([
            ("Path".to_string(), r"C:\Windows".to_string()),
            ("ComSpec".to_string(), r"C:\Windows\cmd.exe".to_string()),
            ("Anthropic_Api_Key".to_string(), "sk-leak".to_string()),
        ]);
        if cfg!(windows) {
            assert_eq!(
                kept.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
                vec!["Path", "ComSpec"],
                "kept under their own casing, and a credential is still dropped"
            );
        } else {
            assert!(kept.is_empty(), "case-sensitive off Windows: {kept:?}");
        }
    }

    #[test]
    fn name_comparison_follows_the_platform() {
        assert!(env_name_eq("PATH", "PATH"));
        assert!(!env_name_eq("PATH", "PATHEXT"));
        assert_eq!(env_name_eq("PATH", "Path"), cfg!(windows));
    }
}
