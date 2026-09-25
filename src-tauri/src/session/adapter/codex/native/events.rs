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
    if let RequestKind::Questions(input) = &request.kind {
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
            "Bash",
            command
                .command
                .clone()
                .or_else(|| command.reason.clone())
                .unwrap_or_else(|| "Codex command approval".into()),
            json!({"command":command.command,"reason":command.reason}),
            command.cwd.as_deref().unwrap_or(cwd),
        ),
        RequestKind::File(file) => (
            "Edit",
            file.reason
                .clone()
                .unwrap_or_else(|| "Codex file change approval".into()),
            json!({"changes":request.file_changes(),"reason":file.reason,"grantRoot":file.grant_root}),
            cwd,
        ),
        RequestKind::Questions(_) => unreachable!(),
    };
    RuntimeEvent::PermissionAsked {
        block_id: request.block_id.clone(),
        ask: PermissionAsk {
            tool_name: tool.into(),
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
}
impl Default for Items {
    fn default() -> Self {
        Self {
            translator: Translator::new(crate::ids::uuid),
            text_ids: HashMap::new(),
            completed: HashSet::new(),
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
                    text: string(item, "text"),
                }];
            }
            "commandExecution" => ItemKind::CommandExecution {
                command: string(item, "command"),
                aggregated_output: string(item, "aggregatedOutput"),
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
            _ => return vec![],
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
        self.translator
            .on_event(event)
            .into_iter()
            .map(|effect| super::super::runner::normalize(&mut self.translator, effect, ctx))
            .collect()
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
        self.translator
            .close_open()
            .into_iter()
            .map(|effect| super::super::runner::normalize(&mut self.translator, effect, ctx))
            .collect()
    }
}
/// The session cwd in every spelling Codex may report a path in: the host
/// path, plus its Linux form when the session runs under WSL.
pub(super) fn roots(ctx: &TurnContext) -> Vec<String> {
    let mut roots = vec![ctx.cwd.clone()];
    if let Some((_, linux)) = crate::wsl::wsl_unc_to_linux(&ctx.cwd) {
        roots.push(linux);
    }
    roots
}
fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().into()
}
