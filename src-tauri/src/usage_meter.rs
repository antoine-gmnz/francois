//! Shared plan-limit meter vocabulary.
//!
//! This value belongs to neither the app usage cache nor the session domain:
//! both consume it, and runtime adapters construct it. Keeping it in this
//! leaf prevents adapters from depending on the app usage domain.

use serde::Serialize;

/// One plan-limit meter serialized to the contract's `UsageMeter` shape.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct UsageMeter {
    pub label: String,
    #[serde(rename = "percentUsed")]
    pub percent_used: u64,
    /// Verbatim reset text, e.g. `Jul 22, 5:29pm (Europe/Paris)`.
    #[serde(rename = "resetsAt")]
    pub resets_at: String,
}
