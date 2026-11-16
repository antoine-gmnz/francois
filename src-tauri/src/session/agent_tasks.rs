//! Background-agent lifecycle from the CLI's own `system` task lines.
//!
//! A subagent used to exist for Francois only through the `Agent`/`Task`
//! `tool_use` that dispatched it (`stream/blocks.rs::mint_subagent`). Two
//! everyday paths never produce one:
//!
//!  - `SendMessage` to an agent that already finished RESUMES it: the CLI emits
//!    `task_started` with the SAME `task_id` and the `SendMessage`'s
//!    `tool_use_id`, while every line the agent then streams still carries the
//!    ORIGINAL `Agent` call's `tool_use_id` as `parent_tool_use_id`.
//!  - after an app restart the registry is empty, so a resumed agent (or any
//!    line attributed to a dispatch from the previous process) matched nothing
//!    and was dropped — the panel read "No subagents" while the reviewer ran.
//!
//! So `task_started` (`task_type: local_agent`) is the source of truth for "an
//! agent is running", keyed by the CLI's stable `task_id` — which every
//! attributed line also carries as `agent_id`. And in stream-json mode the
//! completion is the `system` `task_notification`, not the harness's user-text
//! notice, so that closes the agent by the same key.
//!
//! Pure over `Session`; the projection emits what these return.

use super::agents::{evict_old_agents, revive_agent};
use super::*;
use serde_json::Value;

/// One parsed `system` task line about a subagent.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum AgentTaskLine {
    Started {
        task_id: String,
        tool_use_id: String,
        name: String,
        task: String,
        background: bool,
    },
    Ended {
        task_id: String,
        tool_use_id: String,
        failed: bool,
    },
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// `task_started` for a local agent, or `task_notification` for any task
/// (an id that names no agent is ignored when applied). `None` otherwise —
/// background Bash (`local_bash`) is not an agent.
pub(crate) fn parse_agent_task_line(v: &Value) -> Option<AgentTaskLine> {
    if v.get("type").and_then(Value::as_str) != Some("system") {
        return None;
    }
    let task_id = str_field(v, "task_id")?;
    let tool_use_id = str_field(v, "tool_use_id").unwrap_or_default();
    match v.get("subtype").and_then(Value::as_str)? {
        "task_started" => {
            if v.get("task_type").and_then(Value::as_str) != Some("local_agent") {
                return None;
            }
            let task = str_field(v, "description").unwrap_or_else(|| "subagent".into());
            let name = str_field(v, "subagent_type").unwrap_or_else(|| task.clone());
            Some(AgentTaskLine::Started {
                task_id,
                tool_use_id,
                name,
                task,
                background: v
                    .get("is_backgrounded")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            })
        }
        "task_notification" => Some(AgentTaskLine::Ended {
            task_id,
            tool_use_id,
            failed: matches!(
                v.get("status").and_then(Value::as_str),
                Some("failed" | "error" | "killed" | "stopped")
            ),
        }),
        _ => None,
    }
}

/// The agent a task line (or an attributed line's `agent_id`) is about.
pub(crate) fn agent_for_task(s: &Session, task_id: &str, tool_use_id: &str) -> Option<String> {
    s.agent_by_task
        .get(task_id)
        .or_else(|| s.agent_by_tool.get(tool_use_id))
        .cloned()
}

/// Apply one task line. Started: bind the task to the agent its dispatch
/// already minted, revive the agent it names (a `SendMessage` resume), or mint
/// one the registry has never seen (dispatched before a restart). Ended: close
/// that agent if it is a background one still running.
pub(crate) fn apply_agent_task(
    s: &mut Session,
    line: AgentTaskLine,
    at: u64,
) -> Vec<AgentEmission> {
    match line {
        AgentTaskLine::Started {
            task_id,
            tool_use_id,
            name,
            task,
            background,
        } => {
            if let Some(agent_id) = agent_for_task(s, &task_id, &tool_use_id) {
                s.agent_by_task.insert(task_id, agent_id.clone());
                if !tool_use_id.is_empty() {
                    s.agent_by_tool.insert(tool_use_id, agent_id.clone());
                }
                return revive_agent(s, &agent_id);
            }
            let agent = AgentInfo {
                id: uuid(),
                session_id: s.id.clone(),
                name,
                task,
                status: "running".into(),
                started_at: at,
                ended_at: None,
                background,
                last_activity: None,
                step_count: 0,
            };
            s.agent_by_task.insert(task_id, agent.id.clone());
            if !tool_use_id.is_empty() {
                s.agent_by_tool.insert(tool_use_id, agent.id.clone());
            }
            s.insert_agent(agent.clone());
            vec![AgentEmission::Update { agent }]
        }
        AgentTaskLine::Ended {
            task_id,
            tool_use_id,
            failed,
        } => {
            let Some(agent_id) = agent_for_task(s, &task_id, &tool_use_id) else {
                return Vec::new();
            };
            // A synchronous dispatch is closed by its own tool_result, which
            // lands right after and carries the summary — closing it here
            // too would only emit a redundant update.
            match s.agents.get_mut(&agent_id) {
                Some(a) if a.status == "running" && a.background => {
                    a.status = if failed { "error" } else { "done" }.into();
                    a.ended_at = Some(at);
                    let agent = a.clone();
                    evict_old_agents(s);
                    vec![AgentEmission::Update { agent }]
                }
                _ => Vec::new(),
            }
        }
    }
}

/// An attributed line whose `parent_tool_use_id` names no known dispatch (the
/// `Agent` call happened in a previous process): resolve it through the
/// line's `agent_id` (= the CLI task id), and remember the pairing so the
/// rest of that agent's lines resolve directly.
pub(crate) fn resolve_attributed(
    s: &mut Session,
    parent_tool_use_id: &str,
    task_id: Option<&str>,
) -> Option<String> {
    if let Some(agent_id) = s.agent_by_tool.get(parent_tool_use_id) {
        return Some(agent_id.clone());
    }
    let agent_id = s.agent_by_task.get(task_id?)?.clone();
    s.agent_by_tool
        .insert(parent_tool_use_id.into(), agent_id.clone());
    Some(agent_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::test_session;
    use serde_json::json;

    // Shapes copied from a real 2.1.x capture of Agent → finish → SendMessage.
    fn started(tool_use_id: &str) -> Value {
        json!({ "type": "system", "subtype": "task_started", "task_id": "aad9fe",
            "tool_use_id": tool_use_id, "description": "Review WW-197",
            "subagent_type": "waati:waati-reviewer", "is_backgrounded": true,
            "task_type": "local_agent" })
    }
    fn notification(tool_use_id: &str, status: &str) -> Value {
        json!({ "type": "system", "subtype": "task_notification", "task_id": "aad9fe",
            "tool_use_id": tool_use_id, "status": status })
    }
    fn apply(s: &mut Session, v: Value) -> Vec<AgentEmission> {
        apply_agent_task(s, parse_agent_task_line(&v).unwrap(), 10)
    }
    fn status(s: &Session) -> Vec<&str> {
        s.agent_order
            .iter()
            .map(|id| s.agents[id].status.as_str())
            .collect()
    }

    #[test]
    fn only_local_agent_tasks_are_agents() {
        let bash = json!({ "type": "system", "subtype": "task_started", "task_id": "b1",
            "tool_use_id": "t", "task_type": "local_bash" });
        assert_eq!(parse_agent_task_line(&bash), None);
        assert_eq!(
            parse_agent_task_line(&json!({ "type": "system", "subtype": "init" })),
            None
        );
        assert!(matches!(
            parse_agent_task_line(&started("t1")),
            Some(AgentTaskLine::Started { name, task, background: true, .. })
                if name == "waati:waati-reviewer" && task == "Review WW-197"
        ));
    }

    #[test]
    fn a_dispatch_francois_already_minted_is_bound_not_duplicated() {
        let mut s = test_session();
        s.insert_agent(AgentInfo {
            id: "a1".into(),
            session_id: "s1".into(),
            name: "reviewer".into(),
            task: "t".into(),
            status: "running".into(),
            started_at: 1,
            ended_at: None,
            background: true,
            last_activity: None,
            step_count: 0,
        });
        s.agent_by_tool.insert("toolu_agent".into(), "a1".into());
        assert!(apply(&mut s, started("toolu_agent")).is_empty());
        assert_eq!(s.agent_order, vec!["a1"]);
        assert_eq!(
            s.agent_by_task.get("aad9fe").map(String::as_str),
            Some("a1")
        );
    }

    #[test]
    fn a_send_message_resume_revives_the_same_agent_and_its_notification_closes_it() {
        let mut s = test_session();
        apply(&mut s, started("toolu_agent"));
        apply(&mut s, notification("toolu_agent", "completed"));
        assert_eq!(status(&s), vec!["done"]);
        // SendMessage: same task id, the SendMessage's own tool_use_id.
        let ems = apply(&mut s, started("toolu_send"));
        assert_eq!(ems.len(), 1, "one update: running again");
        assert_eq!(status(&s), vec!["running"], "one agent, not two");
        apply(&mut s, notification("toolu_send", "completed"));
        assert_eq!(status(&s), vec!["done"]);
    }

    #[test]
    fn a_resume_after_a_restart_mints_the_agent_and_adopts_its_old_lines() {
        // Empty registry: the `Agent` call was made by a previous process.
        let mut s = test_session();
        let ems = apply(&mut s, started("toolu_send"));
        assert_eq!(ems.len(), 1);
        assert_eq!(status(&s), vec!["running"]);
        let id = s.agent_order[0].clone();
        assert_eq!(s.agents[&id].name, "waati:waati-reviewer");
        // Its lines carry the ORIGINAL dispatch id plus agent_id = task id.
        assert_eq!(
            resolve_attributed(&mut s, "toolu_old_agent", Some("aad9fe")),
            Some(id.clone())
        );
        assert_eq!(
            resolve_attributed(&mut s, "toolu_old_agent", None),
            Some(id)
        );
        assert_eq!(
            resolve_attributed(&mut s, "toolu_unknown", Some("other")),
            None
        );
    }

    #[test]
    fn a_failed_task_ends_in_error_and_an_unknown_one_changes_nothing() {
        let mut s = test_session();
        apply(&mut s, started("toolu_agent"));
        apply(&mut s, notification("toolu_agent", "failed"));
        assert_eq!(status(&s), vec!["error"]);
        let mut empty = test_session();
        assert!(apply(&mut empty, notification("toolu_x", "completed")).is_empty());
    }
}
