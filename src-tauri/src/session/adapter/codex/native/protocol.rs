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
        }),
        _ => Err(ProtocolError::MalformedEnvelope),
    }
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
