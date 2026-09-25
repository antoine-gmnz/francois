//! Adapter-private request authority; no native response is inferred from history.
use super::protocol::{response, RequestId};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct NativeScope {
    pub session_id: String,
    pub generation: u64,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RequestError {
    StaleScope,
    Replay,
    InvalidParams,
    UnsupportedMethod,
    UnsupportedDecision,
    InvalidAnswer,
    NotPending,
    AlreadyClaimed,
    RequestLimit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NativeDecision {
    Accept,
    Decline,
    Cancel,
}
impl NativeDecision {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
        }
    }
    fn parse(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "accept" => Some(Self::Accept),
            "decline" => Some(Self::Decline),
            "cancel" => Some(Self::Cancel),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RequestContext {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
}
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommandApproval {
    #[serde(default)]
    pub kind: CommandApprovalKind,
    #[serde(flatten)]
    pub context: RequestContext,
    pub approval_id: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub reason: Option<String>,
    pub available_decisions: Option<Vec<Value>>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum CommandApprovalKind {
    #[default]
    Command,
    WriteStdin,
}
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileApproval {
    #[serde(flatten)]
    pub context: RequestContext,
    pub reason: Option<String>,
    pub grant_root: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(super) struct QuestionOption {
    pub label: String,
    pub description: String,
}
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Question {
    pub id: String,
    pub header: String,
    pub question: String,
    // Schema defaults (0.155.1): absent flags are false, absent options null.
    #[serde(default)]
    pub is_other: bool,
    #[serde(default)]
    pub is_secret: bool,
    #[serde(default)]
    pub options: Option<Vec<QuestionOption>>,
}
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserInput {
    #[serde(flatten)]
    pub context: RequestContext,
    pub questions: Vec<Question>,
    pub is_blocking: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub(super) enum RequestKind {
    Command(CommandApproval),
    File(FileApproval),
    Questions(UserInput),
}
impl RequestKind {
    fn context(&self) -> &RequestContext {
        match self {
            Self::Command(r) => &r.context,
            Self::File(r) => &r.context,
            Self::Questions(r) => &r.context,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct PendingRequest {
    pub block_id: String,
    pub kind: RequestKind,
    file_changes: Option<Vec<Value>>,
}
impl PendingRequest {
    pub(super) fn is_blocking(&self) -> bool {
        match &self.kind {
            RequestKind::Questions(request) => request.is_blocking,
            _ => true,
        }
    }
    pub(super) fn allowed_decisions(&self) -> Vec<NativeDecision> {
        match &self.kind {
            RequestKind::Command(request) => match &request.available_decisions {
                Some(decisions) => {
                    let mut result = Vec::new();
                    for decision in decisions.iter().filter_map(NativeDecision::parse) {
                        if !result.contains(&decision) {
                            result.push(decision);
                        }
                    }
                    result
                }
                // Version-verified decision enum defaults, not an invented
                // permission-rule grant. An explicitly empty list stays empty.
                None => vec![
                    NativeDecision::Accept,
                    NativeDecision::Decline,
                    NativeDecision::Cancel,
                ],
            },
            RequestKind::File(_) => vec![
                NativeDecision::Accept,
                NativeDecision::Decline,
                NativeDecision::Cancel,
            ],
            RequestKind::Questions(_) => Vec::new(),
        }
    }
    pub(super) fn file_changes(&self) -> Option<&[Value]> {
        self.file_changes.as_deref()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum ResolutionOutcome {
    Permission(NativeDecision),
    Answers(BTreeMap<String, String>),
    Cancelled,
}
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Resolution {
    pub block_id: String,
    pub is_question: bool,
    pub outcome: ResolutionOutcome,
}

// Intentionally no Debug/Clone implementation: the sole raw secret-bearing
// response travels directly to the serialized native writer, never diagnostics.
pub(super) struct PreparedReply {
    wire: Value,
}
impl PreparedReply {
    pub(super) fn wire(&self) -> &Value {
        &self.wire
    }
}
struct Entry {
    request: PendingRequest,
    outcome: Option<ResolutionOutcome>,
}

/// One active native turn in one owned connection. Mutated under the owning
/// connection's mutex. Caller drains/closes it before replacing the turn scope.
pub(super) struct RequestLedger {
    scope: NativeScope,
    next_block: u64,
    closed: bool,
    seen: HashSet<RequestId>,
    pending: HashMap<RequestId, Entry>,
    files: HashMap<String, Vec<Value>>,
}
impl RequestLedger {
    pub(super) fn new(scope: NativeScope) -> Self {
        Self {
            scope,
            next_block: 0,
            closed: false,
            seen: HashSet::new(),
            pending: HashMap::new(),
            files: HashMap::new(),
        }
    }
    fn check_scope(&self, scope: &NativeScope) -> Result<(), RequestError> {
        if self.closed || scope != &self.scope {
            Err(RequestError::StaleScope)
        } else {
            Ok(())
        }
    }

    /// Keep request-id tombstones for the lifetime of the connection. A late
    /// serverRequest/resolved carries no turn id, so an old id must never be
    /// reused by a new turn's request ledger in that same connection.
    pub(super) fn advance_turn(
        &mut self,
        next: NativeScope,
    ) -> Result<Vec<Resolution>, RequestError> {
        if self.closed
            || next.session_id != self.scope.session_id
            || next.thread_id != self.scope.thread_id
            || next.generation < self.scope.generation
            || next.turn_id == self.scope.turn_id
        {
            return Err(RequestError::StaleScope);
        }
        let cancelled = self
            .pending
            .drain()
            .map(|(_, entry)| Resolution {
                is_question: matches!(entry.request.kind, RequestKind::Questions(_)),
                block_id: entry.request.block_id,
                outcome: ResolutionOutcome::Cancelled,
            })
            .collect();
        self.files.clear();
        self.scope = next;
        Ok(cancelled)
    }
    pub(super) fn observe_file_item(
        &mut self,
        scope: &NativeScope,
        item: Value,
    ) -> Result<(), RequestError> {
        self.check_scope(scope)?;
        if item.get("type").and_then(Value::as_str) != Some("fileChange") {
            return Err(RequestError::InvalidParams);
        }
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or(RequestError::InvalidParams)?;
        let changes = item
            .get("changes")
            .and_then(Value::as_array)
            .ok_or(RequestError::InvalidParams)?;
        if changes.iter().any(|change| {
            change.get("path").and_then(Value::as_str).is_none()
                || change.get("diff").and_then(Value::as_str).is_none()
                || !change.get("kind").is_some_and(Value::is_object)
        }) {
            return Err(RequestError::InvalidParams);
        }
        if self.files.len() >= 4096 && !self.files.contains_key(id) {
            return Err(RequestError::RequestLimit);
        }
        self.files.insert(id.into(), changes.clone());
        Ok(())
    }
    pub(super) fn insert(
        &mut self,
        scope: &NativeScope,
        id: RequestId,
        method: &str,
        params: Value,
    ) -> Result<PendingRequest, RequestError> {
        self.check_scope(scope)?;
        if self.seen.contains(&id) {
            return Err(RequestError::Replay);
        }
        if self.seen.len() >= 4096 || self.pending.len() >= 128 {
            return Err(RequestError::RequestLimit);
        }
        let kind = match method {
            "item/commandExecution/requestApproval" => RequestKind::Command(
                serde_json::from_value(params).map_err(|_| RequestError::InvalidParams)?,
            ),
            "item/fileChange/requestApproval" => RequestKind::File(
                serde_json::from_value(params).map_err(|_| RequestError::InvalidParams)?,
            ),
            "item/tool/requestUserInput" => RequestKind::Questions(
                serde_json::from_value(params).map_err(|_| RequestError::InvalidParams)?,
            ),
            _ => return Err(RequestError::UnsupportedMethod),
        };
        let context = kind.context();
        if context.thread_id != scope.thread_id
            || context.turn_id != scope.turn_id
            || context.item_id.is_empty()
        {
            return Err(RequestError::StaleScope);
        }
        if let RequestKind::Questions(input) = &kind {
            let ids: HashSet<_> = input.questions.iter().map(|q| q.id.as_str()).collect();
            if input.questions.is_empty()
                || input.questions.len() > 3
                || ids.len() != input.questions.len()
                || ids.contains("")
            {
                return Err(RequestError::InvalidParams);
            }
        }
        let file_changes = matches!(kind, RequestKind::File(_))
            .then(|| self.files.get(&context.item_id).cloned())
            .flatten();
        self.next_block += 1;
        let request = PendingRequest {
            block_id: format!("codex-request:{}:{}", scope.generation, self.next_block),
            kind,
            file_changes,
        };
        self.seen.insert(id.clone());
        self.pending.insert(
            id,
            Entry {
                request: request.clone(),
                outcome: None,
            },
        );
        Ok(request)
    }
    fn entry(
        &mut self,
        scope: &NativeScope,
        block_id: &str,
    ) -> Result<(&RequestId, &mut Entry), RequestError> {
        self.check_scope(scope)?;
        self.pending
            .iter_mut()
            .find(|(_, entry)| entry.request.block_id == block_id)
            .ok_or(RequestError::NotPending)
    }
    pub(super) fn claim_permission(
        &mut self,
        scope: &NativeScope,
        block_id: &str,
        decision: NativeDecision,
    ) -> Result<PreparedReply, RequestError> {
        let (id, entry) = self.entry(scope, block_id)?;
        if entry.outcome.is_some() {
            return Err(RequestError::AlreadyClaimed);
        }
        if !entry.request.allowed_decisions().contains(&decision) {
            return Err(RequestError::UnsupportedDecision);
        }
        // Store intended outcome BEFORE releasing the lock for stdin: native
        // resolved may arrive before the writer returns. A failed/ambiguous
        // write closes the ledger once; it never reopens a claim for replay.
        entry.outcome = Some(ResolutionOutcome::Permission(decision));
        Ok(PreparedReply {
            wire: response(id, json!({"decision":decision.as_str()})),
        })
    }
    pub(super) fn claim_answers(
        &mut self,
        scope: &NativeScope,
        block_id: &str,
        answers: BTreeMap<String, String>,
    ) -> Result<PreparedReply, RequestError> {
        let (id, entry) = self.entry(scope, block_id)?;
        if entry.outcome.is_some() {
            return Err(RequestError::AlreadyClaimed);
        }
        let RequestKind::Questions(input) = &entry.request.kind else {
            return Err(RequestError::InvalidAnswer);
        };
        if answers.len() != input.questions.len() {
            return Err(RequestError::InvalidAnswer);
        }
        let mut redacted = BTreeMap::new();
        let mut wire_answers = serde_json::Map::new();
        for question in &input.questions {
            let answer = answers
                .get(&question.id)
                .ok_or(RequestError::InvalidAnswer)?;
            if let Some(options) = &question.options {
                if !options.is_empty()
                    && !question.is_other
                    && !options.iter().any(|option| &option.label == answer)
                {
                    return Err(RequestError::InvalidAnswer);
                }
            }
            redacted.insert(
                question.id.clone(),
                if question.is_secret {
                    "[redacted]".into()
                } else {
                    answer.clone()
                },
            );
            wire_answers.insert(question.id.clone(), json!({"answers":[answer]}));
        }
        entry.outcome = Some(ResolutionOutcome::Answers(redacted));
        Ok(PreparedReply {
            wire: response(id, json!({"answers":wire_answers})),
        })
    }
    pub(super) fn resolve(&mut self, scope: &NativeScope, id: &RequestId) -> Option<Resolution> {
        self.check_scope(scope).ok()?;
        let entry = self.pending.remove(id)?;
        Some(Resolution {
            is_question: matches!(entry.request.kind, RequestKind::Questions(_)),
            block_id: entry.request.block_id,
            outcome: entry.outcome.unwrap_or(ResolutionOutcome::Cancelled),
        })
    }
    pub(super) fn close(&mut self) -> Vec<Resolution> {
        self.closed = true;
        self.drain()
    }
    pub(super) fn pending(&self) -> impl Iterator<Item = &PendingRequest> {
        self.pending.values().map(|entry| &entry.request)
    }
    pub(super) fn drain(&mut self) -> Vec<Resolution> {
        self.files.clear();
        self.pending
            .drain()
            .map(|(_, entry)| Resolution {
                is_question: matches!(entry.request.kind, RequestKind::Questions(_)),
                block_id: entry.request.block_id,
                outcome: ResolutionOutcome::Cancelled,
            })
            .collect()
    }
}
