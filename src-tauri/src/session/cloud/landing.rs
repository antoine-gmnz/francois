//! FR-4 / FR-11 — where an adoption lands on disk, and everything this run must
//! be able to undo.
//!
//! The landing directory exists and is a git repository BEFORE teleport spawns,
//! because teleport checks the session's branch out into it: `worktree` (the
//! default) creates a fresh tree through the existing session-worktree path,
//! `checkout` uses the project root as-is.
//!
//! FR-11 is the other half of the same concern: a failed or cancelled adoption
//! removes the worktree it created **in this run** and never one that already
//! existed. `AdoptGuard` is the only thing that reverses anything, and it can
//! only reverse what the branch that actually created a tree handed it.

use super::*;
use crate::ipc::ErrorCode;

use crate::diff::{is_git_repo, GitHost};

const NOT_A_REPO_MSG: &str =
    "That project's directory is not a git repository — teleport checks out the session's \
     branch, so it needs one.";

// ---------- FR-4: the branch a fresh worktree lands on ----------

/// The readable tail of a cloud id, for FR-4's fallback branch name.
pub fn short_cloud_id(cloud_id: &str) -> String {
    let body = cloud_id
        .strip_prefix("session_")
        .or_else(|| cloud_id.strip_prefix("cse_"))
        .unwrap_or(cloud_id);
    let short: String = body
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if short.is_empty() {
        "session".to_string()
    } else {
        short.to_lowercase()
    }
}

/// FR-4: the branch the worktree lands on — the cloud session's when known,
/// else `cloud/<shortId>`. A branch starting with `-` is refused rather than
/// passed on: it becomes a positional git argument downstream, where git would
/// read it as an option.
pub fn adopt_branch(cloud_branch: Option<&str>, cloud_id: &str) -> String {
    match cloud_branch
        .map(str::trim)
        .filter(|b| !b.is_empty() && !b.starts_with('-'))
    {
        Some(branch) => branch.to_string(),
        None => format!("cloud/{}", short_cloud_id(cloud_id)),
    }
}

// ---------- FR-4: the landing directory ----------

pub struct Landing {
    pub(crate) dir: String,
    pub(crate) worktree: Option<SessionWorktree>,
    pub(crate) distro: Option<String>,
    /// `Some` ⇔ THIS run created a worktree, which is the only thing FR-11 may
    /// ever remove. Taken by the adoption's guard the moment it is armed.
    pub(crate) created: Option<CreatedWorktree>,
}

impl Landing {
    /// The `owner/name` of the landing checkout, for `CLOUD_REPO_MISMATCH`'s
    /// `currentRepo` (FR-8) — best-effort, and absent rather than guessed.
    pub fn current_repo(&self) -> Option<String> {
        let host = host_from_distro(&self.distro);
        let out =
            crate::diff::git_routed(&host, &self.dir, &["remote", "get-url", "origin"]).ok()?;
        if out.code != 0 {
            return None;
        }
        remote_slug(String::from_utf8_lossy(&out.stdout).trim())
    }
}

/// The revision a NEW worktree branch forks from: the project's current branch,
/// else `HEAD`. Only consulted when the cloud session's branch does not exist
/// locally yet — an existing branch ignores it entirely (session-worktree FR-8).
fn base_ref_of(host: &GitHost, root: &str) -> String {
    match crate::diff::git_routed(host, root, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(out) if out.code == 0 => {
            let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if branch.is_empty() || branch.starts_with('-') {
                "HEAD".to_string()
            } else {
                branch
            }
        }
        _ => "HEAD".to_string(),
    }
}

/// FR-4: `worktree` (the default) creates a fresh tree through the existing
/// session-worktree path; `checkout` uses the project root as-is. Either way the
/// directory exists and is a git repository BEFORE teleport spawns.
pub fn prepare_landing(
    project_root: &str,
    destination: &str,
    cloud_branch: Option<&str>,
    cloud_id: &str,
) -> Result<Landing, AdoptError> {
    let host = GitHost::of(project_root);
    if !is_git_repo(&host, project_root) {
        return Err(AdoptError::new(ErrorCode::NotAGitRepo, NOT_A_REPO_MSG));
    }
    if destination == "checkout" {
        return Ok(Landing {
            dir: project_root.to_string(),
            worktree: None,
            distro: None,
            created: None,
        });
    }
    let branch = adopt_branch(cloud_branch, cloud_id);
    let opts = WorktreeCreateInput {
        branch,
        base_ref: base_ref_of(&host, project_root),
        adopt: false,
    };
    match resolve_worktree(project_root, &opts) {
        Ok((dir, sw, distro)) => Ok(Landing {
            dir,
            created: Some(CreatedWorktree {
                host: host_from_distro(&distro),
                repo_root: sw.source_repo_root.clone(),
                path: sw.path.clone(),
                branch: sw.branch.clone(),
                created_branch: sw.created_branch,
            }),
            worktree: Some(sw),
            distro,
        }),
        Err(AppError {
            code, message: msg, ..
        }) if code == ErrorCode::WorktreeBranchInUse => Err(AdoptError::detailed(
            code,
            "that branch is already checked out at another path",
            serde_json::json!({ "path": msg }),
        )),
        Err(AppError {
            code, message: msg, ..
        }) => Err(AdoptError::new(code, msg)),
    }
}

// ---------- FR-11: nothing this run created outlives a failure ----------

/// Removes the registry slot (killing the PTY with it) on EVERY exit path, and
/// reverses a worktree this run created unless the adoption succeeded. Never
/// touches a worktree that already existed — `created` is only ever set by the
/// branch that actually made one.
pub struct AdoptGuard<'a> {
    reg: &'a CloudAdoptRegistry,
    key: String,
    pub(crate) created: Option<CreatedWorktree>,
    pub(crate) keep: bool,
}

impl<'a> AdoptGuard<'a> {
    pub fn new(reg: &'a CloudAdoptRegistry, key: String) -> AdoptGuard<'a> {
        AdoptGuard {
            reg,
            key,
            created: None,
            keep: false,
        }
    }
}

impl Drop for AdoptGuard<'_> {
    fn drop(&mut self) {
        if let Some(entry) = self.reg.take(&self.key) {
            entry.kill();
        }
        if !self.keep {
            if let Some(created) = self.created.take() {
                created.reverse();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    // ---- FR-4: the branch ----

    #[test]
    fn the_worktree_branch_is_the_cloud_sessions_when_known() {
        assert_eq!(
            adopt_branch(Some("fix/flaky-auth"), "session_01AB"),
            "fix/flaky-auth"
        );
    }

    #[test]
    fn an_unknown_branch_falls_back_to_cloud_slash_short_id() {
        assert_eq!(adopt_branch(None, "session_01Mo4r8N2qZ"), "cloud/01mo4r8n");
        assert_eq!(adopt_branch(Some("   "), "cse_ABCDEF"), "cloud/abcdef");
        // A cloud id with nothing usable in it still yields a legal branch.
        assert_eq!(adopt_branch(None, "session_----"), "cloud/session");
    }

    #[test]
    fn a_branch_that_could_be_read_as_a_flag_is_refused() {
        // The branch becomes a positional argument to `git worktree add`, where
        // a leading '-' is parsed as an option.
        assert_eq!(adopt_branch(Some("--force"), "session_01AB"), "cloud/01ab");
    }

    // ---- FR-4 / FR-11: the landing directory, and what a failure leaves behind ----

    fn git(dir: &Path, args: &[&str]) {
        let cmd = crate::process_util::spawn("git")
            .args(args)
            .current_dir(dir);
        assert!(cmd.status().expect("git spawn").success(), "git {args:?}");
    }

    /// A throwaway repo with one commit, plus the sibling `.francois-worktrees`
    /// tree a landing would be created under, so a test cleans up both.
    struct TempRepo {
        root: PathBuf,
        worktrees: PathBuf,
    }

    impl TempRepo {
        fn new(tag: &str) -> TempRepo {
            let base = std::env::temp_dir().join(format!("francois-cloud-{tag}-{}", uuid()));
            let root = base.join("repo");
            std::fs::create_dir_all(&root).unwrap();
            git(&root, &["init", "-q", "-b", "main"]);
            git(&root, &["config", "user.email", "t@example.com"]);
            git(&root, &["config", "user.name", "Test"]);
            std::fs::write(root.join("a.txt"), "hi").unwrap();
            git(&root, &["add", "."]);
            git(&root, &["commit", "-q", "-m", "init"]);
            TempRepo {
                worktrees: base.join(".francois-worktrees"),
                root,
            }
        }

        fn path(&self) -> String {
            self.root.to_string_lossy().to_string()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.worktrees).ok();
            std::fs::remove_dir_all(self.root.parent().unwrap_or(&self.root)).ok();
        }
    }

    /// `Landing`/`AdoptError` are carriers with no `Debug` — unwrap them by hand
    /// rather than widening either shape for the tests' convenience.
    fn landing_of(
        root: &str,
        destination: &str,
        cloud_branch: Option<&str>,
        cloud_id: &str,
    ) -> Landing {
        match prepare_landing(root, destination, cloud_branch, cloud_id) {
            Ok(l) => l,
            Err(e) => panic!("prepare_landing failed: {} {}", e.code, e.message),
        }
    }

    #[test]
    fn a_worktree_landing_checks_out_the_cloud_sessions_branch_before_teleport_spawns() {
        // FR-4: the default landing is a fresh worktree on the cloud session's
        // own branch, and it is a git repo BEFORE the PTY exists.
        let repo = TempRepo::new("landing");
        let landing = landing_of(&repo.path(), "worktree", Some("fix/flake"), "session_01AB");
        assert_ne!(landing.dir, repo.path());
        assert!(Path::new(&landing.dir).exists());
        assert!(is_git_repo(&GitHost::of(&landing.dir), &landing.dir));
        let sw = landing.worktree.as_ref().expect("worktree provenance");
        assert_eq!(sw.branch, "fix/flake");
        assert!(
            landing.created.is_some(),
            "FR-11 arms only on the branch that actually created a tree"
        );
    }

    #[test]
    fn an_unknown_cloud_branch_lands_on_cloud_slash_short_id() {
        let repo = TempRepo::new("fallback-branch");
        let landing = landing_of(&repo.path(), "worktree", None, "session_01Mo4r8N2qZ");
        assert_eq!(
            landing.worktree.as_ref().expect("provenance").branch,
            "cloud/01mo4r8n"
        );
    }

    #[test]
    fn a_failed_adoption_removes_the_worktree_it_created_and_keeps_one_it_did_not() {
        // §9: "a repo-mismatch dialog … leaves no PTY and no worktree behind".
        let repo = TempRepo::new("reversal");
        let mut landing = landing_of(&repo.path(), "worktree", Some("fix/flake"), "session_01AB");
        let dir = landing.dir.clone();
        let reg = CloudAdoptRegistry::default();
        {
            let mut guard = AdoptGuard::new(&reg, "session_01AB".into());
            guard.created = landing.created.take();
        } // dropped as a failure would drop it
        assert!(
            !Path::new(&dir).exists(),
            "FR-11: the tree this run created must not survive the failure"
        );

        // …and the success path keeps it: it belongs to the session now.
        let mut landing = landing_of(&repo.path(), "worktree", Some("fix/keep"), "session_01AB");
        let dir = landing.dir.clone();
        {
            let mut guard = AdoptGuard::new(&reg, "session_01AB".into());
            guard.created = landing.created.take();
            guard.keep = true;
        }
        assert!(Path::new(&dir).exists());
    }

    #[test]
    fn a_checkout_landing_is_the_project_root_and_is_never_reversible() {
        let repo = TempRepo::new("checkout");
        let landing = landing_of(&repo.path(), "checkout", Some("fix/flake"), "session_01AB");
        assert_eq!(landing.dir, repo.path());
        assert!(landing.worktree.is_none());
        assert!(
            landing.created.is_none(),
            "FR-11 must never be able to remove a checkout it did not create"
        );
    }

    #[test]
    fn a_project_root_that_is_not_a_git_repo_fails_before_anything_is_spawned() {
        let dir = std::env::temp_dir().join(format!("francois-cloud-bare-{}", uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        match prepare_landing(&dir.to_string_lossy(), "worktree", None, "session_01AB") {
            Err(e) => assert_eq!(e.code, ErrorCode::NotAGitRepo),
            Ok(_) => panic!("teleport needs a repo to check the branch out into"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
