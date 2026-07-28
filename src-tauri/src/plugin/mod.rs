// plugin/ — the `plugins` domain (specs/plugin-system.md).
//
// Capability-sandboxed third-party extensions. The whole point of the feature is
// the boundary: plugin JavaScript runs in a QuickJS isolate INSIDE this core, and
// the webview only ever receives core-validated `PanelSpec` / `StatusItemSpec`
// JSON. No plugin code, in any form, reaches the frontend.
//
// This file owns the shared data model (the serde mirrors of
// contract/plugin-system.ts) and declares the children; each child owns one
// concern plus its own tests:
//   registry.rs  — plugins.json load/save (atomic + rollback), consentPending,
//                  enablement resolution, project-removal cleanup (FR-16/75..80)
//   install.rs   — source parsing, git/npm resolution, staging, unpack limits and
//                  path-traversal defense, the update swap (FR-1..FR-15)
//   isolate.rs   — the QuickJS runtime, the empty-global policy, the five limits,
//                  module evaluation, the invocation thread pool (FR-17..FR-24)
//   hostapi.rs   — the `francois` object and its capability gating (FR-25..FR-33)
//   net.rs       — the allowlisted fetch proxy (FR-31)
//   panelspec.rs — validation/normalization of every returned spec (FR-34..FR-44)
//   secrets.rs   — secret.key + XChaCha20-Poly1305 + the `enc:v1:` envelope (FR-65/66)
//   injection.rs — pending prompt requests, rate limits, expiry, and the hand-off
//                  into the EXISTING session send path (FR-53..FR-60)
//   commands.rs  — the twelve Tauri commands, all `#[command(async)]`

mod commands;
mod hostapi;
mod injection;
mod install;
mod isolate;
mod net;
mod panelspec;
mod registry;
mod secrets;

#[allow(unused_imports)]
#[allow(unused_imports)]
pub(crate) use commands::*;
#[allow(unused_imports)]
pub(crate) use hostapi::*;
#[allow(unused_imports)]
pub(crate) use injection::*;
#[allow(unused_imports)]
pub(crate) use install::*;
#[allow(unused_imports)]
pub(crate) use isolate::*;
#[allow(unused_imports)]
pub(crate) use net::*;
#[allow(unused_imports)]
pub(crate) use panelspec::*;
#[allow(unused_imports)]
pub(crate) use registry::*;
#[allow(unused_imports)]
pub(crate) use secrets::*;

#[cfg(test)]
mod cohorte;
#[cfg(test)]
mod testutil;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub(crate) const EVENT_CHANNEL: &str = "francois://plugins/event";

// ---------- constants mirrored from contract/plugin-system.ts ----------

pub(crate) const MANIFEST_FILENAME: &str = "francois-plugin.json";
pub(crate) const SECRET_SENTINEL: &str = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}";
pub(crate) const SETTING_MAX_STRING: usize = 4000;
pub(crate) const REFRESH_INTERVAL_MIN_MS: u64 = 5_000;
pub(crate) const REFRESH_INTERVAL_MAX_MS: u64 = 3_600_000;

pub(crate) const PANEL_MAX_NODES: usize = 2000;
pub(crate) const PANEL_MAX_DEPTH: usize = 32;
pub(crate) const PANEL_MAX_TEXT: usize = 2000;
pub(crate) const PANEL_MAX_BADGE: usize = 32;
pub(crate) const PANEL_MAX_KEYHINT: usize = 8;
pub(crate) const PANEL_MAX_ACTION_LABEL: usize = 64;
pub(crate) const PANEL_MAX_TITLE: usize = 48;
pub(crate) const PANEL_MAX_EMPTY_TEXT: usize = 120;
pub(crate) const STATUS_MAX_TEXT: usize = 24;
pub(crate) const STATUS_MAX_BADGE: usize = 6;
pub(crate) const PANEL_TRUNCATED_NOTICE: &str = "\u{27e8}panel truncated\u{27e9}";
pub(crate) const PANEL_INVALID_NODE: &str = "\u{27e8}invalid node\u{27e9}";
pub(crate) const PANEL_MAX_ARG_KEYS: usize = 16;
pub(crate) const PANEL_MAX_ARG_KEY_LEN: usize = 64;
pub(crate) const PANEL_MAX_ARG_VALUE_LEN: usize = 512;

pub(crate) const STAGING_TTL_MS: u64 = 600_000;
/// FR-73. Mirrored from the contract for completeness, but the FRONTEND owns
/// this threshold: the core only reports `consecutive`, and the refresh timer it
/// stops lives in the pane (FR-70). Kept here so the two cannot silently differ.
#[allow(dead_code)]
pub(crate) const PLUGIN_FAILURE_LIMIT: u32 = 5;

pub(crate) const ISOLATE_MEMORY_LIMIT_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const ISOLATE_MAX_STACK_BYTES: usize = 512 * 1024;
pub(crate) const ISOLATE_CPU_DEADLINE_MS: u64 = 2_000;
pub(crate) const ISOLATE_WALL_DEADLINE_MS: u64 = 10_000;
pub(crate) const ISOLATE_MAX_IO_CALLS: u32 = 8;
pub(crate) const ISOLATE_MAX_CONCURRENT: usize = 4;

pub(crate) const STORAGE_MAX_KEY_LEN: usize = 128;
pub(crate) const STORAGE_MAX_BYTES: usize = 256 * 1024;

pub(crate) const FETCH_MAX_PER_INVOCATION: u32 = 4;
pub(crate) const FETCH_MAX_REQUEST_BYTES: usize = 1024 * 1024;
pub(crate) const FETCH_MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
pub(crate) const FETCH_TIMEOUT_MS: u64 = 15_000;

pub(crate) const INJECTION_MAX_PROMPT_CHARS: usize = 8_000;
pub(crate) const INJECTION_TTL_MS: u64 = 600_000;
pub(crate) const INJECTION_MAX_PER_MINUTE: usize = 5;

pub(crate) const UNPACK_MAX_TOTAL_BYTES: u64 = 5 * 1024 * 1024;
pub(crate) const UNPACK_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const UNPACK_MAX_ENTRIES: usize = 200;

/// FR-26: the per-plugin in-memory log ring.
pub(crate) const LOG_RING_MAX_LINES: usize = 200;
pub(crate) const LOG_MAX_LINE_CHARS: usize = 2_000;

// ---------- error codes (contract/common.ts ErrorCode, plugin members) ----------

pub(crate) const E_NOT_FOUND: &str = "PLUGIN_NOT_FOUND";
pub(crate) const E_ALREADY_INSTALLED: &str = "PLUGIN_ALREADY_INSTALLED";
pub(crate) const E_MANIFEST_INVALID: &str = "PLUGIN_MANIFEST_INVALID";
pub(crate) const E_SOURCE_UNREACHABLE: &str = "PLUGIN_SOURCE_UNREACHABLE";
pub(crate) const E_RUNTIME: &str = "PLUGIN_RUNTIME_ERROR";
pub(crate) const E_CONSENT_REQUIRED: &str = "PLUGIN_CONSENT_REQUIRED";
pub(crate) const E_INJECTION_NOT_PENDING: &str = "PLUGIN_INJECTION_NOT_PENDING";
pub(crate) const E_STORE_WRITE_FAILED: &str = "PLUGIN_STORE_WRITE_FAILED";

// ---------- manifest (contract §5.2) ----------

/// FR-31's network allowlist. `hosts` is stored VERBATIM (manifest order) because
/// the consent card shows it unabbreviated and unsorted (FR-11); matching
/// normalizes at compare time instead (`net::host_allowed`).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PluginNetwork {
    #[serde(default)]
    pub hosts: Vec<String>,
}

/// FR-9: granted as a SET, all-or-nothing — so `grantedCapabilities` always equals
/// the consented manifest's `capabilities`, and a host function is either injected
/// or ABSENT. Absent flags must serialize as OMITTED keys (never `false`/`null`) so
/// a manifest round-trips byte-identically through the registry.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PluginCapabilities {
    #[serde(rename = "readState", default, skip_serializing_if = "Option::is_none")]
    pub read_state: Option<bool>,
    #[serde(
        rename = "driveSessions",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub drive_sessions: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<PluginNetwork>,
}

impl PluginCapabilities {
    pub(crate) fn read_state(&self) -> bool {
        self.read_state == Some(true)
    }
    pub(crate) fn drive_sessions(&self) -> bool {
        self.drive_sessions == Some(true)
    }
    /// The allowlist, or an empty slice when the capability is absent.
    pub(crate) fn hosts(&self) -> &[String] {
        match &self.network {
            Some(n) => &n.hosts,
            None => &[],
        }
    }
    pub(crate) fn has_network(&self) -> bool {
        self.network.is_some()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PluginCommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glyph: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PluginPanelContribution {
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PluginContributes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<PluginCommandContribution>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel: Option<PluginPanelContribution>,
    /// `Record<string, never>` on the wire — an empty object claiming the surface.
    #[serde(rename = "statusBar", default, skip_serializing_if = "Option::is_none")]
    pub status_bar: Option<Map<String, Value>>,
}

impl PluginContributes {
    pub(crate) fn commands(&self) -> &[PluginCommandContribution] {
        match &self.commands {
            Some(c) => c,
            None => &[],
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginSettingType {
    String,
    Number,
    Boolean,
    Select,
    Secret,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PluginSettingOption {
    pub value: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PluginSettingDescriptor {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: PluginSettingType,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<PluginSettingOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PluginManifest {
    #[serde(rename = "manifestVersion")]
    pub manifest_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub entry: String,
    #[serde(default)]
    pub contributes: PluginContributes,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<Vec<PluginSettingDescriptor>>,
    #[serde(default)]
    pub capabilities: PluginCapabilities,
    #[serde(
        rename = "refreshIntervalMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub refresh_interval_ms: Option<u64>,
}

impl PluginManifest {
    pub(crate) fn configuration(&self) -> &[PluginSettingDescriptor] {
        match &self.configuration {
            Some(c) => c,
            None => &[],
        }
    }
}

// ---------- installed state (contract §5.2) ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginSourceKind {
    Github,
    Npm,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PluginSource {
    pub kind: PluginSourceKind,
    pub spec: String,
}

/// FR-75. Tagged on `scope`, mirroring the contract's discriminated union.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "scope", rename_all = "lowercase")]
pub enum PluginEnablement {
    Off,
    All,
    Projects {
        #[serde(rename = "projectIds", default)]
        project_ids: Vec<String>,
    },
}

impl Default for PluginEnablement {
    fn default() -> Self {
        PluginEnablement::Off
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum PluginSurface {
    Panel,
    StatusBar,
    Command,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PluginRuntimeError {
    pub at: u64,
    pub surface: PluginSurface,
    pub message: String,
}

/// One registry entry, exactly as persisted in plugins.json. `settings` here is the
/// RAW store — non-secret values in plaintext, secrets as `enc:v1:…` envelopes
/// (FR-65). The webview never sees this shape; `to_view` produces `InstalledPlugin`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PluginEntry {
    /// The last CONSENTED manifest. Re-read from disk at load (FR-69); this copy is
    /// what keeps an entry renderable when its install directory went missing.
    pub manifest: PluginManifest,
    pub source: PluginSource,
    #[serde(rename = "resolvedRef")]
    pub resolved_ref: String,
    #[serde(rename = "installPath")]
    pub install_path: String,
    #[serde(rename = "installedAt")]
    pub installed_at: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(default)]
    pub enablement: PluginEnablement,
    #[serde(rename = "grantedCapabilities", default)]
    pub granted_capabilities: PluginCapabilities,
    #[serde(default)]
    pub settings: Map<String, Value>,
    /// Never persisted — recomputed at load from the on-disk manifest (FR-16).
    #[serde(skip)]
    pub consent_pending: bool,
    /// Never persisted — a fresh run starts clean (§6).
    #[serde(skip)]
    pub last_error: Option<PluginRuntimeError>,
    /// Never persisted — the manifest actually on disk, when it differs from the
    /// consented one (FR-16). `None` ⇒ the directory is missing or unreadable.
    #[serde(skip)]
    pub disk_manifest: Option<PluginManifest>,
}

/// `InstalledPlugin` as it crosses to the WEBVIEW (contract §5.2): the ON-DISK
/// manifest (so the modal can show what the update wants), the granted set, and
/// settings with secrets redacted (FR-64).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub source: PluginSource,
    #[serde(rename = "resolvedRef")]
    pub resolved_ref: String,
    #[serde(rename = "installPath")]
    pub install_path: String,
    #[serde(rename = "installedAt")]
    pub installed_at: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    pub enablement: PluginEnablement,
    #[serde(rename = "grantedCapabilities")]
    pub granted_capabilities: PluginCapabilities,
    #[serde(rename = "consentPending")]
    pub consent_pending: bool,
    pub settings: Map<String, Value>,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    pub last_error: Option<PluginRuntimeError>,
}

// ---------- PanelSpec (contract §5.3) ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PanelTone {
    Default,
    Dim,
    Accent,
    Success,
    Warn,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PanelGap {
    Sm,
    Md,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PanelAlign {
    Start,
    Center,
    Between,
}

/// FROZEN for version 1 (FR-35): exactly these ten types. Every value of this enum
/// is produced by `panelspec::validate_panel` — a plugin's raw JSON never reaches
/// this type directly, so an unknown/malformed node becomes the `⟨invalid node⟩`
/// text placeholder instead of failing the whole panel.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PanelNode {
    Text {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tone: Option<PanelTone>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wrap: Option<bool>,
    },
    Row {
        children: Vec<PanelNode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gap: Option<PanelGap>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        align: Option<PanelAlign>,
    },
    Stack {
        children: Vec<PanelNode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gap: Option<PanelGap>,
    },
    List {
        items: Vec<PanelNode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selectable: Option<bool>,
        #[serde(rename = "emptyText", default, skip_serializing_if = "Option::is_none")]
        empty_text: Option<String>,
    },
    Badge {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tone: Option<PanelTone>,
    },
    Keyhint {
        value: String,
    },
    Divider,
    Action {
        label: String,
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Map<String, Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyhint: Option<String>,
    },
    Progress {
        percent: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Spinner {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PanelSpec {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub nodes: Vec<PanelNode>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StatusItemSpec {
    pub version: u32,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<PanelTone>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    #[serde(rename = "commandId", default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
}

// ---------- events (contract §5.4) ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginInstallPhase {
    Resolving,
    Downloading,
    Verifying,
    Unpacking,
    Done,
    Failed,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type")]
pub enum PluginEvent {
    #[serde(rename = "plugin.registry")]
    Registry { plugins: Vec<InstalledPlugin> },
    #[serde(rename = "plugin.invalidated")]
    Invalidated {
        #[serde(rename = "pluginId")]
        plugin_id: String,
        surface: PluginSurface,
    },
    #[serde(rename = "plugin.error")]
    Error {
        #[serde(rename = "pluginId")]
        plugin_id: String,
        error: PluginRuntimeError,
        consecutive: u32,
    },
    #[serde(rename = "plugin.install.progress")]
    InstallProgress {
        #[serde(rename = "stagingId")]
        staging_id: String,
        phase: PluginInstallPhase,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

pub(crate) fn emit(app: &AppHandle, ev: PluginEvent) {
    let _ = app.emit(EVENT_CHANNEL, ev);
}

// ---------- managed state (§6) ----------

/// A resolved-but-not-committed tree (FR-5). Swept after STAGING_TTL_MS.
pub(crate) struct StagedTree {
    pub dir: std::path::PathBuf,
    pub manifest: PluginManifest,
    pub source: PluginSource,
    pub resolved_ref: String,
    pub unpacked_bytes: u64,
    pub created_at: u64,
    /// Set when the staging belongs to an in-flight update of an installed plugin.
    pub updating: Option<String>,
}

/// A pending injection request, keyed by its transcript BlockId (FR-53/FR-57).
#[derive(Clone)]
pub(crate) struct PendingInjection {
    pub plugin_id: String,
    pub plugin_name: String,
    pub session_id: String,
    pub request: Value,
    pub prompt: String,
    pub expires_at: u64,
}

/// Everything the domain holds in memory. Only the registry is persisted; log
/// buffers, failure counters, rate windows, staging and pending injections all die
/// with the process (§6).
#[derive(Default)]
pub(crate) struct PluginInner {
    pub plugins: Vec<PluginEntry>,
    pub staging: HashMap<String, StagedTree>,
    pub logs: HashMap<String, VecDeque<String>>,
    pub failures: HashMap<(String, PluginSurface), u32>,
    pub injections: HashMap<String, PendingInjection>,
    /// pluginId → the request timestamps inside the rolling minute (FR-54).
    pub injection_window: HashMap<String, VecDeque<u64>>,
    /// The last validated spec per surface, returned when a tick is dropped (FR-22).
    pub last_panel: HashMap<String, Option<PanelSpec>>,
    pub last_status: HashMap<String, Option<StatusItemSpec>>,
    /// FR-79: set once when an unparseable plugins.json was backed up at startup.
    pub registry_reset: bool,
    /// FR-66: set when a stored `enc:v1:` value could not be opened.
    pub secrets_unreadable: bool,
}

/// The Tauri-managed state for the whole domain. `inner` is a leaf lock: no other
/// mutex is ever taken while it is held, and it is ALWAYS released before an
/// isolate invocation is dispatched (FR-22 — nothing blocks on plugin code).
#[derive(Default)]
pub struct PluginState {
    pub(crate) inner: Mutex<PluginInner>,
    pub(crate) pool: isolate::IsolatePool,
}

// ---------- helpers ----------

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// FR-2: the id is the install-directory name, the registry key, the PaneId suffix
/// and every attribution string — so it must be a charset that can never escape a
/// directory or collide with a path separator.
pub(crate) fn valid_plugin_id(id: &str) -> bool {
    let n = id.len();
    if !(2..=64).contains(&n) {
        return false;
    }
    let mut bytes = id.bytes();
    let first = bytes.next().unwrap_or(b'-');
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// FR-61: `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`.
pub(crate) fn valid_setting_key(key: &str) -> bool {
    let n = key.len();
    if !(1..=64).contains(&n) {
        return false;
    }
    let mut bytes = key.bytes();
    let first = bytes.next().unwrap_or(b'0');
    if !first.is_ascii_alphabetic() {
        return false;
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// FR-36/FR-54: strip control characters (keeping the ones the caller allows) and
/// truncate to `max` CHARS — never bytes, so a multi-byte grapheme is never split.
pub(crate) fn clean_text(raw: &str, max: usize, keep_newlines: bool) -> String {
    let mut out = String::with_capacity(raw.len().min(max));
    for c in raw.chars() {
        let keep = if c == '\n' || c == '\t' {
            keep_newlines
        } else {
            !c.is_control()
        };
        if keep {
            out.push(c);
            if out.chars().count() >= max {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plugin_id_pattern_matches_the_contract() {
        // ^[a-z0-9][a-z0-9-]{1,63}$ — 2..=64 chars
        assert!(valid_plugin_id("acme-ci"));
        assert!(valid_plugin_id("a1"));
        assert!(valid_plugin_id("9x"));
        assert!(!valid_plugin_id("a")); // too short
        assert!(!valid_plugin_id("-acme")); // must not start with '-'
        assert!(!valid_plugin_id("Acme")); // no uppercase
        assert!(!valid_plugin_id("acme_ci")); // no underscore
        assert!(!valid_plugin_id("../evil"));
        assert!(!valid_plugin_id("a/b"));
        assert!(!valid_plugin_id(""));
        assert!(!valid_plugin_id(&"a".repeat(65)));
        assert!(valid_plugin_id(&"a".repeat(64)));
    }

    #[test]
    fn setting_key_pattern_matches_the_contract() {
        assert!(valid_setting_key("token"));
        assert!(valid_setting_key("a"));
        assert!(valid_setting_key("A_b-9"));
        assert!(!valid_setting_key("9lives")); // must start with a letter
        assert!(!valid_setting_key(""));
        assert!(!valid_setting_key("a b"));
        assert!(!valid_setting_key(&format!("a{}", "b".repeat(64))));
    }

    #[test]
    fn clean_text_strips_control_chars_and_truncates_by_chars() {
        assert_eq!(clean_text("a\u{7}b", 10, false), "ab");
        assert_eq!(clean_text("a\nb", 10, false), "ab");
        assert_eq!(clean_text("a\nb\tc", 10, true), "a\nb\tc");
        // truncation counts CHARS, never bytes
        assert_eq!(clean_text("éééé", 2, false), "éé");
        assert_eq!(clean_text("hello", 3, false), "hel");
    }

    #[test]
    fn enablement_serializes_as_the_contract_union() {
        for (v, expect) in [
            (PluginEnablement::Off, json!({ "scope": "off" })),
            (PluginEnablement::All, json!({ "scope": "all" })),
            (
                PluginEnablement::Projects {
                    project_ids: vec!["p1".into()],
                },
                json!({ "scope": "projects", "projectIds": ["p1"] }),
            ),
        ] {
            assert_eq!(serde_json::to_value(&v).unwrap(), expect);
            assert_eq!(
                serde_json::from_value::<PluginEnablement>(expect).unwrap(),
                v
            );
        }
    }

    #[test]
    fn capabilities_omit_absent_flags_entirely() {
        // FR-9: absent ⇒ the key is missing, never `false`. A manifest must
        // round-trip byte-identically or `consentPending` would flap.
        let caps = PluginCapabilities {
            read_state: Some(true),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&caps).unwrap(),
            json!({ "readState": true })
        );
        let empty = PluginCapabilities::default();
        assert_eq!(serde_json::to_value(&empty).unwrap(), json!({}));
        assert!(!empty.read_state() && !empty.drive_sessions() && !empty.has_network());
        assert!(empty.hosts().is_empty());
    }

    #[test]
    fn panel_node_union_round_trips_every_one_of_the_ten_types() {
        // FR-35 (§9 · PanelSpec): the ten-member frozen vocabulary, tagged on `type`.
        let nodes = json!([
            { "type": "text", "value": "hi", "tone": "accent", "wrap": true },
            { "type": "row", "children": [{ "type": "divider" }], "gap": "md", "align": "between" },
            { "type": "stack", "children": [], "gap": "sm" },
            { "type": "list", "items": [{ "type": "keyhint", "value": "⏎" }], "selectable": true, "emptyText": "none" },
            { "type": "badge", "value": "ok", "tone": "success" },
            { "type": "keyhint", "value": "⌘K" },
            { "type": "divider" },
            { "type": "action", "label": "open", "commandId": "open-run", "args": { "runId": "4821" }, "keyhint": "⏎" },
            { "type": "progress", "percent": 42.0, "label": "half" },
            { "type": "spinner", "label": "loading" }
        ]);
        let parsed: Vec<PanelNode> = serde_json::from_value(nodes.clone()).unwrap();
        assert_eq!(parsed.len(), 10);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), nodes);

        // absent optionals are OMITTED, never null
        let bare: Vec<PanelNode> =
            serde_json::from_value(json!([{ "type": "text", "value": "x" }])).unwrap();
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            json!([{ "type": "text", "value": "x" }])
        );
    }

    #[test]
    fn panel_and_status_specs_round_trip() {
        let spec = PanelSpec {
            version: 1,
            title: Some("CI".into()),
            nodes: vec![PanelNode::Divider],
        };
        let v = serde_json::to_value(&spec).unwrap();
        assert_eq!(
            v,
            json!({ "version": 1, "title": "CI", "nodes": [{ "type": "divider" }] })
        );
        assert_eq!(serde_json::from_value::<PanelSpec>(v).unwrap(), spec);

        let item = StatusItemSpec {
            version: 1,
            text: "3 failing".into(),
            tone: Some(PanelTone::Error),
            badge: None,
            command_id: Some("open".into()),
        };
        assert_eq!(
            serde_json::to_value(&item).unwrap(),
            json!({ "version": 1, "text": "3 failing", "tone": "error", "commandId": "open" })
        );
    }

    #[test]
    fn plugin_event_union_serializes_to_the_contract_shape() {
        let ev = PluginEvent::Invalidated {
            plugin_id: "acme-ci".into(),
            surface: PluginSurface::StatusBar,
        };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            json!({ "type": "plugin.invalidated", "pluginId": "acme-ci", "surface": "statusBar" })
        );

        let ev = PluginEvent::Error {
            plugin_id: "acme-ci".into(),
            error: PluginRuntimeError {
                at: 5,
                surface: PluginSurface::Panel,
                message: "execution deadline exceeded".into(),
            },
            consecutive: 5,
        };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            json!({ "type": "plugin.error", "pluginId": "acme-ci", "consecutive": 5,
                "error": { "at": 5, "surface": "panel", "message": "execution deadline exceeded" } })
        );

        let ev = PluginEvent::InstallProgress {
            staging_id: "s1".into(),
            phase: PluginInstallPhase::Downloading,
            message: None,
        };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            json!({ "type": "plugin.install.progress", "stagingId": "s1", "phase": "downloading" })
        );

        let ev = PluginEvent::Registry {
            plugins: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            json!({ "type": "plugin.registry", "plugins": [] })
        );
    }

    #[test]
    fn manifest_round_trips_through_serde() {
        let raw = json!({
            "manifestVersion": 1,
            "id": "acme-ci",
            "name": "Acme CI",
            "version": "1.2.0",
            "description": "CI runs at a glance",
            "author": "Acme",
            "entry": "dist/plugin.js",
            "contributes": {
                "commands": [{ "id": "open-run", "title": "Open run", "glyph": "⌁", "palette": true }],
                "panel": { "title": "CI" },
                "statusBar": {}
            },
            "configuration": [
                { "key": "repo", "type": "string", "label": "owner/repo", "default": "acme/x" },
                { "key": "token", "type": "secret", "label": "github token" },
                { "key": "mode", "type": "select", "label": "mode",
                  "options": [{ "value": "a", "label": "A" }] },
                { "key": "poll", "type": "number", "label": "poll", "min": 5.0, "max": 60.0 }
            ],
            "capabilities": { "readState": true, "network": { "hosts": ["api.github.com"] } },
            "refreshIntervalMs": 30000
        });
        let m: PluginManifest = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(m.id, "acme-ci");
        assert_eq!(m.configuration().len(), 4);
        assert_eq!(m.configuration()[1].kind, PluginSettingType::Secret);
        assert!(m.capabilities.read_state() && !m.capabilities.drive_sessions());
        assert_eq!(m.capabilities.hosts(), ["api.github.com"]);
        assert_eq!(serde_json::to_value(&m).unwrap(), raw);
    }

    #[test]
    fn installed_plugin_wire_shape_omits_absent_last_error() {
        let p = InstalledPlugin {
            manifest: crate::plugin::testutil::manifest_fixture("acme-ci"),
            source: PluginSource {
                kind: PluginSourceKind::Github,
                spec: "acme/francois-ci".into(),
            },
            resolved_ref: "8f2c1a9".into(),
            install_path: "/tmp/plugins/acme-ci".into(),
            installed_at: 1,
            updated_at: 2,
            enablement: PluginEnablement::Off,
            granted_capabilities: PluginCapabilities::default(),
            consent_pending: false,
            settings: Map::new(),
            last_error: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("lastError").is_none());
        assert_eq!(v["source"]["kind"], "github");
        assert_eq!(v["enablement"], json!({ "scope": "off" }));
        assert_eq!(v["consentPending"], false);
    }
}
