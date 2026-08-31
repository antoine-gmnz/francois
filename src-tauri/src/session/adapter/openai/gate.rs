//! FR-9..FR-13 — the permission gate for the Francois loop.
//!
//! On a Claude session the gate is Claude Code's and Francois only renders its
//! cards. Here **we are the gate**: nothing executes without our approval step,
//! and §2 calls that the highest-severity correctness requirement in the
//! feature. Specified fail-closed throughout — there is no default-allow path
//! for any tool, `Read` included.
//!
//! `evaluate` is a PURE decision function: no I/O beyond the read-only
//! filesystem metadata `resolve_in_cwd` needs to canonicalize a path, no HTTP,
//! no tool execution (that is `tools.rs`'s job). `rules` is expected to be
//! FR-9's reuse of `permissions::list_rules` — already ordered deny → ask →
//! allow, local before global — so the first matching ENABLED rule wins.
//!
//! **Interpretation applied (flagged for review):** FR-12 says
//! `bypassPermissions` "skips the gate entirely" and FR-13 says tool execution
//! is "confined to the session's cwd" with no mode qualifier. Read together,
//! FR-12 is about the *approval step* and FR-13 is unconditional — so
//! `resolve_in_cwd`'s containment check runs BEFORE the mode is even
//! consulted, in every mode including `bypassPermissions`.

use super::FrancoisTool;
use crate::ipc::{AppError, ErrorCode};
use crate::permissions::{path_key, path_relative_to_cwd, split_pattern, PermissionRule};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// FR-10's exact tool-result string for a `deny` rule. `pub(crate)` so
/// `runner.rs`'s park path (the same refusal, reached via a card rather than
/// a rule match) reuses this literal instead of keeping its own copy.
pub const DENY_MESSAGE: &str = "Permission denied by a Francois rule.";

/// The outcome of evaluating one tool call against the gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    /// Execute the call; no card.
    Allow,
    /// Do NOT execute; the `String` is the tool result handed back to the model.
    Deny(String),
    /// Park on a permission card (`permission.asked`, built by `build_ask`).
    Ask,
}

/// `SessionMeta.permissionMode` (contract/common.ts `PermissionMode`), the
/// subset FR-12 branches on. Any string outside this set is `Default` — the
/// fail-closed half of FR-12.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Default,
    Plan,
    AcceptEdits,
    BypassPermissions,
}

fn normalize_mode(raw: &str) -> Mode {
    match raw {
        "plan" => Mode::Plan,
        "acceptEdits" => Mode::AcceptEdits,
        "bypassPermissions" => Mode::BypassPermissions,
        // "default" AND every unrecognized string — assert this, it is the
        // fail-closed half of FR-12.
        _ => Mode::Default,
    }
}

/// FR-9..FR-13: decide what happens to one tool call, before it executes.
pub fn evaluate(
    tool: FrancoisTool,
    input: &Value,
    cwd: &str,
    permission_mode: &str,
    rules: &[PermissionRule],
) -> GateDecision {
    // FR-13, unconditionally (see the module doc's interpretation note): a path
    // escaping `cwd` is refused before the card AND before the mode branch, so
    // a card — or bypassPermissions — can never approve a path the tool would
    // then refuse.
    if let Some(raw) = path_arg(tool, input, cwd) {
        if let Err(e) = resolve_in_cwd(Path::new(cwd), raw) {
            // The tool result the model reads is the message; the code never
            // crosses the IPC boundary from here (FR-6).
            return GateDecision::Deny(e.message);
        }
    }

    match normalize_mode(permission_mode) {
        Mode::BypassPermissions => GateDecision::Allow,
        Mode::Plan
            if matches!(
                tool,
                FrancoisTool::Write | FrancoisTool::Edit | FrancoisTool::Bash
            ) =>
        {
            GateDecision::Deny(plan_refusal(tool))
        }
        Mode::AcceptEdits if matches!(tool, FrancoisTool::Write | FrancoisTool::Edit) => {
            GateDecision::Allow
        }
        _ => evaluate_by_rules(tool, input, cwd, rules),
    }
}

/// FR-12's plan-mode refusal, one per tool so the model knows what was blocked.
/// No exact wording is pinned by the spec (§7 only says "a refusal string");
/// this mirrors the "Francois: …" prefix `permission-guardrails` FR-12 already
/// uses for its own deny message.
fn plan_refusal(tool: FrancoisTool) -> String {
    format!("Francois: {tool} is not available while this session is in plan mode.")
}

/// FR-9/FR-10: walk the resolved rules (already ordered deny → ask → allow) and
/// apply the first ENABLED match. No match, or nothing at all — `Ask`. There is
/// no default-allow branch here, by construction: every path through this
/// function that is not an explicit `allow` match falls through to `Ask`.
fn evaluate_by_rules(
    tool: FrancoisTool,
    input: &Value,
    cwd: &str,
    rules: &[PermissionRule],
) -> GateDecision {
    for rule in rules.iter().filter(|r| r.enabled) {
        if rule_matches(&rule.pattern, tool, input, cwd) {
            return match rule.effect.as_str() {
                "allow" => GateDecision::Allow,
                "deny" => GateDecision::Deny(DENY_MESSAGE.to_string()),
                // "ask" and anything else on disk that isn't allow/deny — park it.
                _ => GateDecision::Ask,
            };
        }
    }
    GateDecision::Ask
}

/// The rule matcher (none existed in `permissions/` — Claude Code does this
/// matching upstream today; this is the Francois-loop's own).
///
/// `permission-guardrails` v1 generates patterns from real calls only — a
/// hand-typed pattern must match one of `generate_pattern`'s own shapes or it
/// silently never fires (`specs/permission-guardrails.md` §2 non-goals). So the
/// matcher only needs to understand those shapes:
///   * a bare tool name (`"Bash"`) — matches any call of that tool;
///   * `Bash(<prefix>:*)` — a prefix match on the raw command;
///   * `Bash(<exact>)` — an exact command match;
///   * `<Tool>(<path>)` — an exact match on the path expressed the same way
///     `generate_pattern`/`path_relative_to_cwd` expresses it.
///
/// This is deliberately the exact inverse of `generate_pattern`: the pinned
/// invariant test below proves that a pattern `generate_pattern` produces for a
/// call always matches that same call here.
fn rule_matches(pattern: &str, tool: FrancoisTool, input: &Value, cwd: &str) -> bool {
    if pattern == tool.as_str() {
        return true;
    }
    let Some((rule_tool, arg)) = split_pattern(pattern) else {
        // Some other bare form (`mcp__…`, `WebFetch`, …) — never one of the six.
        return false;
    };
    if rule_tool != tool.as_str() {
        return false;
    }
    match tool {
        FrancoisTool::Bash => {
            let cmd = input
                .get("command")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .trim();
            match arg.strip_suffix(":*") {
                Some(prefix) => cmd == prefix || cmd.starts_with(&format!("{prefix} ")),
                None => cmd == arg,
            }
        }
        FrancoisTool::Read
        | FrancoisTool::Write
        | FrancoisTool::Edit
        | FrancoisTool::Grep
        | FrancoisTool::Glob => match path_arg(tool, input, cwd) {
            Some(raw) => path_relative_to_cwd(raw, cwd) == arg,
            None => false,
        },
    }
}

/// The path-shaped argument of a call, using the SAME key names
/// `permissions/patterns.rs` keys on (`file_path`, `path`) — so the gate and the
/// pattern builder always read the same request shape. `Grep`/`Glob` declare
/// `path` optional ("Defaults to the session's working directory.",
/// `wire.rs`); an absent or empty key defaults to `cwd` itself here, BEFORE
/// `resolve_in_cwd` ever runs, so containment always has something to resolve
/// and `tools::execute` never falls through to its own internal-error string
/// for these two tools. `Read`/`Write`/`Edit` declare `file_path` required, so
/// they get no default — an absent key stays `None` for them.
fn path_arg<'a>(tool: FrancoisTool, input: &'a Value, cwd: &'a str) -> Option<&'a str> {
    let keys = path_key(tool.as_str())?;
    let found = keys.iter().find_map(|k| {
        input
            .get(*k)
            .and_then(|v| v.as_str())
            .filter(|p| !p.is_empty())
    });
    found.or_else(|| matches!(tool, FrancoisTool::Grep | FrancoisTool::Glob).then_some(cwd))
}

/// FR-13: resolve `raw` against `cwd` and reject anything escaping it after
/// canonicalization, symlinks included. `raw`'s own `.`/`..` segments are
/// collapsed lexically (`lexically_normalize`) BEFORE the existing-ancestor
/// search below, so a not-yet-created tail can never itself smuggle a `..`
/// escape past an existing prefix that happens to still be inside `cwd`.
///
/// Handles a write into a not-yet-created directory, any number of levels
/// deep (`newdir/deeper/new.ts`, neither `newdir` nor `deeper` existing yet)
/// by walking `joined`'s ancestors up to the first that exists on disk,
/// canonicalizing THAT (so a symlink anywhere in the existing prefix still
/// resolves and is still checked), then rejoining the still-missing tail.
pub fn resolve_in_cwd(cwd: &Path, raw: &str) -> Result<PathBuf, AppError> {
    // core-architecture-wave3 FR-6: INVALID_INPUT on every rejection. The
    // message is what `GateDecision::Deny` hands the model; the code exists so
    // this signature is the same `Result<T, AppError>` as every other fallible
    // one in the core, not because a caller branches on it.
    let refused = |m: String| AppError::new(ErrorCode::InvalidInput, m);
    let candidate = Path::new(raw);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        cwd.join(candidate)
    };
    let joined = lexically_normalize(&joined);

    let canonical_cwd = std::fs::canonicalize(cwd)
        .map_err(|e| refused(format!("session cwd is not accessible: {e}")))?;

    let canonical_target = match std::fs::canonicalize(&joined) {
        Ok(p) => p,
        Err(_) => {
            let existing = joined
                .ancestors()
                .find(|p| p.exists())
                .ok_or_else(|| refused(format!("{raw} is outside the session directory.")))?;
            let canonical_existing = std::fs::canonicalize(existing)
                .map_err(|_| refused(format!("{raw} is outside the session directory.")))?;
            let remainder = joined
                .strip_prefix(existing)
                .map_err(|_| refused(format!("{raw} is outside the session directory.")))?;
            canonical_existing.join(remainder)
        }
    };

    if canonical_target.starts_with(&canonical_cwd) {
        Ok(canonical_target)
    } else {
        Err(refused(format!("{raw} is outside the session directory.")))
    }
}

/// Collapse `.`/`..` path components purely syntactically (no filesystem
/// access) — see `resolve_in_cwd`'s doc for why this must run before the
/// existing-ancestor search.
fn lexically_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    // ---------- fixtures ----------

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A unique, created throwaway session cwd — every test gets its own, no
    /// shared global state (repo convention, see `session/attachments/testutil.rs`).
    fn temp_cwd(label: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "francois-oai-gate-{label}-{}-{n}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Plant a directory link at `link` pointing at `target`. On Windows this is
    /// a JUNCTION (`mklink /J`), which needs no elevation/Developer Mode, unlike
    /// a real symlink — the same trade `session/attachments/testutil.rs` makes.
    /// Returns false when the host refuses, so the caller has nothing to assert.
    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) -> bool {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return true;
        }
        crate::process_util::spawn("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok()
            && link.exists()
    }

    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    fn rule(tier: &str, effect: &str, pattern: &str, enabled: bool) -> PermissionRule {
        PermissionRule {
            id: format!("{tier}|{effect}|{pattern}"),
            pattern: pattern.to_string(),
            effect: effect.to_string(),
            tier: tier.to_string(),
            enabled,
            label: pattern.to_string(),
        }
    }

    fn allow(tier: &str, pattern: &str) -> PermissionRule {
        rule(tier, "allow", pattern, true)
    }

    fn deny(tier: &str, pattern: &str) -> PermissionRule {
        rule(tier, "deny", pattern, true)
    }

    fn ask_rule(tier: &str, pattern: &str) -> PermissionRule {
        rule(tier, "ask", pattern, true)
    }

    // ---------- FR-10: fail-closed, table-driven across all six tools ----------

    #[test]
    fn every_tool_asks_when_nothing_matches() {
        let cwd = temp_cwd("unmatched");
        std::fs::write(cwd.join("a.txt"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();

        let cases: [(FrancoisTool, Value); 6] = [
            (
                FrancoisTool::Read,
                json!({ "file_path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (
                FrancoisTool::Write,
                json!({ "file_path": cwd.join("new.txt").to_string_lossy() }),
            ),
            (
                FrancoisTool::Edit,
                json!({ "file_path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (
                FrancoisTool::Grep,
                json!({ "path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (FrancoisTool::Glob, json!({ "path": cwd_str.clone() })),
            (FrancoisTool::Bash, json!({ "command": "npm test" })),
        ];
        for (tool, input) in cases {
            let decision = evaluate(tool, &input, &cwd_str, "default", &[]);
            assert_eq!(decision, GateDecision::Ask, "{tool} with no rules must ask");
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    // ---------- FR-13/wire.rs: an omitted/empty `path` defaults to cwd ----------

    #[test]
    fn grep_and_glob_default_to_cwd_when_path_is_omitted_or_empty() {
        let cwd = "/repo/session-cwd";
        for tool in [FrancoisTool::Grep, FrancoisTool::Glob] {
            assert_eq!(
                path_arg(tool, &json!({}), cwd),
                Some(cwd),
                "{tool} with an omitted path must default to cwd"
            );
            assert_eq!(
                path_arg(tool, &json!({ "path": "" }), cwd),
                Some(cwd),
                "{tool} with an empty path must default to cwd"
            );
        }
    }

    #[test]
    fn read_write_and_edit_do_not_default_when_path_is_omitted() {
        // file_path is REQUIRED for these three (wire.rs's own schema) — an
        // absent key must stay None, not silently default to cwd.
        let cwd = "/repo/session-cwd";
        for tool in [FrancoisTool::Read, FrancoisTool::Write, FrancoisTool::Edit] {
            assert_eq!(
                path_arg(tool, &json!({}), cwd),
                None,
                "{tool} must not default an omitted file_path"
            );
        }
    }

    #[test]
    fn grep_with_no_path_still_runs_containment_using_cwd_itself() {
        // Before the fix, an omitted `path` made `path_arg` return `None`,
        // which skipped `resolve_in_cwd` entirely. Proven here by pointing
        // `cwd` at a directory that does not exist: the gate must now still
        // try to resolve it (against the defaulted cwd) and refuse.
        let missing_cwd = std::env::temp_dir().join("francois-oai-gate-missing-cwd-does-not-exist");
        std::fs::remove_dir_all(&missing_cwd).ok();
        let cwd_str = missing_cwd.to_string_lossy().to_string();
        let decision = evaluate(
            FrancoisTool::Grep,
            &json!({ "pattern": "x" }),
            &cwd_str,
            "default",
            &[],
        );
        match decision {
            GateDecision::Deny(msg) => {
                assert!(msg.contains("not accessible"), "unexpected message: {msg}")
            }
            other => panic!("expected containment to run for an omitted path, got {other:?}"),
        }
    }

    #[test]
    fn glob_with_no_path_resolves_and_asks_when_cwd_exists() {
        let cwd = temp_cwd("glob-no-path");
        let cwd_str = cwd.to_string_lossy().to_string();
        let decision = evaluate(FrancoisTool::Glob, &json!({}), &cwd_str, "default", &[]);
        assert_eq!(decision, GateDecision::Ask);
        std::fs::remove_dir_all(&cwd).ok();
    }

    // ---------- the invariant: generate_pattern's output always matches itself ----------

    #[test]
    fn a_pattern_generated_for_a_call_always_matches_that_same_call() {
        let cwd = temp_cwd("invariant");
        std::fs::write(cwd.join("a.ts"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();

        let cases: [(FrancoisTool, Value); 6] = [
            (
                FrancoisTool::Read,
                json!({ "file_path": cwd.join("a.ts").to_string_lossy() }),
            ),
            (
                FrancoisTool::Write,
                json!({ "file_path": cwd.join("new-file.ts").to_string_lossy() }),
            ),
            (
                FrancoisTool::Edit,
                json!({ "file_path": cwd.join("a.ts").to_string_lossy(), "old_string": "x", "new_string": "y" }),
            ),
            (
                FrancoisTool::Grep,
                json!({ "path": cwd.join("a.ts").to_string_lossy(), "pattern": "x" }),
            ),
            (FrancoisTool::Glob, json!({ "path": cwd_str.clone() })),
            (
                FrancoisTool::Bash,
                json!({ "command": "npm test -- --watch --bail" }),
            ),
        ];
        for (tool, input) in cases {
            let pattern = crate::permissions::generate_pattern(tool.as_str(), &input, &cwd_str);
            let rules = vec![allow("local", &pattern)];
            let decision = evaluate(tool, &input, &cwd_str, "default", &rules);
            assert_eq!(
                decision,
                GateDecision::Allow,
                "{tool}: generated pattern {pattern:?} did not match its own call"
            );
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    // ---------- FR-10: a deny rule never executes ----------

    #[test]
    fn a_deny_rule_never_executes() {
        let rules = vec![deny("local", "Bash(rm:*)")];
        let decision = evaluate(
            FrancoisTool::Bash,
            &json!({ "command": "rm -rf build" }),
            "/repo",
            "default",
            &rules,
        );
        assert_eq!(
            decision,
            GateDecision::Deny("Permission denied by a Francois rule.".to_string())
        );
    }

    #[test]
    fn deny_takes_precedence_when_it_sorts_first_in_the_list() {
        // list_rules orders deny -> ask -> allow; first-match-wins on that order
        // is what makes deny beat a broader allow for the same call.
        let rules = vec![deny("local", "Bash"), allow("local", "Bash(npm test:*)")];
        let decision = evaluate(
            FrancoisTool::Bash,
            &json!({ "command": "npm test" }),
            "/repo",
            "default",
            &rules,
        );
        assert_eq!(
            decision,
            GateDecision::Deny("Permission denied by a Francois rule.".to_string())
        );
    }

    // ---------- FR-12: plan mode ----------

    #[test]
    fn plan_mode_refuses_write_edit_and_bash() {
        let cwd = temp_cwd("plan");
        std::fs::write(cwd.join("a.txt"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();

        for (tool, input) in [
            (
                FrancoisTool::Write,
                json!({ "file_path": cwd.join("new.txt").to_string_lossy() }),
            ),
            (
                FrancoisTool::Edit,
                json!({ "file_path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (FrancoisTool::Bash, json!({ "command": "npm test" })),
        ] {
            let decision = evaluate(tool, &input, &cwd_str, "plan", &[]);
            match decision {
                GateDecision::Deny(_) => {}
                other => panic!("{tool} in plan mode must be refused, got {other:?}"),
            }
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn plan_mode_still_lets_read_grep_and_glob_reach_the_rules() {
        let cwd = temp_cwd("plan-read");
        std::fs::write(cwd.join("a.txt"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();

        for (tool, input) in [
            (
                FrancoisTool::Read,
                json!({ "file_path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (
                FrancoisTool::Grep,
                json!({ "path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (FrancoisTool::Glob, json!({ "path": cwd_str.clone() })),
        ] {
            // No rule matches -> Ask, not Deny: plan mode does not refuse these.
            assert_eq!(
                evaluate(tool, &input, &cwd_str, "plan", &[]),
                GateDecision::Ask
            );
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    // ---------- FR-12: acceptEdits ----------

    #[test]
    fn accept_edits_auto_allows_only_write_and_edit() {
        let cwd = temp_cwd("accept-edits");
        std::fs::write(cwd.join("a.txt"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();

        for tool in [FrancoisTool::Write, FrancoisTool::Edit] {
            let input = json!({ "file_path": cwd.join("a.txt").to_string_lossy() });
            assert_eq!(
                evaluate(tool, &input, &cwd_str, "acceptEdits", &[]),
                GateDecision::Allow,
                "{tool} must be auto-allowed under acceptEdits"
            );
        }
        // The "only": Bash/Read/Grep/Glob still ask (no rule provided).
        for (tool, input) in [
            (FrancoisTool::Bash, json!({ "command": "npm test" })),
            (
                FrancoisTool::Read,
                json!({ "file_path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (
                FrancoisTool::Grep,
                json!({ "path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (FrancoisTool::Glob, json!({ "path": cwd_str.clone() })),
        ] {
            assert_eq!(
                evaluate(tool, &input, &cwd_str, "acceptEdits", &[]),
                GateDecision::Ask,
                "{tool} must still ask under acceptEdits"
            );
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    // ---------- FR-13: cwd containment, before any card ----------

    #[test]
    fn a_cwd_escape_is_refused_before_any_card_even_with_a_matching_allow_rule() {
        let cwd = temp_cwd("escape");
        let outside = temp_cwd("escape-outside");
        std::fs::write(outside.join("secret.txt"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();
        let escaping_path = outside.join("secret.txt").to_string_lossy().to_string();

        // An allow-everything rule is present, so if containment ran AFTER rule
        // matching (or not at all) this would wrongly resolve Allow.
        let rules = vec![allow("local", "Read")];
        let decision = evaluate(
            FrancoisTool::Read,
            &json!({ "file_path": escaping_path }),
            &cwd_str,
            "default",
            &rules,
        );
        match decision {
            GateDecision::Deny(_) => {}
            other => panic!("expected a refusal before any card, got {other:?}"),
        }
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn a_relative_dot_dot_escape_is_refused_even_when_the_target_does_not_exist() {
        let cwd = temp_cwd("dotdot");
        let cwd_str = cwd.to_string_lossy().to_string();
        let decision = evaluate(
            FrancoisTool::Write,
            &json!({ "file_path": "../secret.txt" }),
            &cwd_str,
            "default",
            &[],
        );
        match decision {
            GateDecision::Deny(_) => {}
            other => panic!("expected a refusal, got {other:?}"),
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn a_symlinked_directory_escape_is_refused() {
        let cwd = temp_cwd("symlink-cwd");
        let outside = temp_cwd("symlink-outside");
        std::fs::write(outside.join("target.txt"), b"x").unwrap();
        let link = cwd.join("escape-link");
        if !link_dir(&outside, &link) {
            // Host refuses unprivileged links (no Developer Mode) — nothing to
            // assert here, same accommodation the repo's other symlink tests make.
            std::fs::remove_dir_all(&cwd).ok();
            std::fs::remove_dir_all(&outside).ok();
            return;
        }
        let cwd_str = cwd.to_string_lossy().to_string();
        let via_link = cwd
            .join("escape-link")
            .join("target.txt")
            .to_string_lossy()
            .to_string();
        let decision = evaluate(
            FrancoisTool::Read,
            &json!({ "file_path": via_link }),
            &cwd_str,
            "default",
            &[],
        );
        match decision {
            GateDecision::Deny(_) => {}
            other => panic!("expected a refusal through the symlink, got {other:?}"),
        }
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn a_write_to_a_new_file_inside_cwd_is_allowed() {
        let cwd = temp_cwd("newfile");
        let new_path = cwd.join("brand-new.txt").to_string_lossy().to_string();
        let resolved = resolve_in_cwd(&cwd, &new_path).expect("new file inside cwd must resolve");
        assert!(resolved.starts_with(std::fs::canonicalize(&cwd).unwrap()));
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn a_write_into_a_not_yet_created_nested_directory_inside_cwd_is_allowed() {
        // Neither `newdir` nor `deeper` exists yet — `tools::write` creates
        // both via `create_dir_all`, so the gate must not reject this.
        let cwd = temp_cwd("nested-newdir");
        let nested = cwd
            .join("newdir")
            .join("deeper")
            .join("brand-new.ts")
            .to_string_lossy()
            .to_string();
        let resolved = resolve_in_cwd(&cwd, &nested)
            .expect("a new file under a not-yet-created nested directory must resolve inside cwd");
        assert!(resolved.starts_with(std::fs::canonicalize(&cwd).unwrap()));
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn evaluate_allows_a_write_into_a_nested_not_yet_created_directory() {
        let cwd = temp_cwd("nested-newdir-evaluate");
        let cwd_str = cwd.to_string_lossy().to_string();
        let file_path = cwd
            .join("newdir")
            .join("brand-new.ts")
            .to_string_lossy()
            .to_string();
        let decision = evaluate(
            FrancoisTool::Write,
            &json!({ "file_path": file_path }),
            &cwd_str,
            "default",
            &[],
        );
        // No rule matches -> Ask (not Deny) proves containment did not reject it.
        assert_eq!(decision, GateDecision::Ask);
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn a_dot_dot_escape_through_a_not_yet_created_nested_directory_is_still_denied() {
        let cwd = temp_cwd("nested-dotdot");
        let result = resolve_in_cwd(&cwd, "newdir/../../secret.txt");
        assert!(
            result.is_err(),
            "escaping via .. through a nested new path must be denied"
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn a_nested_not_yet_created_path_reached_through_a_symlinked_ancestor_is_still_denied() {
        let cwd = temp_cwd("nested-symlink-cwd");
        let outside = temp_cwd("nested-symlink-outside");
        let link = cwd.join("escape-link");
        if !link_dir(&outside, &link) {
            // Host refuses unprivileged links — nothing to assert (same
            // accommodation as `a_symlinked_directory_escape_is_refused`).
            std::fs::remove_dir_all(&cwd).ok();
            std::fs::remove_dir_all(&outside).ok();
            return;
        }
        // `newsub` does not exist yet, on either side of the link.
        let raw = cwd
            .join("escape-link")
            .join("newsub")
            .join("new.ts")
            .to_string_lossy()
            .to_string();
        let result = resolve_in_cwd(&cwd, &raw);
        assert!(
            result.is_err(),
            "a nested new path reached through a symlinked ancestor must still be denied"
        );
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    // ---------- FR-11 (matcher correctness beyond the degenerate invariant case) ----------

    #[test]
    fn a_bash_prefix_rule_matches_any_command_sharing_that_prefix() {
        // The rule's own prefix ("git") is SHORTER than what generate_pattern
        // would derive for this call ("git commit") — proving the matcher does
        // real prefix/starts_with matching, not just literal pattern equality.
        let rules = vec![allow("local", "Bash(git:*)")];
        let decision = evaluate(
            FrancoisTool::Bash,
            &json!({ "command": "git commit -m 'msg'" }),
            "/repo",
            "default",
            &rules,
        );
        assert_eq!(decision, GateDecision::Allow);
    }

    #[test]
    fn path_rules_match_only_the_exact_relative_path() {
        let cwd = temp_cwd("path-exact");
        std::fs::write(cwd.join("a.ts"), b"x").unwrap();
        std::fs::write(cwd.join("b.ts"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();

        let rules = vec![allow("local", "Read(a.ts)")];
        assert_eq!(
            evaluate(
                FrancoisTool::Read,
                &json!({ "file_path": cwd.join("a.ts").to_string_lossy() }),
                &cwd_str,
                "default",
                &rules
            ),
            GateDecision::Allow
        );
        assert_eq!(
            evaluate(
                FrancoisTool::Read,
                &json!({ "file_path": cwd.join("b.ts").to_string_lossy() }),
                &cwd_str,
                "default",
                &rules
            ),
            GateDecision::Ask
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    // ---------- FR-10: an `ask` rule parks a card, same as no match ----------

    #[test]
    fn an_ask_rule_parks_a_card() {
        let rules = vec![ask_rule("local", "Bash(git push:*)")];
        let decision = evaluate(
            FrancoisTool::Bash,
            &json!({ "command": "git push origin main" }),
            "/repo",
            "default",
            &rules,
        );
        assert_eq!(decision, GateDecision::Ask);
    }

    #[test]
    fn a_disabled_rule_is_skipped() {
        // A rule parked in the sidecar (enabled: false) must not decide anything.
        let rules = vec![rule("local", "allow", "Bash", false)];
        let decision = evaluate(
            FrancoisTool::Bash,
            &json!({ "command": "npm test" }),
            "/repo",
            "default",
            &rules,
        );
        assert_eq!(decision, GateDecision::Ask);
    }

    // ---------- FR-12: bypassPermissions skips the gate entirely ----------

    #[test]
    fn bypass_permissions_skips_the_gate_for_every_tool() {
        let cwd = temp_cwd("bypass");
        std::fs::write(cwd.join("a.txt"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();

        let cases: [(FrancoisTool, Value); 6] = [
            (
                FrancoisTool::Read,
                json!({ "file_path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (
                FrancoisTool::Write,
                json!({ "file_path": cwd.join("new.txt").to_string_lossy() }),
            ),
            (
                FrancoisTool::Edit,
                json!({ "file_path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (
                FrancoisTool::Grep,
                json!({ "path": cwd.join("a.txt").to_string_lossy() }),
            ),
            (FrancoisTool::Glob, json!({ "path": cwd_str.clone() })),
            (FrancoisTool::Bash, json!({ "command": "rm -rf /" })),
        ];
        for (tool, input) in cases {
            // Even a `deny` rule is bypassed — the mode skips the gate entirely.
            let rules = vec![deny("local", "Bash")];
            let decision = evaluate(tool, &input, &cwd_str, "bypassPermissions", &rules);
            assert_eq!(
                decision,
                GateDecision::Allow,
                "{tool} must be allowed under bypassPermissions"
            );
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn bypass_permissions_does_not_bypass_cwd_containment() {
        // FR-13's containment is unconditional (this module's interpretation
        // note): bypassPermissions skips the APPROVAL step, not the confinement.
        let cwd = temp_cwd("bypass-escape");
        let outside = temp_cwd("bypass-escape-outside");
        std::fs::write(outside.join("secret.txt"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();
        let escaping_path = outside.join("secret.txt").to_string_lossy().to_string();

        let decision = evaluate(
            FrancoisTool::Read,
            &json!({ "file_path": escaping_path }),
            &cwd_str,
            "bypassPermissions",
            &[],
        );
        match decision {
            GateDecision::Deny(_) => {}
            other => panic!("expected containment to still apply, got {other:?}"),
        }
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    // ---------- FR-12: an unrecognized mode behaves as default ----------

    #[test]
    fn an_unrecognized_mode_behaves_as_default() {
        let cwd = temp_cwd("weird-mode");
        std::fs::write(cwd.join("a.txt"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();

        // No rule -> asks, exactly like "default" (not treated as bypass/plan/acceptEdits).
        assert_eq!(
            evaluate(
                FrancoisTool::Write,
                &json!({ "file_path": cwd.join("a.txt").to_string_lossy() }),
                &cwd_str,
                "some-future-mode",
                &[]
            ),
            GateDecision::Ask
        );
        // A matching allow rule still applies under the unrecognized mode —
        // proving it is routed through FR-10, not silently blocked or bypassed.
        let rules = vec![allow("local", "Bash(npm test:*)")];
        assert_eq!(
            evaluate(
                FrancoisTool::Bash,
                &json!({ "command": "npm test" }),
                &cwd_str,
                "some-future-mode",
                &rules
            ),
            GateDecision::Allow
        );
        std::fs::remove_dir_all(&cwd).ok();
    }
}
