//! the git runner and wsl-filesystem FR-5 routing (host, cwd, repo cache).

use super::*;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::wsl;

/// Run `git <args>` in cwd with an argv array (never a shell string — FR-13).
pub fn git(cwd: &str, args: &[&str]) -> std::io::Result<GitOut> {
    let out = crate::process_util::spawn("git")
        .args(args)
        .current_dir(cwd)
        .output()?;
    Ok(GitOut {
        code: out.status.code().unwrap_or(-1),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

pub type GitErr = crate::ipc::AppError;

// ---------- wsl-filesystem FR-5 git routing ----------
//
// "Git follows the filesystem. The shell and claude follow the runtime." — every
// git op below routes on whether the REPO lives on a WSL UNC path, never on the
// claude runtime. `GitHost` is derived ONCE per operation from the session cwd
// (`GitHost::of`, called by `repo_info`/`diff_stage_all`/`diff_commit`) and
// threaded through explicitly from there — deliberately NOT re-derived from
// whatever `dir` string a given call happens to receive, because a WSL repo's
// cached root (from `--show-toplevel`, a Linux path like `/home/u/api`) would
// misclassify as Native if you asked `is_wsl_unc_path` about it directly.

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum GitHost {
    Native,
    /// The repo lives in the named distro (from the UNC cwd). Carried here so
    /// every spawn passes `-d <distro>` — bare `wsl.exe` targets the machine's
    /// DEFAULT distro, which is wrong whenever the repo lives in another one
    /// (docker-desktop-as-default machines, multi-distro setups).
    Wsl(String),
}

impl GitHost {
    /// Derived once from the session cwd — see the module note above.
    pub fn of(cwd: &str) -> Self {
        match wsl::wsl_unc_to_linux(cwd) {
            Some((distro, _)) => GitHost::Wsl(distro),
            None => GitHost::Native,
        }
    }
}

/// Normalizes a routing `dir` under the Wsl host into the Linux path `--cd` needs:
/// translates a WSL UNC path (FR-2), or passes a Linux path through unchanged (a
/// repo root previously returned verbatim by `--show-toplevel`, which by
/// construction never matches the WSL UNC prefixes). Idempotent either way, so
/// every call site can just pass "whatever dir it has" — the session cwd on the
/// first probe, the cached root afterwards — without tracking which form it is.
pub fn wsl_cd_target(dir: &str) -> String {
    wsl::wsl_unc_to_linux(dir)
        .map(|(_, linux)| linux)
        .unwrap_or_else(|| dir.to_string())
}

/// Pure: the exact (program, argv) `git_routed` runs for `dir` under `host`
/// (FR-5). Native is untouched — `("git", args)` — matching exactly what the
/// pre-existing `git()` runner spawns with `current_dir(dir)` (regression-pinned
/// by tests: the native branch must stay byte-identical to v0.2.1, spec §9). Wsl
/// wraps as `wsl.exe -d <distro> --cd <dir> -- git <args…>` — `-d` because bare
/// wsl.exe targets the default distro, not necessarily the repo's.
pub fn git_program(host: &GitHost, dir: &str, args: &[&str]) -> (String, Vec<String>) {
    match host {
        GitHost::Native => (
            "git".to_string(),
            args.iter().map(|s| s.to_string()).collect(),
        ),
        GitHost::Wsl(distro) => {
            let mut argv = vec![
                "-d".to_string(),
                distro.clone(),
                "--cd".to_string(),
                wsl_cd_target(dir),
                "--".to_string(),
                "git".to_string(),
            ];
            argv.extend(args.iter().map(|s| s.to_string()));
            ("wsl.exe".to_string(), argv)
        }
    }
}

/// Run `git <args>` against `dir` under `host` (FR-5 routing). Native delegates to
/// the pre-existing `git()` runner UNCHANGED — same spawn, same behavior. Wsl
/// spawns `git_program`'s argv with NO `current_dir` set: `dir` is a Linux path,
/// meaningless as wsl.exe's own Windows-side working directory (confirmed live: a
/// WSL UNC path handed to `--cd` raw is rejected with `Wsl/E_INVALIDARG`) — `--cd`
/// alone positions the git invocation inside the distro. Output decoding: git
/// inside the distro prints UTF-8, but wsl.exe reports its OWN failures (unknown
/// distro, bad --cd, WSL not installed) in UTF-16LE — and on stdout — so a failed
/// spawn with an empty stderr surfaces the decoded stdout as the error text
/// instead of NUL-interleaved garbage (or nothing).
pub fn git_routed(host: &GitHost, dir: &str, args: &[&str]) -> std::io::Result<GitOut> {
    match host {
        GitHost::Native => git(dir, args),
        GitHost::Wsl(_) => {
            let (program, argv) = git_program(host, dir, args);
            let out = crate::process_util::spawn(program).args(&argv).output()?;
            let code = out.status.code().unwrap_or(-1);
            let mut stderr = wsl::decode_wsl_output(&out.stderr);
            if code != 0 && stderr.is_empty() && out.stdout.contains(&0) {
                stderr = wsl::decode_wsl_output(&out.stdout);
            }
            Ok(GitOut {
                code,
                stdout: out.stdout,
                stderr,
            })
        }
    }
}

pub fn is_git_repo(host: &GitHost, cwd: &str) -> bool {
    matches!(git_routed(host, cwd, &["rev-parse", "--is-inside-work-tree"]), Ok(o) if o.code == 0 && String::from_utf8_lossy(&o.stdout).trim() == "true")
}

/// HEAD when the repo has a commit, else the empty-tree object (FR-2).
pub fn diff_base(host: &GitHost, cwd: &str) -> String {
    match git_routed(host, cwd, &["rev-parse", "--verify", "-q", "HEAD"]) {
        Ok(o) if o.code == 0 => "HEAD".into(),
        _ => EMPTY_TREE.into(),
    }
}

/// The worktree top level for a cwd, so all git commands run from the same base and
/// their repo-root-relative paths agree even when the session cwd is a subdirectory.
/// Falls back to cwd if resolution fails. For a WSL repo this is a **Linux** path
/// (wsl-filesystem FR-6) — stored verbatim by `repo_info` and reused directly as
/// the `--cd` target for every subsequent op on that repo.
pub fn repo_root(host: &GitHost, cwd: &str) -> String {
    // Fallbacks return the cwd in the HOST's path dialect: for a Wsl host the
    // "root is a Linux path" invariant must hold even here — untracked_counts
    // joins `<root>/<path>` and translates via linux_to_wsl_unc, which would
    // produce garbage from a raw \\wsl$ UNC cwd (review finding, wsl-filesystem).
    let fallback = || match host {
        GitHost::Wsl(_) => wsl_cd_target(cwd),
        GitHost::Native => cwd.to_string(),
    };
    match git_routed(host, cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(o) if o.code == 0 => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                fallback()
            } else {
                s
            }
        }
        _ => fallback(),
    }
}

/// Cache of `cwd -> (host, worktree_root, stable_base)`. `git.exe`/`wsl.exe` spawn
/// overhead is ~100ms+ on Windows, and every diff op needs the root + base; without
/// caching, each `getFileDiff` fires 3 separate rev-parse probes before it even runs
/// the diff. The root of a cwd never changes, and neither does its host (a session's
/// cwd doesn't move between the Windows and WSL filesystems mid-session). `stable_base`
/// holds `Some("HEAD")` once a commit exists (HEAD never reverts to no-commits in
/// practice, so it's safe to pin); for a commit-less repo it stays `None` and the base
/// is recomputed each call (cheap, rare, and self-corrects to `HEAD` on the first commit).
pub static REPO_CACHE: OnceLock<Mutex<HashMap<String, (GitHost, String, Option<String>)>>> =
    OnceLock::new();

/// `(host, root, base)` for a cwd, or `None` if it isn't a git worktree. Serves the
/// common case (a repo with commits) entirely from cache after the first call — zero
/// git/wsl spawns. `host` is derived ONCE here (wsl-filesystem FR-5) from the raw
/// session `cwd` — never re-derived from `root`, which for a WSL repo is already a
/// Linux path by the time it's cached (see the FR-5 routing note above).
pub fn repo_info(cwd: &str) -> Option<(GitHost, String, String)> {
    let cache = REPO_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((host, root, stable_base)) = cache.lock().unwrap().get(cwd).cloned() {
        let base = stable_base.unwrap_or_else(|| diff_base(&host, &root));
        return Some((host, root, base));
    }
    let host = GitHost::of(cwd);
    if !is_git_repo(&host, cwd) {
        return None;
    }
    let root = repo_root(&host, cwd);
    let base = diff_base(&host, &root);
    let stable = (base == "HEAD").then(|| "HEAD".to_string());
    cache
        .lock()
        .unwrap()
        .insert(cwd.to_string(), (host.clone(), root.clone(), stable));
    Some((host, root, base))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- wsl-filesystem FR-5 routing ----

    #[test]
    fn git_host_of_routes_on_cwd_shape_alone() {
        // "the claude runtime is irrelevant" (spec FR-5) — GitHost::of only ever
        // looks at the cwd string.
        assert_eq!(GitHost::of("D:\\repo"), GitHost::Native);
        // The distro rides along in the host (multi-distro remediation): -d must
        // name the repo's distro, not whatever the machine's default happens to be.
        assert_eq!(
            GitHost::of("\\\\wsl$\\Ubuntu\\home\\u\\api"),
            GitHost::Wsl("Ubuntu".into())
        );
        assert_eq!(
            GitHost::of("\\\\wsl.localhost\\Debian\\home\\u"),
            GitHost::Wsl("Debian".into())
        );
        assert_eq!(GitHost::of("/mnt/c/Users/u"), GitHost::Native); // not a WSL UNC path (FR-1)
    }

    #[test]
    fn git_program_native_is_byte_identical_to_pre_wsl_filesystem_argv() {
        // Regression pin (spec §9 last bullet): native-runtime drive-letter sessions
        // must keep producing byte-identical git invocations.
        let (prog, args) = git_program(
            &GitHost::Native,
            "D:\\repo",
            &["status", "--porcelain=v1", "-z"],
        );
        assert_eq!(prog, "git");
        assert_eq!(args, vec!["status", "--porcelain=v1", "-z"]);
    }

    #[test]
    fn git_program_wsl_wraps_with_distro_and_cd_and_translates_a_unc_cwd() {
        let (prog, args) = git_program(
            &GitHost::Wsl("Ubuntu".into()),
            "\\\\wsl$\\Ubuntu\\home\\u\\api",
            &["status", "--porcelain=v1"],
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
                "git",
                "status",
                "--porcelain=v1"
            ]
        );
    }

    #[test]
    fn git_program_wsl_passes_a_cached_linux_repo_root_through_verbatim() {
        // A repo root returned by a prior `--show-toplevel` (FR-6) is already Linux —
        // it must NOT be run through FR-2 translation again (it wouldn't match the
        // WSL UNC prefixes anyway, so this is also just wsl_cd_target's idempotence).
        let (prog, args) = git_program(
            &GitHost::Wsl("Ubuntu".into()),
            "/home/u/api",
            &["diff", "--numstat"],
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
                "git",
                "diff",
                "--numstat"
            ]
        );
    }

    #[test]
    fn wsl_cd_target_translates_unc_and_passes_linux_paths_through() {
        assert_eq!(
            wsl_cd_target("\\\\wsl$\\Ubuntu\\home\\u\\api"),
            "/home/u/api"
        );
        assert_eq!(wsl_cd_target("/home/u/api"), "/home/u/api");
    }

    // ---- session-worktree FR-21: repo_info from inside a LINKED worktree ----
    // (a linked worktree's `.git` is a FILE, not a directory — `--show-toplevel`
    // must still resolve to the worktree's own root, not the main repo's.)

    /// Windows CI runners can alias a long account name to its DOS 8.3 short
    /// form in `%TEMP%` (e.g. `runneradmin` -> `RUNNER~1`), while git resolves
    /// `--show-toplevel` to the long form — canonicalize before comparing so
    /// the two spellings of the same path don't spuriously differ.
    fn canonical_lower(p: &std::path::Path) -> String {
        let c = std::fs::canonicalize(p).expect("canonicalize");
        let s = c.to_string_lossy().replace('\\', "/");
        s.strip_prefix("//?/")
            .unwrap_or(&s)
            .trim_end_matches('/')
            .to_lowercase()
    }

    #[test]
    fn repo_info_resolves_a_linked_worktrees_own_root() {
        fn git(dir: &std::path::Path, args: &[&str]) {
            let status = crate::process_util::spawn("git")
                .args(args)
                .current_dir(dir)
                .status()
                .expect("git spawn");
            assert!(status.success(), "git {args:?} failed in {dir:?}");
        }

        let base = std::env::temp_dir().join(format!(
            "francois-repoinfo-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        git(&base, &["init", "-q", "-b", "main"]);
        git(&base, &["config", "user.email", "t@example.com"]);
        git(&base, &["config", "user.name", "Test"]);
        std::fs::write(base.join("a.txt"), "hi").unwrap();
        git(&base, &["add", "."]);
        git(&base, &["commit", "-q", "-m", "init"]);

        let wt_path = base.parent().unwrap().join(format!(
            "{}-wt",
            base.file_name().unwrap().to_string_lossy()
        ));
        let wt_str = wt_path.to_string_lossy().to_string();
        git(&base, &["worktree", "add", "-b", "feat/x", &wt_str, "main"]);

        // The linked worktree's `.git` is a FILE (pointer), not a directory.
        assert!(wt_path.join(".git").is_file());

        let cwd = wt_str;
        let (host, root, _base) = repo_info(&cwd).expect("repo_info resolves");
        assert_eq!(host, GitHost::Native);
        // The resolved root is the WORKTREE's own root, not the main repo's.
        assert_eq!(
            root.trim_end_matches('/').to_lowercase(),
            canonical_lower(&wt_path)
        );
    }

    /// The WSL-host half of `repo_info_resolves_a_linked_worktrees_own_root`
    /// above (FR-21/acceptance §9: "covered by a test on each host"). `#[ignore]`
    /// because it needs a real, running WSL distro reachable at `\\wsl$\<distro>`
    /// — run manually with:
    ///   cargo test --  --ignored repo_info_resolves_a_linked_worktrees_own_root_on_wsl --nocapture
    #[test]
    #[ignore = "live: needs a running WSL distro reachable at \\\\wsl$\\<distro>"]
    fn repo_info_resolves_a_linked_worktrees_own_root_on_wsl() {
        fn git(dir: &std::path::Path, args: &[&str]) {
            let status = crate::process_util::spawn("git")
                .args(args)
                .current_dir(dir)
                .status()
                .expect("git spawn");
            assert!(status.success(), "git {args:?} failed in {dir:?}");
        }

        let Some(root_unc) = wsl::wsl_unc_root(None) else {
            eprintln!("skipping: no WSL distro reachable at \\\\wsl$\\/\\\\wsl.localhost\\");
            return;
        };
        let Some((distro, _)) = wsl::wsl_unc_to_linux(&root_unc) else {
            eprintln!("skipping: could not determine the default distro's name from {root_unc}");
            return;
        };

        let base = std::path::Path::new(&root_unc).join(format!(
            "tmp/francois-repoinfo-wsl-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        git(&base, &["init", "-q", "-b", "main"]);
        git(&base, &["config", "user.email", "t@example.com"]);
        git(&base, &["config", "user.name", "Test"]);
        std::fs::write(base.join("a.txt"), "hi").unwrap();
        git(&base, &["add", "."]);
        git(&base, &["commit", "-q", "-m", "init"]);

        let wt_path = base.parent().unwrap().join(format!(
            "{}-wt",
            base.file_name().unwrap().to_string_lossy()
        ));
        let wt_str = wt_path.to_string_lossy().to_string();
        git(
            &base,
            &["worktree", "add", "-b", "feat/wsl-x", &wt_str, "main"],
        );

        // The linked worktree's `.git` is a FILE (pointer), not a directory —
        // same shape as the native case, just mounted through the WSL UNC path.
        assert!(wt_path.join(".git").is_file());

        let cwd = wt_str;
        let (host, root, _base) = repo_info(&cwd).expect("repo_info resolves");
        assert_eq!(host, GitHost::Wsl(distro));
        // The resolved root is the WORKTREE's own Linux-dialect root, not the
        // main repo's — mirrors the native assertion above, translated to the
        // Linux path `--show-toplevel` returns from inside the distro.
        let (_, wt_linux) = wsl::wsl_unc_to_linux(&cwd).expect("wt cwd is a wsl unc path");
        assert_eq!(root.trim_end_matches('/'), wt_linux.trim_end_matches('/'));
    }
}
