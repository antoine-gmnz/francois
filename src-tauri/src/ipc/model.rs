//! `ModelInfo` — the contract's model shape (`contract/common.ts`).
//!
//! core-architecture-wave3 FR-9: it used to live in `session/models.rs`, which
//! is where the model *catalog* logic belongs — but the TYPE is a wire payload
//! two domains build, and `account/endpoint.rs` had to say
//! `crate::session::ModelInfo` to build one. An endpoint account listing the
//! models it advertises is not asking the session engine anything.
//!
//! Here it sits beside `AppError` and `ErrorCode`, the crate's other
//! contract-shaped types, in a module that depends on nothing. `session::models`
//! re-exports it, so the catalog's own call sites are unchanged.

use serde::{Deserialize, Serialize};

/// `Deserialize` is not part of the wire contract — it exists so the catalog can
/// round-trip through the on-disk mirror (`models.json`). Every field but `id`
/// and `label` is `default`ed, so a mirror written by an older build still loads.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(
        rename = "contextTokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_tokens: Option<u64>,
    /// Effort levels this model supports (subset of low/medium/high/xhigh/max).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
}

/// The minimal entry: an id and a label, nothing claimed about the rest.
pub fn model(id: &str, label: &str) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        label: label.into(),
        brief: None,
        context_tokens: None,
        efforts: Vec::new(),
    }
}
