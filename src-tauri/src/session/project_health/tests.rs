use super::*;
use serde_json::json;

/// A throwaway directory, canonicalized (macOS temp lives under `/private/var`),
/// removed on drop. Nothing here ever touches the real `~/.claude*`.
struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Self {
        let p =
            std::env::temp_dir().join(format!("francois-health-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(realpath(&p))
    }
    fn dir(&self, rel: &str) -> PathBuf {
        let p = self.0.join(rel);
        std::fs::create_dir_all(&p).unwrap();
        p
    }
    fn file(&self, rel: &str, body: &str) -> PathBuf {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        p
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}
fn key_of(p: &Path) -> String {
    norm_path(&s(p))
}

// ---- trust_key ----

#[test]
fn trust_key_is_the_repo_root_for_a_plain_repo() {
    let t = Tmp::new("plain");
    let repo = t.dir("repo/.git").parent().unwrap().to_path_buf();
    assert_eq!(trust_key(&s(&repo), "native"), key_of(&repo));
}

#[test]
fn trust_key_is_the_repo_root_for_a_subdirectory_cwd() {
    let t = Tmp::new("sub");
    t.dir("repo/.git");
    let sub = t.dir("repo/src/deep");
    assert_eq!(trust_key(&s(&sub), "native"), key_of(&t.0.join("repo")));
}

#[test]
fn trust_key_is_the_cwd_outside_a_repo() {
    let t = Tmp::new("norepo");
    let cwd = t.dir("plain/folder");
    assert_eq!(trust_key(&s(&cwd), "native"), key_of(&cwd));
}

#[test]
fn trust_key_of_a_linked_worktree_with_a_relative_gitdir_is_the_main_root() {
    let t = Tmp::new("wt-rel");
    let admin = t.dir("main/.git/worktrees/feat");
    std::fs::write(admin.join("commondir"), "../..\n").unwrap();
    t.file("wts/feat/.git", "gitdir: ../../main/.git/worktrees/feat\n");
    let cwd = t.dir("wts/feat/src");
    assert_eq!(trust_key(&s(&cwd), "native"), key_of(&t.0.join("main")));
}

#[test]
fn trust_key_of_a_linked_worktree_with_an_absolute_gitdir_is_the_main_root() {
    let t = Tmp::new("wt-abs");
    // No `commondir` file: falls back to the `…/worktrees/<name>` shape.
    let admin = t.dir("main/.git/worktrees/feat");
    t.file("feat/.git", &format!("gitdir: {}\n", s(&admin)));
    let cwd = t.0.join("feat");
    assert_eq!(trust_key(&s(&cwd), "native"), key_of(&t.0.join("main")));
}

#[test]
fn trust_key_of_a_submodule_is_the_submodule_itself() {
    let t = Tmp::new("submodule");
    t.dir("super/.git/modules/lib");
    t.file("super/lib/.git", "gitdir: ../.git/modules/lib\n");
    let cwd = t.0.join("super/lib");
    assert_eq!(trust_key(&s(&cwd), "native"), key_of(&cwd));
}

#[cfg(unix)]
#[test]
fn trust_key_resolves_symlinks() {
    let t = Tmp::new("symlink");
    let repo = t.dir("real/.git").parent().unwrap().to_path_buf();
    let link = t.0.join("link");
    std::os::unix::fs::symlink(&repo, &link).unwrap();
    assert_eq!(trust_key(&s(&link), "native"), key_of(&repo));
}

// ---- exact-key trust predicate ----

#[test]
fn an_ancestor_trusted_but_root_not_is_untrusted() {
    let t = Tmp::new("ancestor");
    t.dir("repo/.git");
    let cwd = s(&t.0.join("repo"));
    let config = t.dir("config");
    t.file(
        "config/.claude.json",
        &json!({ "projects": { key_of(&t.0): { "hasTrustDialogAccepted": true } } }).to_string(),
    );
    let h = project_health(&cwd, "native", Some(&s(&config)));
    assert!(!h.trust.trusted);
    assert_eq!(h.trust.key, key_of(&t.0.join("repo")));
}

#[test]
fn a_trusted_subdirectory_cwd_does_not_count_but_the_root_does() {
    let t = Tmp::new("subtrust");
    t.dir("repo/.git");
    let sub = t.dir("repo/pkg");
    let config = t.dir("config");
    t.file(
        "config/.claude.json",
        &json!({ "projects": { key_of(&sub): { "hasTrustDialogAccepted": true } } }).to_string(),
    );
    assert!(
        !project_health(&s(&sub), "native", Some(&s(&config)))
            .trust
            .trusted
    );
    t.file(
        "config/.claude.json",
        &json!({ "projects": { key_of(&t.0.join("repo")): { "hasTrustDialogAccepted": true } } })
            .to_string(),
    );
    assert!(
        project_health(&s(&sub), "native", Some(&s(&config)))
            .trust
            .trusted
    );
}

#[test]
fn a_trusted_worktree_path_does_not_count() {
    let t = Tmp::new("wt-trust");
    t.dir("main/.git/worktrees/feat");
    t.file("feat/.git", "gitdir: ../main/.git/worktrees/feat\n");
    let wt = t.0.join("feat");
    let config = t.dir("config");
    t.file(
        "config/.claude.json",
        &json!({ "projects": { key_of(&wt): { "hasTrustDialogAccepted": true } } }).to_string(),
    );
    let h = project_health(&s(&wt), "native", Some(&s(&config)));
    assert!(!h.trust.trusted);
    assert_eq!(h.trust.key, key_of(&t.0.join("main")));
}

// ---- allow rules ----

#[test]
fn allow_rule_count_sums_both_cwd_files() {
    let docs = vec![
        json!({ "permissions": { "allow": ["Bash(touch:*)", "Read"], "deny": ["x"] } }),
        json!({ "permissions": { "allow": ["Edit"] } }),
        json!({ "permissions": {} }),
        json!({}),
    ];
    assert_eq!(allow_rule_count(&docs), 3);
}

#[test]
fn allow_rules_are_read_from_the_cwd_not_the_git_root() {
    let t = Tmp::new("allow");
    t.dir("repo/.git");
    t.file(
        "repo/.claude/settings.json",
        r#"{"permissions":{"allow":["Read","Grep","Glob"]}}"#,
    );
    t.file(
        "repo/pkg/.claude/settings.json",
        r#"{"permissions":{"allow":["Bash(touch:*)"]}}"#,
    );
    t.file(
        "repo/pkg/.claude/settings.local.json",
        r#"{"permissions":{"allow":["Edit"]}}"#,
    );
    let config = t.dir("config");
    let h = project_health(&s(&t.0.join("repo/pkg")), "native", Some(&s(&config)));
    assert_eq!(h.trust.allow_rule_count, 2);
    assert!(!h.trust.trusted);
}

#[test]
fn unparseable_settings_count_as_no_rules() {
    let t = Tmp::new("garbage");
    t.file(".claude/settings.json", "{ nope");
    assert_eq!(allow_rule_count(&cwd_settings_docs(&s(&t.0))), 0);
}

// ---- guard detection ----

fn cohorte_shell() -> Value {
    json!({ "hooks": { "PreToolUse": [
        { "matcher": "Bash|Task|Agent", "hooks": [
            { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py\"", "onFailure": "block" } ] },
        { "matcher": "Write|Edit|MultiEdit|NotebookEdit", "hooks": [
            { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py\"", "onFailure": "block" } ] }
    ] } })
}

fn cohorte_exec() -> Value {
    json!({ "hooks": { "PreToolUse": [
        { "matcher": "Bash|Task|Agent", "hooks": [
            { "type": "command", "command": "python3", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/cohorte-gate.py"], "onFailure": "block" } ] }
    ] } })
}

#[test]
fn find_guards_detects_the_shell_form() {
    let g = find_guards(&[cohorte_shell()]);
    assert_eq!(g.len(), 2);
    assert_eq!(g[0].interpreter.as_deref(), Some("python3"));
}

#[test]
fn find_guards_detects_the_exec_form() {
    let g = find_guards(&[cohorte_exec()]);
    assert_eq!(
        g,
        vec![GuardHook {
            interpreter: Some("python3".into())
        }]
    );
}

#[test]
fn find_guards_ignores_other_hooks_and_other_events() {
    let docs = vec![json!({ "hooks": {
        "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "python3 lint.py" } ] } ],
        "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "python3 cohorte-gate.py" } ] } ]
    } })];
    assert!(find_guards(&docs).is_empty());
}

#[test]
fn a_directly_invoked_script_needs_no_interpreter() {
    let docs = vec![json!({ "hooks": { "PreToolUse": [ { "hooks": [
        { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py\"" } ] } ] } })];
    assert_eq!(find_guards(&docs), vec![GuardHook { interpreter: None }]);
}

#[test]
fn guard_health_reports_the_missing_interpreter() {
    let never = |_: &str| false;
    let h = guard_health(&[cohorte_shell()], Some(&never));
    assert_eq!(
        h,
        ClaudeGuardHealth {
            registered: true,
            interpreter_missing: Some("python3".into())
        }
    );
}

#[test]
fn guard_health_is_quiet_when_the_interpreter_resolves() {
    let always = |p: &str| p == "python3";
    let h = guard_health(&[cohorte_exec()], Some(&always));
    assert_eq!(
        h,
        ClaudeGuardHealth {
            registered: true,
            interpreter_missing: None
        }
    );
}

#[test]
fn guard_health_skips_the_interpreter_check_when_asked() {
    let h = guard_health(&[cohorte_shell()], None);
    assert_eq!(
        h,
        ClaudeGuardHealth {
            registered: true,
            interpreter_missing: None
        }
    );
}

#[test]
fn guard_health_without_a_guard_reports_nothing() {
    let never = |_: &str| false;
    let h = guard_health(&[json!({})], Some(&never));
    assert_eq!(
        h,
        ClaudeGuardHealth {
            registered: false,
            interpreter_missing: None
        }
    );
}

// ---- writer ----

#[test]
fn write_trust_creates_a_missing_file() {
    let t = Tmp::new("write-new");
    let path = t.0.join("config/.claude.json");
    write_trust(&path, "/a/repo").unwrap();
    let doc: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        doc,
        json!({ "projects": { "/a/repo": { "hasTrustDialogAccepted": true } } })
    );
}

#[test]
fn write_trust_preserves_every_other_field() {
    let t = Tmp::new("write-keep");
    let before = json!({
        "numStartups": 12,
        "oauthAccount": { "email": "x" },
        "projects": {
            "/other": { "hasTrustDialogAccepted": false, "allowedTools": [] },
            "/a/repo": { "hasTrustDialogAccepted": false, "lastCost": 1.5, "mcpServers": { "s": {} } }
        }
    });
    let path = t.file(".claude.json", &before.to_string());
    write_trust(&path, "/a/repo").unwrap();
    let doc: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let mut expected = before.clone();
    expected["projects"]["/a/repo"]["hasTrustDialogAccepted"] = json!(true);
    assert_eq!(doc, expected);
}

#[test]
fn write_trust_refuses_garbage_and_a_non_object_node() {
    let t = Tmp::new("write-refuse");
    let garbage = t.file("a/.claude.json", "{ nope");
    assert!(write_trust(&garbage, "/a").is_err());
    assert_eq!(std::fs::read_to_string(&garbage).unwrap(), "{ nope");
    let odd = t.file("b/.claude.json", r#"{"projects":{"/a":"weird"}}"#);
    assert!(write_trust(&odd, "/a").is_err());
}

#[test]
fn trusting_then_probing_round_trips() {
    let t = Tmp::new("roundtrip");
    t.dir("repo/.git");
    t.file(
        "repo/.claude/settings.json",
        r#"{"permissions":{"allow":["Bash(touch:*)"]}}"#,
    );
    let cwd = s(&t.0.join("repo"));
    let config = t.dir("config");
    let before = project_health(&cwd, "native", Some(&s(&config)));
    assert!(!before.trust.trusted);
    let path = claude_json_path(Some(&s(&config)), "native", &cwd).unwrap();
    write_trust(&path, &before.trust.key).unwrap();
    let after = project_health(&cwd, "native", Some(&s(&config)));
    assert!(after.trust.trusted);
    assert_eq!(after.trust.allow_rule_count, 1);
}

#[test]
fn health_serializes_to_the_contract_shape() {
    let v = serde_json::to_value(ClaudeProjectHealth::neutral()).unwrap();
    assert_eq!(
        v,
        json!({
            "trust": { "trusted": true, "key": "", "allowRuleCount": 0 },
            "guard": { "registered": false, "interpreterMissing": null }
        })
    );
}

/// Lead-only check against the REAL CLI. Writes trust for the exact key a
/// `claude -p` in `FRANCOIS_TRUST_CHECK_CWD` reads, into
/// `$FRANCOIS_TRUST_CHECK_CONFIG/.claude.json` (a CLAUDE_CONFIG_DIR):
///
///   cd src-tauri && FRANCOIS_TRUST_CHECK_CONFIG=/path/to/throwaway-config \
///     FRANCOIS_TRUST_CHECK_CWD=/path/to/repo-or-worktree \
///     cargo test writes_trust_for_real_cli_check -- --ignored --nocapture
///
/// then `CLAUDE_CONFIG_DIR=<config> claude -p …` in that cwd should honour the
/// project's `permissions.allow` rules. Use a throwaway config dir.
#[test]
#[ignore]
fn writes_trust_for_real_cli_check() {
    let (Ok(config), Ok(cwd)) = (
        std::env::var("FRANCOIS_TRUST_CHECK_CONFIG"),
        std::env::var("FRANCOIS_TRUST_CHECK_CWD"),
    ) else {
        eprintln!("FRANCOIS_TRUST_CHECK_CONFIG / FRANCOIS_TRUST_CHECK_CWD unset — skipping");
        return;
    };
    let path = claude_json_path(Some(&config), "native", &cwd).unwrap();
    let key = trust_key(&cwd, "native");
    write_trust(&path, &key).unwrap();
    let h = project_health(&cwd, "native", Some(&config));
    println!(
        "wrote projects[{key:?}].hasTrustDialogAccepted = true into {}",
        path.display()
    );
    println!("health: {h:?}");
    assert!(h.trust.trusted);
}
