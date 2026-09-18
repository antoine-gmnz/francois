//! MCP first-run approval + workspace trust for a session's project.
//!
//! Claude Code gates project-scope `.mcp.json` servers behind a first-run consent
//! dialog ("New MCP server found in this project"), and an untrusted folder
//! behind a trust dialog. Where the answers live was VERIFIED against the shipped
//! CLI (2.1.220) by driving `claude -p` runs against controlled stores, because
//! the store moved between CLI generations and a decision written where the CLI
//! no longer reads simply does nothing:
//!
//!   - The consent answer lives in the PROJECT's `.claude/settings.local.json`
//!     (`enabledMcpjsonServers` / `disabledMcpjsonServers`). That is what the
//!     interactive dialog writes today. The legacy copies of those two arrays on
//!     the `~/.claude.json` project node are MIGRATED into it (unioned) on the
//!     next CLI run and stripped from the node.
//!   - The folder-trust answer still lives on the `~/.claude.json` project node
//!     (`hasTrustDialogAccepted`), under `getProjectPathForConfig()` — the git
//!     repository root of the cwd (see `cli_project_key`) — and resolves through
//!     every ANCESTOR of the cwd (see `trust_accepted`).
//!
//! What the decisions actually gate (same verification):
//!
//!   - The per-turn `claude -p` spawn (turn.rs) shows NO dialog and STARTS every
//!     undecided `.mcp.json` server — trust does not gate it either. The one
//!     thing it honours is `disabledMcpjsonServers`: a refused name never starts,
//!     and `disabled` beats `enabled` when a name is in both.
//!   - The interactive `--remote-control` host is where the dialogs bite: it
//!     checks trust up front and, if it fails, prints "Error: Workspace not
//!     trusted." and exits(1) before publishing a URL, and undecided servers park
//!     it on the consent dialog. That is why this module still tracks `pending`
//!     and `trust_required` at all.
//!
//! The migration is also why a decision MUST be written to settings.local.json
//! and not only to the legacy node: the union can re-add a name to `disabled`
//! from a stale node entry, and nothing written to the node can ever CLEAR a
//! `disabled` entry already sitting in settings.local.json — an approval that
//! only touches the node looks accepted in the UI and changes nothing in the CLI.
//! `mcp_decide` therefore writes BOTH stores: settings.local.json (what the CLI
//! reads) and the node (old CLIs, plus trust, which still lives there).
//!
//! Francois still never ANSWERS a dialog on the user's behalf — every write here
//! is the direct result of a click. What changed is where the click happens.
//!
//! Concurrency: both stores have three writers (the CLI, an editor, Francois)
//! exactly like settings.json, so writes go through the same surgical
//! read → touch → `write_json_atomic` path as permission-guardrails FR-14. A
//! concurrent CLI write can still lose a stat field it had in flight; nothing can
//! be torn, and the keys this module owns are never touched by anything else in
//! Francois.

use super::*;
use crate::ipc::ErrorCode;

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
    /// Only the INTERACTIVE host (Remote Control) is parked by these — a `-p`
    /// turn starts undecided servers without asking (see the module doc).
    pub fn blocks_interactive(&self) -> bool {
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
pub fn claude_json_path(config_dir: Option<&str>, runtime: &str, cwd: &str) -> Option<PathBuf> {
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

/// The `projects` key Claude Code itself reads and writes for a cwd.
///
/// Read out of the shipped CLI rather than guessed — `getProjectPathForConfig` is
///
///   memo(() => { const cwd = getCwd(); const root = gitRoot(cwd);
///                return norm(root ?? resolve(cwd)) })
///
/// i.e. **the git repository root of the cwd**, falling back to the cwd itself,
/// normalized to forward slashes. A session opened in a SUBDIRECTORY of a repo
/// therefore shares one node with the repo root; keying on the cwd instead would
/// write the decision somewhere the CLI never looks.
pub fn cli_project_key(cwd: &str) -> String {
    norm_path(&git_root(cwd).unwrap_or_else(|| cwd.to_string()))
}

/// The nearest ancestor of `cwd` (inclusive) carrying a `.git` entry — the repo
/// root, resolved without spawning git because this sits on `mcp_list`, which
/// runs on every session switch. `.git` is a FILE in a linked worktree and a
/// directory otherwise; both mark a root the CLI resolves.
fn git_root(cwd: &str) -> Option<String> {
    let mut dir = std::path::Path::new(cwd);
    loop {
        // `Path::parent` bottoms out at "", whose `.git` would resolve against the
        // PROCESS's cwd — a repo root that has nothing to do with the session.
        if dir.as_os_str().is_empty() {
            return None;
        }
        if dir.join(".git").exists() {
            return Some(dir.to_string_lossy().to_string());
        }
        dir = dir.parent()?;
    }
}

/// `cwd` and every ancestor above it, normalized — the chain the CLI's trust
/// check walks.
///
/// Split on the normalized STRING rather than with `std::path::Path`, because the
/// separator here is not necessarily the host's: a `wsl` session carries POSIX
/// paths on Windows, and a Windows path is perfectly reachable on Linux (CI runs
/// these very cases). `Path` only splits on the separators of the platform it is
/// compiled for, so it would silently treat `D:\a\b` as ONE component and report
/// no ancestors at all. `norm_path` has already collapsed both dialects to `/`.
fn ancestors(cwd: &str) -> Vec<String> {
    let normalized = cwd.replace('\\', "/");
    let mut cur = normalized.trim_end_matches('/').to_string();
    if cur.is_empty() {
        // `norm_path` trims the trailing separator, which erases a bare root to "".
        // A cwd of "/" is one rung with nothing above it; "" is no rung at all.
        return if normalized.is_empty() {
            Vec::new()
        } else {
            vec!["/".to_string()]
        };
    }
    let mut out = Vec::new();
    while !cur.is_empty() {
        out.push(cur.clone());
        match cur.rfind('/') {
            // "D:" / "relative" — nothing above it.
            None => break,
            // "/a" — the POSIX root is the last rung, and its own parent.
            Some(0) => {
                if cur == "/" {
                    break;
                }
                cur = "/".to_string();
            }
            Some(i) => cur.truncate(i),
        }
    }
    out
}

/// Whether Claude Code considers this cwd trusted.
///
/// Mirrors the shipped CLI's `checkHasTrustDialogAccepted`, which is
///
///   projects[getProjectPathForConfig()]?.hasTrustDialogAccepted === true
///   || ANY ancestor of the cwd (inclusive, up to the filesystem root) carries it
///
/// **The ancestor walk is the part this module was missing**, and it is not an
/// edge case: accepting the dialog once for `D:/` or `~/src` trusts every repo
/// underneath it forever, so reading only the cwd's own node reports "not
/// trusted" for folders the CLI is perfectly happy to run in. That false positive
/// made `blocks_interactive` refuse every Remote Control start and left a
/// permanent approval banner in pane [4].
///
/// The key match stays `path_eq` (case-insensitive on Windows) where the CLI's is
/// exact. Leaning lenient here can only ever let a start through that the CLI
/// then refuses outright, which `blocking_prompt` reports — the strict reading
/// would instead block a folder the user really has trusted.
pub fn trust_accepted(doc: &Value, cwd: &str) -> bool {
    if node_trusted(doc, &cli_project_key(cwd)) {
        return true;
    }
    ancestors(cwd).iter().any(|key| node_trusted(doc, key))
}

/// `projects[<key>].hasTrustDialogAccepted === true`, for one key.
fn node_trusted(doc: &Value, key: &str) -> bool {
    project_node(doc, key)
        .and_then(|n| n.get("hasTrustDialogAccepted"))
        .and_then(|t| t.as_bool())
        .unwrap_or(false)
}

// ---------- reading the decision (pure) ----------

/// A node's string array under `key`, skipping non-strings (they are preserved on
/// write, just not counted).
pub fn string_list(node: Option<&Value>, key: &str) -> Vec<String> {
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
pub struct Approvals {
    pub(crate) enabled: Vec<String>,
    pub(crate) disabled: Vec<String>,
    pub(crate) enable_all: bool,
    pub(crate) trusted: bool,
}

/// Fold the CLI's project node together with every settings document that can
/// override it. `settings` and `trusted` are passed in rather than read here so
/// the fold stays pure and unit-testable — `trusted` in particular is NOT a
/// property of this one node (see `trust_accepted`: the CLI walks the cwd's
/// ancestors), so reading it off the node would reintroduce the false positive.
pub fn fold_approvals(node: Option<&Value>, settings: &[Value], trusted: bool) -> Approvals {
    let mut out = Approvals {
        enabled: string_list(node, "enabledMcpjsonServers"),
        disabled: string_list(node, "disabledMcpjsonServers"),
        enable_all: false,
        trusted,
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
pub fn classify(servers: &[String], a: &Approvals) -> McpApprovalState {
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
///
/// This is the LEGACY half of a decision (old CLIs, and the migration source) —
/// the store the current CLI actually reads is settings.local.json, written by
/// `apply_settings_decision`. Removing the name from the node's opposite list
/// here also matters for the migration: it unions the node into
/// settings.local.json, so a stale node entry left behind would resurrect the
/// old answer there.
pub fn apply_decision(
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

/// Apply approve/reject to a settings document (the project's
/// `.claude/settings.local.json`) — the store the shipped CLI reads consent from,
/// and the ONLY place a stale `disabledMcpjsonServers` entry can be cleared
/// (`disabled` beats `enabled` in the CLI, so an approval that leaves it behind
/// changes nothing). The two arrays sit at the DOCUMENT root, next to keys this
/// module must not touch (`permissions`, `env`, …) — same surgical contract as
/// `apply_decision`. `None` for a document that is not an object: the caller must
/// refuse to write rather than replace a file it does not understand.
///
/// Trust is deliberately absent — it still lives on the `~/.claude.json` node.
pub fn apply_settings_decision(
    doc: &mut Value,
    approve: &[String],
    reject: &[String],
) -> Option<bool> {
    let root = doc.as_object_mut()?;
    let mut changed = false;
    for name in reject {
        changed |= move_name(
            root,
            name,
            "disabledMcpjsonServers",
            "enabledMcpjsonServers",
        );
    }
    for name in approve {
        changed |= move_name(
            root,
            name,
            "enabledMcpjsonServers",
            "disabledMcpjsonServers",
        );
    }
    Some(changed)
}

/// Carry a project's MCP consent into a fresh worktree's settings document.
///
/// `.claude/settings.local.json` is gitignored, so a session-worktree checkout
/// starts with NO consent store at all: every server the user already decided on
/// in the source checkout re-appears as pending, and a refusal stops applying.
/// Copying the three consent keys at worktree creation makes a worktree session
/// behave like the checkout it was cut from — which is the whole promise of the
/// feature. Only the consent keys travel: `permissions` and everything else in
/// the file stay per-worktree, and a key the target already has is never
/// overwritten (an adopted-then-recreated worktree may carry its own answers).
/// Returns whether the target changed.
pub fn seed_settings_consent(source: &Value, target: &mut Value) -> bool {
    const CONSENT_KEYS: [&str; 3] = [
        "enabledMcpjsonServers",
        "disabledMcpjsonServers",
        "enableAllProjectMcpServers",
    ];
    let Some(root) = target.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    for key in CONSENT_KEYS {
        if root.contains_key(key) {
            continue;
        }
        if let Some(v) = source.get(key) {
            root.insert(key.to_string(), v.clone());
            changed = true;
        }
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
pub fn approval_state(cwd: &str, runtime: &str, config_dir: Option<&str>) -> McpApprovalState {
    let servers: Vec<String> = mcp_servers_of(Some(&read_mcp_json(cwd)))
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let doc = claude_json_path(config_dir, runtime, cwd)
        .and_then(|p| read_json_object(&p).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let approvals = fold_approvals(
        project_node(&doc, &cli_project_key(cwd)),
        &settings_docs(cwd, runtime),
        trust_accepted(&doc, cwd),
    );
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
        return err(ErrorCode::SessionNotFound, "no such session");
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
        return err(ErrorCode::SessionNotFound, "no such session");
    };
    let Some(path) = claude_json_path(config_dir.as_deref(), &runtime, &cwd) else {
        return err(
            ErrorCode::McpError,
            "could not locate the Claude Code config directory for this session",
        );
    };
    // An unparseable store is NEVER overwritten — .claude.json carries the user's
    // whole CLI state and settings.local.json their permission rules, not just
    // the keys this module owns. Both are read up front so a refusal happens
    // before either file is touched — a half-applied decision (node written,
    // settings refused) would leave the two stores telling different stories.
    // core-architecture-wave3 FR-6: the settings helpers raise
    // SETTINGS_WRITE_FAILED; this channel's contract says MCP_ERROR, so the
    // message crosses and the code is this domain's.
    let mut doc = match read_json_object(&path) {
        Ok(v) => v,
        Err(e) => return err(ErrorCode::McpError, e.message),
    };
    let settings_path = local_settings_path(&cwd);
    let mut settings = match read_json_object(&settings_path) {
        Ok(v) => v,
        Err(e) => return err(ErrorCode::McpError, e.message),
    };
    let key = cli_project_key(&cwd);
    if apply_decision(&mut doc, &key, &approve, &reject, trust) {
        if let Err(e) = write_json_atomic(&path, &doc) {
            return err(ErrorCode::McpError, e.message);
        }
    }
    // The half the current CLI actually reads (see the module doc) — without it
    // an approval is at the mercy of the CLI's migration and can never clear a
    // stale refusal.
    match apply_settings_decision(&mut settings, &approve, &reject) {
        Some(true) => {
            if let Err(e) = write_json_atomic(&settings_path, &settings) {
                return err(ErrorCode::McpError, e.message);
            }
        }
        Some(false) => {}
        None => {
            return err(
                ErrorCode::McpError,
                format!("{} is not a JSON object", settings_path.display()),
            )
        }
    }

    // An approved server is deliberately NOT flagged `connecting` here. Nothing has
    // started it — the CLI only does that on the session's next turn — so a
    // fabricated live entry would outrank the approval status in `mcp_list` and
    // paint exactly the handshake-that-never-completes this feature exists to
    // remove. `approval_status` reports it as `approved` instead, and the first
    // turn's init message replaces that with the truth.
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

    // ---- cli_project_key / git_root ----

    #[test]
    fn cli_project_key_normalizes_a_non_repo_cwd() {
        // No `.git` anywhere above a temp dir's leaf: the key is the cwd itself,
        // in the CLI's forward-slash dialect.
        let dir = std::env::temp_dir().join(format!("francois-key-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        assert_eq!(cli_project_key(&cwd), norm_path(&cwd));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cli_project_key_is_the_repo_root_for_a_subdirectory() {
        // getProjectPathForConfig() == norm(gitRoot(cwd) ?? cwd), so a session
        // opened in a subfolder shares ONE node with the repo root. Keying on the
        // cwd would write a decision the CLI never reads.
        let root = std::env::temp_dir().join(format!("francois-repo-{}", uuid::Uuid::new_v4()));
        let sub = root.join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        assert_eq!(
            cli_project_key(&sub.to_string_lossy()),
            norm_path(&root.to_string_lossy())
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn git_root_accepts_the_dot_git_file_of_a_linked_worktree() {
        // A linked worktree's `.git` is a FILE pointing at the main repo, and the
        // CLI treats the worktree itself as the root.
        let wt = std::env::temp_dir().join(format!("francois-wt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: /elsewhere/.git/worktrees/wt").unwrap();
        assert_eq!(
            cli_project_key(&wt.to_string_lossy()),
            norm_path(&wt.to_string_lossy())
        );
        std::fs::remove_dir_all(&wt).ok();
    }

    // ---- ancestors ----

    #[test]
    fn ancestors_walks_both_path_dialects_on_every_host() {
        // Not a portability nicety: `std::path::Path` splits only on the separators
        // of the platform it was compiled for, so a Windows path examined on Linux
        // (CI) or a wsl session's POSIX path examined on Windows would yield ONE
        // component and no ancestors — silently disabling the whole walk.
        assert_eq!(
            ancestors("D:\\some\\deep\\repo"),
            names(&["D:/some/deep/repo", "D:/some/deep", "D:/some", "D:"])
        );
        assert_eq!(
            ancestors("/home/u/proj/"),
            names(&["/home/u/proj", "/home/u", "/home", "/"])
        );
    }

    #[test]
    fn ancestors_terminates_on_a_root_or_a_bare_segment() {
        assert_eq!(ancestors("/"), names(&["/"]));
        assert_eq!(ancestors("D:/"), names(&["D:"]));
        assert!(ancestors("").is_empty());
    }

    // ---- trust_accepted ----

    #[test]
    fn trust_accepted_reads_the_cwds_own_node() {
        let doc = json!({ "projects": { "D:/repo": { "hasTrustDialogAccepted": true } } });
        assert!(trust_accepted(&doc, "D:\\repo"));
    }

    #[test]
    fn trust_accepted_walks_up_to_a_trusted_ancestor() {
        // THE regression this module shipped with. The CLI's own check walks every
        // ancestor of the cwd, so accepting the dialog once for `D:/` trusts every
        // repo underneath it. Reading only the cwd's node reported "not trusted"
        // for a folder `claude` runs in happily — which refused every Remote
        // Control start and pinned an approval banner in pane [4].
        let doc = json!({ "projects": { "D:/": { "hasTrustDialogAccepted": true } } });
        assert!(trust_accepted(&doc, "D:\\some\\deep\\repo"));
    }

    #[test]
    fn trust_accepted_ignores_an_ancestor_that_was_not_trusted() {
        let doc = json!({
            "projects": {
                "D:/": { "hasTrustDialogAccepted": false },
                "D:/other": { "hasTrustDialogAccepted": true }
            }
        });
        assert!(!trust_accepted(&doc, "D:\\some\\repo"));
    }

    #[test]
    fn trust_accepted_is_false_for_a_store_that_has_never_seen_the_tree() {
        assert!(!trust_accepted(&json!({}), "/a/b/c"));
        assert!(!trust_accepted(&json!({ "projects": {} }), "/a/b/c"));
    }

    // ---- fold_approvals ----

    #[test]
    fn fold_approvals_reads_the_project_node() {
        let node = json!({
            "enabledMcpjsonServers": ["serena"],
            "disabledMcpjsonServers": ["sketchy"],
        });
        let a = fold_approvals(Some(&node), &[], true);
        assert_eq!(a.enabled, names(&["serena"]));
        assert_eq!(a.disabled, names(&["sketchy"]));
        assert!(a.trusted);
        assert!(!a.enable_all);
    }

    #[test]
    fn fold_approvals_takes_trust_from_the_caller_not_the_node() {
        // Trust is a property of the whole ancestor chain, not of this one node —
        // a node carrying `hasTrustDialogAccepted: false` under a trusted parent is
        // still trusted, so the fold must never re-derive it.
        let node = json!({ "hasTrustDialogAccepted": false });
        assert!(fold_approvals(Some(&node), &[], true).trusted);
    }

    #[test]
    fn fold_approvals_treats_a_missing_node_as_undecided() {
        let a = fold_approvals(None, &[], false);
        assert_eq!(a, Approvals::default());
    }

    #[test]
    fn fold_approvals_unions_the_settings_tiers() {
        let node = json!({ "enabledMcpjsonServers": ["a"] });
        let settings = vec![
            json!({ "enabledMcpjsonServers": ["b", "a"] }),
            json!({ "disabledMcpjsonServers": ["c"] }),
        ];
        let a = fold_approvals(Some(&node), &settings, true);
        assert_eq!(a.enabled, names(&["a", "b"]), "unioned, no duplicates");
        assert_eq!(a.disabled, names(&["c"]));
    }

    #[test]
    fn fold_approvals_honours_enable_all_from_any_tier() {
        let a = fold_approvals(
            None,
            &[json!({}), json!({ "enableAllProjectMcpServers": true })],
            false,
        );
        assert!(a.enable_all);
    }

    #[test]
    fn fold_approvals_skips_non_string_entries() {
        let node = json!({ "enabledMcpjsonServers": ["a", 7, { "x": 1 }] });
        assert_eq!(
            fold_approvals(Some(&node), &[], false).enabled,
            names(&["a"])
        );
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

    // ---- apply_settings_decision ----

    #[test]
    fn apply_settings_decision_creates_both_arrays_at_the_root() {
        let mut doc = json!({});
        assert_eq!(
            apply_settings_decision(&mut doc, &names(&["serena"]), &[]),
            Some(true)
        );
        assert_eq!(doc["enabledMcpjsonServers"], json!(["serena"]));
    }

    #[test]
    fn apply_settings_decision_clears_a_stale_refusal() {
        // THE regression this write path exists for: `disabled` beats `enabled`
        // in the CLI, and settings.local.json is the only store where a refusal
        // can be cleared — an approval written to the legacy node alone leaves
        // the server refused forever while the panel says approved.
        let mut doc = json!({ "disabledMcpjsonServers": ["serena"] });
        assert_eq!(
            apply_settings_decision(&mut doc, &names(&["serena"]), &[]),
            Some(true)
        );
        assert_eq!(doc["enabledMcpjsonServers"], json!(["serena"]));
        assert_eq!(doc["disabledMcpjsonServers"], json!([]));
    }

    #[test]
    fn apply_settings_decision_is_idempotent() {
        let mut doc = json!({ "enabledMcpjsonServers": ["serena"] });
        assert_eq!(
            apply_settings_decision(&mut doc, &names(&["serena"]), &[]),
            Some(false),
            "an unchanged document must not be rewritten"
        );
    }

    #[test]
    fn apply_settings_decision_preserves_every_other_key() {
        // settings.local.json is the permission-guardrails store too — a consent
        // write must not touch the rules living next to the two arrays.
        let mut doc = json!({
            "permissions": { "allow": ["PowerShell"] },
            "enableAllProjectMcpServers": true
        });
        apply_settings_decision(&mut doc, &[], &names(&["sketchy"]));
        assert_eq!(doc["permissions"]["allow"], json!(["PowerShell"]));
        assert_eq!(doc["enableAllProjectMcpServers"], json!(true));
        assert_eq!(doc["disabledMcpjsonServers"], json!(["sketchy"]));
    }

    #[test]
    fn apply_settings_decision_refuses_a_non_object_document() {
        let mut doc = json!([]);
        assert_eq!(apply_settings_decision(&mut doc, &names(&["x"]), &[]), None);
        assert_eq!(doc, json!([]));
    }

    // ---- seed_settings_consent ----

    #[test]
    fn seed_settings_consent_copies_only_the_consent_keys() {
        let source = json!({
            "enabledMcpjsonServers": ["serena"],
            "enableAllProjectMcpServers": true,
            "permissions": { "allow": ["PowerShell"] }
        });
        let mut target = json!({});
        assert!(seed_settings_consent(&source, &mut target));
        assert_eq!(target["enabledMcpjsonServers"], json!(["serena"]));
        assert_eq!(target["enableAllProjectMcpServers"], json!(true));
        assert!(
            target.get("permissions").is_none(),
            "permission rules stay per-worktree"
        );
    }

    #[test]
    fn seed_settings_consent_never_overwrites_an_existing_answer() {
        let source = json!({ "enabledMcpjsonServers": ["serena"] });
        let mut target = json!({ "enabledMcpjsonServers": [] });
        assert!(!seed_settings_consent(&source, &mut target));
        assert_eq!(target["enabledMcpjsonServers"], json!([]));
    }

    #[test]
    fn seed_settings_consent_is_a_no_op_for_an_undecided_source() {
        let mut target = json!({});
        assert!(!seed_settings_consent(&json!({}), &mut target));
        assert_eq!(target, json!({}));
        assert!(!seed_settings_consent(&json!({}), &mut json!([])));
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
    fn approval_state_reads_the_projects_settings_local_json() {
        // The CLI's consent store is the project's settings.local.json (see the
        // module doc) — a refusal recorded there must classify as rejected even
        // when the ~/.claude.json node knows nothing about the server.
        let dir = std::env::temp_dir().join(format!("francois-approve-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        std::fs::write(
            dir.join(".mcp.json"),
            r#"{"mcpServers":{"serena":{"command":"serena"}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join(".claude").join("settings.local.json"),
            r#"{"disabledMcpjsonServers":["serena"]}"#,
        )
        .unwrap();
        let store = dir.join("config");
        std::fs::create_dir_all(&store).unwrap();

        let state = approval_state(&cwd, "native", Some(&store.to_string_lossy()));
        assert_eq!(state.rejected, names(&["serena"]));
        assert!(state.pending.is_empty());

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
