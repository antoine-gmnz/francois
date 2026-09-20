// profiles/mod.rs — the `profiles` domain (specs/session-profiles.md,
// amended by pi-migration-rollout).
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
//
// pi-migration-rollout FR-2/FR-6: `SessionProfile` is now a runtime-tagged
// union — `LegacySessionProfile | PiSessionProfile`, matching
// contract/session-profiles.ts exactly. A stored entry with NO `kind` key
// (every profile written before this feature) loads as `Legacy`; the on-disk
// registry itself carries a schema VERSION (`migration.rs`) so that
// normalization is recorded once, atomically, with a backup, rather than
// re-derived from a missing field on every load forever.

mod commands;
/// pi-migration-rollout FR-6/FR-10: the profiles.json schema-version
/// migration — versioned, idempotent, atomic, backed up once before the
/// first write. A sibling of `registry.rs` (data-shape migration vs.
/// in-memory CRUD) — `registry.rs` is `migrate_registry`'s only caller.
mod migration;
mod parse;
/// pi-migration-rollout FR-5: `PiProfileSettings` validation — the
/// mode/prompt rule, path shape/bounds, and the certified built-in tool
/// allowlist. A sibling of `parse.rs` (Pi settings vs. legacy extraArgs) —
/// same "one concern per child" split this domain already uses.
mod pi_settings;
mod registry;

pub use commands::*;
pub use migration::{migrate_registry, MigrationOutcome, PROFILE_SCHEMA_VERSION};
pub(crate) use parse::*;
pub use pi_settings::*;
pub use registry::*;

#[cfg(test)]
mod testutil;

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

// ---------- bounds (contract/session-profiles.ts, mirrored — FR-6) ----------

pub const MAX_PROFILE_NAME: usize = 60;
pub const MAX_SYSTEM_PROMPT: usize = 16384;
pub const MAX_EXTRA_ARGS_RAW: usize = 4096;

/// pi-migration-rollout FR-5/§5: contract's `MAX_PI_INSTRUCTION_PATHS`/`MAX_PI_SKILL_PATHS`.
pub const MAX_PI_INSTRUCTION_PATHS: usize = 20;
pub const MAX_PI_SKILL_PATHS: usize = 50;

// ---------- contract types (contract/session-profiles.ts, mirrored) ----------

/// Mirrors `LegacySessionProfile` in contract/session-profiles.ts. The `kind:
/// 'legacy'` tag is NOT a field here — it is injected by the wrapping
/// `SessionProfile` enum's internal tag (`#[serde(tag = "kind")]`), the same
/// shape `shell::ShellOwner`/`session::RuntimeEventPayload` already use for a
/// contract union, so every entry serialized over IPC always carries it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LegacySessionProfile {
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

// ---------- pi-migration-rollout: the Pi profile (contract §5) ----------

/// Mirrors contract's `PI_BUILTIN_TOOLS` — the certified Pi built-in tool
/// names, the ONLY values `PiProfileSettings.tools` accepts. An unknown name
/// REJECTS at validation (`pi_settings::validate_pi_settings`) rather than
/// broadening to defaults.
pub const PI_BUILTIN_TOOLS: &[&str] = &["read", "write", "edit", "bash", "grep", "find", "ls"];

/// Mirrors `PiBuiltinTool` (contract/session-profiles.ts).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PiBuiltinTool {
    Read,
    Write,
    Edit,
    Bash,
    Grep,
    Find,
    Ls,
}

impl PiBuiltinTool {
    /// Same order as `PI_BUILTIN_TOOLS` — `parse`/`as_str` are built directly
    /// off that pairing so the two can never silently drift apart.
    const ALL: [PiBuiltinTool; 7] = [
        Self::Read,
        Self::Write,
        Self::Edit,
        Self::Bash,
        Self::Grep,
        Self::Find,
        Self::Ls,
    ];

    pub(crate) fn parse(raw: &str) -> Option<Self> {
        PI_BUILTIN_TOOLS
            .iter()
            .position(|&name| name == raw)
            .map(|i| Self::ALL[i])
    }

    pub(crate) fn as_str(self) -> &'static str {
        let i = Self::ALL
            .iter()
            .position(|&t| t == self)
            .expect("PiBuiltinTool::ALL lists every variant");
        PI_BUILTIN_TOOLS[i]
    }
}

/// Mirrors `PiProfileSettings.systemPromptMode`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PiSystemPromptMode {
    Default,
    Append,
    Replace,
}

/// Mirrors `PiProfileSettings.projectResources`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PiProjectResources {
    Ignore,
    Allow,
}

/// Mirrors `PiProfileSettings` (contract/session-profiles.ts) — the
/// VALIDATED, stored shape. Built only by `pi_settings::validate_pi_settings`
/// (never constructed piecemeal elsewhere), so every instance in memory
/// already satisfies the mode/prompt rule and the path/tool bounds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PiProfileSettings {
    #[serde(rename = "systemPromptMode")]
    pub(crate) system_prompt_mode: PiSystemPromptMode,
    #[serde(
        rename = "systemPrompt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) system_prompt: Option<String>,
    #[serde(rename = "instructionPaths", default)]
    pub(crate) instruction_paths: Vec<String>,
    #[serde(rename = "skillPaths", default)]
    pub(crate) skill_paths: Vec<String>,
    #[serde(default)]
    pub(crate) tools: Vec<PiBuiltinTool>,
    #[serde(rename = "projectResources")]
    pub(crate) project_resources: PiProjectResources,
}

/// Mirrors `PiSessionProfile`. Same field bounds as `LegacySessionProfile`'s
/// `name`; `kind: 'pi'` is the wrapping enum's tag, not a field here.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PiSessionProfile {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) settings: PiProfileSettings,
    #[serde(rename = "createdAt", default)]
    pub(crate) created_at: u64,
    #[serde(rename = "updatedAt", default)]
    pub(crate) updated_at: u64,
}

/// Mirrors `SessionProfile = LegacySessionProfile | PiSessionProfile`.
/// Internally tagged on `kind` — `#[serde(tag = "kind")]` over newtype
/// variants wrapping a struct is the same shape `shell::ShellOwner` and
/// `session::RuntimeEventPayload` already use for a contract union, so this
/// is not a new pattern in the codebase.
///
/// A registry entry whose `kind` this build does NOT recognize never reaches
/// this enum at all (FR-6): `registry::parse_registry` keeps it as a raw,
/// untouched `serde_json::Value` in `ProfileRegistry.unknown` instead of
/// attempting (and failing) to deserialize it here.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SessionProfile {
    Legacy(LegacySessionProfile),
    Pi(PiSessionProfile),
}

impl SessionProfile {
    pub fn id(&self) -> &str {
        match self {
            SessionProfile::Legacy(p) => &p.id,
            SessionProfile::Pi(p) => &p.id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            SessionProfile::Legacy(p) => &p.name,
            SessionProfile::Pi(p) => &p.name,
        }
    }

    /// `"legacy"` | `"pi"` — the wire spelling of the `kind` tag, for
    /// PROFILE_RUNTIME_MISMATCH checks at the command layer (FR-2).
    pub fn kind(&self) -> &'static str {
        match self {
            SessionProfile::Legacy(_) => "legacy",
            SessionProfile::Pi(_) => "pi",
        }
    }
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
pub struct ProfileRegistry {
    profiles: Mutex<Vec<SessionProfile>>,
    /// pi-migration-rollout FR-6: entries whose `kind` this build does not
    /// understand — preserved verbatim across every future write, never
    /// surfaced to `profiles_list`, never reinterpreted.
    unknown: Mutex<Vec<serde_json::Value>>,
    /// pi-migration-rollout FR-6: `false` when the on-disk schema could not
    /// be safely migrated — a newer schema version than this build
    /// understands, or a migration write that failed. Every `profiles_*`
    /// command refuses (INTERNAL) while this is `false`, and the original
    /// file is left completely untouched on disk.
    writable: Mutex<bool>,
}

impl Default for ProfileRegistry {
    /// A brand-new registry (no profiles.json on disk yet, or a unit test
    /// that never calls `load_profiles`) starts WRITABLE — the existing "a
    /// missing profiles.json is an empty, usable registry" behaviour (FR-4).
    /// `load_profiles` is what flips this to `false`, and only when the file
    /// it actually read could not be trusted.
    fn default() -> Self {
        ProfileRegistry {
            profiles: Mutex::new(Vec::new()),
            unknown: Mutex::new(Vec::new()),
            writable: Mutex::new(true),
        }
    }
}

// ---------- cross-domain: removal notification ----------

/// pr-142 §9: the `profiles ↔ project` inversion, the same one
/// `session::SessionTeardown` and `account::AccountRemovalObserver` already
/// are. Removing a profile has a side-effect on another domain's state —
/// a project default naming it must stop naming it (FR-7) — and
/// `profiles_remove` used to reach across and call
/// `project::clear_default_profile` by name, closing a module cycle
/// (`project` reads `profiles::known_ids` to reconcile those same defaults at
/// boot). This domain now only declares what has to happen; `project`, which
/// owns the affected state and already depends on this one, implements it,
/// and the crate root wires the two together at startup.
///
/// **No new lock edge**: observers are called with the profile registry lock
/// already RELEASED, exactly as the direct call was, and the observer list is
/// a write-once `OnceLock` with no mutex of its own.
pub trait ProfileRemovalObserver: Send + Sync {
    fn profile_removed(&self, app: &AppHandle, profile_id: &str);
}

static REMOVAL_OBSERVERS: OnceLock<Vec<Box<dyn ProfileRemovalObserver>>> = OnceLock::new();

/// Called ONCE, from the crate root's `.setup()`. A second call is ignored —
/// see `session::register_teardown` for why that is not a panic.
pub fn register_removal_observers(observers: Vec<Box<dyn ProfileRemovalObserver>>) {
    let _ = REMOVAL_OBSERVERS.set(observers);
}

/// Notify every registered observer that `profile_id` is gone. A no-op when
/// nothing is registered, which is the case in every unit test and is correct
/// there: a test with no project registry has no default to clear.
pub(crate) fn notify_profile_removed(app: &AppHandle, profile_id: &str) {
    if let Some(observers) = REMOVAL_OBSERVERS.get() {
        for observer in observers {
            observer.profile_removed(app, profile_id);
        }
    }
}

// ---------- shared messages ----------

pub const NOT_FOUND_MSG: &str = "no such profile";
pub const BAD_NAME_MSG: &str = "a profile name must be 1-60 characters";
pub const BAD_PROMPT_MSG: &str = "the system prompt is too long";
pub const BAD_EXTRA_ARGS_MSG: &str = "extra args are too long";
pub const UNTERMINATED_QUOTE_MSG: &str = "extra args contain an unterminated quote";
/// pi-migration-rollout FR-2: `profiles_update`/`profiles_copyToPi(source)` refuse a
/// kind change/an already-Pi source with this reason string in the AppError message.
pub const RUNTIME_MISMATCH_MSG: &str = "a profile's runtime kind cannot change";
/// pi-migration-rollout FR-6: every mutating/listing command refuses while the
/// registry's on-disk schema could not be safely migrated.
pub const REGISTRY_UNWRITABLE_MSG: &str =
    "the profile registry could not be migrated — it is left untouched and read-only";
/// pr-142 §6: `profiles_remove` refuses when it cannot read sessions.json —
/// it would otherwise report "no sessions reference this profile" on a file
/// it never managed to parse (FR-7).
pub const UNREADABLE_SESSIONS_MSG: &str =
    "could not read the session registry, so the profile's references are unknown";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_tool_round_trips_through_parse_and_as_str() {
        for &name in PI_BUILTIN_TOOLS {
            let tool = PiBuiltinTool::parse(name).unwrap_or_else(|| panic!("{name} must parse"));
            assert_eq!(tool.as_str(), name);
        }
        assert_eq!(PiBuiltinTool::ALL.len(), PI_BUILTIN_TOOLS.len());
    }

    #[test]
    fn an_unknown_tool_name_does_not_parse() {
        assert_eq!(PiBuiltinTool::parse("exec"), None);
    }

    /// The seam itself, without an `AppHandle`: registration is the only piece
    /// with state, and the only piece that can silently be forgotten.
    ///
    /// This is the ONLY test that touches `REMOVAL_OBSERVERS` — the `OnceLock`
    /// is process-global, so a second test registering its own observers would
    /// make both non-deterministic under the parallel runner.
    #[test]
    fn removal_observer_registration_is_once_and_the_second_call_is_ignored() {
        struct Noop;
        impl ProfileRemovalObserver for Noop {
            fn profile_removed(&self, _app: &AppHandle, _profile_id: &str) {}
        }
        register_removal_observers(vec![Box::new(Noop)]);
        assert_eq!(REMOVAL_OBSERVERS.get().map(|o| o.len()), Some(1));
        register_removal_observers(vec![Box::new(Noop), Box::new(Noop)]);
        assert_eq!(
            REMOVAL_OBSERVERS.get().map(|o| o.len()),
            Some(1),
            "a second registration must not replace the wiring the app booted with"
        );
    }
}
