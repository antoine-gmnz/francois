//! skill/plugin discovery and the skills-panel commands.

use super::*;

use crate::ipc::{err, ok, IpcResult};
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
    pub(crate) scope: Option<String>, // project | user | plugin
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<String>, // skill | command
    #[serde(rename = "pluginId", skip_serializing_if = "Option::is_none")]
    pub(crate) plugin_id: Option<String>, // '<plugin>@<marketplace>' — enabling target for available entries
}

pub(crate) fn commands_dir(base: &std::path::Path) -> std::path::PathBuf {
    base.join(".claude").join("commands")
}

/// Root that holds installed marketplaces: ~/.claude/plugins/marketplaces.
pub(crate) fn marketplaces_root() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("plugins").join("marketplaces"))
}

/// Enabled plugin ids ("<plugin>@<marketplace>") from ~/.claude/settings.json.
pub(crate) fn enabled_plugin_ids() -> std::collections::HashSet<String> {
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
pub(crate) fn all_plugins() -> Vec<(String, std::path::PathBuf)> {
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
pub(crate) fn scan_commands(dir: &std::path::Path) -> Vec<(String, String)> {
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

pub(crate) fn skill_entry(
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
    }
}

/// Full skills+commands list for a cwd (FR-3/4): installed (project ∪ user ∪ enabled
/// plugins, alpha) then available (non-enabled plugin skills, alpha). Project wins over
/// user wins over plugin on a name collision; skill wins over command within a scope.
pub(crate) fn discover_skills(cwd: &str) -> Vec<SkillInfo> {
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

pub(crate) fn skills_dir(base: &std::path::Path) -> std::path::PathBuf {
    base.join(".claude").join("skills")
}

pub(crate) fn parse_skill_description(skill_md: &std::path::Path) -> String {
    std::fs::read_to_string(skill_md)
        .map(|c| parse_skill_description_str(&c))
        .unwrap_or_default()
}

/// Parse the `description:` from a SKILL.md frontmatter, first sentence, ≤100 chars (FR-4).
pub(crate) fn parse_skill_description_str(content: &str) -> String {
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
pub(crate) fn scan_skills(dir: &std::path::Path) -> Vec<(String, String)> {
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
    let Some(cwd) = engine.with_session(&session_id, |s| s.cwd.clone()) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
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
    let Some(cwd) = engine.with_session(&session_id, |s| s.cwd.clone()) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    let Some(target) = discover_skills(&cwd)
        .into_iter()
        .find(|s| s.name == name && !s.installed)
    else {
        return err(
            "SKILL_ERROR",
            format!("'{name}' is not an available plugin skill"),
        );
    };
    let Some(pid) = target.plugin_id else {
        return err("SKILL_ERROR", format!("'{name}' has no plugin to enable"));
    };
    let Some(home) = dirs::home_dir() else {
        return err("SKILL_ERROR", "could not resolve home directory");
    };
    let path = home.join(".claude").join("settings.json");
    // Parse the existing settings. Absent → start fresh; present-but-unparseable →
    // ABORT (never clobber the user's whole global config on a parse failure).
    let mut cfg = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v.is_object() => v,
            _ => {
                return err(
                    "SKILL_ERROR",
                    "~/.claude/settings.json is not valid JSON — refusing to modify it",
                )
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return err("SKILL_ERROR", format!("could not read settings.json: {e}")),
    };
    let ep = cfg
        .as_object_mut()
        .unwrap()
        .entry("enabledPlugins")
        .or_insert_with(|| serde_json::json!({}));
    let Some(ep) = ep.as_object_mut() else {
        return err(
            "SKILL_ERROR",
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
        return err("SKILL_ERROR", format!("could not write settings.json: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return err(
            "SKILL_ERROR",
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
    args: Option<String>,
) -> IpcResult<Option<()>> {
    let Some(cwd) = engine.with_session(&session_id, |s| s.cwd.clone()) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    if !discover_skills(&cwd)
        .iter()
        .any(|s| s.installed && s.name == name)
    {
        return err("INVALID_INPUT", format!("'{name}' is not installed"));
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
}
