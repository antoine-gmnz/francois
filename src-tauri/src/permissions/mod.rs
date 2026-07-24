// permissions.rs — permission-guardrails (specs/permission-guardrails.md).
//
// Everything file- and pattern-shaped lives here; the control-channel wiring
// (parking an ask, writing the control_response) lives in session.rs, which
// calls into this module. Nothing here touches the session engine's state.
//
// The contract this module implements is Claude Code's OWN settings format:
// rules are written into `permissions.allow` / `permissions.deny` of a real
// settings.json, which means Claude enforces them UPSTREAM of the control
// channel — a ruled call never reaches Francois again (spec §1). Three
// processes write those files (the claude CLI, the user's editor, Francois), so
// every write here is a surgical read → touch one array → write-back that
// preserves every other key (FR-14). An unparseable file is NEVER overwritten.
//
// Rule ids are DERIVED (`tier|effect|pattern`, FR-16) — nothing about a rule is
// stored outside the settings file, except the "disabled" parking lot in the
// Francois-owned sidecar (FR-15), which Claude never reads.

mod commands;
mod patterns;
mod rules;
mod settings;
mod summarize;

pub(crate) use commands::*;
pub(crate) use patterns::*;
pub(crate) use rules::*;
pub(crate) use settings::*;
pub(crate) use summarize::*;

#[cfg(test)]
mod testutil;

use serde::Serialize;

// ---------- contract types (contract/permission-guardrails.ts, mirrored) ----------

/// Mirrors PermissionAsk in contract/common.ts.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PermissionAsk {
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub summary: String,
    #[serde(rename = "inputJson")]
    pub input_json: String,
    pub cwd: String,
    pub pattern: String,
    #[serde(rename = "patternLabel")]
    pub pattern_label: String,
}

/// Mirrors PermissionRule in contract/common.ts. Every field name is a single
/// lowercase word, so serde needs no renames.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PermissionRule {
    pub id: String,
    pub pattern: String,
    pub effect: String,
    pub tier: String,
    pub enabled: bool,
    pub label: String,
}

/// FR-17 listing order: deny first (the rules that stop things), then ask, then allow.
const EFFECT_ORDER: [&str; 3] = ["deny", "ask", "allow"];

/// The sidecar file that parks toggled-off rules (FR-15). Francois is its ONLY
/// writer, so it carries none of the three-writer risk settings.json does.
const SIDECAR_NAME: &str = "francois-permissions.json";
