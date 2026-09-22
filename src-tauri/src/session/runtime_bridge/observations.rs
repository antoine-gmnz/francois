//! Typed native observations projected through the existing session services.
use super::*;
use crate::session::agents::{apply_notice, resolve_notice_agent};
use crate::session::workflows::{apply_workflow_notice, mint_workflow, resolve_notice_workflow};

pub(super) fn apply(
    env: &dyn SessionEnv,
    id: &str,
    cwd: &str,
    event: RuntimeEvent,
) -> Result<(), AppError> {
    let engine = env.engine();
    match event {
        RuntimeEvent::StreamLive => mark_stream_live(env, id),
        RuntimeEvent::AssistantAppend { block_id, text } => {
            engine.with_session_mut(id, |s| s.buf_assistant_streaming(&block_id, &text, &text));
        }
        RuntimeEvent::AssistantChunk {
            block_id,
            text,
            offset,
        } => env.emit_session(SessionEvent::AssistantDelta {
            session_id: id.into(),
            block_id,
            text,
            offset,
        }),
        RuntimeEvent::ToolInputReady {
            block_id,
            tool,
            summary,
            is_task,
            model,
        } => {
            engine.with_session_mut(id, |s| {
                s.buf_tool(
                    &block_id,
                    tool.clone(),
                    summary.clone(),
                    is_task,
                    model.clone(),
                )
            });
            env.emit_session(SessionEvent::ToolStart {
                session_id: id.into(),
                block_id,
                tool,
                summary,
                model,
            });
        }
        RuntimeEvent::CommandOutput {
            block_id,
            command,
            card,
        } => finalize_command_block(env, id, &block_id, &command, &card),
        RuntimeEvent::McpObserved(server) => {
            engine.with_session_mut(id, |s| s.mcp.insert(server.name.clone(), server.clone()));
            env.emit_session(SessionEvent::McpUpdate {
                session_id: id.into(),
                server,
            });
        }
        RuntimeEvent::CommandsObserved(names) => {
            if engine
                .with_session_mut(id, |s| capture_cli_commands(s, names.clone()))
                .unwrap_or(false)
            {
                let commands = merge_commands(&help_entries(), &env.discover_commands(cwd), &names);
                env.emit_session(SessionEvent::Commands {
                    session_id: id.into(),
                    commands,
                });
            }
        }
        RuntimeEvent::SubagentStarted { tool_use_id, agent } => {
            engine.with_session_mut(id, |s| {
                s.agent_by_tool.insert(tool_use_id, agent.id.clone());
                s.insert_agent(agent.clone());
            });
            env.emit_session(SessionEvent::AgentUpdate { agent });
        }
        RuntimeEvent::SubagentInput {
            agent_id,
            background,
            name,
            task,
        } => {
            let emissions = engine
                .with_session_mut(id, |s| {
                    apply_dispatch_input(s, &agent_id, background, &name, &task)
                })
                .unwrap_or_default();
            emit_agent_emissions(env, id, emissions);
        }
        RuntimeEvent::SubagentResult {
            agent_id,
            text,
            is_error,
            at,
        } => {
            let emissions = engine
                .with_session_mut(id, |s| {
                    apply_dispatch_result(s, &agent_id, &text, is_error, at)
                })
                .unwrap_or_default();
            emit_agent_emissions(env, id, emissions);
        }
        RuntimeEvent::SubagentObserved {
            parent_tool_use_id,
            items,
            at,
        } => {
            let emissions = engine
                .with_session_mut(id, |s| {
                    let agent_id = s.agent_by_tool.get(&parent_tool_use_id)?.clone();
                    Some(observe_agent(s, &agent_id, items, cwd, at))
                })
                .flatten()
                .unwrap_or_default();
            emit_agent_emissions(env, id, emissions);
        }
        RuntimeEvent::WorkflowStarted {
            run_id,
            tool_use_id,
            at,
        } => {
            if let Some(run) =
                engine.with_session_mut(id, |s| mint_workflow(s, id, &run_id, &tool_use_id, at))
            {
                env.emit_session(SessionEvent::WorkflowUpdate { run });
            }
        }
        RuntimeEvent::WorkflowInput { run_id, input } => {
            on_workflow_input_complete(env, id, &run_id, &input)
        }
        RuntimeEvent::WorkflowResult {
            run_id,
            text,
            is_error,
        } => on_workflow_dispatch_result(env, id, &run_id, &text, is_error),
        RuntimeEvent::WorkflowAsk {
            block_id,
            kind,
            tool_name,
            parent_tool_use_id,
            agent_id,
        } => {
            super::super::workflow_watch::attribute_workflow_ask_fields(
                env,
                id,
                parent_tool_use_id.as_deref(),
                agent_id.as_deref(),
                &block_id,
                &kind,
                tool_name.as_deref(),
            );
        }
        RuntimeEvent::CompletionNotice { text } => {
            let (workflows, agents) = engine
                .with_session_mut(id, |s| {
                    if let Some(run) = resolve_notice_workflow(s, &text, false) {
                        return (
                            apply_workflow_notice(s, &run, &text, now_ms())
                                .into_iter()
                                .collect(),
                            vec![],
                        );
                    }
                    if let Some(agent) = resolve_notice_agent(s, &text) {
                        return (vec![], apply_notice(s, &agent, &text, now_ms()));
                    }
                    let workflows = resolve_notice_workflow(s, &text, true)
                        .and_then(|run| apply_workflow_notice(s, &run, &text, now_ms()))
                        .into_iter()
                        .collect();
                    (workflows, vec![])
                })
                .unwrap_or_default();
            emit_workflow_updates(env, workflows);
            emit_agent_emissions(env, id, agents);
        }
        _ => {
            return Err(AppError::new(
                ErrorCode::RuntimeProtocolError,
                "Unsupported normalized runtime effect.",
            ))
        }
    }
    Ok(())
}

fn observe_agent(
    s: &mut Session,
    agent_id: &str,
    items: Vec<SubagentObservation>,
    cwd: &str,
    at: u64,
) -> Vec<AgentEmission> {
    if !s.agents.contains_key(agent_id) {
        return vec![];
    }
    let mut out = super::super::agents::revive_agent(s, agent_id);
    for item in items {
        match item {
            SubagentObservation::Text(text) => {
                let label = first_nonblank_line(&text, 120);
                out.extend(super::super::agents::push_step(
                    s, agent_id, "text", None, &label, at,
                ));
                if let Some(block) = push_agent_text(s, agent_id, &text) {
                    out.push(block.emission);
                }
            }
            SubagentObservation::ToolUse { id, name, input } => {
                let summary = tool_summary(&name, &input, cwd);
                let label = if summary.is_empty() {
                    name.clone()
                } else {
                    summary
                };
                let emissions = super::super::agents::push_step(
                    s,
                    agent_id,
                    "tool",
                    Some(name.clone()),
                    &label,
                    at,
                );
                let seq = emissions.iter().find_map(|event| match event {
                    AgentEmission::Step { step, .. } => Some(step.seq),
                    _ => None,
                });
                out.extend(emissions);
                let block_id = if let Some(block) =
                    push_agent_tool(s, agent_id, &name, &label, dispatch_model(&input))
                {
                    out.push(block.emission);
                    block.block_id
                } else {
                    String::new()
                };
                if let (Some(seq), Some(id)) = (seq, id) {
                    s.agent_inner_tools
                        .entry(agent_id.into())
                        .or_default()
                        .insert(
                            id,
                            InnerTool {
                                seq,
                                tool: name,
                                input,
                                block_id,
                            },
                        );
                }
            }
            SubagentObservation::ToolResult {
                tool_use_id,
                text,
                is_error,
            } => {
                let Some(inner) = s
                    .agent_inner_tools
                    .get(agent_id)
                    .and_then(|tools| tools.get(&tool_use_id))
                    .cloned()
                else {
                    continue;
                };
                let meta = if is_error {
                    "error".into()
                } else {
                    tool_meta(&inner.tool, &inner.input, &text)
                };
                if !inner.block_id.is_empty() {
                    out.extend(fill_agent_block_meta(s, agent_id, &inner.block_id, &meta));
                }
                out.extend(super::super::agents::fill_step_meta(
                    s,
                    agent_id,
                    &tool_use_id,
                    inner.seq,
                    meta,
                ));
            }
        }
    }
    out
}
