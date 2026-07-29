//! async subagent lifecycle + activity trail (specs/async-agents.md).

use super::*;

use crate::ipc::{err, ok, IpcResult};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};

// ---------- async-agents: lifecycle + activity trail (specs/async-agents.md) ----------
//
// Everything in this section is PURE over `Session` and returns the events its
// caller must emit (`AgentEmission`), in order. The AppHandle wrappers at the end
// only lock → mutate → drop the lock → emit, so no emit ever happens while
// Engine.sessions is held (the file-wide lock rule).

/// FR-8: the correlation key carried by an inner line, when non-null.
pub(crate) fn parent_tool_use_id(v: &Value) -> Option<String> {
    v.get("parent_tool_use_id")
        .and_then(|p| p.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// FR-8/FR-9 + FR-13's routing decision for one top-level stream line, computed
/// BEFORE any per-type dispatch.
pub(crate) enum LineRoute {
    /// Attributed to a subagent (FR-8): carries its `parent_tool_use_id`
    /// correlation key. Only `assistant`/`user`/`stream_event` can be
    /// attributed — FR-9 assigns no meaning to any other type, so e.g. a
    /// `control_request` that happens to carry a stray `parent_tool_use_id`
    /// must still reach its normal handler (the permission/question control
    /// channel), never be diverted and silently dropped.
    Attributed(String),
    /// A resolved FR-13 task-notification — never reaches the transcript.
    Notice,
    /// Belongs to the parent turn; dispatch on its own `type` as usual.
    Parent,
}

/// Pure classifier used by the NDJSON reader before its per-type `match`.
pub(crate) fn route_line(v: &Value) -> LineRoute {
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if matches!(ty, "assistant" | "user" | "stream_event") {
        if let Some(ptuid) = parent_tool_use_id(v) {
            return LineRoute::Attributed(ptuid);
        }
    }
    if is_task_notification(v) {
        return LineRoute::Notice;
    }
    LineRoute::Parent
}

/// FR-2 ladder: an explicit `run_in_background` boolean wins; otherwise the tool
/// name decides — the stock `Task` tool is synchronous, the harness's `Agent` tool
/// runs in the background unless told otherwise. FR-11 is the safety net.
pub(crate) fn resolve_background(input: &Value, tool: &str) -> bool {
    match input.get("run_in_background").and_then(|b| b.as_bool()) {
        Some(b) => b,
        None => tool == "Agent",
    }
}

/// FR-2: once a tool's input JSON has fully accumulated as `__acc` (the
/// concatenated `input_json_delta` fragments), replace the placeholder
/// `input` with the parsed whole — but keep `__agentId` (stashed at
/// `content_block_start`, §5.4), since it never rides the accumulated JSON
/// and would otherwise be lost, silently completing every `Agent` dispatch
/// as `background: false` (the exact bug this feature fixes). A missing or
/// unparsable `__acc` leaves `input` unchanged.
pub(crate) fn finalize_tool_input(input: &Value) -> Value {
    let Some(acc) = input.get("__acc").and_then(|a| a.as_str()) else {
        return input.clone();
    };
    if acc.is_empty() {
        return input.clone();
    }
    let Ok(mut parsed) = serde_json::from_str::<Value>(acc) else {
        return input.clone();
    };
    if let Some(aid) = input.get("__agentId").cloned() {
        parsed["__agentId"] = aid;
    }
    parsed
}

/// First non-blank line of `text`, trimmed and truncated to `n` chars.
pub(crate) fn first_nonblank_line(text: &str, n: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    truncate(line, n)
}

/// FR-10/FR-12: append one step to an agent's trail. Sets `lastActivity`,
/// increments `stepCount`, drops the oldest step past the window, and asks for
/// `agent.step` then `agent.update`. A blank label or an unknown agent is a no-op.
pub(crate) fn push_step(
    s: &mut Session,
    agent_id: &str,
    kind: &str,
    tool: Option<String>,
    label: &str,
    at: u64,
) -> Vec<AgentEmission> {
    if label.is_empty() || !s.agents.contains_key(agent_id) {
        return Vec::new();
    }
    let seq = {
        let n = s.agent_step_seq.entry(agent_id.to_string()).or_insert(0);
        *n += 1;
        *n
    };
    let step = AgentStep {
        seq,
        kind: kind.into(),
        at,
        tool,
        label: label.into(),
        meta: None,
    };
    let trail = s.agent_steps.entry(agent_id.to_string()).or_default();
    trail.push_back(step.clone());
    let mut evicted_seq: Option<u32> = None;
    while trail.len() > AGENT_TRAIL_CAP {
        // FR-12: the trail is a window; seq/stepCount keep growing. Remember the
        // newest evicted seq (they come off oldest-first, so it's the max).
        if let Some(old) = trail.pop_front() {
            evicted_seq = Some(old.seq);
        }
    }
    if let Some(evicted) = evicted_seq {
        // Finding 2: a step past the window can never be filled again (the
        // fill path above already no-ops once its seq is gone) — drop its
        // dead InnerTool entry too, so the per-agent index doesn't outlive
        // what it can serve.
        if let Some(inner) = s.agent_inner_tools.get_mut(agent_id) {
            inner.retain(|_, it| it.seq > evicted);
        }
    }
    let mut out = vec![AgentEmission::Step {
        agent_id: agent_id.to_string(),
        step: step.clone(),
    }];
    // agent-tab FR-4: every lifecycle notice is also a transcript block. Minted
    // HERE rather than at the four notice call sites so step/block parity is
    // structural — a new notice site cannot forget the tab.
    if kind == "notice" {
        if let Some(nb) = push_agent_notice(s, agent_id, &step.label) {
            out.push(nb.emission);
        }
    }
    if let Some(a) = s.agents.get_mut(agent_id) {
        a.last_activity = Some(step.label);
        a.step_count = a.step_count.saturating_add(1);
        out.push(AgentEmission::Update { agent: a.clone() });
    }
    out
}

/// FR-9/FR-10: fill an existing step's `meta` and re-emit that same `seq` — no new
/// step, `lastActivity`/`stepCount` unchanged, so no `agent.update`.
pub(crate) fn fill_step_meta(
    s: &mut Session,
    agent_id: &str,
    tool_use_id: &str,
    seq: u32,
    meta: String,
) -> Vec<AgentEmission> {
    let Some(trail) = s.agent_steps.get_mut(agent_id) else {
        return Vec::new();
    };
    // The step may already have fallen out of the window (FR-12) — then nothing to fill.
    let Some(step) = trail.iter_mut().find(|st| st.seq == seq) else {
        return Vec::new();
    };
    step.meta = Some(meta);
    let out = vec![AgentEmission::Step {
        agent_id: agent_id.to_string(),
        step: step.clone(),
    }];
    // Finding 2: a tool_use_id gets exactly one result — once filled the entry
    // is dead, so drop it instead of holding its InnerTool (a full `input`
    // JSON clone) for the rest of the session's lifetime.
    if let Some(inner) = s.agent_inner_tools.get_mut(agent_id) {
        inner.remove(tool_use_id);
    }
    out
}

/// FR-11 liveness self-heal: observed inner activity outranks an inferred
/// completion. Emitted BEFORE the steps of the line that triggered it.
pub(crate) fn revive_agent(s: &mut Session, agent_id: &str) -> Vec<AgentEmission> {
    match s.agents.get_mut(agent_id) {
        Some(a) if a.status != "running" => {
            a.status = "running".into();
            a.ended_at = None;
            vec![AgentEmission::Update { agent: a.clone() }]
        }
        _ => Vec::new(),
    }
}

/// FR-2: record the resolved dispatch kind once the input JSON is complete.
pub(crate) fn apply_background(
    s: &mut Session,
    agent_id: &str,
    background: bool,
) -> Vec<AgentEmission> {
    match s.agents.get_mut(agent_id) {
        Some(a) => {
            a.background = background;
            vec![AgentEmission::Update { agent: a.clone() }]
        }
        None => Vec::new(),
    }
}

/// FR-4 / FR-5: the dispatch's own `tool_result`. For a synchronous dispatch it is
/// the completion; for a background dispatch it is only a spawn acknowledgement and
/// MUST NOT stop the clock (the regression this feature exists for).
pub(crate) fn apply_dispatch_result(
    s: &mut Session,
    agent_id: &str,
    result_text: &str,
    is_error: bool,
    at: u64,
) -> Vec<AgentEmission> {
    let Some(background) = s.agents.get(agent_id).map(|a| a.background) else {
        return Vec::new();
    };
    if background {
        // FR-5: remember the ack text for FR-14 matching, note it in the trail.
        let ack: String = result_text.trim().chars().take(200).collect();
        if !ack.is_empty() {
            s.agent_backend_ref.insert(agent_id.to_string(), ack);
        }
        return push_step(s, agent_id, "notice", None, "dispatched in background", at);
    }
    // FR-4: synchronous completion (session-engine FR-39 + the new is_error mapping).
    let excerpt = truncate(result_text.lines().next().unwrap_or(""), 80);
    match s.agents.get_mut(agent_id) {
        Some(a) => {
            a.status = if is_error { "error" } else { "done" }.into();
            a.ended_at = Some(at);
            if !excerpt.is_empty() {
                a.task = excerpt;
            }
            vec![AgentEmission::Update { agent: a.clone() }]
        }
        None => Vec::new(),
    }
}

/// FR-9/FR-10/FR-11: turn one attributed stream line into trail steps.
pub(crate) fn apply_attributed_line(
    s: &mut Session,
    agent_id: &str,
    v: &Value,
    cwd: &str,
    at: u64,
) -> Vec<AgentEmission> {
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    // FR-9: `stream_event` is dropped — its content arrives again on the
    // non-partial `assistant` line, and consuming both would double every step.
    // Such a line produces no event at all (§9), so FR-11 does not fire for it.
    if (ty != "assistant" && ty != "user") || !s.agents.contains_key(agent_id) {
        return Vec::new();
    }
    let mut out = revive_agent(s, agent_id); // FR-11, before FR-9
    let Some(content) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .cloned()
    else {
        return out;
    };
    for item in content {
        let bt = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match (ty, bt) {
            ("assistant", "text") => {
                let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let label = first_nonblank_line(text, 120);
                out.extend(push_step(s, agent_id, "text", None, &label, at));
                // agent-tab FR-1: the same block again, untruncated, for the tab.
                if let Some(nb) = push_agent_text(s, agent_id, text) {
                    out.push(nb.emission);
                }
            }
            ("assistant", "tool_use") => {
                let name = item
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                let input = item
                    .get("input")
                    .cloned()
                    .unwrap_or(Value::Object(Default::default()));
                // The SAME summary the engine derives for a top-level tool.start (§5.4).
                let summary = tool_summary(&name, &input, cwd);
                let label = if summary.is_empty() {
                    name.clone()
                } else {
                    summary
                };
                let ems = push_step(s, agent_id, "tool", Some(name.clone()), &label, at);
                let seq = ems.iter().find_map(|e| match e {
                    AgentEmission::Step { step, .. } => Some(step.seq),
                    _ => None,
                });
                out.extend(ems);
                // agent-tab FR-1: the tool card for the tab, classified like a
                // top-level tool.start (a nested dispatch becomes a subagent block).
                let block_id = match push_agent_tool(s, agent_id, &name, &label) {
                    Some(nb) => {
                        out.push(nb.emission);
                        nb.block_id
                    }
                    None => String::new(),
                };
                // FR-9: remember the inner tool_use_id against the step's seq, in a
                // PER-AGENT map — never the parent turn's tool index. `block_id`
                // rides along so one tool_result fills both projections (agent-tab FR-2).
                if let (Some(seq), Some(tuid)) = (seq, item.get("id").and_then(|i| i.as_str())) {
                    s.agent_inner_tools
                        .entry(agent_id.to_string())
                        .or_default()
                        .insert(
                            tuid.to_string(),
                            InnerTool {
                                seq,
                                tool: name,
                                input,
                                block_id,
                            },
                        );
                }
            }
            ("user", "tool_result") => {
                let tuid = item
                    .get("tool_use_id")
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                // FR-9: a tool_result for an unknown tool_use_id is ignored.
                let Some(inner) = s
                    .agent_inner_tools
                    .get(agent_id)
                    .and_then(|m| m.get(tuid))
                    .cloned()
                else {
                    continue;
                };
                let meta = if item
                    .get("is_error")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false)
                {
                    "error".to_string()
                } else {
                    // The SAME meta the engine derives for a top-level tool.done (§5.4).
                    tool_meta(
                        &inner.tool,
                        &inner.input,
                        &extract_result_text(item.get("content")),
                    )
                };
                // agent-tab FR-2: the same meta closes the transcript block, in
                // place and under the same blockId — never a second block.
                if !inner.block_id.is_empty() {
                    out.extend(fill_agent_block_meta(s, agent_id, &inner.block_id, &meta));
                }
                out.extend(fill_step_meta(s, agent_id, tuid, inner.seq, meta));
            }
            _ => {} // thinking & any other block type → no step
        }
    }
    out
}

/// The text content of a `user` line: a plain string body, or the concatenation of
/// its `text` blocks. tool_result payloads are deliberately excluded (FR-13).
pub(crate) fn user_line_text(v: &Value) -> String {
    match v.get("message").and_then(|m| m.get("content")) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(crate) fn has_tool_result(v: &Value) -> bool {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
        })
        .unwrap_or(false)
}

/// FR-13: a top-level `user` line whose TEXT content carries the marker. A line
/// bearing a tool_result is never a notice — it must reach the transcript.
pub(crate) fn is_task_notification(v: &Value) -> bool {
    if v.get("type").and_then(|t| t.as_str()) != Some("user") || has_tool_result(v) {
        return false;
    }
    user_line_text(v)
        .to_lowercase()
        .contains("task-notification")
}

/// FR-15: `/\b(fail(ed|ure)?|error)\b/i`, hand-rolled (no regex dependency).
pub(crate) fn notice_is_error(text: &str) -> bool {
    text.to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .any(|w| matches!(w, "fail" | "failed" | "failure" | "error"))
}

/// FR-14 ladder: backendRef verbatim → name → the single running background agent.
pub(crate) fn resolve_notice_agent(s: &Session, text: &str) -> Option<String> {
    let candidates: Vec<&AgentInfo> = s
        .agent_order
        .iter()
        .filter_map(|id| s.agents.get(id))
        .filter(|a| a.background && a.status == "running")
        .collect();
    for a in &candidates {
        if let Some(r) = s.agent_backend_ref.get(&a.id) {
            if !r.is_empty() && text.contains(r.as_str()) {
                return Some(a.id.clone());
            }
        }
    }
    for a in &candidates {
        if !a.name.is_empty() && text.contains(a.name.as_str()) {
            return Some(a.id.clone());
        }
    }
    if candidates.len() == 1 {
        return Some(candidates[0].id.clone());
    }
    None
}

/// FR-15: a resolved notice closes its agent — agent.step, then agent.update.
pub(crate) fn apply_notice(
    s: &mut Session,
    agent_id: &str,
    text: &str,
    at: u64,
) -> Vec<AgentEmission> {
    if !s.agents.contains_key(agent_id) {
        return Vec::new();
    }
    let excerpt = first_nonblank_line(text, 80);
    let label = first_nonblank_line(text, 120);
    // Finding 6: push_step is a no-op on an empty label — a blank notice would
    // then close the agent with ZERO agent.update, leaving the panel showing a
    // live clock on an agent the core already considers finished. A step and
    // its paired update must always be emitted.
    let label = if label.is_empty() {
        "completed".to_string()
    } else {
        label
    };
    let errored = notice_is_error(text);
    if let Some(a) = s.agents.get_mut(agent_id) {
        a.status = if errored { "error" } else { "done" }.into();
        a.ended_at = Some(at);
        if !excerpt.is_empty() {
            a.task = excerpt;
        }
    }
    // push_step's own agent.update carries the terminal state — exactly one of each.
    push_step(s, agent_id, "notice", None, &label, at)
}

/// FR-16 turn-end finalization: nothing of this session is left `running`. Runs
/// BEFORE the turn's terminal session.status is emitted, and is the backstop that
/// makes the elapsed clock independent of FR-13's string match.
pub(crate) fn finalize_agents(s: &mut Session, errored: bool, at: u64) -> Vec<AgentEmission> {
    let running: Vec<String> = s
        .agent_order
        .iter()
        .filter(|id| {
            s.agents
                .get(*id)
                .map(|a| a.status == "running")
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let mut out = Vec::new();
    for id in running {
        if let Some(a) = s.agents.get_mut(&id) {
            a.status = if errored { "error" } else { "done" }.into();
            a.ended_at = Some(at);
        }
        out.extend(push_step(s, &id, "notice", None, "ended with the turn", at));
    }
    out
}

/// FR-18: kill is local bookkeeping — the harness-side agent is not interrupted,
/// so FR-11 may legitimately resurrect the card. That is the honest reading.
pub(crate) fn apply_kill(s: &mut Session, agent_id: &str, at: u64) -> Vec<AgentEmission> {
    if !s.agents.contains_key(agent_id) {
        return Vec::new();
    }
    if let Some(a) = s.agents.get_mut(agent_id) {
        a.status = "error".into();
        a.ended_at = Some(at);
    }
    push_step(s, agent_id, "notice", None, "killed from the panel", at)
}

/// §5 `francois:agents:activity`: the agent's trail, ordered by seq. None ⇔ the
/// agentId matches no agent in ANY session's registry (AGENT_NOT_FOUND).
pub(crate) fn activity_of(
    map: &HashMap<String, Session>,
    agent_id: &str,
) -> Option<Vec<AgentStep>> {
    map.values()
        .find(|s| s.agents.contains_key(agent_id))
        .map(|s| {
            s.agent_steps
                .get(agent_id)
                .map(|d| d.iter().cloned().collect())
                .unwrap_or_default()
        })
}

pub(crate) fn emit_agent_emissions(app: &AppHandle, session_id: &str, ems: Vec<AgentEmission>) {
    for e in ems {
        match e {
            AgentEmission::Step { agent_id, step } => emit(
                app,
                SessionEvent::AgentStepEvent {
                    session_id: session_id.into(),
                    agent_id,
                    step,
                },
            ),
            AgentEmission::Update { agent } => emit(app, SessionEvent::AgentUpdate { agent }),
            // agent-tab FR-8: blocks ride the `agents` domain stream, not the
            // session one (§5 — common.ts stays import-free).
            AgentEmission::Block { agent_id, block } => emit_agent_event(
                app,
                AgentEvent::Block {
                    session_id: session_id.into(),
                    agent_id,
                    block,
                },
            ),
        }
    }
}

/// FR-8: divert one attributed line to its agent. A `parent_tool_use_id` matching
/// no known dispatch is ignored entirely — either way the line never reaches the
/// parent-turn handlers, so the SESSION transcript stays the parent turn's record.
pub(crate) fn attribute_inner_line(
    app: &AppHandle,
    session_id: &str,
    parent_tuid: &str,
    v: &Value,
    cwd: &str,
) {
    let ems = {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        let Some(agent_id) = s.agent_by_tool.get(parent_tuid).cloned() else {
            return;
        };
        apply_attributed_line(s, &agent_id, v, cwd, now_ms())
    };
    emit_agent_emissions(app, session_id, ems);
}

/// FR-13/FR-14/FR-15. Returns true when the line was a notice and is consumed —
/// an unresolved notice is consumed too (it is harness-injected, not user content).
pub(crate) fn handle_task_notification(app: &AppHandle, session_id: &str, v: &Value) -> bool {
    if !is_task_notification(v) {
        return false;
    }
    let text = user_line_text(v);
    let ems = {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return true;
        };
        match resolve_notice_agent(s, &text) {
            Some(agent_id) => apply_notice(s, &agent_id, &text, now_ms()),
            None => Vec::new(),
        }
    };
    emit_agent_emissions(app, session_id, ems);
    true
}

// ---------- agents-panel commands (spec §5) ----------
//
// v1 note: `dispatch` mints a tracked agent in the registry and emits
// agent.update so the panel shows it live; wiring a dispatched agent to real
// Claude Code subagent execution (a crafted Task turn) is a session-engine
// enhancement the panel spec explicitly boxes as out of its scope. Real
// subagents Claude spawns via the Task tool during a turn still appear through
// the normal content_block_start(Task) path. `kill` marks the agent errored and
// emits agent.update; it cannot halt an in-turn Claude subagent in v1.

#[tauri::command(async)]
pub fn agents_list(engine: State<'_, Engine>, session_id: String) -> IpcResult<Vec<AgentInfo>> {
    let map = engine.sessions.lock().unwrap();
    match map.get(&session_id) {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some(s) => ok(s
            .agent_order
            .iter()
            .filter_map(|id| s.agents.get(id).cloned())
            .collect()),
    }
}

#[derive(Serialize)]
pub struct DispatchOutput {
    #[serde(rename = "agentId")]
    agent_id: String,
}

#[tauri::command(async)]
pub fn agents_dispatch(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    task: String,
) -> IpcResult<DispatchOutput> {
    let task = task.trim().to_string();
    if task.is_empty() {
        return err("INVALID_INPUT", "task is empty");
    }
    let agent_id = uuid();
    let agent = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        if s.status == "done" || s.status == "error" {
            return err("SESSION_NOT_RUNNING", "session has ended");
        }
        let name: String = task.chars().take(24).collect();
        let agent = AgentInfo {
            id: agent_id.clone(),
            session_id: session_id.clone(),
            name,
            task: task.clone(),
            status: "running".into(),
            started_at: now_ms(),
            ended_at: None,
            // A panel dispatch is not a harness background agent (async-agents FR-2).
            background: false,
            last_activity: None,
            step_count: 0,
        };
        s.insert_agent(agent.clone());
        agent
    };
    emit(&app, SessionEvent::AgentUpdate { agent });
    ok(DispatchOutput { agent_id })
}

#[tauri::command(async)]
pub fn agents_kill(
    app: AppHandle,
    engine: State<'_, Engine>,
    agent_id: String,
) -> IpcResult<Option<()>> {
    // async-agents FR-18: status 'error' + endedAt + a `killed from the panel`
    // notice step. The harness-side background agent is NOT interrupted (v1), so
    // FR-11 may legitimately resurrect the card if it keeps emitting.
    let found = {
        let mut map = engine.sessions.lock().unwrap();
        let mut found = None;
        for s in map.values_mut() {
            if s.agents.contains_key(&agent_id) {
                let sid = s.id.clone();
                found = Some((sid, apply_kill(s, &agent_id, now_ms())));
                break;
            }
        }
        found
    };
    match found {
        None => err("AGENT_NOT_FOUND", "no such agent"),
        Some((session_id, ems)) => {
            emit_agent_emissions(&app, &session_id, ems);
            ok(None)
        }
    }
}

/// `francois:agents:activity` (async-agents §5) — the agent's bounded activity
/// trail, ordered by `seq`. AGENT_NOT_FOUND when the id is unknown everywhere.
#[tauri::command(async)]
pub fn agents_activity(engine: State<'_, Engine>, agent_id: String) -> IpcResult<Vec<AgentStep>> {
    let map = engine.sessions.lock().unwrap();
    match activity_of(&map, &agent_id) {
        Some(steps) => ok(steps),
        None => err("AGENT_NOT_FOUND", "no such agent"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    #[test]
    fn agent_info_serializes_async_agents_shape() {
        // §5: background + stepCount are REQUIRED; endedAt/lastActivity are
        // omitted (never null) while absent.
        let a = agent_fixture("a1", "explorer", true);
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["id"], "a1");
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["status"], "running");
        assert_eq!(v["startedAt"], 1_000);
        assert_eq!(v["background"], true);
        assert_eq!(v["stepCount"], 0);
        assert!(v.get("endedAt").is_none());
        assert!(v.get("lastActivity").is_none());

        let mut b = agent_fixture("a2", "reviewer", false);
        b.ended_at = Some(9_000);
        b.last_activity = Some("Read src/session.rs".into());
        b.step_count = 7;
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["background"], false);
        assert_eq!(v["endedAt"], 9_000);
        assert_eq!(v["lastActivity"], "Read src/session.rs");
        assert_eq!(v["stepCount"], 7);
    }

    #[test]
    fn agent_step_serializes_contract_shape() {
        // §5 AgentStep: seq/kind/at/label always; tool/meta omitted when absent.
        let s = AgentStep {
            seq: 1,
            kind: "text".into(),
            at: 4_242,
            tool: None,
            label: "thinking about it".into(),
            meta: None,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["seq"], 1);
        assert_eq!(v["kind"], "text");
        assert_eq!(v["at"], 4_242);
        assert_eq!(v["label"], "thinking about it");
        assert!(v.get("tool").is_none());
        assert!(v.get("meta").is_none());

        let t = AgentStep {
            seq: 2,
            kind: "tool".into(),
            at: 4_300,
            tool: Some("Read".into()),
            label: "src/session.rs".into(),
            meta: Some("128 lines".into()),
        };
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["kind"], "tool");
        assert_eq!(v["tool"], "Read");
        assert_eq!(v["meta"], "128 lines");
    }

    #[test]
    fn route_line_classifies_attributed_notice_and_parent_lines() {
        // Finding 5 (and Finding 3): pins the routing decision the reader
        // gates on, including that a control_request bearing a parent id is
        // NEVER attributed — diverting it would swallow the permission /
        // question control channel and hang the turn.
        assert!(matches!(
            route_line(&json!({ "type": "assistant", "parent_tool_use_id": "toolu_1" })),
            LineRoute::Attributed(id) if id == "toolu_1"
        ));
        assert!(matches!(
            route_line(&json!({
                "type": "user", "parent_tool_use_id": "toolu_1",
                "message": { "content": [] }
            })),
            LineRoute::Attributed(id) if id == "toolu_1"
        ));
        assert!(matches!(
            route_line(&json!({ "type": "stream_event", "parent_tool_use_id": "toolu_1" })),
            LineRoute::Attributed(id) if id == "toolu_1"
        ));
        // Finding 3: a control_request with a stray parent_tool_use_id must
        // still reach its normal handler.
        assert!(matches!(
            route_line(&json!({
                "type": "control_request", "parent_tool_use_id": "toolu_1",
                "request_id": "req-1"
            })),
            LineRoute::Parent
        ));
        // a top-level notice
        assert!(matches!(
            route_line(&json!({
                "type": "user",
                "message": { "content": "task-notification: agent done" }
            })),
            LineRoute::Notice
        ));
        // a plain top-level line
        assert!(matches!(
            route_line(&json!({
                "type": "user",
                "message": { "content": [ { "type": "text", "text": "hello" } ] }
            })),
            LineRoute::Parent
        ));
    }

    #[test]
    fn finalize_tool_input_keeps_agent_id_across_the_reparse() {
        // Finding 5: the critical invariant — if __agentId is lost here, every
        // Agent dispatch's __agentId lookup misses, resolve_background never
        // runs, and the spawn ack silently completes the agent (the exact bug
        // this feature fixes), with all pre-existing tests still green.
        let input = json!({
            "__agentId": "a1",
            "__acc": "{\"run_in_background\":true}",
        });
        let finalized = finalize_tool_input(&input);
        assert_eq!(finalized["__agentId"], "a1");
        assert!(resolve_background(&finalized, "Agent"));

        // no __acc → input is returned unchanged (start-input-only tool calls)
        let no_acc = json!({ "description": "x" });
        assert_eq!(finalize_tool_input(&no_acc), no_acc);

        // unparsable __acc → left alone rather than losing the whole input
        let bad = json!({ "__agentId": "a1", "__acc": "{not json" });
        assert_eq!(finalize_tool_input(&bad), bad);
    }

    #[test]
    fn background_ladder_resolves_dispatch_kind() {
        // FR-2, in order: explicit false, explicit true, Agent default, Task default.
        assert!(!resolve_background(
            &json!({ "run_in_background": false }),
            "Agent"
        ));
        assert!(resolve_background(
            &json!({ "run_in_background": true }),
            "Task"
        ));
        assert!(resolve_background(&json!({ "description": "x" }), "Agent"));
        assert!(!resolve_background(&json!({ "description": "x" }), "Task"));
        // a non-bool value is not an explicit answer — fall through to the name
        assert!(resolve_background(
            &json!({ "run_in_background": "yes" }),
            "Agent"
        ));
    }

    #[test]
    fn synchronous_result_completes_agent() {
        // FR-4: the paired tool_result IS the completion for a sync dispatch.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", false);
        let ems = apply_dispatch_result(&mut s, "a1", "found 3 call sites\nmore", false, 7_000);
        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.status, "done");
        assert_eq!(a.ended_at, Some(7_000));
        assert_eq!(a.task, "found 3 call sites");
        assert_eq!(emitted_updates(&ems).len(), 1);
        assert!(emitted_steps(&ems).is_empty()); // no notice step for a sync completion
    }

    #[test]
    fn synchronous_error_result_marks_agent_error() {
        // FR-4: is_error → 'error' (new; today every tool_result produced 'done').
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", false);
        apply_dispatch_result(&mut s, "a1", "", true, 7_000);
        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.status, "error");
        assert_eq!(a.ended_at, Some(7_000));
        assert_eq!(a.task, "look around"); // empty excerpt leaves the task alone
    }

    #[test]
    fn background_result_is_spawn_ack_only() {
        // FR-5/FR-7: the ack must NOT stop the clock — this is the regression.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let ems = apply_dispatch_result(
            &mut s,
            "a1",
            "  Agent bg_7f3 started in the background  ",
            false,
            7_000,
        );
        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.status, "running");
        assert_eq!(a.ended_at, None);
        assert_eq!(a.task, "look around");
        assert_eq!(
            s.agent_backend_ref.get("a1").map(String::as_str),
            Some("Agent bg_7f3 started in the background")
        );
        let steps = emitted_steps(&ems);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].kind, "notice");
        assert_eq!(steps[0].label, "dispatched in background");
        assert_eq!(emitted_updates(&ems).len(), 1);
    }

    #[test]
    fn parent_tool_use_id_detects_attributed_lines() {
        // FR-8: non-null → attributed; null/absent → a parent-turn line.
        assert_eq!(
            parent_tool_use_id(&json!({ "type": "assistant", "parent_tool_use_id": "toolu_d" })),
            Some("toolu_d".to_string())
        );
        assert_eq!(
            parent_tool_use_id(&json!({ "type": "assistant", "parent_tool_use_id": null })),
            None
        );
        assert_eq!(parent_tool_use_id(&json!({ "type": "assistant" })), None);
    }

    #[test]
    fn attributed_assistant_line_becomes_steps() {
        // FR-9/FR-10: text + tool_use produce steps (thinking and blank text do not);
        // each append emits agent.step then agent.update, and moves lastActivity.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let line = json!({
            "type": "assistant",
            "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "   \n  " },
                { "type": "text", "text": "\nLooking at the engine.\nsecond line" },
                { "type": "tool_use", "id": "toolu_i1", "name": "Read",
                  "input": { "file_path": "/x/src/session.rs" } }
            ]}
        });
        let ems = apply_attributed_line(&mut s, "a1", &line, "/x", 5_000);
        let steps = emitted_steps(&ems);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].seq, 1);
        assert_eq!(steps[0].kind, "text");
        assert_eq!(steps[0].label, "Looking at the engine.");
        assert!(steps[0].tool.is_none());
        assert_eq!(steps[1].seq, 2);
        assert_eq!(steps[1].kind, "tool");
        assert_eq!(steps[1].tool.as_deref(), Some("Read"));
        assert_eq!(steps[1].label, "src/session.rs"); // same summary as a top-level tool.start
        assert!(steps[1].meta.is_none());
        assert_eq!(emitted_updates(&ems).len(), 2);

        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.step_count, 2);
        assert_eq!(a.last_activity.as_deref(), Some("src/session.rs"));
        assert_eq!(s.agent_steps.get("a1").unwrap().len(), 2);
        // the inner tool index is per-agent and keyed by the INNER tool_use_id
        assert!(s
            .agent_inner_tools
            .get("a1")
            .unwrap()
            .contains_key("toolu_i1"));
    }

    #[test]
    fn attributed_line_also_builds_the_agent_tab_transcript() {
        // agent-tab FR-1/FR-2/FR-3: the SAME line that produces steps produces
        // blocks — untruncated text, a tool card that streams until its result
        // fills the meta in place. This is the wiring the tab depends on, and it
        // is the one thing agent_transcript.rs's pure tests cannot see.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let body = "Looking at the engine.\nsecond line";
        let line = json!({
            "type": "assistant",
            "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "   \n  " },
                { "type": "text", "text": body },
                { "type": "tool_use", "id": "toolu_i1", "name": "Read",
                  "input": { "file_path": "/x/src/session.rs" } }
            ]}
        });
        let blocks = emitted_blocks(&apply_attributed_line(&mut s, "a1", &line, "/x", 5_000));
        assert_eq!(blocks.len(), 2); // thinking and blank text produce none
        assert_eq!(blocks[0]["kind"], "assistant");
        assert_eq!(blocks[0]["blockId"], "a1:1");
        assert_eq!(blocks[0]["text"], body); // NOT the step's 120-char first line
        assert_eq!(blocks[1]["kind"], "tool");
        assert_eq!(blocks[1]["blockId"], "a1:2");
        assert_eq!(blocks[1]["summary"], "src/session.rs");
        assert_eq!(blocks[1]["isStreaming"], true);

        let result = json!({
            "type": "user", "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_i1", "content": "a\nb\nc" }
            ]}
        });
        let filled = emitted_blocks(&apply_attributed_line(&mut s, "a1", &result, "/x", 5_100));
        assert_eq!(filled.len(), 1);
        assert_eq!(filled[0]["blockId"], "a1:2"); // filled in place, not appended
        assert_eq!(filled[0]["isStreaming"], false);
        assert!(filled[0]["meta"].is_string());
        assert_eq!(s.agent_blocks.get("a1").unwrap().len(), 2);
    }

    #[test]
    fn attributed_stream_event_is_dropped() {
        // FR-9: partial-message lines carry the same content as the assistant line;
        // consuming both would double every step. No event at all.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let line = json!({
            "type": "stream_event",
            "parent_tool_use_id": "toolu_d",
            "event": { "type": "content_block_delta", "index": 0,
                       "delta": { "type": "text_delta", "text": "hi" } }
        });
        let ems = apply_attributed_line(&mut s, "a1", &line, "/x", 5_000);
        assert!(ems.is_empty());
        assert_eq!(s.agents.get("a1").unwrap().step_count, 0);
    }

    #[test]
    fn inner_tool_result_fills_meta_in_place() {
        // FR-9/FR-10: same seq re-emitted with meta; no new step, stepCount unchanged.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let assistant = json!({
            "type": "assistant", "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "tool_use", "id": "toolu_i1", "name": "Read",
                  "input": { "file_path": "/x/src/session.rs" } },
                { "type": "tool_use", "id": "toolu_i2", "name": "Read",
                  "input": { "file_path": "/x/src/other.rs" } }
            ]}
        });
        apply_attributed_line(&mut s, "a1", &assistant, "/x", 5_000);
        let result = json!({
            "type": "user", "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_i1", "content": "a\nb\nc" }
            ]}
        });
        let ems = apply_attributed_line(&mut s, "a1", &result, "/x", 6_000);
        let steps = emitted_steps(&ems);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].seq, 1);
        assert_eq!(steps[0].meta.as_deref(), Some("3 lines")); // same meta as tool.done
        assert!(emitted_updates(&ems).is_empty()); // a meta fill is not an update
        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.step_count, 2);
        assert_eq!(s.agent_steps.get("a1").unwrap().len(), 2);

        // is_error wins over the derived meta (a fresh tool_use_id — Finding 2
        // already pruned toolu_i1's entry the moment its fill landed above)
        let errored = json!({
            "type": "user", "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_i2", "is_error": true, "content": "boom" }
            ]}
        });
        let ems = apply_attributed_line(&mut s, "a1", &errored, "/x", 6_100);
        assert_eq!(emitted_steps(&ems)[0].meta.as_deref(), Some("error"));

        // re-filling an already-filled (and now pruned, Finding 2) tool_use_id
        // is a no-op — a tool_use_id gets exactly one result in practice
        let refill = json!({
            "type": "user", "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_i1", "content": "late" }
            ]}
        });
        assert!(apply_attributed_line(&mut s, "a1", &refill, "/x", 6_150).is_empty());

        // an unknown inner tool_use_id is ignored
        let unknown = json!({
            "type": "user", "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_nope", "content": "x" }
            ]}
        });
        assert!(apply_attributed_line(&mut s, "a1", &unknown, "/x", 6_200).is_empty());
    }

    #[test]
    fn fill_step_meta_prunes_inner_tool_entry() {
        // Finding 2(a): a tool_use_id gets exactly one result — the entry is
        // dead once filled, so agent_inner_tools must not hold it forever.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let assistant = json!({
            "type": "assistant", "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "tool_use", "id": "toolu_i1", "name": "Read",
                  "input": { "file_path": "/x/src/session.rs" } }
            ]}
        });
        apply_attributed_line(&mut s, "a1", &assistant, "/x", 5_000);
        assert!(s
            .agent_inner_tools
            .get("a1")
            .unwrap()
            .contains_key("toolu_i1"));

        let result = json!({
            "type": "user", "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_i1", "content": "a\nb" }
            ]}
        });
        let ems = apply_attributed_line(&mut s, "a1", &result, "/x", 6_000);
        // observable behaviour is unchanged: same seq re-emitted, meta filled.
        let steps = emitted_steps(&ems);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].seq, 1);
        assert_eq!(steps[0].meta.as_deref(), Some("2 lines"));
        // but the now-dead entry is gone, so the index no longer grows unbounded.
        assert!(!s
            .agent_inner_tools
            .get("a1")
            .unwrap()
            .contains_key("toolu_i1"));
    }

    #[test]
    fn push_step_eviction_prunes_dead_inner_tools() {
        // Finding 2(b): once a step falls out of the 200-step window it can
        // never be filled again (the fill path already no-ops on it), so its
        // InnerTool entry must not outlive it either.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let first_tool = json!({
            "type": "assistant", "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "tool_use", "id": "toolu_i1", "name": "Read",
                  "input": { "file_path": "/x/src/session.rs" } }
            ]}
        });
        apply_attributed_line(&mut s, "a1", &first_tool, "/x", 5_000);
        assert!(s
            .agent_inner_tools
            .get("a1")
            .unwrap()
            .contains_key("toolu_i1"));

        // Push 200 more steps so the tool_use step (seq 1) falls out of the window.
        for i in 0..200 {
            let line = json!({
                "type": "assistant", "parent_tool_use_id": "toolu_d",
                "message": { "content": [ { "type": "text", "text": format!("step {i}") } ]}
            });
            apply_attributed_line(&mut s, "a1", &line, "/x", 5_000 + i as u64);
        }
        assert_eq!(s.agent_steps.get("a1").unwrap().front().unwrap().seq, 2);
        // seq 1's InnerTool entry is pruned along with the step it can no longer fill.
        assert!(!s
            .agent_inner_tools
            .get("a1")
            .unwrap()
            .contains_key("toolu_i1"));

        // No observable behaviour change: a late result for it is simply ignored,
        // exactly as the existing "unknown tool_use_id" FR-9 rule already does.
        let late_result = json!({
            "type": "user", "parent_tool_use_id": "toolu_d",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_i1", "content": "too late" }
            ]}
        });
        assert!(apply_attributed_line(&mut s, "a1", &late_result, "/x", 9_000).is_empty());
    }

    #[test]
    fn attributed_line_revives_finished_agent() {
        // FR-11: observed inner activity outranks an inferred completion.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        {
            let a = s.agents.get_mut("a1").unwrap();
            a.status = "done".into();
            a.ended_at = Some(7_000);
        }
        let line = json!({
            "type": "assistant", "parent_tool_use_id": "toolu_d",
            "message": { "content": [ { "type": "text", "text": "still going" } ]}
        });
        let ems = apply_attributed_line(&mut s, "a1", &line, "/x", 8_000);
        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.status, "running");
        assert_eq!(a.ended_at, None);
        // the revive update is emitted BEFORE the step
        assert!(matches!(ems[0], AgentEmission::Update { .. }));
        assert!(matches!(ems[1], AgentEmission::Step { .. }));
        assert_eq!(emitted_updates(&ems).len(), 2);
    }

    #[test]
    fn trail_windows_at_200_steps() {
        // FR-12 + §7: the trail is a WINDOW, stepCount is the true total.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        for i in 0..250 {
            let line = json!({
                "type": "assistant", "parent_tool_use_id": "toolu_d",
                "message": { "content": [ { "type": "text", "text": format!("step {i}") } ]}
            });
            apply_attributed_line(&mut s, "a1", &line, "/x", 5_000 + i as u64);
        }
        let trail = s.agent_steps.get("a1").unwrap();
        assert_eq!(trail.len(), AGENT_TRAIL_CAP);
        assert_eq!(trail.front().unwrap().seq, 51);
        assert_eq!(trail.back().unwrap().seq, 250);
        assert_eq!(s.agents.get("a1").unwrap().step_count, 250);
    }

    #[test]
    fn task_notification_line_is_detected() {
        // FR-13: a top-level `user` line whose TEXT content carries the marker.
        assert!(is_task_notification(&json!({
            "type": "user",
            "message": { "content": [
                { "type": "text", "text": "<system-reminder>Task-Notification: explorer finished</system-reminder>" }
            ]}
        })));
        assert!(is_task_notification(&json!({
            "type": "user",
            "message": { "content": "task-notification: agent bg_7f3 completed" }
        })));
        // a plain tool_result line is never a notice (it must reach the transcript)
        assert!(!is_task_notification(&json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": "task-notification" }
            ]}
        })));
        assert!(!is_task_notification(&json!({
            "type": "user",
            "message": { "content": [ { "type": "text", "text": "hello" } ]}
        })));
    }

    #[test]
    fn notice_resolves_by_backend_ref_then_name_then_single() {
        // FR-14 ladder.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_1", true);
        mint_agent(&mut s, "a2", "reviewer", "toolu_2", true);
        s.agent_backend_ref.insert("a1".into(), "bg_7f3".into());
        // 1: backendRef verbatim
        assert_eq!(
            resolve_notice_agent(&s, "task-notification: bg_7f3 is done"),
            Some("a1".to_string())
        );
        // 2: name
        assert_eq!(
            resolve_notice_agent(&s, "task-notification: reviewer has finished"),
            Some("a2".to_string())
        );
        // 3: exactly one running background agent
        s.agents.get_mut("a2").unwrap().status = "done".into();
        assert_eq!(
            resolve_notice_agent(&s, "task-notification: something completed"),
            Some("a1".to_string())
        );
        // a synchronous agent is never a notice target
        let mut sync = test_session();
        mint_agent(&mut sync, "b1", "worker", "toolu_1", false);
        assert_eq!(resolve_notice_agent(&sync, "task-notification"), None);
    }

    #[test]
    fn notice_with_two_running_background_agents_is_ignored() {
        // §7: no agent is ever attributed another's result.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_1", true);
        mint_agent(&mut s, "a2", "reviewer", "toolu_2", true);
        assert_eq!(resolve_notice_agent(&s, "task-notification: done"), None);
    }

    #[test]
    fn notice_closes_agent_and_marks_error_on_failure() {
        // FR-15.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_1", true);
        let ems = apply_notice(
            &mut s,
            "a1",
            "\n  explorer finished: 3 files reviewed\ntail",
            9_000,
        );
        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.status, "done");
        assert_eq!(a.ended_at, Some(9_000));
        assert_eq!(a.task, "explorer finished: 3 files reviewed");
        let steps = emitted_steps(&ems);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].kind, "notice");
        assert_eq!(steps[0].label, "explorer finished: 3 files reviewed");
        // agent.step FIRST, then its agent-tab notice block, then agent.update
        assert!(matches!(ems[0], AgentEmission::Step { .. }));
        assert!(matches!(ems[1], AgentEmission::Block { .. }));
        assert!(matches!(ems[2], AgentEmission::Update { .. }));

        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_1", true);
        apply_notice(&mut s, "a1", "the task failed: no such file", 9_000);
        assert_eq!(s.agents.get("a1").unwrap().status, "error");

        // word-boundary: only whole words fail/failed/failure/error match —
        // 'failover' and 'errors' do NOT (nor does 'terror'/'terrorized').
        assert!(notice_is_error("Error: boom"));
        assert!(notice_is_error("it FAILED"));
        assert!(notice_is_error("failure while running"));
        assert!(!notice_is_error("terrorized the codebase"));
        assert!(!notice_is_error("all good"));
    }

    #[test]
    fn notice_with_blank_text_still_emits_step_and_update() {
        // Finding 6: a blank notice must not close the agent silently — always
        // one step + its paired update, via the "completed" fallback label.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_1", true);
        let ems = apply_notice(&mut s, "a1", "   \n  \n", 9_000);
        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.status, "done");
        assert_eq!(a.ended_at, Some(9_000));
        assert_eq!(a.task, "look around"); // empty excerpt leaves task alone
        let steps = emitted_steps(&ems);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].label, "completed");
        assert_eq!(emitted_updates(&ems).len(), 1);
    }

    #[test]
    fn turn_end_finalizes_running_agents() {
        // FR-16: nothing is left `running` when the turn ends.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_1", true);
        mint_agent(&mut s, "a2", "reviewer", "toolu_2", false);
        s.agents.get_mut("a2").unwrap().status = "done".into();
        s.agents.get_mut("a2").unwrap().ended_at = Some(6_000);

        let ems = finalize_agents(&mut s, false, 9_000);
        let a1 = s.agents.get("a1").unwrap();
        assert_eq!(a1.status, "done");
        assert_eq!(a1.ended_at, Some(9_000));
        assert_eq!(a1.last_activity.as_deref(), Some("ended with the turn"));
        // the already-finished agent is untouched
        assert_eq!(s.agents.get("a2").unwrap().ended_at, Some(6_000));
        let steps = emitted_steps(&ems);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].kind, "notice");
        assert_eq!(steps[0].label, "ended with the turn");
        assert_eq!(emitted_updates(&ems).len(), 1);
        // idempotent: a second finalization finds nothing running
        assert!(finalize_agents(&mut s, false, 9_500).is_empty());
    }

    #[test]
    fn turn_end_error_finalizes_as_error() {
        // FR-16 + session-engine FR-40: errored turn → status 'error' AND endedAt.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_1", true);
        let ems = finalize_agents(&mut s, true, 9_000);
        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.status, "error");
        assert_eq!(a.ended_at, Some(9_000));
        assert_eq!(emitted_steps(&ems)[0].label, "ended with the turn");
    }

    #[test]
    fn kill_appends_notice_step() {
        // FR-18: kill is bookkeeping — status error, endedAt, and an honest notice.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_1", true);
        let ems = apply_kill(&mut s, "a1", 9_000);
        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.status, "error");
        assert_eq!(a.ended_at, Some(9_000));
        let steps = emitted_steps(&ems);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].label, "killed from the panel");
        assert_eq!(emitted_updates(&ems).len(), 1);
        assert!(apply_kill(&mut s, "nope", 9_000).is_empty());
    }

    #[test]
    fn activity_lookup_returns_trail_or_not_found() {
        // §5: agents_activity → the ordered trail; AGENT_NOT_FOUND otherwise.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let line = json!({
            "type": "assistant", "parent_tool_use_id": "toolu_d",
            "message": { "content": [ { "type": "text", "text": "one" }, { "type": "text", "text": "two" } ]}
        });
        apply_attributed_line(&mut s, "a1", &line, "/x", 5_000);
        let engine = test_engine_with(s);
        let map = engine.sessions.lock().unwrap();
        let trail = activity_of(&map, "a1").expect("known agent");
        assert_eq!(trail.len(), 2);
        assert_eq!(trail[0].seq, 1);
        assert_eq!(trail[1].label, "two");
        assert!(activity_of(&map, "unknown").is_none());
    }
}
