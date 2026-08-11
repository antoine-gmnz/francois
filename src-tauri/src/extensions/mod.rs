// extensions/ — the `extensions` domain (specs/extensions.md).
//
// Three COMPILED-IN extensions (`cohorte`, `git`, `docker`), each contributing a
// main-pane `ext:<id>` tab built from four declarative primitives and fed by an
// out-of-process provider binary this module spawns under hard caps. FR-1 is the
// load-bearing rule: there is NO code path anywhere below that parses an
// extension definition from a file — `registry.rs` is a `&'static [...]` array,
// and the only mutable input to the whole system is `ExtensionToggles`.
//
// mod.rs owns the shared data model — both halves of it:
//  * the DEFINITION model (`ExtensionDefinition`, `PanelDefinition`,
//    `ProviderSpec`, `Source`) that registry.rs is written in, and
//  * the WIRE model (`ExtensionInfo`, `PanelInfo`, `PanelData`,
//    `ExtensionEvent`) mirroring contract/extensions.ts exactly.
// Children own one concern each:
//  * registry.rs — the compiled array (FR-1/FR-2). Pure data.
//  * detect.rs   — the FR-3 predicates + the per-root cache (FR-4/FR-5).
//  * provider.rs — spawn, scrubbed env, timeout, output cap, the app-wide
//                  semaphore of 4 (FR-19..FR-24), and the FR-54 line adapter.
//  * schema.rs   — per-primitive validation (FR-25) + FR-51 sanitization.
//  * stream.rs   — live `log-tail` streams keyed by StreamId (FR-38..FR-45).
//  * launch.rs   — the :4317 probe + the detached spawn (FR-46..FR-48).
//  * toggles.rs  — `ExtensionToggles`, persisted to app_data_dir() (FR-6).
//  * commands.rs — the francois:extensions:<verb> Tauri surface.
//
// LOCK ORDER: `ExtensionState` is a LEAF — nothing here ever takes
// `session::Engine.sessions`, and no other domain takes this one.

mod commands;
mod detect;
mod launch;
mod provider;
mod registry;
mod schema;
mod stream;
mod toggles;

#[cfg(test)]
mod testutil;

pub(crate) use commands::*;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// francois:extensions:event → `francois://extensions/event` (§5).
pub(crate) const EVENT_CHANNEL: &str = "francois://extensions/event";

// ---------- caps (mirror the constants in contract/extensions.ts) ----------

/// FR-21. `log-tail` process sources are exempt (FR-40 bounds them instead).
pub(crate) const EXT_TIMEOUT_MS: u64 = 10_000;
/// FR-22.
pub(crate) const EXT_OUTPUT_CAP_BYTES: usize = 4 * 1024 * 1024;
/// FR-23 — in-flight provider processes app-wide; further calls queue FIFO.
pub(crate) const EXT_CONCURRENCY: usize = 4;
/// FR-28 — a definition declaring less is CLAMPED, never rejected.
pub(crate) const EXT_REFRESH_FLOOR_MS: u64 = 2_000;
/// FR-31.
pub(crate) const EXT_PAGE_SIZE: u32 = 100;
/// FR-40 — the core emits at most this many lines of pre-existing file content.
pub(crate) const EXT_LOG_MAX_LINES: usize = 2_000;
/// FR-51 — every provider-derived field, truncated in the CORE before IPC.
pub(crate) const EXT_FIELD_MAX_CHARS: usize = 512;
/// FR-47.
pub(crate) const EXT_PROBE_TIMEOUT_MS: u64 = 2_000;
/// FR-24 — `EXT_PROVIDER_EXIT` carries stderr truncated to this.
pub(crate) const EXT_STDERR_MAX_CHARS: usize = 2_000;

// ---------- wire model (contract/extensions.ts, mirrored) ----------

/// Mirrors `PanelScope`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PanelScope {
    Fleet,
    Project,
}

/// Mirrors `PrimitiveKind` — `rename_all = "kebab-case"` produces exactly
/// `key-value` / `table` / `stat-row` / `log-tail`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PrimitiveKind {
    KeyValue,
    Table,
    StatRow,
    LogTail,
}

/// Mirrors `StatusTone`.
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
    /// FR-25: an unknown tone is a SCHEMA failure, not a silent downgrade —
    /// hence `Option`, resolved by schema.rs.
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

/// Mirrors `ColumnKind`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ColumnKind {
    Text,
    Status,
    Number,
    Time,
    Path,
}

/// Mirrors `ColumnDef`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct ColumnDef {
    pub key: String,
    pub label: String,
    pub kind: ColumnKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<u32>,
}

/// Mirrors `PanelAction`. FR-46: exactly one exists in the whole registry.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct PanelAction {
    pub id: String,
    pub label: String,
    #[serde(rename = "resolvedCommand")]
    pub resolved_command: String,
}

/// Mirrors `PanelInfo.tokenSource`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct TokenSourceInfo {
    #[serde(rename = "panelId")]
    pub panel_id: String,
    #[serde(rename = "rowKey")]
    pub row_key: String,
}

/// Mirrors `PanelInfo`. `refreshMs` is ALREADY clamped to the FR-28 floor here.
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
    pub action: Option<PanelAction>,
}

/// Mirrors `ExtensionInfo`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct ExtensionInfo {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub detected: bool,
    #[serde(rename = "undetectedReason")]
    pub undetected_reason: Option<String>,
    #[serde(rename = "minVersionLabel")]
    pub min_version_label: Option<String>,
    pub panels: Vec<PanelInfo>,
}

/// Mirrors `KeyValueRow`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct KeyValueRow {
    pub key: String,
    pub value: String,
    pub tone: StatusTone,
}

/// Mirrors `TableRow`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct TableRow {
    pub id: String,
    pub cells: HashMap<String, String>,
    pub tone: StatusTone,
}

/// Mirrors `StatTile`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct StatTile {
    pub label: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sublabel: Option<String>,
}

/// Mirrors `PanelData` — the internally-tagged union `extensions_panel`
/// resolves. `log-tail` is absent BY DESIGN (it opens a stream instead).
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

/// Mirrors `ProbeResult` (FR-47).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct ProbeResult {
    pub state: ProbeState,
    pub url: Option<String>,
}

/// The three FR-47 outcomes. A foreign listener is NEVER `running`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProbeState {
    Running,
    Stopped,
    Occupied,
}

/// Mirrors `ExtensionEvent` → `francois://extensions/event` (FR-44/FR-45).
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
    // Part of the contract union the frontend switches on; the core reports a
    // stream failure that happens BEFORE the stream exists through the call's
    // own Result, so nothing constructs this variant today.
    #[allow(dead_code)]
    #[serde(rename = "ext.stream.error")]
    StreamError {
        #[serde(rename = "streamId")]
        stream_id: String,
        error: crate::ipc::AppError,
    },
}

pub(crate) fn emit(app: &AppHandle, ev: ExtensionEvent) {
    let _ = app.emit(EVENT_CHANNEL, ev);
}

// ---------- definition model (what registry.rs is written in) ----------

/// One extension. `id` doubles as the `ext:<id>` tab suffix and the toggle key.
pub(crate) struct ExtensionDefinition {
    pub id: &'static str,
    pub label: &'static str,
    /// FR-26: message composition ONLY. Francois runs no version probe.
    pub min_version_label: Option<&'static str>,
    pub detect: DetectSpec,
    pub panels: &'static [PanelDefinition],
}

/// FR-3: a filesystem or PATH predicate — never repo-supplied content, and
/// never an interpreter. Each variant carries the copy the modal shows when it
/// does not hold (FR-56), so no reason string is composed at a call site.
pub(crate) enum DetectSpec {
    /// `<root>/<rel>` exists, parses as JSON, and carries `key == value`.
    JsonKey {
        rel: &'static str,
        key: &'static str,
        value: &'static str,
        reason: &'static str,
    },
    /// `<root>/<rel>` exists — file OR directory (a worktree's `.git` is a file).
    PathExists {
        rel: &'static str,
        reason: &'static str,
    },
    /// The ONE exec predicate (FR-5): argv[0] resolves and the call exits 0,
    /// under every FR-19..FR-24 cap. Cached like any other (FR-4).
    CommandOk {
        argv: &'static [&'static str],
        missing_reason: &'static str,
        failed_reason: &'static str,
    },
}

/// One argv element. NOT a template string: the only variable content is a
/// number Rust renders or a token that already passed `TOKEN_PATTERN`, and the
/// prefix is always a compiled-in literal. FR-19 (no interpolation, no shell)
/// is therefore structural rather than reviewed.
pub(crate) enum Arg {
    Lit(&'static str),
    /// `<prefix><offset>` — e.g. `Offset("--skip=")` → `--skip=120`.
    Offset(&'static str),
    /// `<prefix><limit>`.
    Limit(&'static str),
    /// `<prefix><token>` — `log-tail` process sources only (FR-38).
    Token(&'static str),
}

/// One field of a line-oriented provider's output (FR-54).
pub(crate) struct FieldSpec {
    /// The `cells` key this field lands in.
    pub key: &'static str,
    pub transform: FieldTransform,
}

/// The only transforms the line adapter performs. Deliberately closed: a
/// declared adapter, not a scripting hook.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FieldTransform {
    None,
    /// `git`'s `%ct`/`:unix` stamps are SECONDS; the contract's `time` columns
    /// are epoch milliseconds like every other timestamp in Francois.
    SecondsToMillis,
}

/// FR-54: a declared `format` string's shape, so line-oriented providers need
/// no per-extension code seam.
pub(crate) struct LineFormat {
    pub sep: &'static str,
    pub fields: &'static [FieldSpec],
    /// Which field is the row id; `None` ⇒ the row's index within the page.
    pub id_field: Option<&'static str>,
    pub tone: ToneRule,
}

/// One JSON-per-line provider (`docker … --format '{{json .}}'`).
pub(crate) struct NdjsonFormat {
    /// `(cells key, json key)` — a json key absent from an object renders empty.
    pub fields: &'static [(&'static str, &'static str)],
    pub id_field: Option<&'static str>,
    pub tone: ToneRule,
}

/// How a row's `tone` is decided from its own cells. No provider-supplied tone
/// is trusted for line/ndjson adapters — the mapping is compiled in.
pub(crate) enum ToneRule {
    Fixed(StatusTone),
    Map {
        key: &'static str,
        entries: &'static [(&'static str, StatusTone)],
        default: StatusTone,
    },
}

/// How a provider's stdout becomes a `PanelData`.
pub(crate) enum OutputFormat {
    /// One JSON document already in the primitive's payload shape (FR-25).
    Json,
    /// Line-oriented, split on a declared separator (FR-54).
    Lines(LineFormat),
    /// One JSON object per line.
    Ndjson(NdjsonFormat),
}

/// What a non-`log-tail` panel spawns.
pub(crate) struct ProviderSpec {
    pub argv0: &'static str,
    pub args: &'static [Arg],
    /// Appended only for a paginated table (FR-31).
    pub page_args: &'static [Arg],
    pub output: OutputFormat,
}

/// One segment of a `log-tail` file source's relative path (FR-38/FR-39).
pub(crate) enum PathSeg {
    Lit(&'static str),
    Token,
}

/// A `log-tail` panel's source. FR-38: these two, and nothing else, may carry
/// the single `token` slot in the system.
pub(crate) enum Source {
    File(&'static [PathSeg]),
    Process {
        argv0: &'static str,
        args: &'static [Arg],
    },
}

/// FR-38: where a `log-tail` panel's token comes from — a sibling panel's
/// VALIDATED rows in the same tab, never user text and never repo content.
pub(crate) struct TokenSourceSpec {
    pub panel_id: &'static str,
    pub row_key: &'static str,
}

pub(crate) struct ActionSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// Static argv (FR-46). No slots, no interpolation. The joined form is what
    /// the FR-48 confirmation shows verbatim.
    pub argv: &'static [&'static str],
}

pub(crate) struct PanelDefinition {
    pub id: &'static str,
    pub label: &'static str,
    pub scope: PanelScope,
    pub primitive: PrimitiveKind,
    pub paginated: bool,
    /// PRE-clamp (FR-28): `refresh_ms_of` applies the floor on the way out.
    pub refresh_ms: Option<u64>,
    pub columns: Option<&'static [ColumnSpec]>,
    pub empty_copy: &'static str,
    pub token_source: Option<TokenSourceSpec>,
    pub action: Option<ActionSpec>,
    /// `None` for `log-tail` — it opens a stream instead.
    pub provider: Option<ProviderSpec>,
    /// `log-tail` only.
    pub source: Option<Source>,
}

pub(crate) struct ColumnSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: ColumnKind,
    pub weight: Option<u32>,
}

// ---------- projection: definition → wire (FR-28 clamp lives here) ----------

/// FR-28: the floor is applied ONCE, in the core, silently. A definition asking
/// for 250 ms is corrected to 2 000 ms, never rejected; `None` stays `None`.
pub(crate) fn clamp_refresh_ms(declared: Option<u64>) -> Option<u64> {
    declared.map(|ms| ms.max(EXT_REFRESH_FLOOR_MS))
}

impl PanelDefinition {
    pub(crate) fn to_info(&self) -> PanelInfo {
        PanelInfo {
            id: self.id.to_string(),
            label: self.label.to_string(),
            scope: self.scope,
            primitive: self.primitive,
            // FR-31: pagination is a `table` affordance and nothing else's.
            paginated: self.paginated && self.primitive == PrimitiveKind::Table,
            refresh_ms: clamp_refresh_ms(self.refresh_ms),
            columns: match self.primitive {
                PrimitiveKind::Table => self.columns.map(|cols| {
                    cols.iter()
                        .map(|c| ColumnDef {
                            key: c.key.to_string(),
                            label: c.label.to_string(),
                            kind: c.kind,
                            weight: c.weight,
                        })
                        .collect()
                }),
                _ => None,
            },
            empty_copy: self.empty_copy.to_string(),
            token_source: self.token_source.as_ref().map(|t| TokenSourceInfo {
                panel_id: t.panel_id.to_string(),
                row_key: t.row_key.to_string(),
            }),
            action: self.action.as_ref().map(|a| PanelAction {
                id: a.id.to_string(),
                label: a.label.to_string(),
                resolved_command: a.argv.join(" "),
            }),
        }
    }
}

// ---------- managed state (§6) ----------

/// Everything the extension system keeps in memory. Only `toggles` is persisted
/// (FR-6); the detection cache and every stream rebuild on restart.
#[derive(Default)]
pub(crate) struct ExtensionState {
    pub(crate) toggles: Mutex<toggles::Toggles>,
    pub(crate) detect: Mutex<detect::DetectCache>,
    pub(crate) streams: Mutex<stream::Streams>,
}

/// App exit: a `log-tail` process source is a real child process, and leaking a
/// `docker logs -f` past the window closing is the orphan FR-43's kill paths
/// exist to prevent. The detached dashboard (FR-48) is deliberately NOT here —
/// it is untracked by design.
pub(crate) fn kill_all_streams(app: &AppHandle) {
    if let Some(state) = app.try_state::<ExtensionState>() {
        state.streams.lock().unwrap().close_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn to_json<T: Serialize>(v: &T) -> Value {
        serde_json::to_value(v).unwrap()
    }

    // The wire enums must serialize to the exact strings in contract/extensions.ts.
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

    // §5 `PanelData` is discriminated by `primitive`, with `hasMore` camelCased.
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
        // `sublabel` is optional in the contract — absent, not null.
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

    // FR-44/FR-45: the event union is tagged by `type` with camelCase fields.
    #[test]
    fn extension_events_round_trip_to_the_contract_shape() {
        assert_eq!(
            to_json(&ExtensionEvent::StreamStarted {
                stream_id: "s1".into(),
                panel_id: "docker:logs".into()
            }),
            json!({ "type": "ext.stream.started", "streamId": "s1", "panelId": "docker:logs" })
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
            to_json(&ExtensionEvent::StreamEnded {
                stream_id: "s1".into(),
                exit_code: None
            }),
            json!({ "type": "ext.stream.ended", "streamId": "s1", "exitCode": null })
        );
        assert_eq!(
            to_json(&ExtensionEvent::StreamError {
                stream_id: "s1".into(),
                error: crate::ipc::AppError {
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

    // FR-28: silently clamped to the floor, never rejected; `null` stays `null`.
    #[test]
    fn refresh_ms_is_clamped_to_the_floor() {
        assert_eq!(clamp_refresh_ms(Some(250)), Some(EXT_REFRESH_FLOOR_MS));
        assert_eq!(clamp_refresh_ms(Some(0)), Some(EXT_REFRESH_FLOOR_MS));
        assert_eq!(clamp_refresh_ms(Some(5_000)), Some(5_000));
        assert_eq!(clamp_refresh_ms(None), None);
    }

    // The caps are the contract's numbers, not this module's opinion.
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
    }
}
