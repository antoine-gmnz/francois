//! The `RuntimeEventPayload` wire union and the payload structs its variants
//! carry.
//!
//! Split out of `events.rs` per §Code layout (CLAUDE.md's ~1000-line file
//! cap): three Pi features (pi-transcript-events, pi-models-metrics,
//! pi-turn-controls) added enough runtime-event vocabulary to that file to
//! push it well past the ceiling. A SIBLING of `events`, not a child of it —
//! `super::*` here still resolves to the whole `session` module, exactly as
//! it does in `events.rs` itself — so every cross-reference below
//! (`super::retired_pi::RuntimeQueueEntry`, `adapter::RuntimeModelRef`, …)
//! reads identically to how it read before the split. `events` re-exports
//! the names other files already reach through `events::*`
//! (`RuntimeEventPayload`, `RuntimeToolCall`, `RuntimeAttachmentRef`,
//! `RuntimeModelDescriptor`, `RuntimeMetrics`), so no other module's import
//! path changes.

use super::*;

use crate::ipc::RuntimeFailure;
use serde::{Deserialize, Serialize};

/// pi-transcript-events: a normalized generic tool-call lifecycle, sanitized in
/// the adapter before it crosses IPC — never the raw Pi RPC input/output object.
/// Mirrors contract/common.ts `RuntimeToolCall`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeToolCall {
    pub id: String,
    pub name: String,
    /// 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
    pub status: String,
    #[serde(rename = "inputText")]
    pub input_text: String,
    #[serde(rename = "outputText")]
    pub output_text: String,
    /// true ⇒ `inputText` was cut at the 64 KiB preview bound (FR-4).
    #[serde(rename = "inputTruncated")]
    pub input_truncated: bool,
    /// true ⇒ `outputText` was cut at the 64 KiB preview bound (FR-4).
    #[serde(rename = "outputTruncated")]
    pub output_truncated: bool,
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(rename = "completedAt", skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
}

/// pi-models-metrics §5: one provider/model row as the runtime reports it.
/// Mirrors contract/common.ts `RuntimeModelDescriptor` — identity is
/// `model_ref` (the contract's `ref`, renamed here because `ref` is a Rust
/// keyword), `displayName` is presentation only. `unavailableReason` is
/// present iff `availability` is `'unavailable'` (FR-3).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RuntimeModelDescriptor {
    #[serde(rename = "ref")]
    pub model_ref: adapter::RuntimeModelRef,
    #[serde(rename = "displayName")]
    pub display_name: String,
    /// 'text' | 'image'
    pub input: Vec<String>,
    #[serde(rename = "contextWindow")]
    pub context_window: Option<u64>,
    #[serde(rename = "maxOutputTokens")]
    pub max_output_tokens: Option<u64>,
    pub reasoning: bool,
    /// 'unknown' | 'configured' | 'verified' | 'failed'
    #[serde(rename = "authState")]
    pub auth_state: String,
    /// 'available' | 'unavailable'
    pub availability: String,
    #[serde(
        rename = "unavailableReason",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub unavailable_reason: Option<String>,
}

/// pi-models-metrics §5: usage as the runtime reports it, with explicit
/// unknowns. Mirrors contract/common.ts `RuntimeMetrics` — every non-null
/// counter is a finite nonnegative number, `null` means UNKNOWN (never zero).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RuntimeMetrics {
    #[serde(rename = "inputTokens")]
    pub input_tokens: Option<u64>,
    #[serde(rename = "outputTokens")]
    pub output_tokens: Option<u64>,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: Option<u64>,
    #[serde(rename = "cacheWriteTokens")]
    pub cache_write_tokens: Option<u64>,
    #[serde(rename = "contextTokens")]
    pub context_tokens: Option<u64>,
    #[serde(rename = "contextWindow")]
    pub context_window: Option<u64>,
    /// 'reported' | 'estimated' | 'unknown'
    #[serde(rename = "contextBasis")]
    pub context_basis: String,
    #[serde(rename = "costUsd")]
    pub cost_usd: Option<f64>,
    /// 'estimated' | 'unknown'
    #[serde(rename = "costBasis")]
    pub cost_basis: String,
    #[serde(rename = "measuredAt")]
    pub measured_at: u64,
    pub stale: bool,
}

/// pi-transcript-events FR-7: a user-attached file/image, resolved against the
/// existing attachment ingest/asset scopes — never a base64 payload over IPC.
/// Mirrors contract/common.ts `RuntimeAttachmentRef`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeAttachmentRef {
    pub id: String,
    pub name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    /// 'available' | 'missing'
    pub state: String,
}

/// Ordered, session-scoped runtime events. This intentionally carries only
/// core-normalised values; Pi's wire DTOs stay inside its future adapter.
///
/// pi-transcript-events §5: the five transcript-normalization variants below
/// (`message.user` .. `notice`) mirror contract/common.ts's
/// `TranscriptRuntimePayload`, merged into `RuntimeEventPayload` there exactly
/// as they are merged into this enum here. `blockId` ties each to the
/// conversation block it creates/updates (contract/conversation-view.ts).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind")]
#[allow(dead_code)]
pub enum RuntimeEventPayload {
    #[serde(rename = "run.state")]
    RunState {
        state: super::events::RuntimeRunState,
    },
    #[serde(rename = "capabilities")]
    Capabilities {
        #[serde(serialize_with = "serialize_capabilities")]
        capabilities: RuntimeCapabilities,
    },
    #[serde(rename = "failure")]
    Failure { failure: RuntimeFailure },
    #[serde(rename = "message.user")]
    MessageUser {
        #[serde(rename = "blockId")]
        block_id: String,
        text: String,
        attachments: Vec<RuntimeAttachmentRef>,
        #[serde(rename = "clientMessageId", skip_serializing_if = "Option::is_none")]
        client_message_id: Option<String>,
    },
    #[serde(rename = "assistant.delta")]
    AssistantDelta {
        #[serde(rename = "blockId")]
        block_id: String,
        #[serde(rename = "contentIndex")]
        content_index: u32,
        text: String,
        offset: usize,
    },
    #[serde(rename = "assistant.complete")]
    AssistantComplete {
        #[serde(rename = "blockId")]
        block_id: String,
        text: String,
        /// 'complete' | 'interrupted' | 'error'
        outcome: String,
    },
    #[serde(rename = "tool.update")]
    ToolUpdate {
        #[serde(rename = "blockId")]
        block_id: String,
        tool: RuntimeToolCall,
    },
    #[serde(rename = "notice")]
    Notice {
        #[serde(rename = "blockId")]
        block_id: String,
        /// 'info' | 'warning' | 'error'
        tone: String,
        text: String,
    },
    /// pi-models-metrics §5: published only AFTER the core read the accepted
    /// value back from the runtime (FR-5/FR-6) — `effort` is the actual
    /// read-back level, absent when the model runs at its own default or a
    /// model change cleared an incompatible one.
    #[serde(rename = "model.changed")]
    ModelChanged {
        model: RuntimeModelDescriptor,
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
    },
    #[serde(rename = "metrics")]
    Metrics { metrics: RuntimeMetrics },
    /// pi-turn-controls §5: mirrors contract/common.ts `ControlRuntimePayload`'s
    /// `queue.changed` — always the session's FULL pending admissions
    /// snapshot (an empty array clears the composer's queue strip).
    #[serde(rename = "queue.changed")]
    QueueChanged {
        entries: Vec<super::retired_pi::RuntimeQueueEntry>,
    },
    /// pi-turn-controls FR-8: `automatic: true` is progress inside the
    /// CURRENT run, never a turn completion of its own.
    #[serde(rename = "compaction")]
    Compaction {
        /// 'started' | 'completed' | 'failed'
        state: String,
        automatic: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// pi-turn-controls: a provider retry observed mid-turn — progress, never
    /// a turn completion.
    #[serde(rename = "retry")]
    Retry {
        /// 'waiting' | 'running' | 'finished'
        state: String,
        attempt: u32,
        #[serde(rename = "delayMs", skip_serializing_if = "Option::is_none")]
        delay_ms: Option<u64>,
    },
}

fn serialize_capabilities<S: serde::Serializer>(
    caps: &RuntimeCapabilities,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    adapter::validate_capabilities(caps)
        .map_err(|_| serde::ser::Error::custom("invalid capability snapshot"))?;
    caps.serialize(serializer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// pi-transcript-events §5: each transcript-normalization variant
    /// serializes to the contract's `TranscriptRuntimePayload` shape — the
    /// `kind` tag plus its own field set, `blockId` always camelCase.
    #[test]
    fn transcript_runtime_payload_variants_serialize_to_contract_shape() {
        let user = serde_json::to_value(RuntimeEventPayload::MessageUser {
            block_id: "b1".into(),
            text: "hi".into(),
            attachments: vec![RuntimeAttachmentRef {
                id: "a1".into(),
                name: "cat.png".into(),
                mime_type: "image/png".into(),
                state: "available".into(),
            }],
            client_message_id: Some("c1".into()),
        })
        .unwrap();
        assert_eq!(
            user,
            json!({ "kind": "message.user", "blockId": "b1", "text": "hi",
                "attachments": [{ "id": "a1", "name": "cat.png", "mimeType": "image/png", "state": "available" }],
                "clientMessageId": "c1" })
        );

        let user_no_client_id = serde_json::to_value(RuntimeEventPayload::MessageUser {
            block_id: "b1".into(),
            text: "hi".into(),
            attachments: vec![],
            client_message_id: None,
        })
        .unwrap();
        assert!(user_no_client_id.get("clientMessageId").is_none());

        let delta = serde_json::to_value(RuntimeEventPayload::AssistantDelta {
            block_id: "b2".into(),
            content_index: 0,
            text: "Hel".into(),
            offset: 0,
        })
        .unwrap();
        assert_eq!(
            delta,
            json!({ "kind": "assistant.delta", "blockId": "b2", "contentIndex": 0, "text": "Hel", "offset": 0 })
        );

        let complete = serde_json::to_value(RuntimeEventPayload::AssistantComplete {
            block_id: "b2".into(),
            text: "Hello".into(),
            outcome: "complete".into(),
        })
        .unwrap();
        assert_eq!(
            complete,
            json!({ "kind": "assistant.complete", "blockId": "b2", "text": "Hello", "outcome": "complete" })
        );

        let tool = serde_json::to_value(RuntimeEventPayload::ToolUpdate {
            block_id: "b3".into(),
            tool: RuntimeToolCall {
                id: "t1".into(),
                name: "Read".into(),
                status: "running".into(),
                input_text: "file.rs".into(),
                output_text: "".into(),
                input_truncated: false,
                output_truncated: false,
                started_at: Some(1_000),
                completed_at: None,
            },
        })
        .unwrap();
        assert_eq!(tool["kind"], "tool.update");
        assert_eq!(tool["blockId"], "b3");
        assert_eq!(tool["tool"]["id"], "t1");
        assert_eq!(tool["tool"]["status"], "running");
        assert_eq!(tool["tool"]["startedAt"], 1_000);
        assert!(tool["tool"].get("completedAt").is_none());

        let notice = serde_json::to_value(RuntimeEventPayload::Notice {
            block_id: "b4".into(),
            tone: "warning".into(),
            text: "unsupported content".into(),
        })
        .unwrap();
        assert_eq!(
            notice,
            json!({ "kind": "notice", "blockId": "b4", "tone": "warning", "text": "unsupported content" })
        );
    }

    /// pi-models-metrics §5: `model.changed`/`metrics` serialize to the
    /// contract's `ModelRuntimePayload` shape — `ref` (not `model_ref`) on the
    /// wire, `effort` omitted (never null) when absent.
    #[test]
    fn model_runtime_payload_variants_serialize_to_contract_shape() {
        let descriptor = RuntimeModelDescriptor {
            model_ref: adapter::RuntimeModelRef {
                provider_id: "anthropic".into(),
                model_id: "claude-sonnet-5".into(),
            },
            display_name: "Sonnet 5".into(),
            input: vec!["text".into(), "image".into()],
            context_window: Some(200_000),
            max_output_tokens: Some(8_192),
            reasoning: true,
            auth_state: "verified".into(),
            availability: "available".into(),
            unavailable_reason: None,
        };
        let changed = serde_json::to_value(RuntimeEventPayload::ModelChanged {
            model: descriptor.clone(),
            effort: Some("high".into()),
        })
        .unwrap();
        assert_eq!(changed["kind"], "model.changed");
        assert_eq!(changed["model"]["ref"]["providerId"], "anthropic");
        assert_eq!(changed["model"]["ref"]["modelId"], "claude-sonnet-5");
        assert!(changed["model"].get("model_ref").is_none());
        assert_eq!(changed["effort"], "high");

        let no_effort = serde_json::to_value(RuntimeEventPayload::ModelChanged {
            model: descriptor,
            effort: None,
        })
        .unwrap();
        assert!(no_effort.get("effort").is_none());

        let metrics = RuntimeMetrics {
            input_tokens: Some(120),
            output_tokens: Some(45),
            cache_read_tokens: None,
            cache_write_tokens: None,
            context_tokens: Some(3_400),
            context_window: Some(200_000),
            context_basis: "reported".into(),
            cost_usd: Some(0.0123),
            cost_basis: "estimated".into(),
            measured_at: 1_000,
            stale: false,
        };
        let metrics_value = serde_json::to_value(RuntimeEventPayload::Metrics {
            metrics: metrics.clone(),
        })
        .unwrap();
        assert_eq!(metrics_value["kind"], "metrics");
        assert_eq!(metrics_value["metrics"]["inputTokens"], 120);
        assert_eq!(metrics_value["metrics"]["cacheReadTokens"], Value::Null);
        assert_eq!(metrics_value["metrics"]["costBasis"], "estimated");

        // Round trips (session persistence stores this on SessionMeta.metrics).
        let bytes = serde_json::to_vec(&metrics).unwrap();
        let back: RuntimeMetrics = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back, metrics);
    }
}
