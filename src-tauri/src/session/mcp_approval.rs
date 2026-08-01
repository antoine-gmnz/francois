//! MCP first-run approval + workspace trust for a session's project.
//!
//! Claude Code gates project-scope `.mcp.json` servers behind a first-run consent
//! dialog ("New MCP server found in this project"), and a never-before-opened
//! folder behind a trust dialog. Both answers are stored in the CLI's own user
//! store — `<claude config>/.claude.json`, under `projects[<cwd>]`:
//!
//!   enabledMcpjsonServers  — the names the user said yes to
//!   disabledMcpjsonServers — the names the user said no to
//!   hasTrustDialogAccepted — the folder-trust answer
//!
//! Why Francois has to own this. The per-turn `claude -p` spawn (turn.rs) SKIPS
//! both dialogs, so an unapproved server silently never connects and pane [4]
//! shows a permanent `handshake…` for a server that will never handshake. The
//! Remote Control host (remote/start.rs) is a real interactive TUI, so it PARKS
//! on the dialog forever — `blocking_prompt` catches that and kills it, which is
//! the failure the user actually sees. Both symptoms are the same missing
//! decision, so this module makes that decision available from the app and writes
//! exactly the keys the CLI reads.
//!
//! Francois still never ANSWERS a dialog on the user's behalf — every write here
//! is the direct result of a click. What changed is where the click happens.
//!
//! Concurrency: `~/.claude.json` has three writers (the CLI, an editor, Francois)
//! exactly like settings.json, so writes go through the same surgical
//! read → touch → `write_json_atomic` path as permission-guardrails FR-14. A
//! concurrent CLI write can still lose a stat field it had in flight; nothing can
//! be torn, and the three keys this module owns are never touched by anything
//! else in Francois.

use super::*;

use crate::ipc::{err, ok, IpcResult};
use crate::permissions::{
    global_settings_path, local_settings_path, read_json_object, write_json_atomic,
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::PathBuf;
use tauri::{AppHandle, State};

// ---------- contract shapes (contract/mcp-panel.ts, mirrored by hand) ----------

/// contract McpApprovalState.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpApprovalState {
    /// `.mcp.json` servers with no decision on record yet — what the CLI would ask about.
    pub pending: Vec<String>,
    /// `.mcp.json` servers already approved (or blanket-approved by settings).
    pub approved: Vec<String>,
    /// `.mcp.json` servers explicitly refused; the CLI will not start them.
    pub rejected: Vec<String>,
    /// The folder-trust dialog has not been accepted for this cwd yet.
    pub trust_required: bool,
    /// `enableAllProjectMcpServers` is on in some settings tier — nothing can be pending.
    pub enable_all_project_mcp_servers: bool,
}

impl McpApprovalState {
    /// Anything an interactive `claude` would stop and ask about in this folder.
    pub(crate) fn blocks_interactive(&self) -> bool {
        !self.pending.is_empty() || self.trust_required
    }
}

// ---------- locating the CLI's user store ----------

/// `<claude config>/.claude.json` for a session — the file the CLI keeps the three
/// approval keys in.
///
/// Resolution mirrors the spawn's own env (spawn.rs `account_env`), because a
/// decision written to the wrong store is a decision the session's `claude` never
/// sees: an account with a `CLAUDE_CONFIG_DIR` keeps its OWN `.claude.json` in
/// there (that override replaces the config root wholesale — see account/mirror.rs),
/// a `wsl` session's store lives in the DISTRO's home reached over the UNC root,
/// and everything else is `~/.claude.json`.
pub(crate) fn claude_json_path(
    config_dir: Option<&str>,
    runtime: &str,
    cwd: &str,
) -> Option<PathBuf> {
    if let Some(dir) = config_dir {
        return Some(PathBuf::from(dir).join(".claude.json"));
    }
    let home = if runtime == "wsl" {
        crate::wsl::wsl_home_unc(cwd).map(PathBuf::from)
    } else {
        dirs::home_dir()
    }?;
    Some(home.join(".claude.json"))
}

/// The `projects` key to read and write for a cwd.
///
/// Prefers a key the CLI already has for this folder, matched with `path_eq` so a
/// `D:\repo` cwd finds the CLI's `D:/repo` node rather than creating a second one
/// beside it — two nodes for one folder would mean writing a decision the CLI then
/// reads from the other node and never sees. Only when there is no node at all do
/// we mint one, in `norm_path`'s forward-slash dialect: that is what current CLI
/// versions write on Windows (verified against a live `~/.claude.json`), and a
/// no-op everywhere else.
pub(crate) fn project_key(doc: &Value, cwd: &str) -> String {
    doc.get("projects")
        .and_then(|p| p.as_object())
        .and_then(|o| o.keys().find(|k| path_eq(k, cwd)).cloned())
        .unwrap_or_else(|| norm_path(cwd))
}

// ---------- reading the decision (pure) ----------

/// A node's string array under `key`, skipping non-strings (they are preserved on
/// write, just not counted).
pub(crate) fn string_list(node: Option<&Value>, key: &str) -> Vec<String> {
    node.and_then(|n| n.get(key))
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Everything that can carry a decision, folded into one view. `.claude.json`'s
/// project node is the dialog's own store; the settings tiers can carry the same
/// three keys (Claude Code's `enabledMcpjsonServers` / `disabledMcpjsonServers` /
/// `enableAllProjectMcpServers` settings), and a server allowed by ANY of them is
/// not something the CLI will ask about.
#[derive(Default, Debug, PartialEq)]
pub(crate) struct Approvals {
    pub(crate) enabled: Vec<String>,
    pub(crate) disabled: Vec<String>,
    pub(crate) enable_all: bool,
    pub(crate) trusted: bool,
}

/// Fold the CLI's project node together with every settings document that can
/// override it. `settings` is passed in rather than read here so the fold stays
/// pure and unit-testable.
pub(crate) fn fold_approvals(node: Option<&Value>, settings: &[Value]) -> Approvals {
    let mut out = Approvals {
        enabled: string_list(node, "enabledMcpjsonServers"),
        disabled: string_list(node, "disabledMcpjsonServers"),
        enable_all: false,
        trusted: node
            .and_then(|n| n.get("hasTrustDialogAccepted"))
            .and_then(|t| t.as_bool())
            .unwrap_or(false),
    };
    for doc in settings {
        for name in string_list(Some(doc), "enabledMcpjsonServers") {
            if !out.enabled.contains(&name) {
                out.enabled.push(name);
            }
        }
        for name in string_list(Some(doc), "disabledMcpjsonServers") {
            if !out.disabled.contains(&name) {
                out.disabled.push(name);
            }
        }
        if doc
            .get("enableAllProjectMcpServers")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            out.enable_all = true;
        }
    }
    out
}

/// Sort the project's `.mcp.json` server names into the three buckets the panel
/// renders. `disabled` wins over `enabled` for a name in both, matching the CLI:
/// a refused server does not start, however it got into the other list.
pub(crate) fn classify(servers: &[String], a: &Approvals) -> McpApprovalState {
    let mut state = McpApprovalState {
        trust_required: !a.trusted,
        enable_all_project_mcp_servers: a.enable_all,
        ..Default::default()
    };
    for name in servers {
        if a.disabled.contains(name) {
            state.rejected.push(name.clone());
        } else if a.enable_all || a.enabled.contains(name) {
            state.approved.push(name.clone());
        } else {
            state.pending.push(name.clone());
        }
    }
    state
}

// ---------- writing the decision (pure) ----------

/// The `projects.<key>` object of a `.claude.json` document, created on demand.
/// `None` for a document (or an existing node) that is not an object — the caller
/// must refuse to write rather than replace something it does not understand.
fn project_node_mut<'a>(doc: &'a mut Value, key: &str) -> Option<&'a mut Map<String, Value>> {
    let root = doc.as_object_mut()?;
    let projects = root
        .entry("projects")
        .or_insert_with(|| Value::Object(Map::new()));
    if !projects.is_object() {
        return None;
    }
    let node = projects
        .as_object_mut()?
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !node.is_object() {
        return None;
    }
    node.as_object_mut()
}

/// Move `name` into the `into` array and out of the `outof` one. Returns whether
/// the document changed, so an idempotent re-approval never rewrites the file.
fn move_name(node: &mut Map<String, Value>, name: &str, into: &str, outof: &str) -> bool {
    let mut changed = false;
    let target = node
        .entry(into.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !target.is_array() {
        *target = Value::Array(Vec::new());
        changed = true;
    }
    if let Some(arr) = target.as_array_mut() {
        if !arr.iter().any(|v| v.as_str() == Some(name)) {
            arr.push(Value::String(name.to_string()));
            changed = true;
        }
    }
    if let Some(arr) = node.get_mut(outof).and_then(|a| a.as_array_mut()) {
        let before = arr.len();
        arr.retain(|v| v.as_str() != Some(name));
        changed |= before != arr.len();
    }
    changed
}

/// Apply a set of decisions to a `.claude.json` document, surgically: every other
/// key of the document, of the `projects` map, and of the node itself is left
/// exactly as it was. Returns whether anything changed.
///
/// A name in BOTH lists is approved — `approve` is applied last, so the explicit
/// yes wins over a stale no.
pub(crate) fn apply_decision(
    doc: &mut Value,
    key: &str,
    approve: &[String],
    reject: &[String],
    trust: bool,
) -> bool {
    let Some(node) = project_node_mut(doc, key) else {
        return false;
    };
    let mut changed = false;
    for name in reject {
        changed |= move_name(
            node,
            name,
            "disabledMcpjsonServers",
            "enabledMcpjsonServers",
        );
    }
    for name in approve {
        changed |= move_name(
            node,
            name,
            "enabledMcpjsonServers",
            "disabledMcpjsonServers",
        );
    }
    if trust && node.get("hasTrustDialogAccepted").and_then(|t| t.as_bool()) != Some(true) {
        node.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
        changed = true;
    }
    changed
}

// ---------- the I/O half ----------

/// Every settings document that can carry an approval key, in no particular order
/// (the fold is a union, so order does not matter). Missing or unparseable files
/// are skipped: a settings.json Francois cannot read must not make a project look
/// approved, and must not fail the read either.
fn settings_docs(cwd: &str, runtime: &str) -> Vec<Value> {
    let mut paths = vec![
        std::path::Path::new(cwd)
            .join(".claude")
            .join("settings.json"),
        local_settings_path(cwd),
    ];
    if let Some(global) = global_settings_path(cwd, runtime) {
        paths.push(global);
    }
    paths
        .iter()
        .filter_map(|p| read_json_object(p).ok())
        .collect()
}

/// The approval state of one project — the whole read path, for the command and
/// for `mcp_list`'s per-row status.
pub(crate) fn approval_state(
    cwd: &str,
    runtime: &str,
    config_dir: Option<&str>,
) -> McpApprovalState {
    let servers: Vec<String> = mcp_servers_of(Some(&read_mcp_json(cwd)))
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let doc = claude_json_path(config_dir, runtime, cwd)
        .and_then(|p| read_json_object(&p).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let approvals = fold_approvals(project_node(&doc, cwd), &settings_docs(cwd, runtime));
    classify(&servers, &approvals)
}

/// (cwd, runtime, account config dir) for a session — the three things every read
/// and write here needs.
fn target_of(
    app: &AppHandle,
    engine: &Engine,
    session_id: &str,
) -> Option<(String, String, Option<String>)> {
    let (cwd, runtime, account_id) = engine.with_session(session_id, |s| {
        (s.cwd.clone(), s.runtime.clone(), s.account_id.clone())
    })?;
    let config_dir = crate::account::config_dir_of(app, &account_id);
    Some((cwd, runtime, config_dir))
}

// ---------- commands ----------

/// francois:mcp:approvals — what this session's project still needs a decision on.
#[tauri::command(async)]
pub fn mcp_approvals(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<McpApprovalState> {
    let Some((cwd, runtime, config_dir)) = target_of(&app, &engine, &session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    ok(approval_state(&cwd, &runtime, config_dir.as_deref()))
}

/// francois:mcp:decide — approve/reject project MCP servers and/or trust the
/// folder, then answer with the state that resulted. Idempotent: a decision that
/// changes nothing never rewrites the file.
///
/// Approved servers are re-flagged `connecting` (same as `mcp_reconnect`): the CLI
/// only actually starts them on the session's next turn, and a row left at
/// `pending` after an approval would read as if the click did nothing.
#[tauri::command(async)]
pub fn mcp_decide(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    approve: Vec<String>,
    reject: Vec<String>,
    trust: bool,
) -> IpcResult<McpApprovalState> {
    let Some((cwd, runtime, config_dir)) = target_of(&app, &engine, &session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    let Some(path) = claude_json_path(config_dir.as_deref(), &runtime, &cwd) else {
        return err(
            "MCP_ERROR",
            "could not locate the Claude Code config directory for this session",
        );
    };
    // An unparseable .claude.json is NEVER overwritten — it carries the user's
    // whole CLI state, not just these three keys.
    let mut doc = match read_json_object(&path) {
        Ok(v) => v,
        Err(e) => return err("MCP_ERROR", e),
    };
    let key = project_key(&doc, &cwd);
    if apply_decision(&mut doc, &key, &approve, &reject, trust) {
        if let Err(e) = write_json_atomic(&path, &doc) {
            return err("MCP_ERROR", e);
        }
    }

    for name in &approve {
        let info = connecting_info(name);
        engine.with_session_mut(&session_id, |s| {
            s.mcp.insert(name.clone(), info.clone());
        });
        emit(
            &app,
            SessionEvent::McpUpdate {
                session_id: session_id.clone(),
                server: info,
            },
        );
    }
    for name in &reject {
        engine.with_session_mut(&session_id, |s| {
            s.mcp.remove(name);
        });
    }

    ok(approval_state(&cwd, &runtime, config_dir.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // ---- claude_json_path ----

    #[test]
    fn claude_json_path_prefers_the_accounts_config_dir() {
        // multi-account: CLAUDE_CONFIG_DIR replaces the config root wholesale, so
        // the account's own .claude.json is the only store its claude reads.
        let p = claude_json_path(Some("/accounts/a1"), "native", "/repo").unwrap();
        assert_eq!(p, PathBuf::from("/accounts/a1").join(".claude.json"));
    }

    #[test]
    fn claude_json_path_falls_back_to_the_home_store() {
        let p = claude_json_path(None, "native", "/repo").unwrap();
        assert!(p.ends_with(".claude.json"));
        assert_eq!(p.parent(), dirs::home_dir().as_deref());
    }

    // ---- project_key ----

    #[test]
    fn project_key_reuses_the_clis_existing_node_across_path_dialects() {
        // The CLI writes forward slashes on Windows; a session's cwd carries
        // backslashes. Minting a second node would write a decision the CLI reads
        // from the first one and never sees.
        let doc = json!({ "projects": { "D:/repo": { "hasTrustDialogAccepted": true } } });
        assert_eq!(project_key(&doc, "D:\\repo"), "D:/repo");
    }

    #[test]
    fn project_key_mints_a_normalized_key_when_there_is_no_node() {
        assert_eq!(project_key(&json!({}), "D:\\repo"), "D:/repo");
        assert_eq!(project_key(&json!({ "projects": {} }), "/a/b/"), "/a/b");
    }

    // ---- fold_approvals ----

    #[test]
    fn fold_approvals_reads_the_project_node() {
        let node = json!({
            "enabledMcpjsonServers": ["serena"],
            "disabledMcpjsonServers": ["sketchy"],
            "hasTrustDialogAccepted": true
        });
        let a = fold_approvals(Some(&node), &[]);
        assert_eq!(a.enabled, names(&["serena"]));
        assert_eq!(a.disabled, names(&["sketchy"]));
        assert!(a.trusted);
        assert!(!a.enable_all);
    }

    #[test]
    fn fold_approvals_treats_a_missing_node_as_untrusted_and_undecided() {
        let a = fold_approvals(None, &[]);
        assert_eq!(a, Approvals::default());
        assert!(
            !a.trusted,
            "a folder the CLI has never seen shows the trust dialog"
        );
    }

    #[test]
    fn fold_approvals_unions_the_settings_tiers() {
        let node = json!({ "enabledMcpjsonServers": ["a"] });
        let settings = vec![
            json!({ "enabledMcpjsonServers": ["b", "a"] }),
            json!({ "disabledMcpjsonServers": ["c"] }),
        ];
        let a = fold_approvals(Some(&node), &settings);
        assert_eq!(a.enabled, names(&["a", "b"]), "unioned, no duplicates");
        assert_eq!(a.disabled, names(&["c"]));
    }

    #[test]
    fn fold_approvals_honours_enable_all_from_any_tier() {
        let a = fold_approvals(
            None,
            &[json!({}), json!({ "enableAllProjectMcpServers": true })],
        );
        assert!(a.enable_all);
    }

    #[test]
    fn fold_approvals_skips_non_string_entries() {
        let node = json!({ "enabledMcpjsonServers": ["a", 7, { "x": 1 }] });
        assert_eq!(fold_approvals(Some(&node), &[]).enabled, names(&["a"]));
    }

    // ---- classify ----

    #[test]
    fn classify_sorts_servers_into_the_three_buckets() {
        let a = Approvals {
            enabled: names(&["yes"]),
            disabled: names(&["no"]),
            enable_all: false,
            trusted: true,
        };
        let state = classify(&names(&["yes", "no", "dunno"]), &a);
        assert_eq!(state.approved, names(&["yes"]));
        assert_eq!(state.rejected, names(&["no"]));
        assert_eq!(state.pending, names(&["dunno"]));
        assert!(!state.trust_required);
        assert!(
            state.blocks_interactive(),
            "a pending server parks the RC host"
        );
    }

    #[test]
    fn classify_lets_a_refusal_win_over_an_approval() {
        // The CLI does not start a disabled server whatever else says about it.
        let a = Approvals {
            enabled: names(&["x"]),
            disabled: names(&["x"]),
            enable_all: true,
            trusted: true,
        };
        assert_eq!(classify(&names(&["x"]), &a).rejected, names(&["x"]));
    }

    #[test]
    fn classify_approves_everything_under_enable_all() {
        let a = Approvals {
            enable_all: true,
            trusted: true,
            ..Default::default()
        };
        let state = classify(&names(&["a", "b"]), &a);
        assert_eq!(state.approved, names(&["a", "b"]));
        assert!(state.pending.is_empty());
        assert!(!state.blocks_interactive());
    }

    #[test]
    fn classify_reports_trust_on_its_own_even_with_no_servers() {
        // The trust dialog parks the Remote Control host just as hard as the MCP
        // one, and a project with no .mcp.json at all can still be untrusted.
        let state = classify(&[], &Approvals::default());
        assert!(state.trust_required);
        assert!(state.blocks_interactive());
    }

    // ---- apply_decision ----

    #[test]
    fn apply_decision_creates_the_node_and_both_arrays() {
        let mut doc = json!({});
        assert!(apply_decision(
            &mut doc,
            "/repo",
            &names(&["serena"]),
            &[],
            true
        ));
        assert_eq!(
            doc["projects"]["/repo"]["enabledMcpjsonServers"],
            json!(["serena"])
        );
        assert_eq!(
            doc["projects"]["/repo"]["hasTrustDialogAccepted"],
            json!(true)
        );
    }

    #[test]
    fn apply_decision_is_idempotent() {
        let mut doc = json!({
            "projects": { "/repo": {
                "enabledMcpjsonServers": ["serena"],
                "hasTrustDialogAccepted": true
            } }
        });
        assert!(
            !apply_decision(&mut doc, "/repo", &names(&["serena"]), &[], true),
            "an unchanged document must not be rewritten"
        );
    }

    #[test]
    fn apply_decision_moves_a_name_between_the_two_lists() {
        let mut doc = json!({
            "projects": { "/repo": { "disabledMcpjsonServers": ["serena"] } }
        });
        assert!(apply_decision(
            &mut doc,
            "/repo",
            &names(&["serena"]),
            &[],
            false
        ));
        assert_eq!(
            doc["projects"]["/repo"]["enabledMcpjsonServers"],
            json!(["serena"])
        );
        assert_eq!(
            doc["projects"]["/repo"]["disabledMcpjsonServers"],
            json!([]),
            "an emptied array stays in place, like permissions FR-14"
        );

        assert!(apply_decision(
            &mut doc,
            "/repo",
            &[],
            &names(&["serena"]),
            false
        ));
        assert_eq!(doc["projects"]["/repo"]["enabledMcpjsonServers"], json!([]));
        assert_eq!(
            doc["projects"]["/repo"]["disabledMcpjsonServers"],
            json!(["serena"])
        );
    }

    #[test]
    fn apply_decision_lets_approve_win_when_a_name_is_in_both_requests() {
        let mut doc = json!({});
        apply_decision(&mut doc, "/repo", &names(&["x"]), &names(&["x"]), false);
        assert_eq!(
            doc["projects"]["/repo"]["enabledMcpjsonServers"],
            json!(["x"])
        );
        assert_eq!(
            doc["projects"]["/repo"]["disabledMcpjsonServers"],
            json!([])
        );
    }

    #[test]
    fn apply_decision_preserves_every_other_key() {
        // ~/.claude.json holds the user's whole CLI state — onboarding counters,
        // oauth account, per-project stats. A decision must touch three keys.
        let mut doc = json!({
            "userID": "u1",
            "projects": {
                "/other": { "hasTrustDialogAccepted": true },
                "/repo": { "lastCost": 12, "mcpServers": { "local": {} } }
            }
        });
        apply_decision(&mut doc, "/repo", &names(&["serena"]), &[], true);
        assert_eq!(doc["userID"], "u1");
        assert_eq!(
            doc["projects"]["/other"]["hasTrustDialogAccepted"],
            json!(true)
        );
        assert_eq!(doc["projects"]["/repo"]["lastCost"], json!(12));
        assert!(doc["projects"]["/repo"]["mcpServers"]["local"].is_object());
    }

    #[test]
    fn apply_decision_refuses_a_node_that_is_not_an_object() {
        // Better to report "nothing changed" than to replace something we do not
        // understand inside the user's CLI store.
        let mut doc = json!({ "projects": { "/repo": "surprise" } });
        assert!(!apply_decision(
            &mut doc,
            "/repo",
            &names(&["x"]),
            &[],
            true
        ));
        assert_eq!(doc["projects"]["/repo"], json!("surprise"));

        let mut doc = json!({ "projects": [] });
        assert!(!apply_decision(
            &mut doc,
            "/repo",
            &names(&["x"]),
            &[],
            true
        ));
    }

    #[test]
    fn apply_decision_replaces_a_non_array_list_rather_than_panicking() {
        let mut doc = json!({ "projects": { "/repo": { "enabledMcpjsonServers": 7 } } });
        assert!(apply_decision(
            &mut doc,
            "/repo",
            &names(&["x"]),
            &[],
            false
        ));
        assert_eq!(
            doc["projects"]["/repo"]["enabledMcpjsonServers"],
            json!(["x"])
        );
    }

    // ---- approval_state: the read path end to end, on a real temp project ----

    #[test]
    fn approval_state_reads_mcp_json_against_the_home_store() {
        let dir = std::env::temp_dir().join(format!("francois-approve-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        std::fs::write(
            dir.join(".mcp.json"),
            r#"{"mcpServers":{"serena":{"command":"serena"},"other":{"command":"other"}}}"#,
        )
        .unwrap();

        // The account config dir doubles as a fixture root for the store, which is
        // what keeps this test off the developer's real ~/.claude.json.
        let store = dir.join("config");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(
            store.join(".claude.json"),
            serde_json::to_vec(&json!({
                "projects": { norm_path(&cwd): {
                    "enabledMcpjsonServers": ["serena"],
                    "hasTrustDialogAccepted": true
                } }
            }))
            .unwrap(),
        )
        .unwrap();

        let state = approval_state(&cwd, "native", Some(&store.to_string_lossy()));
        assert_eq!(state.approved, names(&["serena"]));
        assert_eq!(state.pending, names(&["other"]));
        assert!(!state.trust_required);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn approval_state_of_a_project_with_no_mcp_json_is_empty() {
        let dir = std::env::temp_dir().join(format!("francois-approve-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let store = dir.join("config");
        std::fs::create_dir_all(&store).unwrap();

        let state = approval_state(&cwd, "native", Some(&store.to_string_lossy()));
        assert!(state.pending.is_empty());
        assert!(state.approved.is_empty());
        assert!(
            state.trust_required,
            "an unseen folder still shows the trust dialog"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
