// extensions/ — the `extensions` domain, amended by `extension-install`
// (specs/extensions.md + specs/extension-install.md).
//
// The registry used to be a compiled `&'static [ExtensionDefinition]` array.
// `extension-install` deletes that array: the registry is now a DIRECTORY,
// `~/.francois/extensions/<id>/extension.json`, loaded and re-validated on
// app launch and on `extensions_detect` (FR-13). Nothing else ever reads a
// definition from anywhere else — no repo, no `~/.claude`, no env override.
//
// A manifest found on disk is DISABLED until the user consents to its
// declared commands (FR-15..FR-20) — discovery is not authorization.
//
// mod.rs owns the shared data model — three halves of it:
//  * the LOADED model (`LoadedExtension`, `PanelDefinition`, `ProviderSpec`,
//    `Source`, `DetectPredicate`) — what `registry.rs`/`manifest.rs` build
//    from a manifest's bytes, all OWNED (never `&'static`, since a manifest
//    is read at runtime).
//  * the WIRE model (`ExtensionInfo`, `PanelInfo`, `PanelData`,
//    `ExtensionEvent`, `ConsentState`) mirroring contract/extensions.ts.
//  * the CONSENT model (`toggles::ToggleEntry`) — the one persisted, mutable
//    input to the whole system, alongside the enabled bit.
// Children own one concern each:
//  * manifest.rs — FR-5..FR-11: parse + validate ONE extension.json (whole-
//    manifest, JSON-pointer errors) into a `LoadedExtension`.
//  * registry.rs — FR-1..FR-4, FR-13: scan the directory, load every
//    manifest, and the lookups over the result.
//  * detect.rs   — the FR-12 predicates + the per-root cache (unchanged
//    shape from `extensions` FR-4/FR-5).
//  * provider.rs — spawn, scrubbed env, timeout, output cap, the app-wide
//                  semaphore of 4 (FR-19..FR-24 of extensions, unchanged),
//                  and the `lines` adapter (FR-21..FR-23).
//  * schema.rs   — per-primitive PAYLOAD validation (`extensions` FR-25,
//                  unchanged) + FR-51 sanitization.
//  * stream.rs   — live `log-tail` streams keyed by StreamId (FR-38..FR-45
//                  of `extensions`, unchanged shape).
//  * toggles.rs  — `Toggles`, persisted to app_data_dir() — enabled bit +
//                  consent sha256 (FR-15..FR-20).
//  * commands.rs — the francois:extensions:<verb> Tauri surface.
//
// LOCK ORDER: `ExtensionState` is a LEAF — nothing here ever takes
// `session::Engine.sessions`, and no other domain takes this one.

mod commands;
mod detect;
mod manifest;
mod provider;
mod registry;
mod schema;
mod stream;
mod toggles;

#[cfg(test)]
mod testutil;

pub(crate) use commands::*;

use crate::ipc::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// francois:extensions:event → `francois://extensions/event` (§5).
pub(crate) const EVENT_CHANNEL: &str = "francois://extensions/event";

// ---------- caps (mirror the constants in contract/extensions.ts) ----------

pub(crate) const EXT_TIMEOUT_MS: u64 = 10_000;
pub(crate) const EXT_OUTPUT_CAP_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const EXT_CONCURRENCY: usize = 4;
pub(crate) const EXT_REFRESH_FLOOR_MS: u64 = 2_000;
pub(crate) const EXT_PAGE_SIZE: u32 = 100;
pub(crate) const EXT_LOG_MAX_LINES: usize = 2_000;
pub(crate) const EXT_FIELD_MAX_CHARS: usize = 512;
/// Mirrors the contract constant of the same name. `extensions_probe`/
/// `extensions_launch` are GONE (FR-24 — the dashboard action left with
/// cohorte), so nothing in the core reads this any more; it stays only so
/// the two sides do not silently drift on a constant the frontend still
/// exports.
#[allow(dead_code)]
pub(crate) const EXT_PROBE_TIMEOUT_MS: u64 = 2_000;
pub(crate) const EXT_STDERR_MAX_CHARS: usize = 2_000;
/// FR-5: `extension.json` is refused past this size.
pub(crate) const MANIFEST_MAX_BYTES: usize = 256 * 1024;
/// FR-5.
pub(crate) const MANIFEST_VERSION: u64 = 1;

/// FR-3: `^[a-z][a-z0-9-]{0,31}$` — an extension's id is its directory name.
pub(crate) fn valid_extension_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() {
        return false;
    }
    let mut len = 1;
    for c in chars {
        if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return false;
        }
        len += 1;
        if len > 32 {
            return false;
        }
    }
    true
}

/// FR-9: `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$` — argv[0] is a bare binary name.
pub(crate) fn valid_argv0(argv0: &str) -> bool {
    let mut chars = argv0.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphanumeric() || first == '_') {
        return false;
    }
    let mut len = 1;
    for c in chars {
        if !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
            return false;
        }
        len += 1;
        if len > 64 {
            return false;
        }
    }
    true
}

/// FR-10: the compiled-in shell blocklist — a load-time refusal, not a filter.
pub(crate) const SHELL_ARGV0_BLOCKLIST: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "fish",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "env",
];

/// Normalizes an `argv0` candidate for shell-blocklist comparison: lowercased, with a
/// trailing `.exe` suffix stripped. Keeps `SHELL_ARGV0_BLOCKLIST` itself as the canonical
/// lowercase bare-name list while still catching Windows executable-suffix / case variants
/// (e.g. `"bash.exe"`, `"SH"`, `"CMD.EXE"`).
pub(crate) fn normalize_argv0_for_blocklist(argv0: &str) -> String {
    let lower = argv0.to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

// ---------- wire model (contract/extensions.ts, mirrored) ----------

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PanelScope {
    Fleet,
    Project,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PrimitiveKind {
    KeyValue,
    Table,
    StatRow,
    LogTail,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StatusTone {
    Ok,
    Warn,
    Error,
    Neutral,
    Busy,
}

impl StatusTone {
    pub(crate) fn from_wire(s: &str) -> Option<StatusTone> {
        match s {
            "ok" => Some(StatusTone::Ok),
            "warn" => Some(StatusTone::Warn),
            "error" => Some(StatusTone::Error),
            "neutral" => Some(StatusTone::Neutral),
            "busy" => Some(StatusTone::Busy),
            _ => None,
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ColumnKind {
    Text,
    Status,
    Number,
    Time,
    Path,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct ColumnDef {
    pub key: String,
    pub label: String,
    pub kind: ColumnKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<u32>,
}

/// Mirrors `PanelInfo.tokenSource`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct TokenSourceInfo {
    #[serde(rename = "panelId")]
    pub panel_id: String,
    #[serde(rename = "rowKey")]
    pub row_key: String,
}

/// Mirrors `PanelInfo`. FR-24: `action` is GONE — no panel mutates anything.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct PanelInfo {
    pub id: String,
    pub label: String,
    pub scope: PanelScope,
    pub primitive: PrimitiveKind,
    pub paginated: bool,
    #[serde(rename = "refreshMs")]
    pub refresh_ms: Option<u64>,
    pub columns: Option<Vec<ColumnDef>>,
    #[serde(rename = "emptyCopy")]
    pub empty_copy: String,
    #[serde(rename = "tokenSource")]
    pub token_source: Option<TokenSourceInfo>,
}

/// Mirrors `DetectPredicate` — tagged by `kind`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind")]
pub(crate) enum DetectPredicate {
    #[serde(rename = "pathExists")]
    PathExists { path: String },
    #[serde(rename = "pathJsonEquals")]
    PathJsonEquals {
        path: String,
        pointer: String,
        equals: String,
    },
    #[serde(rename = "commandSucceeds")]
    CommandSucceeds { argv: Vec<String> },
}

/// Mirrors `ConsentState` — tagged unit variants, `{ "state": "granted" }`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "state")]
pub(crate) enum ConsentState {
    #[serde(rename = "granted")]
    Granted,
    #[serde(rename = "never")]
    Never,
    #[serde(rename = "stale")]
    Stale,
}

/// Mirrors `ExtensionSource`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct ExtensionSource {
    pub dir: String,
    /// FR-18: the sha256 of the manifest's raw bytes, hex-encoded — the value
    /// the consent dialog echoes back in `ConsentRequest.manifestSha256`, so
    /// `extensions_consent` can refuse a manifest edited mid-dialog. The EMPTY
    /// STRING when the manifest could not be read (i.e. `manifestError` is
    /// non-null), which is exactly the case where consent is not offerable
    /// anyway.
    #[serde(rename = "manifestSha256")]
    pub manifest_sha256: String,
    #[serde(rename = "declaredCommands")]
    pub declared_commands: Vec<Vec<String>>,
}

/// Mirrors `ExtensionInfo`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct ExtensionInfo {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub consent: ConsentState,
    pub detected: bool,
    #[serde(rename = "undetectedReason")]
    pub undetected_reason: Option<String>,
    #[serde(rename = "minVersionLabel")]
    pub min_version_label: Option<String>,
    pub source: ExtensionSource,
    pub predicate: DetectPredicate,
    pub panels: Vec<PanelInfo>,
    #[serde(rename = "manifestError")]
    pub manifest_error: Option<AppError>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct KeyValueRow {
    pub key: String,
    pub value: String,
    pub tone: StatusTone,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct TableRow {
    pub id: String,
    pub cells: HashMap<String, String>,
    pub tone: StatusTone,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct StatTile {
    pub label: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sublabel: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "primitive", rename_all = "kebab-case")]
pub(crate) enum PanelData {
    KeyValue {
        rows: Vec<KeyValueRow>,
    },
    Table {
        rows: Vec<TableRow>,
        offset: u32,
        #[serde(rename = "hasMore")]
        has_more: bool,
    },
    StatRow {
        tiles: Vec<StatTile>,
    },
}

/// Mirrors `ExtensionEvent` → `francois://extensions/event`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type")]
pub(crate) enum ExtensionEvent {
    #[serde(rename = "ext.stream.started")]
    StreamStarted {
        #[serde(rename = "streamId")]
        stream_id: String,
        #[serde(rename = "panelId")]
        panel_id: String,
    },
    #[serde(rename = "ext.stream.chunk")]
    StreamChunk {
        #[serde(rename = "streamId")]
        stream_id: String,
        lines: Vec<String>,
    },
    #[serde(rename = "ext.stream.ended")]
    StreamEnded {
        #[serde(rename = "streamId")]
        stream_id: String,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
    },
    #[allow(dead_code)]
    #[serde(rename = "ext.stream.error")]
    StreamError {
        #[serde(rename = "streamId")]
        stream_id: String,
        error: AppError,
    },
}

pub(crate) fn emit(app: &AppHandle, ev: ExtensionEvent) {
    let _ = app.emit(EVENT_CHANNEL, ev);
}

// ---------- loaded model (what manifest.rs builds from extension.json) ----------

/// One line-oriented field of a `lines`-adapted panel (FR-21/FR-23). A field
/// literally named `tone` decides the row's tone; every other field lands in
/// `cells` verbatim (after FR-51 sanitization).
pub(crate) type LineFields = Vec<String>;

/// How a provider's stdout becomes a `PanelData` (FR-21).
pub(crate) enum OutputFormat {
    /// One JSON document already in the primitive's payload shape.
    Json,
    /// FR-21/FR-22/FR-23 — `table`-only.
    Lines {
        separator: String,
        fields: LineFields,
        id_field: Option<String>,
    },
}

/// What a non-`log-tail` panel spawns. `args`/`page_args` are literal argv
/// elements; `${offset}`/`${limit}` are substituted in-place by `provider.rs`
/// (Rust-rendered numbers, never provider- or user-supplied text) — no shell,
/// no `sh -c`, one argv element per element (FR-19 of `extensions`, unchanged).
pub(crate) struct ProviderSpec {
    pub argv0: String,
    pub args: Vec<String>,
    /// Appended only for a paginated request.
    pub page_args: Vec<String>,
    pub output: OutputFormat,
}

/// A `log-tail` panel's source. FR-38 of `extensions`: these two, and nothing
/// else, may carry the single `token` slot in the system — `${token}`
/// substituted with a value that has ALREADY passed `TOKEN_PATTERN`.
pub(crate) enum Source {
    /// Relative path under the panel's root; may contain `${token}` once.
    File {
        path_template: String,
    },
    Process {
        argv0: String,
        args: Vec<String>,
    },
}

pub(crate) struct TokenSourceSpec {
    pub panel_id: String,
    pub row_key: String,
}

pub(crate) struct ColumnSpec {
    pub key: String,
    pub label: String,
    pub kind: ColumnKind,
    pub weight: Option<u32>,
}

pub(crate) struct PanelDefinition {
    /// `<extensionId>:<slug>` (FR-8) — minted here, never read from the
    /// manifest.
    pub id: String,
    pub label: String,
    pub scope: PanelScope,
    pub primitive: PrimitiveKind,
    pub paginated: bool,
    /// PRE-clamp (FR-28 of `extensions`): `to_info` applies the floor.
    pub refresh_ms: Option<u64>,
    pub columns: Option<Vec<ColumnSpec>>,
    pub empty_copy: String,
    pub token_source: Option<TokenSourceSpec>,
    /// `None` for `log-tail` — it opens a stream instead.
    pub provider: Option<ProviderSpec>,
    /// `log-tail` only.
    pub source: Option<Source>,
}

impl PanelDefinition {
    pub(crate) fn to_info(&self) -> PanelInfo {
        PanelInfo {
            id: self.id.clone(),
            label: self.label.clone(),
            scope: self.scope,
            primitive: self.primitive,
            paginated: self.paginated && self.primitive == PrimitiveKind::Table,
            refresh_ms: clamp_refresh_ms(self.refresh_ms),
            columns: match self.primitive {
                PrimitiveKind::Table => self.columns.as_ref().map(|cols| {
                    cols.iter()
                        .map(|c| ColumnDef {
                            key: c.key.clone(),
                            label: c.label.clone(),
                            kind: c.kind,
                            weight: c.weight,
                        })
                        .collect()
                }),
                _ => None,
            },
            empty_copy: self.empty_copy.clone(),
            token_source: self.token_source.as_ref().map(|t| TokenSourceInfo {
                panel_id: t.panel_id.clone(),
                row_key: t.row_key.clone(),
            }),
        }
    }
}

/// FR-28 (`extensions`): the floor is applied ONCE, in the core, silently.
pub(crate) fn clamp_refresh_ms(declared: Option<u64>) -> Option<u64> {
    declared.map(|ms| ms.max(EXT_REFRESH_FLOOR_MS))
}

/// One manifest, loaded and validated (or not). Present in the registry EVEN
/// when it failed to load (FR-3/FR-6) — `extensions` still lists it, with
/// `manifest_error` set and `panels` empty (never partial, FR-6).
pub(crate) struct LoadedExtension {
    /// The directory name — the id, valid or not (FR-3). Always present, even
    /// for a directory whose name fails `EXTENSION_ID_PATTERN`.
    pub id: String,
    pub dir: PathBuf,
    pub label: String,
    pub min_version_label: Option<String>,
    pub predicate: DetectPredicate,
    pub panels: Vec<PanelDefinition>,
    /// FR-16/FR-18: every distinct argv the manifest declares, panels first
    /// then the predicate's, deduplicated, in declaration order.
    pub declared_commands: Vec<Vec<String>>,
    /// FR-18: sha256 of the manifest's raw bytes, hex-encoded. `None` only
    /// when the file could not even be read (already excluded from the
    /// registry per FR-4 — kept `Option` for the type's own honesty).
    pub manifest_sha256: Option<String>,
    pub manifest_error: Option<AppError>,
}

impl LoadedExtension {
    pub(crate) fn panel(&self, panel_id: &str) -> Option<&PanelDefinition> {
        self.panels.iter().find(|p| p.id == panel_id)
    }
}

// ---------- managed state (§6) ----------

/// Everything the extension system keeps in memory. `registry` rebuilds on
/// app launch and on `extensions_detect` ONLY (FR-13); `toggles` is the one
/// persisted, mutable input (FR-15..FR-20); the detection cache and every
/// stream rebuild on restart.
#[derive(Default)]
pub(crate) struct ExtensionState {
    pub(crate) registry: Mutex<Vec<LoadedExtension>>,
    pub(crate) toggles: Mutex<toggles::Toggles>,
    pub(crate) detect: Mutex<detect::DetectCache>,
    pub(crate) streams: Mutex<stream::Streams>,
}

/// App exit: a `log-tail` process source is a real child process, and leaking
/// one past the window closing is the orphan this feature promises never to
/// leave behind.
pub(crate) fn kill_all_streams(app: &AppHandle) {
    if let Some(state) = app.try_state::<ExtensionState>() {
        state.streams.lock().unwrap().close_all();
    }
}

/// Called once at app setup, mirroring `project::load_projects` — loads the
/// registry from `~/.francois/extensions/` and reconciles the persisted
/// toggles against it (FR-13, FR-18, FR-19).
pub(crate) fn load_registry(app: &AppHandle) {
    if let Some(state) = app.try_state::<ExtensionState>() {
        commands::refresh_registry(app, &state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn to_json<T: Serialize>(v: &T) -> Value {
        serde_json::to_value(v).unwrap()
    }

    #[test]
    fn primitive_kinds_serialize_kebab_case() {
        assert_eq!(to_json(&PrimitiveKind::KeyValue), json!("key-value"));
        assert_eq!(to_json(&PrimitiveKind::Table), json!("table"));
        assert_eq!(to_json(&PrimitiveKind::StatRow), json!("stat-row"));
        assert_eq!(to_json(&PrimitiveKind::LogTail), json!("log-tail"));
    }

    #[test]
    fn scopes_tones_and_column_kinds_serialize_lowercase() {
        assert_eq!(to_json(&PanelScope::Fleet), json!("fleet"));
        assert_eq!(to_json(&PanelScope::Project), json!("project"));
        for (tone, wire) in [
            (StatusTone::Ok, "ok"),
            (StatusTone::Warn, "warn"),
            (StatusTone::Error, "error"),
            (StatusTone::Neutral, "neutral"),
            (StatusTone::Busy, "busy"),
        ] {
            assert_eq!(to_json(&tone), json!(wire));
            assert_eq!(StatusTone::from_wire(wire), Some(tone));
        }
        assert_eq!(StatusTone::from_wire("accent"), None);
        assert_eq!(to_json(&ColumnKind::Time), json!("time"));
        assert_eq!(to_json(&ColumnKind::Path), json!("path"));
    }

    #[test]
    fn panel_data_is_tagged_by_primitive() {
        let mut cells = HashMap::new();
        cells.insert("branch".to_string(), "main".to_string());
        assert_eq!(
            to_json(&PanelData::Table {
                rows: vec![TableRow {
                    id: "r1".into(),
                    cells,
                    tone: StatusTone::Ok
                }],
                offset: 100,
                has_more: true,
            }),
            json!({
                "primitive": "table",
                "rows": [{ "id": "r1", "cells": { "branch": "main" }, "tone": "ok" }],
                "offset": 100,
                "hasMore": true,
            })
        );
        assert_eq!(
            to_json(&PanelData::KeyValue {
                rows: vec![KeyValueRow {
                    key: "pipeline".into(),
                    value: "ok".into(),
                    tone: StatusTone::Ok
                }]
            }),
            json!({ "primitive": "key-value", "rows": [{ "key": "pipeline", "value": "ok", "tone": "ok" }] })
        );
        assert_eq!(
            to_json(&PanelData::StatRow {
                tiles: vec![StatTile {
                    label: "spend".into(),
                    value: "$4".into(),
                    sublabel: None
                }]
            }),
            json!({ "primitive": "stat-row", "tiles": [{ "label": "spend", "value": "$4" }] })
        );
    }

    #[test]
    fn extension_events_round_trip_to_the_contract_shape() {
        assert_eq!(
            to_json(&ExtensionEvent::StreamStarted {
                stream_id: "s1".into(),
                panel_id: "git:log".into()
            }),
            json!({ "type": "ext.stream.started", "streamId": "s1", "panelId": "git:log" })
        );
        assert_eq!(
            to_json(&ExtensionEvent::StreamChunk {
                stream_id: "s1".into(),
                lines: vec!["a".into(), "b".into()]
            }),
            json!({ "type": "ext.stream.chunk", "streamId": "s1", "lines": ["a", "b"] })
        );
        assert_eq!(
            to_json(&ExtensionEvent::StreamEnded {
                stream_id: "s1".into(),
                exit_code: Some(1)
            }),
            json!({ "type": "ext.stream.ended", "streamId": "s1", "exitCode": 1 })
        );
        assert_eq!(
            to_json(&ExtensionEvent::StreamError {
                stream_id: "s1".into(),
                error: AppError {
                    code: "EXT_PROVIDER_MISSING".into(),
                    message: "docker not found on PATH".into(),
                    detail: None,
                }
            }),
            json!({
                "type": "ext.stream.error",
                "streamId": "s1",
                "error": { "code": "EXT_PROVIDER_MISSING", "message": "docker not found on PATH" }
            })
        );
    }

    // extension-install FR-15/FR-18: `consent`/`source`/`predicate` round-trip
    // to the contract's exact shapes.
    #[test]
    fn extension_info_carries_consent_source_and_predicate() {
        let info = ExtensionInfo {
            id: "git".into(),
            label: "git".into(),
            enabled: false,
            consent: ConsentState::Never,
            detected: true,
            undetected_reason: None,
            min_version_label: None,
            source: ExtensionSource {
                dir: "/home/u/.francois/extensions/git".into(),
                manifest_sha256: "abc123".into(),
                declared_commands: vec![vec!["git".into(), "log".into()]],
            },
            predicate: DetectPredicate::PathExists {
                path: ".git".into(),
            },
            panels: vec![],
            manifest_error: None,
        };
        assert_eq!(
            to_json(&info),
            json!({
                "id": "git",
                "label": "git",
                "enabled": false,
                "consent": { "state": "never" },
                "detected": true,
                "undetectedReason": null,
                "minVersionLabel": null,
                "source": {
                    "dir": "/home/u/.francois/extensions/git",
                    "manifestSha256": "abc123",
                    "declaredCommands": [["git", "log"]],
                },
                "predicate": { "kind": "pathExists", "path": ".git" },
                "panels": [],
                "manifestError": null,
            })
        );
        assert_eq!(
            to_json(&ConsentState::Granted),
            json!({ "state": "granted" })
        );
        assert_eq!(to_json(&ConsentState::Stale), json!({ "state": "stale" }));
    }

    #[test]
    fn refresh_ms_is_clamped_to_the_floor() {
        assert_eq!(clamp_refresh_ms(Some(250)), Some(EXT_REFRESH_FLOOR_MS));
        assert_eq!(clamp_refresh_ms(Some(0)), Some(EXT_REFRESH_FLOOR_MS));
        assert_eq!(clamp_refresh_ms(Some(5_000)), Some(5_000));
        assert_eq!(clamp_refresh_ms(None), None);
    }

    #[test]
    fn the_caps_match_the_contract() {
        assert_eq!(EXT_TIMEOUT_MS, 10_000);
        assert_eq!(EXT_OUTPUT_CAP_BYTES, 4 * 1024 * 1024);
        assert_eq!(EXT_CONCURRENCY, 4);
        assert_eq!(EXT_REFRESH_FLOOR_MS, 2_000);
        assert_eq!(EXT_PAGE_SIZE, 100);
        assert_eq!(EXT_LOG_MAX_LINES, 2_000);
        assert_eq!(EXT_FIELD_MAX_CHARS, 512);
        assert_eq!(EXT_PROBE_TIMEOUT_MS, 2_000);
        assert_eq!(MANIFEST_MAX_BYTES, 256 * 1024);
        assert_eq!(MANIFEST_VERSION, 1);
    }

    // FR-3: the directory-name id pattern.
    #[test]
    fn extension_id_pattern_matches_the_contract() {
        assert!(valid_extension_id("git"));
        assert!(valid_extension_id("k8s-tools"));
        assert!(valid_extension_id("a"));
        assert!(!valid_extension_id(""));
        assert!(!valid_extension_id("Git"));
        assert!(!valid_extension_id("1git"));
        assert!(!valid_extension_id("git_tools"));
        assert!(!valid_extension_id(&"a".repeat(33)));
        assert!(valid_extension_id(&"a".repeat(32)));
    }

    // FR-9/FR-10: the argv0 pattern and the shell blocklist.
    #[test]
    fn argv0_pattern_and_shell_blocklist_match_the_spec() {
        assert!(valid_argv0("git"));
        assert!(valid_argv0("docker-compose"));
        assert!(valid_argv0("kubectl.exe"));
        assert!(!valid_argv0(""));
        assert!(!valid_argv0("/usr/bin/git"));
        assert!(!valid_argv0("../git"));
        assert!(!valid_argv0(&"a".repeat(65)));
        assert!(valid_argv0(&"a".repeat(64)));
        for shell in [
            "sh",
            "bash",
            "zsh",
            "fish",
            "cmd",
            "powershell",
            "pwsh",
            "env",
        ] {
            assert!(SHELL_ARGV0_BLOCKLIST.contains(&shell));
        }
    }
}
