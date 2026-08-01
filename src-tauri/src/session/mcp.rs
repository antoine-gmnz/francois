//! MCP server discovery, attach/detach, and the mcp-panel commands.

use super::*;

use crate::ipc::{err, ok, IpcResult};
use serde_json::Value;
use tauri::{AppHandle, State};

// ---------- mcp-panel commands (spec §5) ----------
//
// v1 note: Claude Code connects MCP servers when it runs a turn in the project
// cwd (reported via system.init → mcp.update). `attach`/`detach` write the
// project-scope `.mcp.json`; `reconnect` re-flags `connecting`. The real
// connection state resolves on the session's next turn. The panel shows
// project-scope servers merged with the last runtime status.

pub(crate) fn mcp_json_path(cwd: &str) -> std::path::PathBuf {
    std::path::Path::new(cwd).join(".mcp.json")
}

pub(crate) fn read_mcp_json(cwd: &str) -> Value {
    std::fs::read(mcp_json_path(cwd))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Read `.mcp.json` for a WRITE path: absent → `{}`, valid object → it, present-but-
/// unparseable → Err so attach/detach never clobber a malformed file (parity with
/// skills_install's settings.json guard).
pub(crate) fn read_mcp_json_for_write(cwd: &str) -> Result<Value, String> {
    match std::fs::read(mcp_json_path(cwd)) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v.is_object() => Ok(v),
            _ => Err("refusing to overwrite .mcp.json — it is not valid JSON".into()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("could not read .mcp.json: {e}")),
    }
}

/// Read `~/.claude.json` (the CLI's user store; holds user-scope `mcpServers` and
/// per-project `projects[path].mcpServers` = local scope). `{}` if missing/unreadable.
pub(crate) fn read_claude_json() -> Value {
    dirs::home_dir()
        .map(|h| h.join(".claude.json"))
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Normalize a path for matching `~/.claude.json` `projects` keys (forward slashes,
/// no trailing separator). Case is preserved — CLI keys are stored verbatim.
pub(crate) fn norm_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

/// The `mcpServers` object from a `~/.claude.json` node, as name→config pairs.
pub(crate) fn mcp_servers_of(node: Option<&Value>) -> Vec<(String, Value)> {
    node.and_then(|n| n.get("mcpServers"))
        .and_then(|m| m.as_object())
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// Compare two paths after normalization — case-insensitively on Windows, where the
/// filesystem is case-insensitive so `~/.claude.json` keys may differ in case (e.g.
/// drive letter) from a session's cwd.
pub(crate) fn path_eq(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        norm_path(a).eq_ignore_ascii_case(&norm_path(b))
    }
    #[cfg(not(windows))]
    {
        norm_path(a) == norm_path(b)
    }
}

/// Look up the local-scope project node in `~/.claude.json` for a cwd, matching
/// on normalized path (CLI stores keys with forward slashes on Windows).
pub(crate) fn project_node<'a>(cj: &'a Value, cwd: &str) -> Option<&'a Value> {
    cj.get("projects")?
        .as_object()?
        .iter()
        .find_map(|(k, v)| path_eq(k, cwd).then_some(v))
}

pub(crate) fn write_mcp_json(cwd: &str, v: &Value) -> std::io::Result<()> {
    std::fs::write(
        mcp_json_path(cwd),
        serde_json::to_vec_pretty(v).unwrap_or_default(),
    )
}

pub(crate) fn transport_of(cfg: &Value) -> &'static str {
    let t = cfg.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if t == "http" || t == "sse" || cfg.get("url").is_some() {
        "http"
    } else {
        "stdio"
    }
}

pub(crate) fn command_of(cfg: &Value) -> String {
    let cmd = cfg.get("command").and_then(|c| c.as_str()).unwrap_or("");
    let args: Vec<String> = cfg
        .get("args")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if args.is_empty() {
        cmd.to_string()
    } else {
        format!("{} {}", cmd, args.join(" "))
    }
}

pub(crate) fn connecting_info(name: &str) -> McpServerInfo {
    McpServerInfo {
        name: name.to_string(),
        status: "connecting".into(),
        tool_count: None,
        error_message: None,
        scope: None,
    }
}

/// v1 curated registry (static; no network). Mirrors McpRegistryEntry.
pub(crate) fn registry() -> Vec<Value> {
    use serde_json::json;
    vec![
        json!({ "name": "filesystem", "description": "Local filesystem access", "transport": "stdio",
                "commandTemplate": "npx -y @modelcontextprotocol/server-filesystem {path}",
                "params": [{ "key": "path", "label": "Root directory", "required": true }] }),
        json!({ "name": "github", "description": "GitHub repos, issues, PRs", "transport": "stdio",
                "commandTemplate": "npx -y @modelcontextprotocol/server-github",
                "params": [{ "key": "GITHUB_PERSONAL_ACCESS_TOKEN", "label": "GitHub token", "required": true, "secret": true }] }),
        json!({ "name": "postgres", "description": "Query a Postgres database", "transport": "stdio",
                "commandTemplate": "npx -y @modelcontextprotocol/server-postgres {connectionString}",
                "params": [{ "key": "connectionString", "label": "Connection string", "required": true }] }),
        json!({ "name": "fetch", "description": "Fetch and read web pages", "transport": "stdio",
                "commandTemplate": "uvx mcp-server-fetch", "params": [] }),
        json!({ "name": "sqlite", "description": "Query a SQLite database file", "transport": "stdio",
                "commandTemplate": "uvx mcp-server-sqlite --db-path {dbPath}",
                "params": [{ "key": "dbPath", "label": "Database file path", "required": true }] }),
    ]
}

#[tauri::command(async)]
pub fn mcp_registry() -> IpcResult<Vec<Value>> {
    ok(registry())
}

/// All MCP servers visible to a cwd, in the same precedence the CLI uses:
/// local (project node in ~/.claude.json) > project (.mcp.json) > user
/// (~/.claude.json top-level). Returns (name, scope) with each name appearing once.
pub(crate) fn merged_mcp_scopes(cwd: &str) -> Vec<(String, String)> {
    let cj = read_claude_json();
    let sources: [(&str, Vec<(String, Value)>); 3] = [
        ("local", mcp_servers_of(project_node(&cj, cwd))),
        ("project", mcp_servers_of(Some(&read_mcp_json(cwd)))),
        ("user", mcp_servers_of(Some(&cj))),
    ];
    let mut out: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (scope, servers) in sources {
        for (name, _) in servers {
            if seen.insert(name.clone()) {
                out.push((name, scope.to_string()));
            }
        }
    }
    out
}

/// Find a server's raw config + scope across all scopes (local > project > user).
pub(crate) fn find_mcp_config(cwd: &str, name: &str) -> Option<(Value, String)> {
    let cj = read_claude_json();
    if let Some(v) = project_node(&cj, cwd)
        .and_then(|n| n.get("mcpServers"))
        .and_then(|m| m.get(name))
    {
        return Some((v.clone(), "local".into()));
    }
    if let Some(v) = read_mcp_json(cwd)
        .get("mcpServers")
        .and_then(|m| m.get(name))
    {
        return Some((v.clone(), "project".into()));
    }
    if let Some(v) = cj.get("mcpServers").and_then(|m| m.get(name)) {
        return Some((v.clone(), "user".into()));
    }
    None
}

/// Override a server's reported status with its APPROVAL status when there is no
/// live connection to report.
///
/// Without this, an unapproved `.mcp.json` server sits at `connecting` forever:
/// `claude -p` skips the consent dialog, so the server never starts and never
/// reports anything, and the panel shows a handshake that will never complete.
/// A live status always wins — once the server has actually connected, what the
/// stream said is the truth.
///
/// Only `project` scope is eligible: the consent dialog exists because `.mcp.json`
/// is checked into the repo, and a name the user ALSO declared locally or globally
/// resolves to that config first (see `find_mcp_config`'s precedence) — the CLI
/// never asks about it, so neither do we.
pub(crate) fn approval_status(
    name: &str,
    scope: &str,
    approvals: &McpApprovalState,
) -> Option<&'static str> {
    if scope != "project" {
        return None;
    }
    if approvals.pending.iter().any(|n| n == name) {
        Some("pending")
    } else if approvals.rejected.iter().any(|n| n == name) {
        Some("rejected")
    } else if approvals.approved.iter().any(|n| n == name) {
        // Approved but nothing has started it: the CLI only spawns `.mcp.json`
        // servers when the next turn spawns, so `connecting` here would be a
        // handshake nobody is performing — the exact stuck row this feature was
        // meant to remove, just one click later.
        Some("approved")
    } else {
        None
    }
}

#[tauri::command(async)]
pub fn mcp_list(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Vec<Value>> {
    let Some((cwd, claude_runtime, account_id, runtime)) = engine.with_session(&session_id, |s| {
        (
            s.cwd.clone(),
            s.runtime.clone(),
            s.account_id.clone(),
            s.mcp.clone(),
        )
    }) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    let config_dir = crate::account::config_dir_of(&app, &account_id);
    let approvals = approval_state(&cwd, &claude_runtime, config_dir.as_deref());

    let mut out: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (name, scope) in merged_mcp_scopes(&cwd) {
        seen.insert(name.clone());
        let live = runtime.get(&name).cloned();
        let mut info = live.clone().unwrap_or_else(|| connecting_info(&name));
        if live.is_none() {
            if let Some(status) = approval_status(&name, &scope, &approvals) {
                info.status = status.into();
            }
        }
        info.scope = Some(scope);
        out.push(serde_json::to_value(info).unwrap());
    }
    // runtime-reported servers not present in any config (rare — e.g. resolved from an init frame).
    for (name, info) in &runtime {
        if !seen.contains(name) {
            out.push(serde_json::to_value(info.clone()).unwrap());
        }
    }
    ok(out)
}

#[tauri::command(async)]
pub fn mcp_detail(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    name: String,
) -> IpcResult<Value> {
    let Some((cwd, claude_runtime, account_id, runtime)) = engine.with_session(&session_id, |s| {
        (
            s.cwd.clone(),
            s.runtime.clone(),
            s.account_id.clone(),
            s.mcp.get(&name).cloned(),
        )
    }) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    let Some((entry, scope)) = find_mcp_config(&cwd, &name) else {
        return err(
            "MCP_ERROR",
            format!("'{name}' is not configured for this session"),
        );
    };
    let transport = transport_of(&entry);
    let live = runtime.is_some();
    let mut info = runtime.unwrap_or_else(|| connecting_info(&name));
    if !live {
        let config_dir = crate::account::config_dir_of(&app, &account_id);
        let approvals = approval_state(&cwd, &claude_runtime, config_dir.as_deref());
        if let Some(status) = approval_status(&name, &scope, &approvals) {
            info.status = status.into();
        }
    }
    info.scope = Some(scope);
    let mut o = serde_json::to_value(&info).unwrap();
    o["transport"] = Value::String(transport.into());
    if transport == "stdio" {
        o["command"] = Value::String(command_of(&entry));
    } else {
        o["url"] = Value::String(
            entry
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .into(),
        );
    }
    ok(o)
}

#[tauri::command(async)]
pub fn mcp_reconnect(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    name: String,
) -> IpcResult<Option<()>> {
    let Some(info) = engine.with_session_mut(&session_id, |s| {
        let info = connecting_info(&name);
        s.mcp.insert(name.clone(), info.clone());
        info
    }) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    emit(
        &app,
        SessionEvent::McpUpdate {
            session_id,
            server: info,
        },
    );
    ok(None)
}

#[tauri::command(async)]
pub fn mcp_detach(
    engine: State<'_, Engine>,
    session_id: String,
    name: String,
) -> IpcResult<Option<()>> {
    let Some(cwd) = engine.with_session(&session_id, |s| s.cwd.clone()) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    // Only project-scope servers live in this project's .mcp.json. Refuse to silently
    // edit the user's global ~/.claude.json for local/user-scope servers.
    if let Some((_, scope)) = find_mcp_config(&cwd, &name) {
        if scope != "project" {
            return err("MCP_ERROR", format!("'{name}' is {scope}-scoped (managed globally) — remove it with `claude mcp remove {name}`"));
        }
    }
    engine.with_session_mut(&session_id, |s| {
        s.mcp.remove(&name);
    });
    let mut cfg = match read_mcp_json_for_write(&cwd) {
        Ok(v) => v,
        Err(e) => return err("MCP_ERROR", e),
    };
    if let Some(servers) = cfg.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
        servers.remove(&name);
    }
    if let Err(e) = write_mcp_json(&cwd, &cfg) {
        return err("MCP_ERROR", format!("could not write .mcp.json: {e}"));
    }
    ok(None)
}

#[tauri::command(async)]
pub fn mcp_attach(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    entry: Value,
) -> IpcResult<Option<()>> {
    let name = entry
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return err("INVALID_INPUT", "server name is required");
    }
    let transport = entry
        .get("transport")
        .and_then(|t| t.as_str())
        .unwrap_or("stdio");
    let Some(cwd) = engine.with_session(&session_id, |s| s.cwd.clone()) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };

    let mut cfg = match read_mcp_json_for_write(&cwd) {
        Ok(v) => v,
        Err(e) => return err("MCP_ERROR", e),
    };
    let servers = cfg
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut();
    let Some(servers) = servers else {
        return err(
            "MCP_ERROR",
            "malformed .mcp.json (mcpServers is not an object)",
        );
    };
    if servers.contains_key(&name) {
        return err(
            "INVALID_INPUT",
            format!("'{name}' already exists in this project's .mcp.json"),
        );
    }

    let secret = entry.get("secretParams").and_then(|s| s.as_object());
    let server = if transport == "http" {
        let url = entry
            .get("url")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .trim();
        if url.is_empty() {
            return err("INVALID_INPUT", "url is required for an http server");
        }
        let mut o = serde_json::json!({ "type": "http", "url": url });
        if let Some(sec) = secret {
            if !sec.is_empty() {
                o["headers"] = Value::Object(sec.clone());
            }
        }
        o
    } else {
        let cmdline = entry
            .get("command")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim();
        if cmdline.is_empty() {
            return err("INVALID_INPUT", "command is required for a stdio server");
        }
        let mut parts = cmdline.split_whitespace();
        let cmd = parts.next().unwrap_or("");
        let args: Vec<&str> = parts.collect();
        let mut o = serde_json::json!({ "command": cmd, "args": args });
        if let Some(sec) = secret {
            if !sec.is_empty() {
                o["env"] = Value::Object(sec.clone());
            }
        }
        o
    };

    servers.insert(name.clone(), server);
    if let Err(e) = write_mcp_json(&cwd, &cfg) {
        return err("MCP_ERROR", format!("could not write .mcp.json: {e}"));
    }

    let info = connecting_info(&name);
    engine.with_session_mut(&session_id, |s| {
        s.mcp.insert(name.clone(), info.clone());
    });
    emit(
        &app,
        SessionEvent::McpUpdate {
            session_id,
            server: info,
        },
    );
    ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn norm_path_forward_slashes_no_trailing() {
        assert_eq!(norm_path("D:\\francois\\"), "D:/francois");
        assert_eq!(norm_path("D:/francois"), "D:/francois");
        assert_eq!(norm_path("/home/u/proj/"), "/home/u/proj");
    }

    #[test]
    fn approval_status_maps_every_bucket_the_stream_has_not_spoken_for() {
        let approvals = McpApprovalState {
            pending: vec!["waiting".into()],
            approved: vec!["ok".into()],
            rejected: vec!["nope".into()],
            trust_required: false,
            enable_all_project_mcp_servers: false,
        };
        assert_eq!(
            approval_status("waiting", "project", &approvals),
            Some("pending")
        );
        assert_eq!(
            approval_status("nope", "project", &approvals),
            Some("rejected")
        );
        // An approved server the stream has not spoken for has NOT started: the CLI
        // spawns `.mcp.json` servers with the next turn. Reporting `connecting` (the
        // fallback when this returns None) promised a handshake nobody was
        // performing, and the row sat on it forever.
        assert_eq!(
            approval_status("ok", "project", &approvals),
            Some("approved")
        );
        assert_eq!(approval_status("unknown", "project", &approvals), None);
    }

    #[test]
    fn approval_status_ignores_a_name_that_resolves_to_a_non_project_scope() {
        // A `.mcp.json` name the user ALSO declared locally resolves to the local
        // config first, so the CLI never asks about it — flagging it `pending`
        // would offer a decision that changes nothing.
        let approvals = McpApprovalState {
            pending: vec!["serena".into()],
            ..Default::default()
        };
        assert_eq!(approval_status("serena", "local", &approvals), None);
        assert_eq!(approval_status("serena", "user", &approvals), None);
        assert_eq!(
            approval_status("serena", "project", &approvals),
            Some("pending")
        );
    }

    #[test]
    fn project_node_matches_normalized_path() {
        let cj = json!({ "projects": { "D:/francois": { "mcpServers": { "x": {} } } } });
        // backslash cwd must still resolve to the forward-slash key
        let node = project_node(&cj, "D:\\francois");
        assert!(node.is_some());
        assert_eq!(mcp_servers_of(node).len(), 1);
    }
}
