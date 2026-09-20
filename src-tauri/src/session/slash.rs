//! the per-session slash command registry (specs/slash-menu.md).

use super::*;
use crate::ipc::ErrorCode;

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
    /// skill entries only: the SkillInfo scope (project | user | plugin | path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) scope: Option<String>,
    /// pi-skills-capabilities: the exact text to submit for a runtime-listed
    /// command (e.g. `/skill:review`). Absent ⇒ the legacy `/` + name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) invocation: Option<String>,
}

/// FR-1/FR-3 merge, pure: builtins first (help order), then installed skills
/// (discovery order; both kinds — skills and command files are all invoked as
/// /<name>), then cli names (init order). First occurrence of a name wins.
pub fn merge_commands(
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
                invocation: None,
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
                invocation: None,
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
                invocation: None,
            });
        }
    }
    out
}

// ---------- pi-skills-capabilities: Pi routing ----------
//
// A Pi session's slash menu is NEVER the Claude-shaped merge above: it is
// the runtime's own loaded commands (FR-1's `get_commands`, via
// `RuntimeSessionControl::list_commands`), augmented with exactly the three
// François-owned actions this build actually implements for Pi — never a
// TUI-only command such as `/login` advertised as if it were an RPC verb.

/// The François-owned actions implemented for a Pi session (model switching,
/// manual compaction, clearing the queue) — everything else runs through the
/// runtime's own commands.
fn pi_owned_actions() -> [SlashCommandInfo; 3] {
    [
        SlashCommandInfo {
            name: "model".into(),
            description: "Switch the model for this session".into(),
            source: "builtin",
            scope: None,
            invocation: None,
        },
        SlashCommandInfo {
            name: "compact".into(),
            description: "Compact this conversation".into(),
            source: "builtin",
            scope: None,
            invocation: None,
        },
        SlashCommandInfo {
            name: "clear-queue".into(),
            description: "Clear this session's queued messages".into(),
            source: "builtin",
            scope: None,
            invocation: None,
        },
    ]
}

/// FR-2 / contract §5: the runtime's own commands (in their reported order,
/// exact `invocation` spelling preserved), augmented — never replaced — with
/// the François-owned actions above. Dedup by bare name, first occurrence
/// wins, so a runtime command never loses to a same-named builtin action
/// (the builtins are appended last, not merged in ahead of the runtime's own
/// list).
pub fn merge_pi_commands(runtime: &[adapter::RuntimeCommandInfo]) -> Vec<SlashCommandInfo> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for c in runtime {
        let name = adapter::pi::skill_name_from_invocation(&c.invocation);
        if seen.insert(name.clone()) {
            out.push(SlashCommandInfo {
                name,
                description: c.description.clone(),
                source: "skill",
                scope: Some("path".into()),
                invocation: Some(c.invocation.clone()),
            });
        }
    }
    for action in pi_owned_actions() {
        if seen.insert(action.name.clone()) {
            out.push(action);
        }
    }
    out
}

/// FR-2: an init event's slash_commands, normalized to bare names (a leading
/// '/' is stripped — FR-3 stores without it; non-strings skipped). None when
/// the array is absent (→ no change to the capture).
pub fn parse_init_slash_commands(v: &Value) -> Option<Vec<String>> {
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
pub fn capture_cli_commands(session: &mut Session, names: Vec<String>) -> bool {
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
    let Some((cwd, cli, agent_runtime)) = engine.with_session(&session_id, |s| {
        (s.cwd.clone(), s.cli_commands.clone(), s.agent_runtime)
    }) else {
        return err(ErrorCode::SessionNotFound, "no such session");
    };
    // pi-skills-capabilities: a Pi session's menu is the runtime's own
    // commands plus François-owned actions only — never the Claude-shaped
    // merge below.
    if agent_runtime == AgentRuntime::Pi {
        let Some(connection) = engine.runtime_connection_for(&session_id) else {
            return err(
                ErrorCode::RuntimeExited,
                "this session has no live Pi connection",
            );
        };
        return match connection.list_commands() {
            Ok(commands) => ok(merge_pi_commands(&commands)),
            Err(error) => IpcResult::Err { ok: false, error },
        };
    }
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

    // ---------- pi-skills-capabilities ----------

    fn pi_command(invocation: &str, description: &str) -> adapter::RuntimeCommandInfo {
        adapter::RuntimeCommandInfo {
            invocation: invocation.into(),
            description: description.into(),
            source: adapter::RuntimeCommandSource::Skill,
            source_path: None,
            loaded: true,
            unavailable_reason: None,
        }
    }

    #[test]
    fn merge_pi_commands_lists_the_runtime_commands_first_with_invocation_preserved() {
        let runtime = vec![pi_command("/skill:review", "review a diff")];
        let merged = merge_pi_commands(&runtime);
        assert_eq!(merged[0].name, "review");
        assert_eq!(merged[0].invocation.as_deref(), Some("/skill:review"));
        assert_eq!(merged[0].source, "skill");
        assert_eq!(merged[0].scope.as_deref(), Some("path"));
    }

    #[test]
    fn merge_pi_commands_augments_with_exactly_the_three_owned_actions() {
        let merged = merge_pi_commands(&[]);
        let names: Vec<&str> = merged.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["model", "compact", "clear-queue"]);
        for c in &merged {
            assert_eq!(c.source, "builtin");
            assert_eq!(c.invocation, None);
        }
    }

    #[test]
    fn merge_pi_commands_never_advertises_a_tui_only_login_command() {
        let merged = merge_pi_commands(&[pi_command("/login", "authenticate")]);
        // The runtime NAMING a command does not, on its own, make it one of
        // the three implemented actions — but this test's real point is that
        // nothing here invents a `/login` entry when the runtime list is
        // empty; a runtime-reported one is passed through verbatim, since
        // `get_commands` "omits TUI-only commands" per the audit (FR-1) and
        // this function trusts that boundary rather than re-filtering it.
        assert!(merged.iter().any(|c| c.name == "login"));
        let bare = merge_pi_commands(&[]);
        assert!(!bare.iter().any(|c| c.name == "login"));
    }

    #[test]
    fn merge_pi_commands_dedups_by_bare_name_runtime_wins_over_an_owned_action() {
        let runtime = vec![pi_command("/compact", "runtime-owned compaction")];
        let merged = merge_pi_commands(&runtime);
        let compact_entries: Vec<_> = merged.iter().filter(|c| c.name == "compact").collect();
        assert_eq!(compact_entries.len(), 1);
        assert_eq!(compact_entries[0].source, "skill");
    }
}
