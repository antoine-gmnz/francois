// profiles/mod.rs — the `profiles` domain (specs/session-profiles.md).
//
// A profile bundles a system prompt and raw extra CLI args under a name — a
// reusable identity a session can be started from. It deliberately carries NO
// model / effort / permission mode: a profile is always paired with a project,
// and the project's own session defaults own those three.
// App-scoped and shared across every account (FR-2): profiles.json in
// the app data dir, mirrored in memory, following the exact registry pattern
// `project`/`account` use — Francois is its only writer, read-merge-write
// discipline, memory-authoritative after the one load at startup.
//
// A session SNAPSHOTS the resolved values at creation (FR-15/FR-16): editing
// or deleting a profile never touches a session already created from it. That
// snapshot — `SessionProfileRef` — is what `session::SessionMeta.profile`
// carries; it lives here (not in `session/`) because it is this domain's
// contract shape, the same way `project::SessionSeed` is defined in `project`
// even though only `session` ever constructs one from it.
//
// This feature defines NO event channel (spec §5 preamble): every mutation is
// initiated by this app's own frontend and resolves with the new state.

mod commands;
mod parse;
mod registry;

pub(crate) use commands::*;
pub(crate) use parse::*;
pub(crate) use registry::*;

#[cfg(test)]
mod testutil;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// ---------- bounds (contract/session-profiles.ts, mirrored — FR-6) ----------

pub(crate) const MAX_PROFILE_NAME: usize = 60;
pub(crate) const MAX_SYSTEM_PROMPT: usize = 16384;
pub(crate) const MAX_EXTRA_ARGS_RAW: usize = 4096;

// ---------- contract types (contract/session-profiles.ts, mirrored) ----------

/// Mirrors `SessionProfile` in contract/session-profiles.ts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SessionProfile {
    pub(crate) id: String,
    /// trimmed, 1..=MAX_PROFILE_NAME; NOT unique (FR-3)
    pub(crate) name: String,
    /// Present and non-empty ⇒ REPLACE mode (FR-17/FR-12).
    #[serde(
        rename = "systemPrompt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) system_prompt: Option<String>,
    /// Verbatim as typed, for round-tripping the editor (FR-8).
    #[serde(
        rename = "extraArgsRaw",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) extra_args_raw: Option<String>,
    /// Core-parsed tokens (FR-7); the argv actually appended.
    #[serde(rename = "extraArgs", default, skip_serializing_if = "Option::is_none")]
    pub(crate) extra_args: Option<Vec<String>>,
    #[serde(rename = "createdAt", default)]
    pub(crate) created_at: u64,
    #[serde(rename = "updatedAt", default)]
    pub(crate) updated_at: u64,
}

/// Mirrors `SessionProfileRef` in contract/common.ts — the profile identity a
/// session snapshots at creation (FR-16). Never re-resolved against the
/// registry: a deleted profile's name still renders (FR-22).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SessionProfileRef {
    pub(crate) id: String,
    /// snapshotted at creation
    pub(crate) name: String,
    /// true iff the session was created with a non-empty systemPrompt (FR-17).
    #[serde(rename = "replacesSystemPrompt")]
    pub(crate) replaces_system_prompt: bool,
}

// ---------- managed state ----------

/// The whole registry, held in memory and mirrored to profiles.json on every
/// mutation. Francois is the only writer, so memory is the source of truth
/// after the one load at startup (`load_profiles`).
#[derive(Default)]
pub struct ProfileRegistry {
    profiles: Mutex<Vec<SessionProfile>>,
}

// ---------- shared messages ----------

pub(crate) const NOT_FOUND_MSG: &str = "no such profile";
pub(crate) const BAD_NAME_MSG: &str = "a profile name must be 1-60 characters";
pub(crate) const BAD_PROMPT_MSG: &str = "the system prompt is too long";
pub(crate) const BAD_EXTRA_ARGS_MSG: &str = "extra args are too long";
pub(crate) const UNTERMINATED_QUOTE_MSG: &str = "extra args contain an unterminated quote";
