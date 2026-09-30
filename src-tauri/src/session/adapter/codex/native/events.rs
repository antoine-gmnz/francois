//! Projection only: vendor ids stay in these private maps; effects use local ids.
use super::super::{
    translate::Translator,
    wire::{todo_status, CodexEvent, Item, ItemKind, PatchChange, Todo},
};
use super::requests::{NativeDecision, PendingRequest, RequestKind, Resolution, ResolutionOutcome};
use crate::permissions::PermissionAsk;
use crate::session::application::{
    RequestKind as ApplicationRequestKind, RuntimeEvent, TurnContext,
};
use crate::session::control::QuestionOption;
use crate::session::SessionQuestion;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(super) fn asked(request: &PendingRequest, cwd: &str) -> RuntimeEvent {
    if let Some(input) = request.kind.questions() {
        return RuntimeEvent::QuestionAsked {
            block_id: request.block_id.clone(),
            blocking: Some(input.is_blocking),
            questions: input
                .questions
                .iter()
                .map(|question| SessionQuestion {
                    id: Some(question.id.clone()),
                    question: question.question.clone(),
                    header: question.header.clone(),
                    multi_select: false,
                    is_other: Some(question.is_other),
                    is_secret: Some(question.is_secret),
                    options: question
                        .options
                        .as_deref()
                        .unwrap_or_default()
                        .iter()
                        .map(|option| QuestionOption {
                            label: option.label.clone(),
                            description: option.description.clone(),
                            preview: None,
                            recommended: false,
                        })
                        .collect(),
                })
                .collect(),
        };
    }
    let (tool, summary, input, cwd) = match &request.kind {
        RequestKind::Command(command) => (
            "Bash".to_string(),
            command
                .command
                .clone()
                .or_else(|| command.reason.clone())
                .unwrap_or_else(|| "Codex command approval".into()),
            json!({"command":command.command,"reason":command.reason}),
            command.cwd.as_deref().unwrap_or(cwd),
        ),
        RequestKind::File(file) => (
            "Edit".to_string(),
            file.reason
                .clone()
                .unwrap_or_else(|| "Codex file change approval".into()),
            json!({"changes":request.file_changes(),"reason":file.reason,"grantRoot":file.grant_root}),
            cwd,
        ),
        RequestKind::Permissions(grant) => (
            "Permissions".to_string(),
            grant
                .reason
                .clone()
                .unwrap_or_else(|| "Codex requests additional permissions for this turn".into()),
            json!({"permissions":grant.permissions,"reason":grant.reason,"scope":"turn"}),
            grant.cwd.as_str(),
        ),
        RequestKind::ElicitationUrl(request) => (
            "MCP".to_string(),
            format!(
                "{}\nComplete the request at {} before allowing it.",
                request.message, request.url
            ),
            json!({"server":request.server,"url":request.url,"message":request.message}),
            cwd,
        ),
        RequestKind::Mcp(mcp) => (
            // Claude Code's own name for an MCP tool, so the card and any
            // rule matching read the same for either runtime.
            match &mcp.tool {
                Some(tool) => format!("mcp__{}__{tool}", mcp.server),
                None => format!("mcp__{}", mcp.server),
            },
            mcp.message.clone(),
            mcp.arguments.clone(),
            cwd,
        ),
        RequestKind::Questions(_) | RequestKind::Elicitation(_) => unreachable!(),
    };
    RuntimeEvent::PermissionAsked {
        block_id: request.block_id.clone(),
        ask: PermissionAsk {
            tool_name: tool,
            summary,
            input_json: input.to_string(),
            cwd: cwd.into(),
            pattern: String::new(),
            pattern_label: String::new(),
            allowed_decisions: Some(
                request
                    .allowed_decisions()
                    .into_iter()
                    .map(|decision| {
                        match decision {
                            NativeDecision::Accept => "allowOnce",
                            NativeDecision::Decline => "denyOnce",
                            NativeDecision::Cancel => "cancel",
                        }
                        .into()
                    })
                    .collect(),
            ),
        },
    }
}
pub(super) fn resolved(resolution: Resolution) -> RuntimeEvent {
    match resolution.outcome {
        ResolutionOutcome::Answers(answers) => RuntimeEvent::QuestionAnswered {
            block_id: resolution.block_id,
            answers: json!(answers),
        },
        ResolutionOutcome::Permission(decision) => RuntimeEvent::PermissionDecided {
            block_id: resolution.block_id,
            outcome: match decision {
                NativeDecision::Accept => "allowed",
                NativeDecision::Decline => "denied",
                NativeDecision::Cancel => "cancelled",
            }
            .into(),
            rule: None,
        },
        ResolutionOutcome::Cancelled => RuntimeEvent::RequestResolved {
            block_id: resolution.block_id,
            kind: if resolution.is_question {
                ApplicationRequestKind::Question
            } else {
                ApplicationRequestKind::Permission
            },
            outcome: "cancelled".into(),
        },
    }
}
pub(super) struct Items {
    translator: Translator<fn() -> String>,
    text_ids: HashMap<String, String>,
    completed: HashSet<String>,
    details: super::item_details::Details,
    progress: super::progress::Progress,
}
impl Default for Items {
    fn default() -> Self {
        Self {
            translator: Translator::new(crate::ids::uuid),
            text_ids: HashMap::new(),
            completed: HashSet::new(),
            details: super::item_details::Details::default(),
            progress: super::progress::Progress::default(),
        }
    }
}
impl Items {
    pub(super) fn delta(&mut self, item_id: &str, text: &str) -> Option<RuntimeEvent> {
        if item_id.is_empty() || self.completed.contains(item_id) {
            return None;
        }
        let block_id = self
            .text_ids
            .entry(item_id.into())
            .or_insert_with(crate::ids::uuid)
            .clone();
        Some(RuntimeEvent::AssistantDelta {
            block_id,
            text: text.into(),
        })
    }
    pub(super) fn item(
        &mut self,
        item: &Value,
        completed: bool,
        ctx: &TurnContext,
    ) -> Vec<RuntimeEvent> {
        let Some(id) = item["id"].as_str().filter(|id| !id.is_empty()) else {
            return vec![];
        };
        if self.completed.contains(id) {
            return vec![];
        }
        if completed {
            self.completed.insert(id.into());
        }
        let kind = match item["type"].as_str().unwrap_or_default() {
            "agentMessage" => {
                if !completed {
                    return vec![];
                }
                let block_id = self
                    .text_ids
                    .entry(id.into())
                    .or_insert_with(crate::ids::uuid)
                    .clone();
                return vec![RuntimeEvent::AssistantFinal {
                    block_id,
                    text: message_text(item),
                }];
            }
            "commandExecution" => ItemKind::CommandExecution {
                command: string(item, "command"),
                aggregated_output: item["aggregatedOutput"]
                    .as_str()
                    .or_else(|| self.progress.buffered(id))
                    .unwrap_or_default()
                    .into(),
                exit_code: item["exitCode"].as_i64(),
            },
            "fileChange" => ItemKind::FileChange {
                changes: item["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|change| {
                        Some(PatchChange {
                            path: change["path"].as_str()?.into(),
                            kind: string(&change["kind"], "type"),
                            move_path: change["kind"]["move_path"].as_str().map(String::from),
                            diff: string(change, "diff"),
                        })
                    })
                    .collect(),
                status: string(item, "status"),
            },
            "mcpToolCall" => ItemKind::McpToolCall {
                server: string(item, "server"),
                tool: string(item, "tool"),
                status: string(item, "status"),
                arguments: item["arguments"].clone(),
                result: item["result"].clone(),
                error: item["error"]["message"].as_str().map(String::from),
            },
            "webSearch" => ItemKind::WebSearch {
                query: string(item, "query"),
            },
            _ => return self.details.item(item, completed, ctx),
        };
        let item = Item {
            id: id.into(),
            kind,
        };
        self.translator.set_roots(roots(ctx));
        let event = if completed {
            CodexEvent::ItemCompleted { item }
        } else {
            CodexEvent::ItemStarted { item }
        };
        let mut events: Vec<_> = self
            .translator
            .on_event(event)
            .into_iter()
            .map(|effect| super::super::runner::normalize(&mut self.translator, effect, ctx))
            .collect();
        self.progress.observe(id, completed, &mut events);
        events
    }
    pub(super) fn progress(&mut self, params: &Value, append: bool) -> Option<RuntimeEvent> {
        self.progress.update(params, append)
    }
    /// `turn/plan/updated`: every update is a whole plan, so — like each of
    /// Claude's `TodoWrite` calls — it lands as one completed `TodoWrite` row.
    pub(super) fn plan(&mut self, params: &Value, ctx: &TurnContext) -> Vec<RuntimeEvent> {
        let todos = params["plan"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|step| Todo {
                content: string(step, "step"),
                status: todo_status(step["status"].as_str().unwrap_or_default()),
            })
            .collect();
        let item = Item {
            id: crate::ids::uuid(),
            kind: ItemKind::TodoList { todos },
        };
        self.translator
            .on_event(CodexEvent::ItemCompleted { item })
            .into_iter()
            .map(|effect| super::super::runner::normalize(&mut self.translator, effect, ctx))
            .collect()
    }
    pub(super) fn close(&mut self, ctx: &TurnContext) -> Vec<RuntimeEvent> {
        let mut events: Vec<_> = self
            .translator
            .close_open()
            .into_iter()
            .map(|effect| super::super::runner::normalize(&mut self.translator, effect, ctx))
            .collect();
        events.extend(self.details.close(ctx));
        self.progress.close(&mut events);
        events
    }
}
/// The session cwd in every spelling Codex may report a path in: the host
/// path, plus its Linux form when the session runs under WSL.
pub(super) fn roots(ctx: &TurnContext) -> Vec<String> {
    let mut roots = vec![ctx.cwd.clone()];
    if let Ok(canonical) = std::fs::canonicalize(&ctx.cwd) {
        let canonical = canonical.to_string_lossy().into_owned();
        if !roots.contains(&canonical) {
            roots.push(canonical);
        }
    }
    if let Some((_, linux)) = crate::wsl::wsl_unc_to_linux(&ctx.cwd) {
        roots.push(linux);
    }
    roots
}
fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().into()
}

fn message_text(item: &Value) -> String {
    let mut text = string(item, "text");
    // Asynchronous agent questions have no RPC request id: replies are normal
    // user turns. Preserve them in the message instead of inventing authority.
    for question in item["questions"].as_array().into_iter().flatten().take(32) {
        if let Some(title) = question["title"].as_str() {
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(title);
            for option in question["options"]
                .as_array()
                .into_iter()
                .flatten()
                .take(32)
                .filter_map(Value::as_str)
            {
                text.push_str("\n- ");
                text.push_str(option);
            }
        }
    }
    text
}
