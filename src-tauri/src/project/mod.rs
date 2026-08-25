// project.rs — the `project` domain (specs/projects.md).
//
// A project is a named, persisted workspace rooted at a directory, owning
//  (a) session DEFAULTS that pre-fill the new-session modal — a snapshot, copied
//      onto the session at creation and never re-applied (FR-24), and
//  (b) coding STANDARDS that Francois writes into that repo's own CLAUDE.md
//      inside a delimited managed block (FR-11..FR-14), so plain `claude` runs and
//      teammates pick them up natively via git.
//
// Two very different persistence surfaces, deliberately split:
//  * projects.json in the app data dir — Francois is its ONLY writer, so the whole
//    document is rewritten atomically on every mutation (registry.rs).
//  * <root>/CLAUDE.md — a HAND-WRITTEN, git-tracked file this app shares with the
//    user and their editor. Every byte outside the two marker lines is preserved
//    verbatim, and a file whose markers are malformed is never written at all
//    (standards.rs — the same "refuses to touch what it does not understand"
//    discipline permission-guardrails applies to settings.json).
//
// This feature defines NO event channel (spec §5 preamble): every mutation is
// initiated by this app's own frontend and resolves with the new state. The one
// piece of project state that reaches other features — SessionMeta.projectId —
// rides on the existing `session.meta` SessionEvent.

mod commands;
mod registry;
mod repo_brief;
mod standards;

pub(crate) use commands::*;
pub(crate) use registry::*;
pub(crate) use repo_brief::*;
pub(crate) use standards::*;

#[cfg(test)]
mod testutil;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// ---------- contract types (contract/projects.ts + contract/common.ts, mirrored) ----------

/// Mirrors `ProjectDefaults` in contract/common.ts. Every field is optional: an
/// ABSENT field means "inherit" — the modal keeps its pre-feature default for that
/// control. Absent must serialize as an OMITTED key (never `null`), because that
/// is how the frontend distinguishes "inherit" from "explicitly set".
///
/// The values are stored VERBATIM and never validated here: `session_create` is
/// the gate that rejects an impossible combination (§7 #22..#24), and a project
/// default that a model no longer advertises must survive so the modal can show it
/// dim rather than have the core silently rewrite the user's configuration.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ProjectDefaults {
    #[serde(rename = "modelId", default, skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(
        rename = "permissionMode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime: Option<String>,
    #[serde(rename = "allowGit", default, skip_serializing_if = "Option::is_none")]
    allow_git: Option<bool>,
    /// multi-account FR-20: the account a new session under this project opens
    /// on. CLEARED HERE when the account it names is removed
    /// (`clear_default_account`); the modal's fallback to the isDefault account
    /// stays the backstop for a clear that could not be persisted, and for
    /// registries written before the sweep existed.
    #[serde(rename = "accountId", default, skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    /// session-profiles FR-20/FR-21: the profile a new session under this
    /// project starts with. Unlike every other default, this one is CLEARED
    /// HERE when the profile it names is deleted (`clear_default_profile`), so
    /// the registry does not accumulate references to profiles that are gone.
    /// The modal still drops an unresolvable id silently (FR-21) — that stays
    /// the backstop for a clear that could not be persisted, and for registries
    /// written before the sweep existed.
    #[serde(rename = "profileId", default, skip_serializing_if = "Option::is_none")]
    profile_id: Option<String>,
    /// response-mode FR-16: the response mode a new session under this project
    /// opens on. Stored VERBATIM like every other default here — `session_create`
    /// is the gate that rejects a value outside the enum, and the modal reads an
    /// unknown one as 'default' (§7).
    #[serde(
        rename = "responseMode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    response_mode: Option<String>,
}

/// One registry entry, exactly as persisted in projects.json (FR-1). `rootExists`
/// is NOT here on purpose — it is derived at list time (FR-2).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Project {
    id: String,
    name: String,
    /// Absolute, normalized (FR-8). Unique across the registry.
    root: String,
    #[serde(default)]
    defaults: ProjectDefaults,
    #[serde(rename = "createdAt", default)]
    created_at: u64,
    #[serde(rename = "lastUsedAt", default)]
    last_used_at: u64,
    /// project-groups FR-6: the group this project belongs to; absent ⇒
    /// ungrouped. Must serialize as an OMITTED key, never `null` — same
    /// discipline as every `ProjectDefaults` field.
    #[serde(rename = "groupId", default, skip_serializing_if = "Option::is_none")]
    group_id: Option<String>,
}

/// Mirrors `ProjectMeta` in contract/projects.ts — a `Project` plus the derived
/// `rootExists` (FR-2, never persisted).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProjectMeta {
    id: String,
    name: String,
    root: String,
    defaults: ProjectDefaults,
    #[serde(rename = "createdAt")]
    created_at: u64,
    #[serde(rename = "lastUsedAt")]
    last_used_at: u64,
    #[serde(rename = "rootExists")]
    root_exists: bool,
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
    group_id: Option<String>,
}

// ---------- project-groups: the entity ----------

/// Mirrors `ProjectGroup` in contract/projects.ts (project-groups FR-1).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectGroup {
    id: String,
    /// Trimmed, 1–MAX_GROUP_NAME_LENGTH. NOT unique (FR-4).
    name: String,
    #[serde(rename = "createdAt", default)]
    created_at: u64,
}

/// Mirrors `ProjectStandards` in contract/projects.ts — the structured content of
/// the managed block. Rules are identified by their INDEX; the whole object is
/// written on every change.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ProjectStandards {
    #[serde(default)]
    notes: String,
    #[serde(default)]
    rules: Vec<String>,
}

/// Mirrors `StandardsRead` in contract/projects.ts — what a read reports about
/// `<root>/CLAUDE.md` on disk.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct StandardsRead {
    standards: ProjectStandards,
    #[serde(rename = "fileExists")]
    file_exists: bool,
    #[serde(rename = "blockPresent")]
    block_present: bool,
}

/// Mirrors `ProjectRegistrySnapshot` in contract/projects.ts — the
/// `project_list` response shape (project-groups §5, WAS `ProjectMeta[]`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProjectRegistrySnapshot {
    projects: Vec<ProjectMeta>,
    groups: Vec<ProjectGroup>,
}

// ---------- managed state ----------

/// The two arrays persisted together in projects.json (FR-1, project-groups
/// FR-2). Held behind ONE mutex (below) rather than one-per-array: every
/// mutation — project or group — touches the SAME document on disk, so a single
/// lock is what makes "memory and disk always agree" (FR-10) actually true.
/// Two independent locks let a project write and a group write interleave and
/// each clobber the other's half of the document with a stale snapshot, and
/// project mutations acquiring the groups lock (or vice versa) from inside their
/// own persist step is a lock-order inversion waiting to deadlock — seen in
/// earlier revisions of this file.
#[derive(Default)]
pub(crate) struct RegistryDocument {
    pub(crate) projects: Vec<Project>,
    pub(crate) groups: Vec<ProjectGroup>,
}

/// The whole registry, held in memory and mirrored to projects.json on every
/// mutation. Francois is the only writer, so memory is the source of truth after
/// the one load at startup (`load_projects`).
#[derive(Default)]
pub struct ProjectRegistry {
    doc: Mutex<RegistryDocument>,
}

// ---------- shared messages ----------

pub(crate) const NOT_FOUND_MSG: &str = "no such project";
pub(crate) const ROOT_MISSING_MSG: &str = "the project's root directory no longer exists";
pub(crate) const BAD_ROOT_MSG: &str = "project root does not exist or is not a directory";
pub(crate) const DUPLICATE_ROOT_MSG: &str = "another project already owns that directory";
pub(crate) const GROUP_NOT_FOUND_MSG: &str = "no such project group";
pub(crate) const BAD_GROUP_NAME_MSG: &str = "a group name must be 1–80 characters";
