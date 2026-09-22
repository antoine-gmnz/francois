//! Saved Pi data only. This module performs no runtime or filesystem operations.
use serde::{Deserialize, Serialize};
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct PiResumeRecord {
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u32,
    #[serde(rename = "nativeSessionId")]
    pub(crate) native_session_id: String,
    #[serde(rename = "nativeSessionFile")]
    pub(crate) native_session_file: String,
    #[serde(rename = "accountId")]
    pub(crate) account_id: String,
    #[serde(rename = "configDir")]
    pub(crate) config_dir: String,
    pub(crate) cwd: String,
    #[serde(rename = "piVersion")]
    pub(crate) pi_version: String,
    #[serde(rename = "lastEntryId")]
    pub(crate) last_entry_id: Option<String>,
    #[serde(rename = "leafId")]
    pub(crate) leaf_id: Option<String>,
    #[serde(rename = "projectionVersion")]
    pub(crate) projection_version: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourcePolicy {
    pub(crate) project_resources: ProjectResources,
    pub(crate) extensions: ExtensionsPolicy,
    pub(crate) acknowledged_unrestricted_tools: bool,
}

/// Mirrors contract `RuntimeResourcePolicy.projectResources`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProjectResources {
    Ignore,
    Allow,
}

/// Mirrors contract `RuntimeResourcePolicy.extensions` — a one-member
/// literal type on purpose (FR-6: arbitrary Pi extensions are disabled in
/// this release; there is nothing else this field could ever say).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ExtensionsPolicy {
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub(crate) struct PiLaunchPrompt {
    pub(crate) text: Option<String>,
}
/// Mirrors contract/common.ts `DeliveryMode`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryMode {
    Normal,
    Steer,
    FollowUp,
}

/// Mirrors contract/common.ts `RuntimeMessageReceipt.state`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AdmissionState {
    Admitting,
    Queued,
    Consumed,
    Cancelled,
    DeliveryUnknown,
    Rejected,
}

/// Mirrors contract/common.ts `RuntimeMessageReceipt`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeMessageReceipt {
    #[serde(rename = "clientMessageId")]
    pub(crate) client_message_id: String,
    pub(crate) state: AdmissionState,
    pub(crate) delivery: DeliveryMode,
    #[serde(rename = "queuePosition", skip_serializing_if = "Option::is_none")]
    pub(crate) queue_position: Option<u32>,
}

/// Mirrors contract/common.ts `RuntimeQueueEntry` (`extends RuntimeMessageReceipt`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeQueueEntry {
    #[serde(flatten)]
    pub(crate) receipt: RuntimeMessageReceipt,
    pub(crate) text: String,
    #[serde(rename = "attachmentIds")]
    pub(crate) attachment_ids: Vec<String>,
    #[serde(rename = "createdAt")]
    pub(crate) created_at: u64,
}
