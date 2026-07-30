//! the per-session slash command registry (specs/slash-menu.md).

use super::*;

use crate::ipc::{err, ok, IpcResult};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

// ---------- slash menu (specs/slash-menu.md) ----------
//
// One merged per-session command registry (FR-1): builtins (help_entries,
// verbatim) > installed skills/commands (discover_skills) > the CLI's own
// slash_commands captured from the stream-json init event (FR-2). Dedup by
// name, first source wins; order per FR-3. Served by session_list_commands
// and pushed as one session.commands event whenever an init CHANGES the
// captured cli set.

/// Mirrors SlashCommandInfo in contract/common.ts.
#[derive(Serialize, Clone)]
pub struct SlashCommandInfo {
    pub(crate) name: String,         // without the leading '/'; rendering adds it
    pub(crate) description: String,  // "" when the source provides none (cli)
    pub(crate) source: &'static str, // "builtin" | "skill" | "cli" (contract SlashCommandSource)
    /// skill entries only: the SkillInfo scope (project | user | plugin).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) scope: Option<String>,
}

/// FR-1/FR-3 merge, pure: builtins first (help order), then installed skills
/// (discovery order; both kinds — skills and command files are all invoked as
/// /<name>), then cli names (init order). First occurrence of a name wins.
pub(crate) fn merge_commands(
    builtins: &[HelpEntry],
    skills: &[SkillInfo],
    cli: &[String],
) -> Vec<SlashCommandInfo> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for h in builtins {
        if seen.insert(h.command.to_string()) {
            out.push(SlashCommandInfo {
                name: h.command.to_string(),
                description: h.description.to_string(),
                source: "builtin",
                scope: None,
            });
        }
    }
    for s in skills {
        if !s.installed {
            continue; // spec §2 non-goal: only what is runnable now
        }
        if seen.insert(s.name.clone()) {
            out.push(SlashCommandInfo {
                name: s.name.clone(),
                description: s.description.clone(),
                source: "skill",
                scope: s.scope.clone(),
            });
        }
    }
    for name in cli {
        if seen.insert(name.clone()) {
            out.push(SlashCommandInfo {
                name: name.clone(),
                description: String::new(),
                source: "cli",
                scope: None,
            });
        }
    }
    out
}

/// FR-2: an init event's slash_commands, normalized to bare names (a leading
/// '/' is stripped — FR-3 stores without it; non-strings skipped). None when
/// the array is absent (→ no change to the capture).
pub(crate) fn parse_init_slash_commands(v: &Value) -> Option<Vec<String>> {
    let arr = v.get("slash_commands")?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.strip_prefix('/').unwrap_or(s).to_string())
            .collect(),
    )
}

/// FR-2 change detection: replace the in-memory capture; true iff it differed
/// (→ the caller emits one session.commands with the merged registry).
pub(crate) fn capture_cli_commands(session: &mut Session, names: Vec<String>) -> bool {
    if session.cli_commands == names {
        return false;
    }
    session.cli_commands = names;
    true
}

/// francois:session:listCommands (slash-menu FR-1/FR-4): the merged registry.
/// Snapshot under the lock, then scan the disk with it dropped — never holds
/// Engine.sessions across fs work, never touches a running turn.
#[tauri::command(async)]
pub fn session_list_commands(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Vec<SlashCommandInfo>> {
    let Some((cwd, cli)) =
        engine.with_session(&session_id, |s| (s.cwd.clone(), s.cli_commands.clone()))
    else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    ok(merge_commands(
        &help_entries(),
        &discover_skills(&cwd),
        &cli,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    // ---------- slash-menu (specs/slash-menu.md) ----------

    #[test]
    fn merge_commands_builtins_first_verbatim() {
        // §9: builtins come from help_entries() verbatim (name + description),
        // source "builtin", no scope — before any turn (no skills, no cli).
        let merged = merge_commands(&help_entries(), &[], &[]);
        let builtins = help_entries();
        assert_eq!(merged.len(), builtins.len());
        for (m, h) in merged.iter().zip(builtins.iter()) {
            assert_eq!(m.name, h.command);
            assert_eq!(m.description, h.description);
            assert_eq!(m.source, "builtin");
            assert_eq!(m.scope, None);
        }
    }

    #[test]
    fn merge_commands_dedup_precedence_and_fr3_order() {
        // FR-1/FR-3: builtin > skill > cli on a name collision; order = builtins
        // (help order), then installed skills (discovery order), then cli (init
        // order); installed:false skills are excluded; cli description is "".
        let skills = vec![
            skill_entry(
                "usage".into(),
                "skill usage".into(),
                true,
                "project",
                "skill",
                None,
            ),
            skill_entry(
                "deploy".into(),
                "ship it".into(),
                true,
                "user",
                "command",
                None,
            ),
            skill_entry(
                "hidden".into(),
                "not enabled".into(),
                false,
                "plugin",
                "skill",
                None,
            ),
        ];
        let cli = vec![
            "usage".to_string(),
            "deploy".to_string(),
            "compact".to_string(),
        ];
        let merged = merge_commands(&help_entries(), &skills, &cli);

        let mut expected: Vec<String> = help_entries()
            .iter()
            .map(|h| h.command.to_string())
            .collect();
        expected.push("deploy".into());
        expected.push("compact".into());
        let names: Vec<String> = merged.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, expected);

        let usage = merged.iter().find(|c| c.name == "usage").unwrap();
        assert_eq!(usage.source, "builtin"); // edge #4: builtin wins over skill+cli
        let deploy = merged.iter().find(|c| c.name == "deploy").unwrap();
        assert_eq!(deploy.source, "skill"); // skill wins over cli
        assert_eq!(deploy.description, "ship it");
        assert_eq!(deploy.scope.as_deref(), Some("user"));
        let compact = merged.iter().find(|c| c.name == "compact").unwrap();
        assert_eq!(compact.source, "cli");
        assert_eq!(compact.description, ""); // '' when the source provides none
        assert_eq!(compact.scope, None);
        assert!(!merged.iter().any(|c| c.name == "hidden")); // installed:false excluded
    }

    #[test]
    fn init_slash_commands_parse_and_change_detection() {
        // FR-2: absent array → None (no change); present → bare names (a leading
        // '/' is stripped, non-strings skipped — FR-3 stores without the slash).
        let no_arr = json!({ "type": "system", "subtype": "init", "session_id": "abc" });
        assert_eq!(parse_init_slash_commands(&no_arr), None);
        let with = json!({ "slash_commands": ["compact", "/clear", 7] });
        assert_eq!(
            parse_init_slash_commands(&with),
            Some(vec!["compact".to_string(), "clear".to_string()])
        );

        // capture: first init changes (→ one session.commands), an identical
        // second init does not (§9 acceptance / edge #5), a different set does.
        let mut s = test_session();
        assert!(capture_cli_commands(
            &mut s,
            vec!["compact".into(), "clear".into()]
        ));
        assert_eq!(
            s.cli_commands,
            vec!["compact".to_string(), "clear".to_string()]
        );
        assert!(!capture_cli_commands(
            &mut s,
            vec!["compact".into(), "clear".into()]
        ));
        assert!(capture_cli_commands(&mut s, vec!["compact".into()]));
        assert_eq!(s.cli_commands, vec!["compact".to_string()]);
    }
}
