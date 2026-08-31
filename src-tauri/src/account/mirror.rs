// account/mirror.rs — seeding a per-account CLAUDE_CONFIG_DIR from the user's
// global `~/.claude`.
//
// WHY: an added account is nothing but a `CLAUDE_CONFIG_DIR` override (mod.rs),
// and that env var REPLACES the user config root wholesale — it does not layer
// on top of `~/.claude`. So a freshly minted `<app_data>/accounts/<id>/` starts
// blind: no slash commands, no subagents, no skills, no hooks, no settings. The
// intent of multi-account was to isolate CREDENTIALS, not the user's whole
// toolbox, so every account dir gets the shared entries linked back to the
// global root.
//
// SYMLINKS, not copies, on purpose: the global root is the single install the
// user maintains (`npx cohorte install --global` and friends), so an update
// there must be visible from every account without a re-seed.
//
// Best-effort throughout — a failure to mirror degrades an account to the
// pre-mirror behaviour and must never fail the login that triggered it.

use std::path::{Path, PathBuf};

/// The entries of the global root an account inherits. An explicit ALLOWLIST,
/// never "everything in `~/.claude`": the per-account state lives under the same
/// names (`sessions/`, `projects/`, `.claude.json`, `history.jsonl`, `cache/`)
/// and linking those back would re-merge exactly what an account exists to keep
/// apart.
pub const MIRRORED: &[&str] = &[
    "commands",
    "agents",
    "skills",
    "templates",
    "pipeline",
    "workflows",
    "hooks",
    "plugins",
    "settings.json",
];

/// The user's global config root — `~/.claude`, resolved from the HOME dir and
/// NOT from `CLAUDE_CONFIG_DIR`, which may already point at an account when the
/// app itself was launched from one.
pub fn global_config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}

/// Which of `MIRRORED` this account still needs: present in the global root,
/// absent from the account dir. An entry the account already owns is NEVER
/// touched — that is what makes a backfill safe to run on every load and keeps
/// an account's own `settings.json` (theme, model) from being replaced by a
/// link to the global one. Pure; the caller supplies both listings.
pub fn pending<'a>(source_has: &[&'a str], target_has: &[&str]) -> Vec<&'a str> {
    MIRRORED
        .iter()
        .filter_map(|name| source_has.iter().find(|s| *s == name).copied())
        .filter(|name| !target_has.contains(name))
        .collect()
}

/// Link every missing shared entry from the global root into `config_dir`.
/// Best-effort: a missing global root, an unreadable dir, or a refused symlink
/// all leave the account exactly as it was.
pub fn mirror_global(config_dir: &Path) {
    let Some(source) = global_config_dir() else {
        return;
    };
    // The built-in `default` account IS the global root (it passes no override).
    // Linking a directory into itself would be a cycle, so refuse it — compare
    // canonicalized, since the account path arrives from a `join` and the global
    // one from HOME, which may differ by symlink (/var vs /private/var on macOS).
    if same_dir(&source, config_dir) {
        return;
    }
    let source_names = entry_names(&source);
    let target_names = entry_names(config_dir);
    let source_refs: Vec<&str> = source_names.iter().map(String::as_str).collect();
    let target_refs: Vec<&str> = target_names.iter().map(String::as_str).collect();
    for name in pending(&source_refs, &target_refs) {
        let _ = link_entry(&source.join(name), &config_dir.join(name));
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        // An un-canonicalizable path does not exist yet, so it cannot be the
        // global root; fall back to the literal comparison.
        _ => a == b,
    }
}

/// The immediate entry names of a directory. An unreadable or missing dir reads
/// as empty rather than an error — the caller degrades, never fails.
fn entry_names(dir: &Path) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

/// Does `path` already exist, INCLUDING as a broken symlink? `Path::exists`
/// follows links and would report a dangling one as absent, so a backfill would
/// try to re-create it on every load and fail on every load.
fn occupied(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

#[cfg(unix)]
fn link_entry(source: &Path, target: &Path) -> std::io::Result<()> {
    if occupied(target) {
        return Ok(());
    }
    std::os::unix::fs::symlink(source, target)
}

/// Windows has no unprivileged symlink: `CreateSymbolicLink` needs Developer
/// Mode or SeCreateSymbolicLinkPrivilege, and Francois ships unsigned and
/// per-user. A directory JUNCTION needs neither, so directories get one; a file
/// (`settings.json`) cannot be a junction and is COPIED instead — which means
/// it snapshots rather than tracking the global file on Windows.
#[cfg(windows)]
fn link_entry(source: &Path, target: &Path) -> std::io::Result<()> {
    if occupied(target) {
        return Ok(());
    }
    if source.is_file() {
        return std::fs::copy(source, target).map(|_| ());
    }
    let status = crate::process_util::spawn("cmd")
        .arg("/c")
        .arg("mklink")
        .arg("/J")
        .arg(target)
        .arg(source)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "mklink /J refused {}",
            target.display()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("francois-mirror-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pending_takes_only_allowlisted_entries_the_source_actually_has() {
        let source = [
            "commands",
            "skills",
            "sessions",
            "projects",
            "history.jsonl",
        ];
        let got = pending(&source, &[]);
        assert_eq!(got, vec!["commands", "skills"]);
        // per-account state is never mirrored back, even when both sides have it
        assert!(!got.contains(&"sessions"));
        assert!(!got.contains(&"projects"));
        assert!(!got.contains(&"history.jsonl"));
    }

    #[test]
    fn pending_never_reclaims_an_entry_the_account_already_owns() {
        // the backfill runs on EVERY load, so an account's own settings.json (its
        // theme, its model) must survive rather than be replaced by a link.
        let source = ["commands", "agents", "settings.json"];
        assert_eq!(
            pending(&source, &["settings.json"]),
            vec!["commands", "agents"]
        );
        assert!(pending(&source, &["commands", "agents", "settings.json"]).is_empty());
    }

    #[test]
    fn pending_is_empty_when_there_is_no_global_root_to_mirror() {
        assert!(pending(&[], &[]).is_empty());
        assert!(pending(&[], &["commands"]).is_empty());
    }

    #[test]
    fn mirroring_links_the_missing_entries_and_leaves_the_rest_alone() {
        let root = tmp("links");
        let source = root.join("global");
        let target = root.join("account");
        std::fs::create_dir_all(source.join("commands")).unwrap();
        std::fs::write(source.join("commands").join("brainstorm.md"), b"x").unwrap();
        std::fs::create_dir_all(source.join("sessions")).unwrap();
        std::fs::write(source.join("settings.json"), b"{\"theme\":\"dark\"}").unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("settings.json"), b"{\"theme\":\"light\"}").unwrap();

        let source_names = entry_names(&source);
        let refs: Vec<&str> = source_names.iter().map(String::as_str).collect();
        for name in pending(
            &refs,
            &entry_names(&target)
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        ) {
            link_entry(&source.join(name), &target.join(name)).unwrap();
        }

        // the shared dir is reachable THROUGH the account dir…
        assert!(target.join("commands").join("brainstorm.md").is_file());
        // …the account's own settings.json is untouched…
        assert_eq!(
            std::fs::read_to_string(target.join("settings.json")).unwrap(),
            "{\"theme\":\"light\"}"
        );
        // …and per-account state was not dragged across.
        assert!(!occupied(&target.join("sessions")));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mirroring_refuses_to_link_the_global_root_into_itself() {
        // the built-in `default` account IS ~/.claude; a self-link would be a cycle
        let root = tmp("self");
        std::fs::create_dir_all(root.join("commands")).unwrap();
        assert!(same_dir(&root, &root));
        mirror_global(&root);
        assert!(!occupied(&root.join("commands").join("commands")));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_missing_or_unreadable_directory_reads_as_empty_rather_than_failing() {
        assert!(entry_names(Path::new("/francois/no/such/dir")).is_empty());
    }
}
