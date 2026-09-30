//! The observed 0.155.1 JSONL envelope. Protocol faults never include raw input.
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum RequestId {
    String(String),
    Integer(i64),
}
impl RequestId {
    pub(super) fn parse(value: &Value) -> Result<Self, ProtocolError> {
        if let Some(text) = value.as_str() {
            return Ok(Self::String(text.into()));
        }
        value
            .as_i64()
            .map(Self::Integer)
            .ok_or(ProtocolError::MalformedEnvelope)
    }
    pub(super) fn to_value(&self) -> Value {
        match self {
            Self::String(value) => json!(value),
            Self::Integer(value) => json!(value),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProtocolError {
    MalformedEnvelope,
}

#[derive(Debug, PartialEq)]
pub(super) enum Envelope {
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Success {
        id: RequestId,
        result: Value,
    },
    Failure {
        id: RequestId,
        code: i64,
        /// Codex's own explanation ("model not supported…", "no rollout found…").
        /// Without it the user reads a bare error code.
        message: Option<String>,
    },
}

pub(super) fn decode_frame(bytes: &[u8]) -> Result<Envelope, ProtocolError> {
    decode_value(serde_json::from_slice(bytes).map_err(|_| ProtocolError::MalformedEnvelope)?)
}
pub(super) fn decode_value(value: Value) -> Result<Envelope, ProtocolError> {
    let object = value.as_object().ok_or(ProtocolError::MalformedEnvelope)?;
    if let Some(method) = object.get("method") {
        if object.contains_key("result") || object.contains_key("error") {
            return Err(ProtocolError::MalformedEnvelope);
        }
        let method = method
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(ProtocolError::MalformedEnvelope)?
            .to_string();
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
        if !params.is_object() {
            return Err(ProtocolError::MalformedEnvelope);
        }
        return match object.get("id") {
            Some(id) => Ok(Envelope::Request {
                id: RequestId::parse(id)?,
                method,
                params,
            }),
            None => Ok(Envelope::Notification { method, params }),
        };
    }
    let id = RequestId::parse(object.get("id").ok_or(ProtocolError::MalformedEnvelope)?)?;
    match (object.get("result"), object.get("error")) {
        (Some(result), None) => Ok(Envelope::Success {
            id,
            result: result.clone(),
        }),
        (None, Some(error)) => Ok(Envelope::Failure {
            id,
            code: error
                .get("code")
                .and_then(Value::as_i64)
                .ok_or(ProtocolError::MalformedEnvelope)?,
            message: error
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(String::from),
        }),
        _ => Err(ProtocolError::MalformedEnvelope),
    }
}

/// The sentence a person should read from a Codex error message. Upstream API
/// failures arrive as the raw response body — `{"type":"error","status":400,
/// "error":{"message":"The 'x' model is not supported…"}}` — so the inner
/// `message` is lifted out when there is one. Bounded: this ends up on a card.
pub(super) fn readable_message(raw: &str) -> String {
    const LIMIT: usize = 600;
    let raw = raw.trim();
    let inner = serde_json::from_str::<Value>(raw).ok().and_then(|body| {
        [&body["error"]["message"], &body["message"]]
            .into_iter()
            .find_map(|m| m.as_str().map(str::trim).filter(|m| !m.is_empty()))
            .map(String::from)
    });
    let text = inner.unwrap_or_else(|| raw.to_string());
    if text.chars().count() <= LIMIT {
        return text;
    }
    let mut cut: String = text.chars().take(LIMIT).collect();
    cut.push('…');
    cut
}

pub(super) fn request(id: &RequestId, method: &str, params: Value) -> Value {
    json!({"id":id.to_value(), "method":method, "params":params})
}
pub(super) fn response(id: &RequestId, result: Value) -> Value {
    json!({"id":id.to_value(), "result":result})
}
pub(super) fn unsupported_request(id: &RequestId) -> Value {
    json!({"id":id.to_value(), "error":{"code":-32601,"message":"Unsupported native server request"}})
}
pub(super) fn initialize(id: &RequestId, version: &str) -> Value {
    request(
        id,
        "initialize",
        json!({"clientInfo":{"name":"francois","title":"Francois","version":version},"capabilities":{"experimentalApi":true}}),
    )
}
pub(super) fn interrupt(id: &RequestId, thread: &str, turn: &str) -> Value {
    request(
        id,
        "turn/interrupt",
        json!({"threadId":thread,"turnId":turn}),
    )
}

/// A successful turn/start response alone is not interrupt readiness. Native
/// turn/started consumes one latched Stop; completion winning the race is final.
#[derive(Default)]
pub(super) struct InterruptState {
    requested: bool,
    started: bool,
    sent: bool,
    completed: bool,
}
impl InterruptState {
    pub(super) fn request(&mut self) -> bool {
        self.requested = true;
        self.take_ready()
    }
    pub(super) fn started(&mut self) -> bool {
        self.started = true;
        self.take_ready()
    }
    fn take_ready(&mut self) -> bool {
        if self.requested && self.started && !self.sent && !self.completed {
            self.sent = true;
            true
        } else {
            false
        }
    }
    pub(super) fn not_active(&mut self) {
        self.sent = false;
        self.started = false;
    }
    pub(super) fn completed(&mut self) {
        self.completed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_keeps_codex_own_explanation() {
        let envelope = decode_value(
            json!({"id":3,"error":{"code":-32600,"message":"no rollout found for thread id x"}}),
        )
        .unwrap();
        assert_eq!(
            envelope,
            Envelope::Failure {
                id: RequestId::Integer(3),
                code: -32600,
                message: Some("no rollout found for thread id x".into()),
            }
        );
        let bare = decode_value(json!({"id":3,"error":{"code":-32603}})).unwrap();
        assert!(matches!(bare, Envelope::Failure { message: None, .. }));
    }

    /// Verified live on 0.155.1: an unsupported model fails the turn with the
    /// upstream body as its message, JSON and all.
    #[test]
    fn readable_message_lifts_the_upstream_sentence_out_of_a_raw_body() {
        let raw = r#"{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."}}"#;
        assert_eq!(
            readable_message(raw),
            "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."
        );
        assert_eq!(
            readable_message("  stream disconnected  "),
            "stream disconnected"
        );
        assert_eq!(readable_message(r#"{"message":"flat"}"#), "flat");
        assert_eq!(readable_message("[1,2]"), "[1,2]");
        let long = "x".repeat(2000);
        assert_eq!(readable_message(&long).chars().count(), 601);
    }
}
