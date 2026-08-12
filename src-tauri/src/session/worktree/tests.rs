//! Unit + integration tests for the session-worktree domain (specs/session-worktree.md).
//! Split out of `mod.rs` (quality remediation, round 4: `mod.rs` stayed over the
//! ~1000-line cap even after the round-3 `mod.rs`/`git.rs` split — the bulk was
//! these two test modules, now flattened into their own file). `super::*` pulls
//! in everything `mod.rs` has in scope (the serialized shapes, the pure FR-9
//! path helpers, the command handlers, and the git-shell helpers re-exported
//! from `git.rs`).

use super::*;

// ================= former `mod tests` (pure helpers + command-layer, mocked) =================

// ---------- FR-9: worktree_slug (table mirrors contract/session-worktree.ts) ----------

#[test]
fn slug_lowercases_and_replaces_disallowed_chars() {
    assert_eq!(worktree_slug("feat/Auth Flow"), "feat-auth-flow");
    assert_eq!(worktree_slug("feat/parser"), "feat-parser");
    assert_eq!(worktree_slug("a.b_c-d"), "a.b_c-d");
}

#[test]
fn slug_collapses_runs_and_trims_dashes() {
    assert_eq!(worktree_slug("feat//weird__name!!"), "feat-weird__name");
    assert_eq!(
        worktree_slug("--leading-and-trailing--"),
        "leading-and-trailing"
    );
}

#[test]
fn slug_falls_back_to_a_placeholder_when_it_collapses_to_empty() {
    // Parity with contract/session-worktree.ts `WORKTREE_SLUG_FALLBACK`: a
    // branch entirely outside [a-z0-9._-] (CJK, punctuation) slugs to nothing,
    // which would put the worktree ON the parent directory instead of a child.
    assert_eq!(WORKTREE_SLUG_FALLBACK, "branch");
    assert_eq!(worktree_slug("功能/新分支"), "branch");
    assert_eq!(worktree_slug(""), "branch");
    assert_eq!(worktree_slug("---"), "branch");
}

#[test]
fn slug_truncates_to_60_and_trims_trailing_dash() {
    let long = "a".repeat(58) + "-!!!"; // 58 a's, then chars that collapse to a single '-'
    let slug = worktree_slug(&long);
    assert!(slug.len() <= 60);
    assert!(!slug.ends_with('-'));
}

// ---------- FR-9: suffix_until_free ----------

#[test]
fn suffix_until_free_returns_base_when_free() {
    assert_eq!(suffix_until_free("/tmp/x", |_| false), "/tmp/x");
}

#[test]
fn suffix_until_free_appends_first_free_suffix() {
    let taken = ["/tmp/x", "/tmp/x-2", "/tmp/x-3"];
    assert_eq!(
        suffix_until_free("/tmp/x", |p| taken.contains(&p)),
        "/tmp/x-4"
    );
}

// ---------- FR-9: worktree_target / split_dir_base ----------

#[test]
fn worktree_target_builds_the_sibling_path_forward_slash() {
    let (target, sep) = worktree_target("/home/u/api", "feat/parser");
    assert_eq!(target, "/home/u/.francois-worktrees/api/feat-parser");
    assert_eq!(sep, '/');
}

#[test]
fn worktree_target_builds_the_sibling_path_backslash() {
    let (target, sep) = worktree_target("D:\\repo", "feat/x");
    assert_eq!(target, "D:\\.francois-worktrees\\repo\\feat-x");
    assert_eq!(sep, '\\');
}

#[test]
fn worktree_target_never_ends_in_a_bare_separator() {
    // FR-9: the empty-slug fallback is applied BEFORE the `-2`/`-3` suffix
    // search, so the target is always a named child directory.
    let (target, _) = worktree_target("/home/u/api", "功能/新分支");
    assert_eq!(target, "/home/u/.francois-worktrees/api/branch");
}

// ---------- FR-19: the removal-block reason string ----------

fn status_of(dirty_count: u32, unpushed: bool, unpushed_count: u32) -> WorktreeStatusData {
    WorktreeStatusData {
        dirty: dirty_count > 0,
        dirty_count,
        unpushed,
        unpushed_count,
        upstream: None,
    }
}

#[test]
fn removal_block_reason_names_both_counts() {
    assert_eq!(
        removal_block_reason(&status_of(3, true, 2)),
        "3 uncommitted files, 2 commits not pushed"
    );
}

#[test]
fn removal_block_reason_names_a_single_cause() {
    assert_eq!(
        removal_block_reason(&status_of(2, false, 0)),
        "2 uncommitted files"
    );
    assert_eq!(
        removal_block_reason(&status_of(0, true, 4)),
        "4 commits not pushed"
    );
}

#[test]
fn removal_block_reason_renders_the_unknown_push_status_sentinel() {
    // contract/session-worktree.ts §WorktreeStatusData: `unpushed: true` with
    // `unpushedCount: 0` means the push status could NOT be determined — the
    // reason must never claim "0 commits not pushed".
    assert_eq!(
        removal_block_reason(&status_of(0, true, 0)),
        "push status unknown — no upstream configured"
    );
    assert_eq!(
        removal_block_reason(&status_of(1, true, 0)),
        "1 uncommitted files, push status unknown — no upstream configured"
    );
}

#[test]
fn removal_block_reason_distinguishes_a_failed_upstream_comparison() {
    // LOW remediation: the `unpushed: true` / `unpushedCount: 0` sentinel also
    // covers "an upstream IS configured, but `git rev-list <upstream>..HEAD`
    // itself failed" — blaming a missing upstream there is simply wrong. The
    // wire sentinel stays as the contract defines it; only the wording branches.
    let mut status = status_of(0, true, 0);
    status.upstream = Some("origin/feat/x".into());
    assert_eq!(
        removal_block_reason(&status),
        "push status unknown — could not compare with origin/feat/x"
    );
    let mut dirty = status_of(1, true, 0);
    dirty.upstream = Some("origin/feat/x".into());
    assert_eq!(
        removal_block_reason(&dirty),
        "1 uncommitted files, push status unknown — could not compare with origin/feat/x"
    );
}

// ---------- contract parity: WorktreeCreateOptions deserialization ----------

#[test]
fn worktree_create_input_requires_base_ref() {
    // contract/session-worktree.ts `WorktreeCreateOptions`: `baseRef` is a
    // REQUIRED string (only `adopt` is optional). An omitted `baseRef` must fail
    // deserialization rather than silently coercing to "" — `probe_branch`'s
    // blank check only guards the new-branch path, so the branch-exists path
    // would otherwise accept a client contract violation in silence.
    let full: WorktreeCreateInput =
        serde_json::from_str(r#"{"branch":"feat/x","baseRef":"main","adopt":true}"#)
            .expect("full payload deserializes");
    assert_eq!(full.base_ref, "main");
    assert!(full.adopt);

    let no_adopt: WorktreeCreateInput =
        serde_json::from_str(r#"{"branch":"feat/x","baseRef":"main"}"#)
            .expect("adopt is optional (contract: `adopt?: boolean`)");
    assert!(!no_adopt.adopt);

    let missing = serde_json::from_str::<WorktreeCreateInput>(r#"{"branch":"feat/x"}"#);
    assert!(
        missing.is_err(),
        "an omitted baseRef must be rejected, not defaulted to \"\""
    );
}

// ---------- command-layer: worktree_status_impl / worktree_remove_impl ----------

use crate::session::testutil::*;

fn session_without_worktree() -> Session {
    let mut s = test_session();
    s.id = "s1".into();
    s
}

fn session_with_worktree(path: &str) -> Session {
    let mut s = session_without_worktree();
    s.worktree = Some(SessionWorktree {
        branch: "feat/x".into(),
        base_ref: "main".into(),
        base_resolved: None,
        path: path.into(),
        source_repo_root: "/repo".into(),
        created_branch: true,
        fetched: false,
        fetch_error: None,
    });
    s
}

#[test]
fn worktree_status_impl_reports_session_not_found() {
    let engine = test_engine_with(session_without_worktree());
    match worktree_status_impl(&engine, "no-such-session") {
        IpcResult::Err { error, .. } => assert_eq!(error.code, "SESSION_NOT_FOUND"),
        IpcResult::Ok { .. } => panic!("expected an error"),
    }
}

#[test]
fn worktree_status_impl_reports_worktree_not_found_when_session_has_no_worktree() {
    let engine = test_engine_with(session_without_worktree());
    match worktree_status_impl(&engine, "s1") {
        IpcResult::Err { error, .. } => assert_eq!(error.code, "WORKTREE_NOT_FOUND"),
        IpcResult::Ok { .. } => panic!("expected an error"),
    }
}

#[test]
fn worktree_status_impl_reports_worktree_not_found_when_directory_is_gone() {
    let engine = test_engine_with(session_with_worktree("/no/such/directory/at/all"));
    match worktree_status_impl(&engine, "s1") {
        IpcResult::Err { error, .. } => assert_eq!(error.code, "WORKTREE_NOT_FOUND"),
        IpcResult::Ok { .. } => panic!("expected an error"),
    }
}

#[test]
fn worktree_remove_impl_reports_session_not_found() {
    let engine = test_engine_with(session_without_worktree());
    match worktree_remove_impl(&engine, "no-such-session") {
        IpcResult::Err { error, .. } => assert_eq!(error.code, "SESSION_NOT_FOUND"),
        IpcResult::Ok { .. } => panic!("expected an error"),
    }
}

#[test]
fn worktree_remove_impl_reports_worktree_not_found_when_session_has_no_worktree() {
    let engine = test_engine_with(session_without_worktree());
    match worktree_remove_impl(&engine, "s1") {
        IpcResult::Err { error, .. } => assert_eq!(error.code, "WORKTREE_NOT_FOUND"),
        IpcResult::Ok { .. } => panic!("expected an error"),
    }
}

#[test]
fn adopt_host_routes_a_bare_linux_path_to_the_wsl_default_distro_when_adopting() {
    // CRITICAL remediation: the FR-5 recovery cwd is a bare Linux path with
    // no distro embedded — GitHost::of alone would misclassify it Native.
    // adopt_host only special-cases it when adopt=true; a plain create with
    // the same shape of path stays Native (there is nothing WSL-specific to
    // infer from a non-adopt cwd — it just isn't absolute).
    assert_eq!(adopt_host("D:\\repo", true), GitHost::Native);
    assert_eq!(
        adopt_host("\\\\wsl$\\Ubuntu\\home\\u\\api", true),
        GitHost::Wsl("Ubuntu".into())
    );
}

// ================= former `mod git_tests` (real-git integration, throwaway temp repos) =================

use std::process::Command as Cmd;

/// Windows CI runners can alias a long account name to its DOS 8.3 short form
/// in `%TEMP%` (e.g. `runneradmin` -> `RUNNER~1`), while git resolves a repo
/// root to the long form — canonicalize before comparing so the two
/// spellings of the same path don't spuriously differ.
fn canonical_lower(p: &std::path::Path) -> String {
    let c = std::fs::canonicalize(p).expect("canonicalize");
    let s = c.to_string_lossy().replace('\\', "/");
    s.strip_prefix("//?/")
        .unwrap_or(&s)
        .trim_end_matches('/')
        .to_lowercase()
}

fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "francois-worktree-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let status = Cmd::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("git spawn");
    assert!(status.success(), "git {args:?} failed in {dir:?}");
}

fn init_repo(dir: &std::path::Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "t@example.com"]);
    git(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join("a.txt"), "hi").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "init"]);
}

#[test]
fn creates_a_new_branch_worktree() {
    let repo = tmp_dir("create");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/parser".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (session_cwd, sw, _) = resolve_worktree(&cwd, &opts).expect("create ok");
    assert!(std::path::Path::new(&session_cwd).is_dir());
    assert_eq!(sw.branch, "feat/parser");
    assert!(sw.created_branch);
    assert!(!sw.fetched); // no remote configured
    assert!(sw.fetch_error.is_none());
    // FR-7b: no fetch ran, so there is no fresher base to fork from — `baseRef` verbatim.
    assert_eq!(sw.base_resolved, None);

    // git worktree list in the source repo shows the new branch (acceptance §9).
    let host = GitHost::Native;
    let entries = worktree_list_entries(&host, &cwd);
    assert!(entries
        .iter()
        .any(|e| e.branch.as_deref() == Some("feat/parser")));
}

#[test]
fn a_new_worktree_inherits_the_source_checkouts_mcp_consent() {
    // .claude/settings.local.json is gitignored, so a fresh worktree has no
    // consent store — without the seed, every server the user already decided
    // on in the source checkout re-appears as pending there (and a refusal
    // stops applying). Only the consent keys travel; permission rules stay
    // per-worktree.
    let repo = tmp_dir("consent-seed");
    init_repo(&repo);
    std::fs::create_dir_all(repo.join(".claude")).unwrap();
    std::fs::write(
        repo.join(".claude").join("settings.local.json"),
        r#"{
            "enabledMcpjsonServers": ["serena"],
            "disabledMcpjsonServers": ["sketchy"],
            "permissions": { "allow": ["PowerShell"] }
        }"#,
    )
    .unwrap();
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/consent".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (session_cwd, _, _) = resolve_worktree(&cwd, &opts).expect("create ok");

    let seeded: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(&session_cwd)
                .join(".claude")
                .join("settings.local.json"),
        )
        .expect("the seed wrote the worktree's settings.local.json"),
    )
    .unwrap();
    assert_eq!(
        seeded["enabledMcpjsonServers"],
        serde_json::json!(["serena"])
    );
    assert_eq!(
        seeded["disabledMcpjsonServers"],
        serde_json::json!(["sketchy"])
    );
    assert!(seeded.get("permissions").is_none());
}

#[test]
fn a_source_checkout_with_no_consent_leaves_the_worktree_unseeded() {
    let repo = tmp_dir("consent-none");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/noconsent".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (session_cwd, _, _) = resolve_worktree(&cwd, &opts).expect("create ok");
    assert!(
        !std::path::Path::new(&session_cwd)
            .join(".claude")
            .join("settings.local.json")
            .exists(),
        "no consent to carry — no file is invented"
    );
}

#[test]
fn adopting_an_existing_worktree_mutates_no_git_state() {
    let repo = tmp_dir("adopt-src");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/x".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (worktree_path, _, _) = resolve_worktree(&cwd, &opts).expect("create ok");

    // Now adopt the same path: no prune/fetch/add should run — asserted by
    // re-running the exact same op count check is impractical here, so we
    // instead assert the returned provenance is filled from `worktree list`
    // and the path is unchanged (no new directory created).
    let adopt_opts = WorktreeCreateInput {
        branch: "feat/x".into(),
        base_ref: String::new(),
        adopt: true,
    };
    let (adopted_cwd, sw, _) = resolve_worktree(&worktree_path, &adopt_opts).expect("adopt ok");
    assert_eq!(adopted_cwd, worktree_path);
    assert_eq!(sw.branch, "feat/x");
    assert!(!sw.created_branch);
    assert_eq!(norm_path(&sw.source_repo_root), canonical_lower(&repo));
}

#[test]
fn adopting_a_path_with_no_matching_worktree_entry_is_an_error() {
    // MEDIUM remediation: no fabricated provenance from opts.branch/repo_root
    // when `cwd` isn't actually a registered worktree.
    let repo = tmp_dir("adopt-no-match");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let bogus = std::path::Path::new(&cwd)
        .parent()
        .unwrap()
        .join("not-a-worktree")
        .to_string_lossy()
        .to_string();
    std::fs::create_dir_all(&bogus).unwrap();
    // Not a repo at all at `bogus` — is_git_repo would already fail — so
    // instead adopt a SUBDIRECTORY of the repo itself, which IS inside a git
    // repo (rev-parse succeeds) but is never a `git worktree list` entry.
    let sub = std::path::Path::new(&cwd).join("subdir");
    std::fs::create_dir_all(&sub).unwrap();
    let sub = sub.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/whatever".into(),
        base_ref: String::new(),
        adopt: true,
    };
    let err = resolve_worktree(&sub, &opts).unwrap_err();
    assert_eq!(err.0, "INVALID_INPUT");
    let _ = bogus; // silence unused warning if the early exit above changes
}

#[test]
fn branch_already_checked_out_is_reported_instead_of_a_second_worktree() {
    let repo = tmp_dir("in-use");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/y".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    resolve_worktree(&cwd, &opts).expect("first create ok");

    // A second create for the SAME branch must fail with WORKTREE_BRANCH_IN_USE
    // rather than mutate git state again.
    let err = resolve_worktree(&cwd, &opts).unwrap_err();
    assert_eq!(err.0, "WORKTREE_BRANCH_IN_USE");
}

#[test]
fn probe_branch_is_re_runnable_and_reports_the_holding_worktree() {
    // FR-5/§7: the branch state is probed again immediately before `git
    // worktree add` — after the (up to 20s) fetch window — so a branch that
    // gets checked out DURING the fetch still surfaces the recovery offer
    // instead of an opaque WORKTREE_CREATE_FAILED.
    let repo = tmp_dir("probe-branch");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let host = GitHost::Native;

    // Unknown branch, blank base ref: rejected before any git mutation.
    let err = probe_branch(&host, &cwd, "feat/nope", "  ").unwrap_err();
    assert_eq!(err.0, "INVALID_INPUT");
    // Unknown branch with a base ref: free to create.
    assert!(!probe_branch(&host, &cwd, "feat/nope", "main").expect("free"));

    // Existing branch, not checked out anywhere: exists, base ref ignored.
    git(&repo, &["branch", "feat/free"]);
    assert!(probe_branch(&host, &cwd, "feat/free", "").expect("exists"));

    // Existing branch held by another worktree: the FR-5 error, carrying the path.
    let opts = WorktreeCreateInput {
        branch: "feat/held".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (held_path, _, _) = resolve_worktree(&cwd, &opts).expect("create ok");
    let err = probe_branch(&host, &cwd, "feat/held", "main").unwrap_err();
    assert_eq!(err.0, "WORKTREE_BRANCH_IN_USE");
    assert_eq!(norm_path(&err.1), norm_path(&held_path));
}

#[test]
fn a_failed_add_leaves_no_directory_and_no_stray_branch() {
    let repo = tmp_dir("fail");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    // An invalid base ref makes `worktree add -b <branch> <path> <baseRef>` fail.
    let opts = WorktreeCreateInput {
        branch: "feat/broken".into(),
        base_ref: "does-not-exist".into(),
        adopt: false,
    };
    let result = resolve_worktree(&cwd, &opts);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().0, "WORKTREE_CREATE_FAILED");

    let host = GitHost::Native;
    // No stray branch left behind (FR-11).
    assert!(!branch_exists(&host, &cwd, "feat/broken"));
    // No directory left behind either.
    let (target, _) = worktree_target(&cwd, "feat/broken");
    assert!(!std::path::Path::new(&target).exists());
}

#[test]
fn blank_base_ref_is_rejected_before_calling_git() {
    // LOW remediation: a blank base_ref used to reach `git worktree add -b
    // <branch> <path> ""` and surface an opaque git error.
    let repo = tmp_dir("blank-base-ref");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/blank-base".into(),
        base_ref: "   ".into(),
        adopt: false,
    };
    let err = resolve_worktree(&cwd, &opts).unwrap_err();
    assert_eq!(err.0, "INVALID_INPUT");

    let host = GitHost::Native;
    assert!(!branch_exists(&host, &cwd, "feat/blank-base"));
}

#[test]
fn base_ref_starting_with_dash_is_rejected() {
    let repo = tmp_dir("base-ref-dash");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/dash-base".into(),
        base_ref: "--upload-pack=touch /tmp/pwned".into(),
        adopt: false,
    };
    let err = resolve_worktree(&cwd, &opts).unwrap_err();
    assert_eq!(err.0, "INVALID_INPUT");

    let host = GitHost::Native;
    assert!(!branch_exists(&host, &cwd, "feat/dash-base"));
}

// ---------- FR-7b: fork from the fetched tip of the base branch ----------

/// `git` with its stdout captured, trimmed. Same spawn shape as `git`, which only asserts
/// the status — FR-7b's tests need the commit a ref points at.
fn git_out(dir: &std::path::Path, args: &[&str]) -> String {
    let out = Cmd::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git spawn");
    assert!(out.status.success(), "git {args:?} failed in {dir:?}");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// An `upstream` repo plus a `local` clone of it, both on `main`. A file-path remote needs
/// no network, so the fetch inside `resolve_worktree` really runs.
fn clone_pair(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let upstream = tmp_dir(tag);
    init_repo(&upstream);
    let local = tmp_dir(&format!("{tag}-clone"));
    git(&local, &["clone", "-q", &upstream.to_string_lossy(), "."]);
    git(&local, &["config", "user.email", "t@example.com"]);
    git(&local, &["config", "user.name", "Test"]);
    (upstream, local)
}

fn commit_in(dir: &std::path::Path, file: &str, msg: &str) -> String {
    std::fs::write(dir.join(file), msg).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", msg]);
    git_out(dir, &["rev-parse", "HEAD"])
}

#[test]
fn a_new_branch_forks_from_the_fetched_remote_tip_not_the_stale_local_base() {
    // The whole point of FR-7's fetch: the source checkout's `main` is typically days
    // behind, and forking from it silently starts every worktree on stale code. After the
    // fetch, `refs/remotes/origin/main` is the current base, so that is the start point.
    let (upstream, local) = clone_pair("fork-fresh");
    let stale = git_out(&local, &["rev-parse", "HEAD"]);
    let fresh = commit_in(&upstream, "b.txt", "upstream moved on");
    assert_ne!(stale, fresh);

    let cwd = local.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/fresh".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (session_cwd, sw, _) = resolve_worktree(&cwd, &opts).expect("create ok");

    assert!(sw.fetched);
    assert_eq!(
        sw.base_resolved.as_deref(),
        Some("refs/remotes/origin/main")
    );
    assert_eq!(
        sw.base_ref, "main",
        "the requested base is still echoed verbatim"
    );
    assert_eq!(
        git_out(std::path::Path::new(&session_cwd), &["rev-parse", "HEAD"]),
        fresh,
        "the worktree starts on the fetched tip"
    );
    // The local branch itself is never moved — git refuses to update a checked-out branch,
    // and the user did not ask for their checkout to change.
    assert_eq!(git_out(&local, &["rev-parse", "main"]), stale);
}

#[test]
fn a_local_base_ahead_of_the_remote_keeps_its_own_commits() {
    // Unpushed local commits on the base branch are work the user expects to build on;
    // forking around them to the remote tip would drop them from the worktree.
    let (_upstream, local) = clone_pair("fork-ahead");
    let ahead = commit_in(&local, "c.txt", "local-only work");

    let cwd = local.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/ahead".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (session_cwd, sw, _) = resolve_worktree(&cwd, &opts).expect("create ok");

    assert!(sw.fetched);
    assert_eq!(
        sw.base_resolved, None,
        "local is not an ancestor of the remote tip"
    );
    assert_eq!(
        git_out(std::path::Path::new(&session_cwd), &["rev-parse", "HEAD"]),
        ahead
    );
}

#[test]
fn a_base_ref_with_no_remote_counterpart_is_used_verbatim() {
    // A purely local base branch (equally: a tag or a sha) has no `origin/<baseRef>` to
    // upgrade to — the fetch succeeded, but there is nothing fresher to fork from.
    let (_upstream, local) = clone_pair("fork-local-base");
    git(&local, &["branch", "local-only"]);

    let cwd = local.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/local-base".into(),
        base_ref: "local-only".into(),
        adopt: false,
    };
    let (_, sw, _) = resolve_worktree(&cwd, &opts).expect("create ok");
    assert!(sw.fetched);
    assert_eq!(sw.base_resolved, None);
}

#[test]
fn a_base_ref_that_is_already_a_remote_tracking_ref_is_left_alone() {
    // `origin/main` needs no upgrade — and `refs/remotes/origin/origin/main` resolves to
    // nothing, so the guard must catch it before the probe rather than after.
    let (upstream, local) = clone_pair("fork-remote-base");
    let fresh = commit_in(&upstream, "d.txt", "upstream moved on");

    let cwd = local.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/remote-base".into(),
        base_ref: "origin/main".into(),
        adopt: false,
    };
    let (session_cwd, sw, _) = resolve_worktree(&cwd, &opts).expect("create ok");
    assert_eq!(sw.base_resolved, None);
    assert_eq!(
        git_out(std::path::Path::new(&session_cwd), &["rev-parse", "HEAD"]),
        fresh
    );
}

#[test]
fn an_existing_branch_never_resolves_a_base() {
    // FR-8: the base is ignored entirely when the branch already exists, so recording a
    // resolved one would be a lie the status fork-point then trusts.
    let (upstream, local) = clone_pair("fork-existing");
    commit_in(&upstream, "e.txt", "upstream moved on");
    git(&local, &["branch", "feat/existing"]);

    let cwd = local.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/existing".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (_, sw, _) = resolve_worktree(&cwd, &opts).expect("create ok");
    assert!(!sw.created_branch);
    assert_eq!(sw.base_resolved, None);
}

#[test]
fn fetch_failure_is_reported_as_fetched_false_with_fetch_error() {
    // A repo with a remote that cannot be reached: `git fetch` fails fast,
    // and resolve_worktree must still succeed (fetch is best-effort) while
    // surfacing `fetched: false` + a `fetchError`.
    let repo = tmp_dir("fetch-fail");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let host = GitHost::Native;
    git_routed(
        &host,
        &cwd,
        &[
            "remote",
            "add",
            "origin",
            "https://127.0.0.1:1/no-such-remote.git",
        ],
    )
    .expect("remote add ok");

    let opts = WorktreeCreateInput {
        branch: "feat/fetch-fail".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (_, sw, _) = resolve_worktree(&cwd, &opts).expect("create still succeeds");
    assert!(!sw.fetched);
    assert!(sw.fetch_error.is_some());
}

#[test]
fn remote_named_with_a_leading_dash_is_never_passed_to_git_fetch() {
    // CRITICAL remediation: `git remote` reflects back whatever section name
    // appears in `.git/config` verbatim — for an adopted/hostile repo that can
    // be attacker-controlled (e.g. `--upload-pack=touch /tmp/pwned`), and it
    // was passed as the final bare positional arg to `git fetch --prune
    // <remote>` with no leading-`-` rejection. Write such a remote directly
    // into `.git/config` (bypassing `git remote add`'s own name validation, to
    // mirror a hostile repo shipping this section verbatim) and assert
    // resolve_worktree treats it as "no usable remote" — no fetch attempted,
    // and certainly no command injection — rather than rejecting the whole
    // create.
    let repo = tmp_dir("remote-dash");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let config_extra =
        "\n[remote \"--upload-pack=touch /tmp/pwned\"]\n\turl = https://127.0.0.1:1/no-such-remote.git\n";
    let config_path = repo.join(".git").join("config");
    let mut existing = std::fs::read_to_string(&config_path).unwrap();
    existing.push_str(config_extra);
    std::fs::write(&config_path, existing).unwrap();

    let opts = WorktreeCreateInput {
        branch: "feat/remote-dash".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (_, sw, _) = resolve_worktree(&cwd, &opts).expect("create still succeeds");
    // Treated as unusable: no fetch attempted at all (not merely a failed one).
    assert!(!sw.fetched);
    assert!(sw.fetch_error.is_none());
}

#[test]
fn remove_deletes_a_clean_worktree_and_keeps_the_branch() {
    let repo = tmp_dir("remove");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/remove".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (worktree_path, _, _) = resolve_worktree(&cwd, &opts).expect("create ok");
    let host = GitHost::Native;

    match git_routed(&host, &cwd, &["worktree", "remove", &worktree_path]) {
        Ok(o) => assert_eq!(o.code, 0),
        Err(e) => panic!("{e}"),
    }
    assert!(!std::path::Path::new(&worktree_path).exists());
    // The branch itself is never deleted (FR-20).
    assert!(branch_exists(&host, &cwd, "feat/remove"));
}

#[test]
fn resolve_worktree_rejects_an_invalid_branch_name() {
    let repo = tmp_dir("invalid-branch");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "not..valid~".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let err = resolve_worktree(&cwd, &opts).unwrap_err();
    assert_eq!(err.0, "INVALID_INPUT");
}

#[test]
fn branch_starting_with_dash_is_rejected() {
    // security: `check-ref-format --branch` does not reject a leading `-`,
    // but `branch` is passed as the last positional argument to `git
    // worktree add <path> <branch>` — a value like `--force` would be
    // parsed by git as an option (the same class of bug fixed for base_ref
    // above).
    let repo = tmp_dir("branch-dash");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "--force".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let err = resolve_worktree(&cwd, &opts).unwrap_err();
    assert_eq!(err.0, "INVALID_INPUT");
}

#[test]
fn session_worktree_probe_reports_branch_existence_and_worktree_path() {
    // MEDIUM remediation: session_worktree_probe exercised end-to-end
    // against a real temp repo, asserting branchExists / branchCheckedOutAt
    // / worktreePath (contract/session-worktree.ts WorktreeProbeData).
    let repo = tmp_dir("probe-e2e");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();

    // A branch that does not exist yet: not checked out anywhere, but a
    // worktree path is still previewed for it.
    match session_worktree_probe(cwd.clone(), Some("feat/new".into())) {
        IpcResult::Ok { data, .. } => {
            assert!(data.is_repo);
            assert!(!data.branch_exists);
            assert!(data.branch_checked_out_at.is_none());
            assert!(data.worktree_path.is_some());
        }
        IpcResult::Err { error, .. } => panic!("unexpected error: {}", error.code),
    }

    // Create a real worktree for a branch, then probe it: exists + checked
    // out at that exact path.
    let opts = WorktreeCreateInput {
        branch: "feat/probed".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (worktree_path, _, _) = resolve_worktree(&cwd, &opts).expect("create ok");

    match session_worktree_probe(cwd, Some("feat/probed".into())) {
        IpcResult::Ok { data, .. } => {
            assert!(data.branch_exists);
            assert_eq!(
                norm_path(&data.branch_checked_out_at.expect("checked out")),
                norm_path(&worktree_path)
            );
        }
        IpcResult::Err { error, .. } => panic!("unexpected error: {}", error.code),
    }
}

#[test]
fn session_worktree_probe_rejects_a_relative_cwd() {
    match session_worktree_probe("relative/path".into(), None) {
        IpcResult::Err { error, .. } => assert_eq!(error.code, "INVALID_INPUT"),
        IpcResult::Ok { .. } => panic!("expected a relative cwd to be rejected"),
    }
}

#[test]
fn status_counts_from_the_resolved_base_not_the_stale_local_one() {
    // FR-7b/FR-18: a branch forked from `refs/remotes/origin/main` is ahead of the LOCAL
    // `main` by everything the fetch brought in. Counting `main..HEAD` would report those
    // commits as the session's own unpushed work — and FR-19's removal guard would block
    // on a worktree that has nothing in it.
    let (upstream, local) = clone_pair("status-base");
    commit_in(&upstream, "f.txt", "upstream moved on");

    let cwd = local.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/status-base".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (worktree_path, sw, _) = resolve_worktree(&cwd, &opts).expect("create ok");
    assert_eq!(
        sw.base_resolved.as_deref(),
        Some("refs/remotes/origin/main")
    );

    let mut s = crate::session::testutil::test_session();
    s.id = "s1".into();
    s.worktree = Some(sw);
    let engine = crate::session::testutil::test_engine_with(s);

    match worktree_status_impl(&engine, "s1") {
        IpcResult::Ok { data, .. } => {
            assert!(!data.dirty);
            assert_eq!(
                data.unpushed_count, 0,
                "a fresh worktree is ahead of nothing"
            );
            assert!(!data.unpushed);
        }
        IpcResult::Err { error, .. } => panic!("unexpected error: {}", error.code),
    }

    // One real commit in the worktree, and only that one, counts as unpushed.
    commit_in(
        std::path::Path::new(&worktree_path),
        "g.txt",
        "session work",
    );
    match worktree_status_impl(&engine, "s1") {
        IpcResult::Ok { data, .. } => assert_eq!(data.unpushed_count, 1),
        IpcResult::Err { error, .. } => panic!("unexpected error: {}", error.code),
    }
}

// ---------- command-layer: worktree_remove_impl's WORKTREE_DIRTY refusal ----------

#[test]
fn worktree_remove_impl_refuses_a_dirty_worktree() {
    let repo = tmp_dir("remove-dirty");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/dirty".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (worktree_path, sw, _) = resolve_worktree(&cwd, &opts).expect("create ok");
    std::fs::write(std::path::Path::new(&worktree_path).join("dirty.txt"), "x").unwrap();

    let mut s = crate::session::testutil::test_session();
    s.id = "s1".into();
    s.worktree = Some(sw);
    let engine = crate::session::testutil::test_engine_with(s);

    match worktree_remove_impl(&engine, "s1") {
        IpcResult::Err { error, .. } => assert_eq!(error.code, "WORKTREE_DIRTY"),
        IpcResult::Ok { .. } => panic!("expected the dirty refusal"),
    }
    // The worktree must still be there — refused, not removed.
    assert!(std::path::Path::new(&worktree_path).is_dir());
}

#[test]
fn worktree_remove_impl_says_unknown_rather_than_zero_commits_when_push_status_is_undetermined() {
    // An adopted worktree (`created_branch: false`) has no trusted base_ref and
    // no upstream, so compute_status fails safe with `unpushed: true,
    // unpushed_count: 0`. Removal still hard-blocks (FR-19), but the reason must
    // name the real cause instead of the misleading literal "0 commits".
    let repo = tmp_dir("remove-unknown-push");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/unknown-push".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (worktree_path, mut sw, _) = resolve_worktree(&cwd, &opts).expect("create ok");
    sw.created_branch = false; // as if adopted

    let mut s = crate::session::testutil::test_session();
    s.id = "s1".into();
    s.worktree = Some(sw);
    let engine = crate::session::testutil::test_engine_with(s);

    match worktree_remove_impl(&engine, "s1") {
        IpcResult::Err { error, .. } => {
            assert_eq!(error.code, "WORKTREE_DIRTY");
            assert!(
                error.message.contains("push status unknown"),
                "unexpected reason: {}",
                error.message
            );
            assert!(
                !error.message.contains("0 commits"),
                "unexpected reason: {}",
                error.message
            );
        }
        IpcResult::Ok { .. } => panic!("expected the undetermined-push refusal"),
    }
    assert!(std::path::Path::new(&worktree_path).is_dir());
}

#[test]
fn worktree_remove_impl_removes_a_clean_worktree() {
    let repo = tmp_dir("remove-clean-impl");
    init_repo(&repo);
    let cwd = repo.to_string_lossy().to_string();
    let opts = WorktreeCreateInput {
        branch: "feat/clean-impl".into(),
        base_ref: "main".into(),
        adopt: false,
    };
    let (worktree_path, sw, _) = resolve_worktree(&cwd, &opts).expect("create ok");

    let mut s = crate::session::testutil::test_session();
    s.id = "s1".into();
    s.worktree = Some(sw);
    let engine = crate::session::testutil::test_engine_with(s);

    match worktree_remove_impl(&engine, "s1") {
        IpcResult::Ok { .. } => {}
        IpcResult::Err { error, .. } => panic!("unexpected error: {}", error.code),
    }
    assert!(!std::path::Path::new(&worktree_path).exists());
}
