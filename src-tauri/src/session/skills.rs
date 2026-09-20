//! skill/plugin discovery and the skills-panel commands.

use super::*;
use crate::ipc::ErrorCode;

use crate::ipc::{err, ok, IpcResult};
use crate::session::admission;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

// ---------- skills-panel commands (spec §5) ----------
//
// Discovery mirrors what Claude Code actually loads for a cwd:
//   installed (✦) = SKILL.md skills + slash-command *.md files, from project
//     (<cwd>/.claude/…), user (~/.claude/…), and every *enabled* plugin.
//   available (◇) = SKILL.md skills from marketplace plugins that are NOT enabled.
// "Install" enables the owning plugin in ~/.claude/settings.json (global, reversible),
// which is how Claude Code turns a plugin skill on. Effects apply on the next turn.
// No fs watcher: the panel refetches on install + session switch (FR-7 own flows).

#[derive(Serialize)]
pub struct SkillInfo {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) scope: Option<String>, // project | user | plugin | path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<String>, // skill | command
    #[serde(rename = "pluginId", skip_serializing_if = "Option::is_none")]
    pub(crate) plugin_id: Option<String>, // '<plugin>@<marketplace>' — enabling target for available entries
    // ---- pi-skills-capabilities §5 (RuntimeSkillFields). Absent for every
    // non-Pi entry (the Claude-shaped fields above already say everything a
    // Claude session needs); REQUIRED on every Pi entry — see `pi_skill_info`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) invocation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<String>, // skill | prompt
    #[serde(rename = "sourcePath", skip_serializing_if = "Option::is_none")]
    pub(crate) source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) loaded: Option<bool>,
    #[serde(rename = "unavailableReason", skip_serializing_if = "Option::is_none")]
    pub(crate) unavailable_reason: Option<String>,
}

pub fn commands_dir(base: &std::path::Path) -> std::path::PathBuf {
    base.join(".claude").join("commands")
}

/// Root that holds installed marketplaces: ~/.claude/plugins/marketplaces.
pub fn marketplaces_root() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("plugins").join("marketplaces"))
}

/// Enabled plugin ids ("<plugin>@<marketplace>") from ~/.claude/settings.json.
pub fn enabled_plugin_ids() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let Some(home) = dirs::home_dir() else {
        return set;
    };
    let cfg = std::fs::read(home.join(".claude").join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if let Some(obj) = cfg
        .as_ref()
        .and_then(|c| c.get("enabledPlugins"))
        .and_then(|e| e.as_object())
    {
        for (k, v) in obj {
            if v.as_bool().unwrap_or(false) {
                set.insert(k.clone());
            }
        }
    }
    set
}

/// Every plugin present on disk as ("<plugin>@<marketplace>", plugin_dir), scanning
/// both plugins/ and external_plugins/ under each installed marketplace.
pub fn all_plugins() -> Vec<(String, std::path::PathBuf)> {
    let mut out = Vec::new();
    let Some(root) = marketplaces_root() else {
        return out;
    };
    let Ok(mkts) = std::fs::read_dir(&root) else {
        return out;
    };
    for mkt in mkts.flatten() {
        if !mkt.path().is_dir() {
            continue;
        }
        let Some(mkt_name) = mkt.file_name().to_str().map(String::from) else {
            continue;
        };
        for sub in ["plugins", "external_plugins"] {
            let Ok(plugins) = std::fs::read_dir(mkt.path().join(sub)) else {
                continue;
            };
            for p in plugins.flatten() {
                if !p.path().is_dir() {
                    continue;
                }
                if let Some(pname) = p.file_name().to_str() {
                    out.push((format!("{pname}@{mkt_name}"), p.path()));
                }
            }
        }
    }
    // Deterministic order so an available skill exposed by two plugins always resolves
    // to the same enable target (read_dir order is OS-dependent).
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Scan a dir of `*.md` slash-command files → (name = file stem, description).
pub fn scan_commands(dir: &std::path::Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_file() || path.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            out.push((stem.to_string(), parse_skill_description(&path)));
        }
    }
    out
}

pub fn skill_entry(
    name: String,
    description: String,
    installed: bool,
    scope: &str,
    kind: &str,
    plugin_id: Option<String>,
) -> SkillInfo {
    SkillInfo {
        name,
        description,
        installed,
        scope: Some(scope.into()),
        kind: Some(kind.into()),
        plugin_id,
        invocation: None,
        source: None,
        source_path: None,
        loaded: None,
        unavailable_reason: None,
    }
}

// ---------- pi-skills-capabilities: Pi routing ----------
//
// FR-1/FR-8: `skills_list`/`skills_run` for a Pi session never scan
// `.claude/` and never count marketplace entries — the runtime's OWN
// `get_commands` (via `RuntimeSessionControl::list_commands`) is
// authoritative. `pi_skill_info` is the ONE place a `RuntimeCommandInfo`
// becomes a `SkillInfo`; `scope` is always `'path'` (FR-1: "loaded from an
// explicit path" — Pi carries no project/user/plugin distinction of its own).

fn pi_skill_info(c: adapter::RuntimeCommandInfo) -> SkillInfo {
    SkillInfo {
        name: adapter::pi::skill_name_from_invocation(&c.invocation),
        description: c.description,
        installed: c.loaded,
        scope: Some("path".into()),
        kind: Some(
            match c.source {
                adapter::RuntimeCommandSource::Skill => "skill",
                adapter::RuntimeCommandSource::Prompt => "command",
            }
            .into(),
        ),
        plugin_id: None,
        invocation: Some(c.invocation),
        source: Some(
            match c.source {
                adapter::RuntimeCommandSource::Skill => "skill",
                adapter::RuntimeCommandSource::Prompt => "prompt",
            }
            .into(),
        ),
        source_path: c.source_path,
        loaded: Some(c.loaded),
        unavailable_reason: c.unavailable_reason,
    }
}

/// FR-1: the runtime's ACTUAL loaded commands after the session's resource
/// policy — no `.claude/` scan, no marketplace entries.
fn pi_discover_skills(engine: &Engine, session_id: &str) -> Result<Vec<SkillInfo>, AppError> {
    let connection = engine.runtime_connection_for(session_id).ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeExited,
            "this session has no live Pi connection",
        )
    })?;
    Ok(connection
        .list_commands()?
        .into_iter()
        .map(pi_skill_info)
        .collect())
}

/// The pure half of FR-2's lookup: does `invocation` (a LISTED entry's exact
/// invocation) resolve to a currently LOADED command? Split out of
/// `pi_skills_run` so this decision is unit-testable with no `AppHandle` and
/// no live connection — `pi_skills_run` only adds the I/O (emit + admission)
/// each outcome implies.
#[derive(Debug, PartialEq, Eq)]
enum PiSkillLookup {
    /// Found and loaded — the exact invocation to submit.
    Loaded(String),
    /// Listed, but not currently runnable under the resource policy.
    Blocked(Option<String>),
    /// Not listed at all — vanished on reconnect (or never existed).
    Vanished,
}

/// contract/skills-panel.ts: matched EXACTLY against the listed entries'
/// `invocation`, never against the derived `SkillInfo.name`. The derived name
/// is not an identity — `/skill:deploy` and `/deploy` both list as `deploy`,
/// so keying the run on it lets a repo's skill shadow the user's command.
fn lookup_pi_skill(commands: &[adapter::RuntimeCommandInfo], invocation: &str) -> PiSkillLookup {
    match commands.iter().find(|c| c.invocation == invocation) {
        Some(c) if c.loaded => PiSkillLookup::Loaded(c.invocation.clone()),
        Some(c) => PiSkillLookup::Blocked(c.unavailable_reason.clone()),
        None => PiSkillLookup::Vanished,
    }
}

/// The three fields a Pi run REQUIRES (contract §5: `invocation`,
/// `clientMessageId`, `delivery`) — pure, so the refusal is testable without
/// an `AppHandle`. Every other runtime ignores all three.
fn pi_run_fields(
    invocation: Option<String>,
    client_message_id: Option<String>,
    delivery: Option<admission::DeliveryMode>,
) -> Result<(String, String, admission::DeliveryMode), AppError> {
    let (Some(invocation), Some(client_message_id), Some(delivery)) =
        (invocation, client_message_id, delivery)
    else {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "invocation, clientMessageId and delivery are required to run a skill on a Pi session",
        ));
    };
    Ok((invocation, client_message_id, delivery))
}

/// FR-2: resolve a listed skill's exact `invocation` and submit it through
/// the SAME internal admissions function as `session_submit` — never a raw
/// RPC call, never a second queue. An invocation that is no longer LOADED
/// (vanished on reconnect, or blocked by the resource policy) is
/// `RUNTIME_UNSUPPORTED`; only the "vanished entirely" case emits
/// `skills.changed` to refresh the listing (a still-listed-but-unloaded entry
/// did not change).
fn pi_skills_run(
    app: &AppHandle,
    engine: &Engine,
    session_id: &str,
    args: Option<&str>,
    requested_invocation: Option<String>,
    client_message_id: Option<String>,
    delivery: Option<admission::DeliveryMode>,
) -> Result<(), AppError> {
    if let Err((code, msg)) = engine.require_capability(session_id, "skills") {
        return Err(AppError::new(code, msg));
    }
    let (requested_invocation, client_message_id, delivery) =
        pi_run_fields(requested_invocation, client_message_id, delivery)?;
    let connection = engine.runtime_connection_for(session_id).ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeExited,
            "this session has no live Pi connection",
        )
    })?;
    let commands = connection.list_commands()?;
    let invocation = match lookup_pi_skill(&commands, &requested_invocation) {
        PiSkillLookup::Loaded(invocation) => invocation,
        PiSkillLookup::Blocked(reason) => {
            let reason = reason.map(|r| format!(": {r}")).unwrap_or_default();
            return Err(AppError::new(
                ErrorCode::RuntimeUnsupported,
                format!(
                    "'{requested_invocation}' is not available under the current resource policy{reason}"
                ),
            ));
        }
        PiSkillLookup::Vanished => {
            // FR-2: vanished on reconnect — refresh the listing.
            let _ = app.emit(
                "francois://skills/event",
                serde_json::json!({ "type": "skills.changed", "sessionId": session_id }),
            );
            return Err(AppError::new(
                ErrorCode::RuntimeUnsupported,
                format!("'{requested_invocation}' is no longer listed for this session"),
            ));
        }
    };
    let text = match args {
        Some(a) if !a.trim().is_empty() => format!("{} {}", invocation, a.trim()),
        _ => invocation,
    };
    admission::admit_and_deliver(
        app,
        engine,
        app,
        session_id,
        &client_message_id,
        &text,
        delivery,
        Vec::new(),
    )
    .map(|_| ())
}

/// Full skills+commands list for a cwd (FR-3/4): installed (project ∪ user ∪ enabled
/// plugins, alpha) then available (non-enabled plugin skills, alpha). Project wins over
/// user wins over plugin on a name collision; skill wins over command within a scope.
pub fn discover_skills(cwd: &str) -> Vec<SkillInfo> {
    let mut installed: std::collections::BTreeMap<String, SkillInfo> =
        std::collections::BTreeMap::new();
    let enabled = enabled_plugin_ids();

    // insert lowest → highest precedence; each later insert overwrites the earlier.
    for (pid, dir) in all_plugins() {
        if !enabled.contains(&pid) {
            continue;
        }
        for (n, d) in scan_commands(&dir.join("commands")) {
            installed.insert(
                n.clone(),
                skill_entry(n, d, true, "plugin", "command", Some(pid.clone())),
            );
        }
        for (n, d) in scan_skills(&dir.join("skills")) {
            installed.insert(
                n.clone(),
                skill_entry(n, d, true, "plugin", "skill", Some(pid.clone())),
            );
        }
    }
    if let Some(home) = dirs::home_dir() {
        for (n, d) in scan_commands(&commands_dir(&home)) {
            installed.insert(n.clone(), skill_entry(n, d, true, "user", "command", None));
        }
        for (n, d) in scan_skills(&skills_dir(&home)) {
            installed.insert(n.clone(), skill_entry(n, d, true, "user", "skill", None));
        }
    }
    let proj = std::path::Path::new(cwd);
    for (n, d) in scan_commands(&commands_dir(proj)) {
        installed.insert(
            n.clone(),
            skill_entry(n, d, true, "project", "command", None),
        );
    }
    for (n, d) in scan_skills(&skills_dir(proj)) {
        installed.insert(n.clone(), skill_entry(n, d, true, "project", "skill", None));
    }

    // available = SKILL.md skills from plugins that are NOT enabled, excluding installed names.
    let mut available: std::collections::BTreeMap<String, SkillInfo> =
        std::collections::BTreeMap::new();
    for (pid, dir) in all_plugins() {
        if enabled.contains(&pid) {
            continue;
        }
        for (n, d) in scan_skills(&dir.join("skills")) {
            if installed.contains_key(&n) || available.contains_key(&n) {
                continue;
            }
            available.insert(
                n.clone(),
                skill_entry(n, d, false, "plugin", "skill", Some(pid.clone())),
            );
        }
    }

    let mut out: Vec<SkillInfo> = installed.into_values().collect();
    out.extend(available.into_values());
    out
}

pub fn skills_dir(base: &std::path::Path) -> std::path::PathBuf {
    base.join(".claude").join("skills")
}

pub fn parse_skill_description(skill_md: &std::path::Path) -> String {
    std::fs::read_to_string(skill_md)
        .map(|c| parse_skill_description_str(&c))
        .unwrap_or_default()
}

/// Parse the `description:` from a SKILL.md frontmatter, first sentence, ≤100 chars (FR-4).
pub fn parse_skill_description_str(content: &str) -> String {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return String::new();
    }
    // frontmatter is between the first two `---` fences
    let after = &trimmed[3..];
    let Some(end) = after.find("\n---") else {
        return String::new();
    };
    let fm = &after[..end];
    let mut raw = String::new();
    for line in fm.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("description:") {
            raw = rest.trim().trim_matches(['"', '\'']).to_string();
            break;
        }
    }
    if raw.is_empty() {
        return String::new();
    }
    // first sentence: up to a . ! ? followed by whitespace or end
    let bytes = raw.as_bytes();
    let mut cut = raw.len();
    for (i, &b) in bytes.iter().enumerate() {
        if (b == b'.' || b == b'!' || b == b'?')
            && (i + 1 >= bytes.len() || bytes[i + 1].is_ascii_whitespace())
        {
            cut = i;
            break;
        }
    }
    let first = raw[..cut].trim().to_string();
    if first.chars().count() > 100 {
        format!("{}…", first.chars().take(100).collect::<String>())
    } else {
        first
    }
}

/// Scan a skills dir for immediate subdirs containing SKILL.md → (name, description).
pub fn scan_skills(dir: &std::path::Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        out.push((name.to_string(), parse_skill_description(&skill_md)));
    }
    out
}

#[tauri::command(async)]
pub fn skills_list(engine: State<'_, Engine>, session_id: String) -> IpcResult<Vec<SkillInfo>> {
    let Some((cwd, agent_runtime)) =
        engine.with_session(&session_id, |s| (s.cwd.clone(), s.agent_runtime))
    else {
        return err(ErrorCode::SessionNotFound, "no such session");
    };
    // pi-skills-capabilities FR-1/FR-8: a Pi session's list is the runtime's
    // OWN loaded commands — never the Claude-shaped `.claude/` scan below.
    if agent_runtime == AgentRuntime::Pi {
        return match pi_discover_skills(&engine, &session_id) {
            Ok(list) => ok(list),
            Err(error) => IpcResult::Err { ok: false, error },
        };
    }
    ok(discover_skills(&cwd))
}

/// Enable a plugin (by an available skill's owning plugin) in ~/.claude/settings.json.
/// This is the real "install" for a plugin skill; it applies to every Claude Code
/// session on the next turn. Idempotent.
#[tauri::command(async)]
pub fn skills_install(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    name: String,
) -> IpcResult<Option<()>> {
    if let Err((code, msg)) = engine.require_capability(&session_id, "skillsInstall") {
        return err(code, msg);
    }
    let Some(cwd) = engine.with_session(&session_id, |s| s.cwd.clone()) else {
        return err(ErrorCode::SessionNotFound, "no such session");
    };
    let Some(target) = discover_skills(&cwd)
        .into_iter()
        .find(|s| s.name == name && !s.installed)
    else {
        return err(
            ErrorCode::SkillError,
            format!("'{name}' is not an available plugin skill"),
        );
    };
    let Some(pid) = target.plugin_id else {
        return err(
            ErrorCode::SkillError,
            format!("'{name}' has no plugin to enable"),
        );
    };
    let Some(home) = dirs::home_dir() else {
        return err(ErrorCode::SkillError, "could not resolve home directory");
    };
    let path = home.join(".claude").join("settings.json");
    // Parse the existing settings. Absent → start fresh; present-but-unparseable →
    // ABORT (never clobber the user's whole global config on a parse failure).
    let mut cfg = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v.is_object() => v,
            _ => {
                return err(
                    ErrorCode::SkillError,
                    "~/.claude/settings.json is not valid JSON — refusing to modify it",
                )
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => {
            return err(
                ErrorCode::SkillError,
                format!("could not read settings.json: {e}"),
            )
        }
    };
    let ep = cfg
        .as_object_mut()
        .unwrap()
        .entry("enabledPlugins")
        .or_insert_with(|| serde_json::json!({}));
    let Some(ep) = ep.as_object_mut() else {
        return err(
            ErrorCode::SkillError,
            "malformed settings.json (enabledPlugins is not an object)",
        );
    };
    if ep.get(&pid).and_then(|v| v.as_bool()) == Some(true) {
        return ok(None); // already enabled — idempotent
    }
    ep.insert(pid, Value::Bool(true));
    // Atomic write (temp + rename) so a crash mid-write can't truncate settings.json.
    let bytes = serde_json::to_vec_pretty(&cfg).unwrap_or_default();
    let tmp = path.with_extension("json.francois-tmp");
    if let Err(e) = std::fs::write(&tmp, &bytes) {
        return err(
            ErrorCode::SkillError,
            format!("could not write settings.json: {e}"),
        );
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return err(
            ErrorCode::SkillError,
            format!("could not replace settings.json: {e}"),
        );
    }
    let _ = app.emit(
        "francois://skills/event",
        serde_json::json!({ "type": "skills.changed", "sessionId": session_id }),
    );
    ok(None)
}

#[tauri::command(async)]
pub fn skills_run(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    name: String,
    // pi-skills-capabilities / pr-142 §6: the LISTED entry's exact
    // `SkillInfo.invocation`. REQUIRED for a Pi session — it is what the run
    // is keyed on there, because `name` is derived from it and is not an
    // identity. Optional on the wire so every other runtime (which ignores it
    // and keys on `name` exactly as before) can keep omitting it.
    invocation: Option<String>,
    args: Option<String>,
    // pi-skills-capabilities: REQUIRED for a Pi session (validated exactly
    // as `RuntimeMessageInput`'s fields); ignored by every other runtime.
    client_message_id: Option<String>,
    delivery: Option<admission::DeliveryMode>,
) -> IpcResult<Option<()>> {
    let Some(agent_runtime) = engine.with_session(&session_id, |s| s.agent_runtime) else {
        return err(ErrorCode::SessionNotFound, "no such session");
    };
    if agent_runtime == AgentRuntime::Pi {
        return match pi_skills_run(
            &app,
            &engine,
            &session_id,
            args.as_deref(),
            invocation,
            client_message_id,
            delivery,
        ) {
            Ok(()) => ok(None),
            Err(error) => IpcResult::Err { ok: false, error },
        };
    }
    if let Err((code, msg)) = engine.require_capability(&session_id, "skills") {
        return err(code, msg);
    }
    let Some(cwd) = engine.with_session(&session_id, |s| s.cwd.clone()) else {
        return err(ErrorCode::SessionNotFound, "no such session");
    };
    if !discover_skills(&cwd)
        .iter()
        .any(|s| s.installed && s.name == name)
    {
        return err(
            ErrorCode::InvalidInput,
            format!("'{name}' is not installed"),
        );
    }
    let text = match args {
        Some(a) if !a.trim().is_empty() => format!("/{} {}", name, a.trim()),
        _ => format!("/{name}"),
    };
    // interactive-commands §2 non-goal: skills pass through byte-for-byte — a
    // skill named usage/cost/model/status/help must still run as a real turn.
    match do_send(&app, &session_id, text, uuid(), SendSource::Skill) {
        IpcResult::Ok { .. } => ok(None),
        IpcResult::Err { error, .. } => IpcResult::Err { ok: false, error },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_description_first_sentence() {
        let md = "---\nname: x\ndescription: Read and parse PDFs. Then do more things.\n---\n\n# x\nbody";
        assert_eq!(parse_skill_description_str(md), "Read and parse PDFs");
    }

    #[test]
    fn skill_description_quoted_and_capped() {
        let long = "a".repeat(150);
        let md = format!("---\ndescription: \"{long}\"\n---\n");
        let out = parse_skill_description_str(&md);
        assert_eq!(out.chars().count(), 101); // 100 chars + ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn skill_description_missing_is_empty() {
        assert_eq!(parse_skill_description_str("# no frontmatter\nhi"), "");
        assert_eq!(parse_skill_description_str("---\nname: x\n---\n"), "");
    }

    // ---------- pi-skills-capabilities ----------

    fn pi_command(
        invocation: &str,
        source: adapter::RuntimeCommandSource,
        loaded: bool,
        unavailable_reason: Option<&str>,
    ) -> adapter::RuntimeCommandInfo {
        adapter::RuntimeCommandInfo {
            invocation: invocation.into(),
            description: "does a thing".into(),
            source,
            source_path: Some("/repo/.pi/skills/review".into()),
            loaded,
            unavailable_reason: unavailable_reason.map(String::from),
        }
    }

    #[test]
    fn pi_skill_info_maps_a_loaded_skill_and_derives_its_bare_name() {
        let c = pi_command(
            "/skill:review",
            adapter::RuntimeCommandSource::Skill,
            true,
            None,
        );
        let info = pi_skill_info(c);
        assert_eq!(info.name, "review");
        assert_eq!(info.invocation.as_deref(), Some("/skill:review"));
        assert_eq!(info.source.as_deref(), Some("skill"));
        assert_eq!(info.kind.as_deref(), Some("skill"));
        assert_eq!(info.scope.as_deref(), Some("path"));
        assert!(info.installed);
        assert_eq!(info.loaded, Some(true));
        assert_eq!(info.plugin_id, None);
    }

    #[test]
    fn pi_skill_info_maps_an_unloaded_prompt_with_its_reason() {
        let c = pi_command(
            "/summarize",
            adapter::RuntimeCommandSource::Prompt,
            false,
            Some("project resources are disabled for this session"),
        );
        let info = pi_skill_info(c);
        assert_eq!(info.name, "summarize");
        assert_eq!(info.source.as_deref(), Some("prompt"));
        assert_eq!(info.kind.as_deref(), Some("command"));
        assert!(!info.installed);
        assert_eq!(info.loaded, Some(false));
        assert_eq!(
            info.unavailable_reason.as_deref(),
            Some("project resources are disabled for this session")
        );
    }

    #[test]
    fn lookup_pi_skill_finds_a_loaded_command_by_its_invocation() {
        let commands = vec![pi_command(
            "/skill:review",
            adapter::RuntimeCommandSource::Skill,
            true,
            None,
        )];
        assert_eq!(
            lookup_pi_skill(&commands, "/skill:review"),
            PiSkillLookup::Loaded("/skill:review".into())
        );
    }

    #[test]
    fn lookup_pi_skill_reports_a_listed_but_unloaded_command_as_blocked() {
        let commands = vec![pi_command(
            "/skill:review",
            adapter::RuntimeCommandSource::Skill,
            false,
            Some("project resources are disabled"),
        )];
        assert_eq!(
            lookup_pi_skill(&commands, "/skill:review"),
            PiSkillLookup::Blocked(Some("project resources are disabled".into()))
        );
    }

    /// pr-142 §6: the derived bare name is NOT an identity — `/skill:deploy`
    /// and `/deploy` both list as `deploy`, so a run keyed on the name lets a
    /// repo's skill shadow the user's command. The lookup keys on the exact
    /// `invocation` the listing returned.
    #[test]
    fn lookup_pi_skill_keys_on_the_exact_invocation_never_the_derived_name() {
        let commands = vec![
            pi_command(
                "/skill:deploy",
                adapter::RuntimeCommandSource::Skill,
                true,
                None,
            ),
            pi_command("/deploy", adapter::RuntimeCommandSource::Prompt, true, None),
        ];
        assert_eq!(
            lookup_pi_skill(&commands, "/deploy"),
            PiSkillLookup::Loaded("/deploy".into())
        );
        assert_eq!(
            lookup_pi_skill(&commands, "/skill:deploy"),
            PiSkillLookup::Loaded("/skill:deploy".into())
        );
        assert_eq!(
            lookup_pi_skill(&commands, "deploy"),
            PiSkillLookup::Vanished,
            "the derived name is not an identity — it must not resolve either entry"
        );
    }

    #[test]
    fn lookup_pi_skill_is_vanished_for_an_unknown_invocation() {
        let commands = vec![pi_command(
            "/skill:review",
            adapter::RuntimeCommandSource::Skill,
            true,
            None,
        )];
        assert_eq!(lookup_pi_skill(&commands, "/gone"), PiSkillLookup::Vanished);
    }

    #[test]
    fn a_pi_run_without_an_invocation_is_invalid_input() {
        let err = pi_run_fields(
            None,
            Some("cm-1".into()),
            Some(admission::DeliveryMode::Normal),
        )
        .expect_err("invocation is required on Pi");
        assert_eq!(err.code, ErrorCode::InvalidInput);
        // …and the two fields that were already required still are.
        assert!(pi_run_fields(
            Some("/deploy".into()),
            None,
            Some(admission::DeliveryMode::Normal)
        )
        .is_err());
        assert!(pi_run_fields(Some("/deploy".into()), Some("cm-1".into()), None).is_err());
        assert_eq!(
            pi_run_fields(
                Some("/deploy".into()),
                Some("cm-1".into()),
                Some(admission::DeliveryMode::FollowUp)
            )
            .expect("all three present"),
            (
                "/deploy".to_string(),
                "cm-1".to_string(),
                admission::DeliveryMode::FollowUp
            )
        );
    }

    /// contract/skills-panel.ts: `invocation` is OPTIONAL on the wire — a
    /// Claude-session run omits it entirely (the frontend sends `undefined`,
    /// which never reaches the payload), and a required `String` parameter
    /// would make every one of those runs fail to deserialize.
    ///
    /// Two halves, the same shape `profiles::commands`' `copy_to_pi` pin uses:
    /// the function-pointer line fails to COMPILE if the parameter ever stops
    /// being optional, and the round-trip records what the wire actually looks
    /// like with and without the field. (`skills_run` itself needs an
    /// `AppHandle`, which this crate has no test harness for.)
    #[test]
    fn the_run_request_round_trips_with_and_without_an_invocation() {
        let _invocation_is_optional: fn(
            AppHandle,
            State<'_, Engine>,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<admission::DeliveryMode>,
        ) -> IpcResult<Option<()>> = skills_run;

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RunArgs {
            #[serde(default)]
            invocation: Option<String>,
            #[serde(default)]
            client_message_id: Option<String>,
            #[serde(default)]
            delivery: Option<admission::DeliveryMode>,
        }

        let pi: RunArgs = serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "name": "deploy",
            "invocation": "/skill:deploy",
            "clientMessageId": "cm-1",
            "delivery": "followUp",
        }))
        .expect("a Pi run carries all three");
        assert_eq!(pi.invocation.as_deref(), Some("/skill:deploy"));
        assert_eq!(pi.client_message_id.as_deref(), Some("cm-1"));
        assert_eq!(pi.delivery, Some(admission::DeliveryMode::FollowUp));

        let claude: RunArgs =
            serde_json::from_value(serde_json::json!({ "sessionId": "s1", "name": "deploy" }))
                .expect("a Claude run omits all three");
        assert_eq!(claude.invocation, None);
        assert_eq!(claude.client_message_id, None);
        assert_eq!(claude.delivery, None);
    }
}
