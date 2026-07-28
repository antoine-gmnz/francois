//! the per-turn NDJSON reader and its stream-event handlers.

use super::*;

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// Per-turn state while parsing the NDJSON stream.
pub(crate) struct ToolRec {
    block_id: String,
    tool: String,
    input: Value,
    is_task: bool,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_reader(
    app: AppHandle,
    session_id: String,
    child: Arc<Mutex<Child>>,
    interrupted: Arc<AtomicBool>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    model_id: String,
    resume_used: bool,
    block_id: String,
    text: String,
) {
    // Take stdout out of the shared child so we can read without holding its lock.
    let stdout = { child.lock().unwrap().stdout.take() };
    let Some(stdout) = stdout else {
        finish_turn(&app, &session_id, false, None);
        return;
    };
    let reader = BufReader::new(stdout);

    // index -> (blockId, kind, input_accum)   kind: 0=text 1=tool
    let mut blocks: HashMap<u64, (String, u8, String)> = HashMap::new();
    let mut tools: HashMap<String, ToolRec> = HashMap::new(); // tool_use_id -> rec
    let mut text_accum: HashMap<String, String> = HashMap::new(); // blockId -> text
    let mut open_block: Option<(String, u8)> = None;
    let mut ctx_usage = ContextTracker::default();
    let mut got_result = false;
    let mut got_init = false; // did the stream start (system/init)? — resume-fail detection (FR-8)
    let mut result_error: Option<String> = None;
    // interactive-commands: the turn's parsed command token (FR-17), whether a
    // synthetic message was carded (FR-16), and the result string (FR-18 fallback).
    let turn_cmd: Option<String> = parse_command(&text).map(|(c, _)| c);
    let mut saw_synthetic = false;
    let mut result_text: Option<String> = None;

    let cwd = {
        let engine = app.state::<Engine>();
        let map = engine.sessions.lock().unwrap();
        map.get(&session_id)
            .map(|s| s.cwd.clone())
            .unwrap_or_default()
    };

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // async-agents FR-8/FR-9: a line carrying a non-null parent_tool_use_id on
        // an assistant/user/stream_event type belongs to a subagent. It is
        // attributed to that agent and NEVER passed to the parent-turn handlers,
        // so the SESSION transcript stays a record of the parent turn only. An
        // unknown correlation key is ignored entirely. Any other type (e.g. a
        // control_request) is never diverted, even if it carries a stray
        // parent_tool_use_id — it must still reach its normal handler.
        match route_line(&v) {
            LineRoute::Attributed(ptuid) => {
                attribute_inner_line(&app, &session_id, &ptuid, &v, &cwd);
                continue;
            }
            LineRoute::Notice => {
                // async-agents FR-13: a harness-injected task-notification closes
                // its background agent and never reaches the transcript.
                if handle_task_notification(&app, &session_id, &v) {
                    continue;
                }
            }
            LineRoute::Parent => {}
        }
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "system" => {
                if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                    got_init = true;
                    if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                        {
                            let engine = app.state::<Engine>();
                            let mut map = engine.sessions.lock().unwrap();
                            if let Some(s) = map.get_mut(&session_id) {
                                s.claude_session_id = Some(sid.to_string());
                            }
                        }
                        // persist the (possibly new) thread id so --resume survives a restart (FR-7)
                        let engine = app.state::<Engine>();
                        persist(&app, &engine);
                    }
                    emit_mcp_from_init(&app, &session_id, &v);
                    // slash-menu FR-2: capture the CLI's own slash_commands; on a
                    // CHANGE emit one session.commands carrying the merged
                    // registry. Absent array → no change, identical set → silent.
                    if let Some(names) = parse_init_slash_commands(&v) {
                        let changed = {
                            let engine = app.state::<Engine>();
                            let mut map = engine.sessions.lock().unwrap();
                            map.get_mut(&session_id)
                                .is_some_and(|s| capture_cli_commands(s, names.clone()))
                        };
                        if changed {
                            // Engine.sessions dropped — the skills disk scan must
                            // never run under it (lock rules).
                            let commands =
                                merge_commands(&help_entries(), &discover_skills(&cwd), &names);
                            emit(
                                &app,
                                SessionEvent::Commands {
                                    session_id: session_id.clone(),
                                    commands,
                                },
                            );
                        }
                    }
                }
            }
            "stream_event" => {
                if let Some(ev) = v.get("event") {
                    handle_stream_event(
                        &app,
                        &session_id,
                        &cwd,
                        ev,
                        &mut blocks,
                        &mut tools,
                        &mut text_accum,
                        &mut open_block,
                        &mut ctx_usage,
                    );
                }
            }
            "user" => {
                handle_tool_results(&app, &session_id, &v, &mut tools, &mut open_block);
            }
            "assistant" => {
                // interactive-commands FR-16: a synthetic (CLI-local) assistant message
                // becomes its own command card — no assistant.delta/done for it. Real
                // top-level assistant echoes stay ignored (stream_events carry them).
                if let Some(answer) = synthetic_text(&v) {
                    saw_synthetic = true;
                    let card = classify_local_answer(turn_cmd.as_deref(), &answer);
                    finalize_command_block(
                        &app,
                        &session_id,
                        &uuid(),
                        turn_cmd.as_deref().unwrap_or(""),
                        &card,
                    );
                }
            }
            "result" => {
                got_result = true;
                if v.get("is_error").and_then(|b| b.as_bool()) == Some(true)
                    || v.get("subtype")
                        .and_then(|s| s.as_str())
                        .map(|s| s != "success")
                        .unwrap_or(false)
                {
                    result_error = Some(
                        v.get("result")
                            .and_then(|r| r.as_str())
                            .unwrap_or("the turn ended with an error")
                            .to_string(),
                    );
                }
                if let Some(r) = v.get("result").and_then(|r| r.as_str()) {
                    result_text = Some(r.to_string()); // interactive-commands FR-18
                }
                if let Some(u) = v.get("usage") {
                    ctx_usage.observe_result(u);
                }
                // session-questions FR-2: the result ends the turn — dropping the
                // stdin writer is what lets the CLI exit (stream-json input mode
                // waits for EOF otherwise). No question can be pending past its
                // result: a parked request blocks it.
                *stdin.lock().unwrap() = None;
            }
            "control_request" => {
                // session-questions FR-6..FR-9 + permission-guardrails FR-1/FR-2.
                handle_control_request(
                    &app,
                    &session_id,
                    &v,
                    &stdin,
                    &pending_questions,
                    &pending_permissions,
                );
            }
            "control_cancel_request" => {
                // session-questions FR-10 / permission-guardrails FR-10: the CLI
                // withdrew a parked request. Unmatched ids are ignored.
                if let Some(rid) = v.get("request_id").and_then(|r| r.as_str()) {
                    let claimed = {
                        let mut p = pending_questions.lock().unwrap();
                        let key = p
                            .iter()
                            .find(|(_, q)| q.request_id == rid)
                            .map(|(k, _)| k.clone());
                        key.and_then(|k| p.remove(&k).map(|q| (k, q)))
                    };
                    if let Some((bid, q)) = claimed {
                        // FR-13: best-effort deny for the (live) child, then cancel.
                        let _ = write_control_line(
                            &stdin,
                            &deny_response(&q.request_id, "question cancelled"),
                        );
                        resolve_question(&app, &session_id, &bid, "cancelled", None);
                    }
                    let claimed_perm = {
                        let mut p = pending_permissions.lock().unwrap();
                        let key = p
                            .iter()
                            .find(|(_, q)| q.request_id == rid)
                            .map(|(k, _)| k.clone());
                        key.and_then(|k| p.remove(&k).map(|q| (k, q)))
                    };
                    if let Some((bid, q)) = claimed_perm {
                        let _ = write_control_line(
                            &stdin,
                            &deny_response(&q.request_id, "request cancelled"),
                        );
                        resolve_permission(&app, &session_id, &bid, "cancelled", None);
                    }
                }
            }
            _ => {} // keep_alive & any unrecognized top-level type stay ignored (FR-4)
        }
    }

    // session-questions FR-2: stdout is gone (result, child death, or interrupt) —
    // drop the stdin writer before wait() so the CLI can never linger on an open pipe.
    *stdin.lock().unwrap() = None;
    let _ = child.lock().unwrap().wait();
    let was_interrupted = interrupted.load(Ordering::SeqCst);

    // session-questions FR-13: any question still parked when the turn dies resolves
    // as cancelled, exactly once — this drain is the claim; kill_all's own drain and
    // an in-flight answer can never double-resolve. No control_response: child is gone.
    let orphaned: Vec<String> = {
        let mut p = pending_questions.lock().unwrap();
        p.drain().map(|(k, _)| k).collect()
    };
    for bid in orphaned {
        resolve_question(&app, &session_id, &bid, "cancelled", None);
    }
    // permission-guardrails FR-10: identical drain for parked approval cards —
    // an ask never outlives the turn it parked, and the claim is exactly-once.
    let orphaned_perms: Vec<String> = {
        let mut p = pending_permissions.lock().unwrap();
        p.drain().map(|(k, _)| k).collect()
    };
    for bid in orphaned_perms {
        resolve_permission(&app, &session_id, &bid, "cancelled", None);
    }

    // Resume-fail (FR-8/9): Claude rejected the stale --resume id before starting a
    // thread. Tell the UI and transparently re-run the same message on a fresh thread
    // (ResumeRetry forces resume off → this can fire at most once). The stored id is
    // left in place — a fresh init overwrites it on success; a transient failure keeps it.
    if is_resume_fail(resume_used, got_init, got_result, was_interrupted) {
        emit(
            &app,
            SessionEvent::ResumeFailed {
                session_id: session_id.clone(),
            },
        );
        begin_turn(
            &app,
            &session_id,
            block_id,
            text,
            None,
            TurnMode::ResumeRetry,
        );
        return;
    }

    // Close any block left open (interrupt or crash) — FR-24/FR-34.
    if let Some((bid, kind)) = open_block.take() {
        if kind == 0 {
            emit(
                &app,
                SessionEvent::AssistantDone {
                    session_id: session_id.clone(),
                    block_id: bid,
                },
            );
        } else {
            emit(
                &app,
                SessionEvent::ToolDone {
                    session_id: session_id.clone(),
                    block_id: bid,
                    meta: "interrupted".into(),
                },
            );
        }
    }

    let limit = context_limit(&model_id);
    let pending_used = ctx_usage.finish(limit);
    if got_result && result_error.is_none() {
        // interactive-commands FR-18 defensive fallback: a success turn with zero
        // assistant/tool blocks and no synthetic seen put its local answer only in
        // the result string — card it so no slash command ever dies silently.
        if command_fallback_fires(
            true,
            saw_synthetic,
            !blocks.is_empty(),
            result_text.as_deref(),
        ) {
            let answer = result_text.clone().unwrap_or_default();
            let card = classify_local_answer(turn_cmd.as_deref(), &answer);
            finalize_command_block(
                &app,
                &session_id,
                &uuid(),
                turn_cmd.as_deref().unwrap_or(""),
                &card,
            );
        }
        if let Some(u) = pending_used {
            update_used(&app, &session_id, u);
            emit(
                &app,
                SessionEvent::ContextUsage {
                    session_id: session_id.clone(),
                    used_tokens: u,
                    limit_tokens: limit,
                },
            );
        }
        finish_turn(&app, &session_id, false, None);
    } else if was_interrupted {
        if let Some(u) = pending_used {
            update_used(&app, &session_id, u);
            emit(
                &app,
                SessionEvent::ContextUsage {
                    session_id: session_id.clone(),
                    used_tokens: u,
                    limit_tokens: limit,
                },
            );
        }
        finish_turn(&app, &session_id, false, None);
    } else {
        let msg = result_error
            .unwrap_or_else(|| "the Claude Code process ended unexpectedly".to_string());
        finish_turn(&app, &session_id, true, Some(msg));
    }
}

pub(crate) fn emit_mcp_from_init(app: &AppHandle, session_id: &str, init: &Value) {
    let tools: Vec<String> = init
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let Some(servers) = init.get("mcp_servers").and_then(|s| s.as_array()) else {
        return;
    };
    for srv in servers {
        let name = srv
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let raw_status = srv
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("connected");
        let status = match raw_status {
            "connected" | "ready" => "connected",
            "failed" | "error" => "error",
            _ => "connecting",
        };
        let prefix = format!("mcp__{name}__");
        let count = tools.iter().filter(|t| t.starts_with(&prefix)).count() as u32;
        let info = McpServerInfo {
            name: name.clone(),
            status: status.into(),
            tool_count: if status == "connected" {
                Some(count)
            } else {
                None
            },
            error_message: if status == "error" {
                Some(
                    srv.get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("connection failed")
                        .to_string(),
                )
            } else {
                None
            },
            scope: None,
        };
        {
            let engine = app.state::<Engine>();
            let mut map = engine.sessions.lock().unwrap();
            if let Some(s) = map.get_mut(session_id) {
                s.mcp.insert(name.clone(), info.clone());
            }
        }
        emit(
            app,
            SessionEvent::McpUpdate {
                session_id: session_id.into(),
                server: info,
            },
        );
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_stream_event(
    app: &AppHandle,
    session_id: &str,
    cwd: &str,
    ev: &Value,
    blocks: &mut HashMap<u64, (String, u8, String)>,
    tools: &mut HashMap<String, ToolRec>,
    text_accum: &mut HashMap<String, String>,
    open_block: &mut Option<(String, u8)>,
    ctx_usage: &mut ContextTracker,
) {
    ctx_usage.observe_stream_event(ev);
    let et = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match et {
        "content_block_start" => {
            let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            let cb = ev.get("content_block").cloned().unwrap_or(Value::Null);
            let cbt = cb.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match cbt {
                "text" => {
                    let bid = uuid();
                    blocks.insert(idx, (bid.clone(), 0, String::new()));
                    text_accum.insert(bid, String::new());
                }
                "tool_use" => {
                    let bid = uuid();
                    let tool = cb
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tuid = cb
                        .get("id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("")
                        .to_string();
                    let start_input = cb
                        .get("input")
                        .cloned()
                        .unwrap_or(Value::Object(Default::default()));
                    blocks.insert(idx, (bid.clone(), 1, String::new()));
                    let is_task = is_subagent_tool(&tool);
                    tools.insert(
                        tuid.clone(),
                        ToolRec {
                            block_id: bid.clone(),
                            tool: tool.clone(),
                            input: start_input,
                            is_task,
                        },
                    );
                    // stash tuid in the block accum slot's kind — track via separate map:
                    blocks.get_mut(&idx).map(|b| b.2 = tuid.clone());
                    if is_task {
                        // Mint a subagent record (FR-37).
                        let agent_id = uuid();
                        let desc = tools
                            .get(&tuid)
                            .map(|r| {
                                r.input
                                    .get("description")
                                    .and_then(|d| d.as_str())
                                    .unwrap_or("subagent")
                                    .to_string()
                            })
                            .unwrap_or_else(|| "subagent".into());
                        let name = tools
                            .get(&tuid)
                            .and_then(|r| {
                                r.input
                                    .get("subagent_type")
                                    .and_then(|d| d.as_str())
                                    .map(String::from)
                            })
                            .unwrap_or_else(|| desc.clone());
                        let agent = AgentInfo {
                            id: agent_id.clone(),
                            session_id: session_id.into(),
                            name,
                            task: desc,
                            status: "running".into(),
                            started_at: now_ms(), // async-agents FR-7: never changes
                            ended_at: None,
                            // async-agents FR-3: conservative until content_block_stop
                            // resolves the FR-2 ladder over the complete input JSON.
                            background: false,
                            last_activity: None,
                            step_count: 0,
                        };
                        {
                            let engine = app.state::<Engine>();
                            let mut map = engine.sessions.lock().unwrap();
                            if let Some(s) = map.get_mut(session_id) {
                                s.insert_agent(agent.clone());
                                // async-agents FR-1: the correlation key. Session-scoped
                                // (not turn-local) so FR-13/FR-16 reach it after the
                                // tool call closed.
                                s.agent_by_tool.insert(tuid.clone(), agent_id.clone());
                            }
                        }
                        // record agent_id against the tool for completion
                        if let Some(rec) = tools.get_mut(&tuid) {
                            rec.input["__agentId"] = Value::String(agent_id.clone());
                        }
                        emit(app, SessionEvent::AgentUpdate { agent });
                    }
                }
                _ => {} // thinking etc. — ignored
            }
        }
        "content_block_delta" => {
            let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            let delta = ev.get("delta").cloned().unwrap_or(Value::Null);
            let dt = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match dt {
                "text_delta" => {
                    if let Some((bid, kind, _)) = blocks.get(&idx).cloned() {
                        if kind == 0 {
                            let text = delta
                                .get("text")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string();
                            text_accum.entry(bid.clone()).or_default().push_str(&text);
                            *open_block = Some((bid.clone(), 0));
                            emit(
                                app,
                                SessionEvent::AssistantDelta {
                                    session_id: session_id.into(),
                                    block_id: bid,
                                    text,
                                },
                            );
                        }
                    }
                }
                "input_json_delta" => {
                    if let Some(b) = blocks.get_mut(&idx) {
                        // b.2 currently holds the tool_use_id; accumulate partial json into the ToolRec instead.
                        let tuid = b.2.clone();
                        let partial = delta
                            .get("partial_json")
                            .and_then(|t| t.as_str())
                            .unwrap_or("");
                        if let Some(rec) = tools.get_mut(&tuid) {
                            let acc = rec
                                .input
                                .get("__acc")
                                .and_then(|a| a.as_str())
                                .unwrap_or("")
                                .to_string();
                            rec.input["__acc"] = Value::String(acc + partial);
                        }
                    }
                }
                _ => {} // thinking_delta / signature_delta — ignored
            }
        }
        "content_block_stop" => {
            let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            if let Some((bid, kind, slot)) = blocks.get(&idx).cloned() {
                if kind == 0 {
                    let text = text_accum.get(&bid).cloned().unwrap_or_default();
                    let block = {
                        let engine = app.state::<Engine>();
                        let mut map = engine.sessions.lock().unwrap();
                        match map.get_mut(session_id) {
                            Some(s) => {
                                s.buf_assistant(&bid, text);
                                s.block_buffer.last().cloned()
                            }
                            None => None,
                        }
                    };
                    if let Some(b) = &block {
                        append_transcript(app, session_id, b); // durable-sessions FR-2
                    }
                    *open_block = None;
                    emit(
                        app,
                        SessionEvent::AssistantDone {
                            session_id: session_id.into(),
                            block_id: bid,
                        },
                    );
                } else {
                    // tool: finalize input (accumulated json overrides start input), derive summary, emit tool.start
                    let tuid = slot;
                    if let Some(rec) = tools.get_mut(&tuid) {
                        // async-agents FR-2: the accumulated __acc json becomes the
                        // real input; __agentId survives the reparse (Finding 5).
                        rec.input = finalize_tool_input(&rec.input);
                        let summary = tool_summary(&rec.tool, &rec.input, cwd);
                        // async-agents FR-2: the input JSON is complete now — resolve
                        // the dispatch kind and tell the panel.
                        let bg = if rec.is_task {
                            rec.input
                                .get("__agentId")
                                .and_then(|a| a.as_str())
                                .map(|aid| {
                                    (aid.to_string(), resolve_background(&rec.input, &rec.tool))
                                })
                        } else {
                            None
                        };
                        let bg_ems = {
                            let engine = app.state::<Engine>();
                            let mut map = engine.sessions.lock().unwrap();
                            let mut ems = Vec::new();
                            if let Some(s) = map.get_mut(session_id) {
                                s.buf_tool(&bid, rec.tool.clone(), summary.clone(), rec.is_task);
                                if let Some((aid, background)) = &bg {
                                    ems = apply_background(s, aid, *background);
                                }
                            }
                            ems
                        };
                        emit_agent_emissions(app, session_id, bg_ems);
                        *open_block = Some((bid.clone(), 1));
                        emit(
                            app,
                            SessionEvent::ToolStart {
                                session_id: session_id.into(),
                                block_id: bid,
                                tool: rec.tool.clone(),
                                summary,
                            },
                        );
                    }
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn handle_tool_results(
    app: &AppHandle,
    session_id: &str,
    v: &Value,
    tools: &mut HashMap<String, ToolRec>,
    open_block: &mut Option<(String, u8)>,
) {
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array());
    let Some(content) = content else { return };
    for item in content {
        if item.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let tuid = item
            .get("tool_use_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let is_error = item
            .get("is_error")
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        let result_text = extract_result_text(item.get("content"));
        let Some(rec) = tools.get(&tuid) else {
            continue;
        };
        let block_id = rec.block_id.clone();
        let meta = if is_error {
            "error".to_string()
        } else {
            tool_meta(&rec.tool, &rec.input, &result_text)
        };

        // The dispatch's own tool_result. async-agents FR-4/FR-5: a SYNCHRONOUS
        // dispatch completes here; a BACKGROUND dispatch's result is only a spawn
        // acknowledgement and must not stop the agent's clock (session-engine FR-39
        // is superseded — it treated every ack as completion).
        if rec.is_task {
            if let Some(aid) = rec.input.get("__agentId").and_then(|a| a.as_str()) {
                let ems = {
                    let engine = app.state::<Engine>();
                    let mut map = engine.sessions.lock().unwrap();
                    match map.get_mut(session_id) {
                        Some(s) => apply_dispatch_result(s, aid, &result_text, is_error, now_ms()),
                        None => Vec::new(),
                    }
                };
                emit_agent_emissions(app, session_id, ems);
            }
        }

        let done_block = {
            let engine = app.state::<Engine>();
            let mut map = engine.sessions.lock().unwrap();
            match map.get_mut(session_id) {
                Some(s) => {
                    s.buf_tool_done(&block_id, meta.clone());
                    s.block_buffer
                        .iter()
                        .find(|b| b.block_id == block_id)
                        .cloned()
                }
                None => None,
            }
        };
        if let Some(b) = &done_block {
            append_transcript(app, session_id, b); // durable-sessions FR-2
        }
        if matches!(open_block, Some((b, _)) if *b == block_id) {
            *open_block = None;
        }
        // FR-16: a file-mutating tool finished → recompute the diff summary now.
        if rec.tool == "Edit" || rec.tool == "Write" {
            if let Some(cwd) = app.state::<Engine>().cwd_of(session_id) {
                crate::diff::on_tool_done(app, session_id, &cwd);
            }
        }
        emit(
            app,
            SessionEvent::ToolDone {
                session_id: session_id.into(),
                block_id,
                meta,
            },
        );
    }
}

pub(crate) fn extract_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {

    use crate::session::testutil::*;
    use serde_json::json;

    #[test]
    fn command_output_without_started_inserts_block() {
        // the FR-11/FR-13 instant-notice cases arrive without a command.started
        let mut s = test_session();
        s.buf_command_output(
            "c9",
            "model",
            json!({ "kind": "notice", "text": "model \u{2192} Opus" }),
        );
        assert_eq!(s.block_buffer.len(), 1);
        assert!(!s.block_buffer[0].streaming);
        assert_eq!(s.block_buffer[0].tool, "model");
    }
}
