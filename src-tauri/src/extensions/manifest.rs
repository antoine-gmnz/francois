//! FR-5..FR-11 — parse and validate ONE `extension.json` into a
//! `LoadedExtension`. Whole-manifest, all-or-nothing (FR-6): the first
//! structural failure aborts the whole load and is reported with its JSON
//! pointer; nothing here ever registers half a manifest.
//!
//! This is the file `registry.rs` calls once per subdirectory that carries a
//! readable `extension.json` (FR-4 already filtered out the rest before this
//! module is reached).

use super::{
    normalize_argv0_for_blocklist, ColumnKind, ColumnSpec, DetectPredicate, LoadedExtension,
    OutputFormat, PanelDefinition, PanelScope, PrimitiveKind, ProviderSpec, Source,
    TokenSourceSpec, MANIFEST_MAX_BYTES, MANIFEST_VERSION, SHELL_ARGV0_BLOCKLIST,
};
use crate::ipc::AppError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

/// One structural validation failure — a JSON pointer plus what was expected
/// there. `manifest.rs` never composes the user-facing message itself; that
/// happens once, in `invalid()`, so every caller gets the same shape.
struct Invalid {
    pointer: String,
    expected: String,
}

fn invalid(pointer: impl Into<String>, expected: impl Into<String>) -> Invalid {
    Invalid {
        pointer: pointer.into(),
        expected: expected.into(),
    }
}

type VResult<T> = Result<T, Invalid>;

fn manifest_invalid(err: Invalid, manifest_path: &Path) -> AppError {
    AppError {
        code: "EXT_MANIFEST_INVALID".to_string(),
        message: format!("unknown {} at {}", err.expected, err.pointer),
        detail: Some(json!({
            "pointer": err.pointer,
            "expected": err.expected,
            "manifestPath": manifest_path.to_string_lossy(),
        })),
    }
}

fn manifest_unsupported(found: Value) -> AppError {
    AppError {
        code: "EXT_MANIFEST_UNSUPPORTED".to_string(),
        message: format!("unsupported manifest version {found}"),
        detail: Some(json!({ "found": found, "supported": MANIFEST_VERSION })),
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

// ---------- field readers ----------

fn get_str<'a>(obj: &'a Value, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(|v| v.as_str())
}

fn require_str(obj: &Value, key: &str, pointer: &str) -> VResult<String> {
    match get_str(obj, key) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(invalid(
            format!("{pointer}/{key}"),
            format!("a non-empty string at {key}"),
        )),
    }
}

fn optional_str(obj: &Value, key: &str) -> Option<String> {
    get_str(obj, key).map(str::to_string)
}

fn require_array<'a>(obj: &'a Value, key: &str, pointer: &str) -> VResult<&'a Vec<Value>> {
    obj.get(key)
        .and_then(|v| v.as_array())
        .ok_or_else(|| invalid(format!("{pointer}/{key}"), format!("an array at {key}")))
}

fn require_string_array(obj: &Value, key: &str, pointer: &str) -> VResult<Vec<String>> {
    let arr = require_array(obj, key, pointer)?;
    arr.iter()
        .enumerate()
        .map(|(i, v)| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| invalid(format!("{pointer}/{key}/{i}"), "a string".to_string()))
        })
        .collect()
}

fn require_bool(obj: &Value, key: &str, default: bool) -> bool {
    obj.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// FR-9: bare binary name, off `PATH`. FR-10: not a shell.
fn require_argv0(obj: &Value, pointer: &str) -> VResult<String> {
    let argv0 = require_str(obj, "argv0", pointer)?;
    let sub = format!("{pointer}/argv0");
    if !super::valid_argv0(&argv0) {
        return Err(invalid(sub, "a bare binary name (ARGV0_PATTERN)"));
    }
    if SHELL_ARGV0_BLOCKLIST.contains(&normalize_argv0_for_blocklist(&argv0).as_str()) {
        return Err(invalid(sub, "a binary that is not a shell"));
    }
    Ok(argv0)
}

// ---------- detect (FR-12) ----------

fn parse_predicate(doc: &Value, pointer: &str) -> VResult<DetectPredicate> {
    let Some(spec) = doc.get("detect") else {
        return Err(invalid("/detect", "a detect predicate object"));
    };
    let kind = get_str(spec, "kind").unwrap_or("");
    match kind {
        "pathExists" => Ok(DetectPredicate::PathExists {
            path: require_str(spec, "path", pointer)?,
        }),
        "pathJsonEquals" => Ok(DetectPredicate::PathJsonEquals {
            path: require_str(spec, "path", pointer)?,
            pointer: require_str(spec, "pointer", pointer)?,
            equals: require_str(spec, "equals", pointer)?,
        }),
        "commandSucceeds" => {
            let argv = require_string_array(spec, "argv", &format!("{pointer}/detect"))?;
            let Some(argv0) = argv.first() else {
                return Err(invalid("/detect/argv", "a non-empty argv array"));
            };
            if !super::valid_argv0(argv0) {
                return Err(invalid(
                    "/detect/argv/0",
                    "a bare binary name (ARGV0_PATTERN)",
                ));
            }
            if SHELL_ARGV0_BLOCKLIST.contains(&normalize_argv0_for_blocklist(argv0).as_str()) {
                return Err(invalid("/detect/argv/0", "a binary that is not a shell"));
            }
            Ok(DetectPredicate::CommandSucceeds { argv })
        }
        _ => Err(invalid(
            "/detect/kind",
            "one of pathExists, pathJsonEquals, commandSucceeds",
        )),
    }
}

// ---------- columns (table primitive) ----------

fn parse_columns(panel: &Value, pointer: &str) -> VResult<Vec<ColumnSpec>> {
    let arr = require_array(panel, "columns", pointer)?;
    if arr.is_empty() {
        return Err(invalid(format!("{pointer}/columns"), "at least one column"));
    }
    arr.iter()
        .enumerate()
        .map(|(i, col)| {
            let sub = format!("{pointer}/columns/{i}");
            let key = require_str(col, "key", &sub)?;
            let label = require_str(col, "label", &sub)?;
            let kind = match get_str(col, "kind") {
                Some("text") => ColumnKind::Text,
                Some("status") => ColumnKind::Status,
                Some("number") => ColumnKind::Number,
                Some("time") => ColumnKind::Time,
                Some("path") => ColumnKind::Path,
                _ => {
                    return Err(invalid(
                        format!("{sub}/kind"),
                        "one of text, status, number, time, path",
                    ))
                }
            };
            // A declared `weight` above `u32::MAX` is rejected outright
            // rather than silently truncated/wrapped — the same
            // whole-manifest-or-nothing discipline FR-6 applies to every
            // other structural field.
            let weight = match col.get("weight") {
                None | Some(Value::Null) => None,
                Some(v) => match v.as_u64().and_then(|w| u32::try_from(w).ok()) {
                    Some(w) => Some(w),
                    None => return Err(invalid(format!("{sub}/weight"), "a u32")),
                },
            };
            Ok(ColumnSpec {
                key,
                label,
                kind,
                weight,
            })
        })
        .collect()
}

// ---------- provider output (FR-21/FR-22) ----------

fn parse_output(
    provider: &Value,
    primitive: PrimitiveKind,
    pointer: &str,
) -> VResult<OutputFormat> {
    let out = provider
        .get("output")
        .cloned()
        .unwrap_or_else(|| json!({ "kind": "json" }));
    let sub = format!("{pointer}/output");
    match get_str(&out, "kind") {
        Some("json") => Ok(OutputFormat::Json),
        Some("lines") => {
            // FR-22: `lines` is table-only.
            if primitive != PrimitiveKind::Table {
                return Err(invalid(sub, "`lines` paired with primitive: table"));
            }
            let separator = require_str(&out, "separator", &sub)?;
            let fields = require_string_array(&out, "fields", &sub)?;
            if fields.is_empty() {
                return Err(invalid(format!("{sub}/fields"), "at least one field"));
            }
            // FR-23: `idField` is optional — `rows_from_lines` defaults an
            // absent one to `fields[0]` at read time, so `None` here is not
            // yet the row-index fallback.
            let id_field = optional_str(&out, "idField");
            if let Some(id_field) = id_field.as_ref() {
                if !fields.contains(id_field) {
                    return Err(invalid(
                        format!("{sub}/idField"),
                        "a name present in fields",
                    ));
                }
            }
            Ok(OutputFormat::Lines {
                separator,
                fields,
                id_field,
            })
        }
        _ => Err(invalid(format!("{sub}/kind"), "one of json, lines")),
    }
}

// ---------- provider (non-log-tail panels) ----------

fn parse_provider(panel: &Value, primitive: PrimitiveKind, pointer: &str) -> VResult<ProviderSpec> {
    let Some(provider) = panel.get("provider") else {
        return Err(invalid(format!("{pointer}/provider"), "a provider object"));
    };
    let sub = format!("{pointer}/provider");
    let argv0 = require_argv0(provider, &sub)?;
    let args = match provider.get("args") {
        Some(_) => require_string_array(provider, "args", &sub)?,
        None => Vec::new(),
    };
    let page_args = match provider.get("pageArgs") {
        Some(_) => require_string_array(provider, "pageArgs", &sub)?,
        None => Vec::new(),
    };
    // FR-7: a `${token}` in a non-log-tail panel's argv is STRUCTURAL — the
    // token slot exists only on a log-tail panel's own source.
    if args
        .iter()
        .chain(page_args.iter())
        .any(|a| a.contains("${token}"))
    {
        return Err(invalid(sub, "argv with no ${token} placeholder"));
    }
    let output = parse_output(provider, primitive, pointer)?;
    Ok(ProviderSpec {
        argv0,
        args,
        page_args,
        output,
    })
}

// ---------- source (log-tail panels) ----------

fn parse_source(panel: &Value, pointer: &str) -> VResult<Source> {
    let Some(source) = panel.get("source") else {
        return Err(invalid(format!("{pointer}/source"), "a source object"));
    };
    let sub = format!("{pointer}/source");
    match get_str(source, "kind") {
        Some("file") => {
            let path_template = require_str(source, "path", &sub)?;
            if path_template.matches("${token}").count() > 1 {
                return Err(invalid(format!("{sub}/path"), "at most one ${token}"));
            }
            Ok(Source::File { path_template })
        }
        Some("process") => {
            let argv0 = require_argv0(source, &sub)?;
            let args = match source.get("args") {
                Some(_) => require_string_array(source, "args", &sub)?,
                None => Vec::new(),
            };
            let occurrences: usize = args.iter().map(|a| a.matches("${token}").count()).sum();
            if occurrences > 1 {
                return Err(invalid(format!("{sub}/args"), "at most one ${token}"));
            }
            Ok(Source::Process { argv0, args })
        }
        _ => Err(invalid(format!("{sub}/kind"), "one of file, process")),
    }
}

fn source_has_token(source: &Source) -> bool {
    match source {
        Source::File { path_template } => path_template.contains("${token}"),
        Source::Process { args, .. } => args.iter().any(|a| a.contains("${token}")),
    }
}

// ---------- panels ----------

struct RawPanel {
    slug: String,
    def: PanelDefinition,
    /// The manifest-local `tokenSource.panelId` (a slug), before it is
    /// translated to a full `<ext>:<slug>` id.
    token_source_slug: Option<String>,
}

fn parse_panel(ext_id: &str, panel: &Value, index: usize) -> VResult<RawPanel> {
    let pointer = format!("/panels/{index}");
    let slug = require_str(panel, "id", &pointer)?;
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || !slug.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        || slug.len() > 64
    {
        return Err(invalid(
            format!("{pointer}/id"),
            "a lowercase kebab-case slug",
        ));
    }
    let label = require_str(panel, "label", &pointer)?;
    let scope = match get_str(panel, "scope") {
        Some("fleet") => PanelScope::Fleet,
        Some("project") => PanelScope::Project,
        _ => return Err(invalid(format!("{pointer}/scope"), "one of fleet, project")),
    };
    let primitive = match get_str(panel, "primitive") {
        Some("key-value") => PrimitiveKind::KeyValue,
        Some("table") => PrimitiveKind::Table,
        Some("stat-row") => PrimitiveKind::StatRow,
        Some("log-tail") => PrimitiveKind::LogTail,
        _ => {
            return Err(invalid(
                format!("{pointer}/primitive"),
                "one of key-value, table, stat-row, log-tail",
            ))
        }
    };
    // FR-31 (extensions) / FR-7 (extension-install): paginated is CLAMPED to
    // `table` only, never rejected.
    let paginated = require_bool(panel, "paginated", false) && primitive == PrimitiveKind::Table;
    // FR-7 (extension-install): a negative `refreshMs` is an out-of-range
    // value like any other and must be clamped to the floor downstream
    // (`clamp_refresh_ms` in `to_info`), never treated as "field absent".
    // `as_u64()` returns `None` for negative JSON numbers, so fall back to
    // `as_i64()`/`as_f64()` and map any negative reading to `0` — still
    // below the floor, so the later clamp raises it correctly.
    let refresh_ms = panel.get("refreshMs").and_then(|v| {
        v.as_u64().or_else(|| {
            v.as_i64()
                .map(|n| if n < 0 { 0 } else { n as u64 })
                .or_else(|| v.as_f64().map(|n| if n < 0.0 { 0 } else { n as u64 }))
        })
    });
    let empty_copy = require_str(panel, "emptyCopy", &pointer)?;
    let columns = if primitive == PrimitiveKind::Table {
        Some(parse_columns(panel, &pointer)?)
    } else {
        None
    };

    let token_source_slug = match panel.get("tokenSource") {
        Some(ts) if !ts.is_null() => {
            if primitive != PrimitiveKind::LogTail {
                return Err(invalid(
                    format!("{pointer}/tokenSource"),
                    "tokenSource on a log-tail panel only",
                ));
            }
            let sub = format!("{pointer}/tokenSource");
            let panel_id = require_str(ts, "panelId", &sub)?;
            let row_key = require_str(ts, "rowKey", &sub)?;
            Some((panel_id, row_key))
        }
        _ => None,
    };

    let (provider, source) = match primitive {
        PrimitiveKind::LogTail => {
            if panel.get("provider").is_some() {
                return Err(invalid(
                    format!("{pointer}/provider"),
                    "absent on a log-tail panel",
                ));
            }
            (None, Some(parse_source(panel, &pointer)?))
        }
        _ => {
            if panel.get("source").is_some() {
                return Err(invalid(
                    format!("{pointer}/source"),
                    "absent on a non-log-tail panel",
                ));
            }
            (Some(parse_provider(panel, primitive, &pointer)?), None)
        }
    };

    // A log-tail source declaring `${token}` must have a tokenSource to fill it.
    if let Some(src) = source.as_ref() {
        if source_has_token(src) && token_source_slug.is_none() {
            return Err(invalid(
                format!("{pointer}/tokenSource"),
                "a tokenSource, since the source declares ${token}",
            ));
        }
    }

    let (token_source_slug, row_key) = match token_source_slug {
        Some((panel_id, row_key)) => (Some(panel_id), Some(row_key)),
        None => (None, None),
    };

    Ok(RawPanel {
        slug: slug.clone(),
        def: PanelDefinition {
            id: format!("{ext_id}:{slug}"),
            label,
            scope,
            primitive,
            paginated,
            refresh_ms,
            columns,
            empty_copy,
            // Filled in by `link_token_sources` once every slug is known.
            token_source: token_source_slug.as_ref().map(|panel_id| TokenSourceSpec {
                panel_id: panel_id.clone(),
                row_key: row_key.clone().unwrap_or_default(),
            }),
            provider,
            source,
        },
        token_source_slug,
    })
}

/// FR-38 (extensions): a tokenSource must name a SIBLING panel, and that
/// sibling must be a `table` (its validated rows are the only legal source of
/// a token). Also enforces the extension-install FR-7 cap: at most one token
/// slot in the whole manifest.
fn link_token_sources(ext_id: &str, panels: &mut [RawPanel]) -> VResult<()> {
    let slugs: Vec<(String, PrimitiveKind)> = panels
        .iter()
        .map(|p| (p.slug.clone(), p.def.primitive))
        .collect();

    let mut token_slots = 0usize;
    for (index, panel) in panels.iter_mut().enumerate() {
        let pointer = format!("/panels/{index}");
        if let Some(src) = panel.def.source.as_ref() {
            if source_has_token(src) {
                token_slots += 1;
                if token_slots > 1 {
                    return Err(invalid(
                        format!("{pointer}/source"),
                        "at most one ${token} slot in the whole manifest",
                    ));
                }
            }
        }
        if let Some(slug) = panel.token_source_slug.clone() {
            let Some((_, sibling_primitive)) = slugs.iter().find(|(s, _)| *s == slug) else {
                return Err(invalid(
                    format!("{pointer}/tokenSource/panelId"),
                    "a sibling panel declared in this manifest",
                ));
            };
            if *sibling_primitive != PrimitiveKind::Table {
                return Err(invalid(
                    format!("{pointer}/tokenSource/panelId"),
                    "a sibling panel whose primitive is table",
                ));
            }
            if let Some(ts) = panel.def.token_source.as_mut() {
                ts.panel_id = format!("{ext_id}:{slug}");
            }
        }
    }
    Ok(())
}

// ---------- declared commands (FR-16) ----------

/// FR-51: mirrors `schema::strip_control_sequences` (C0/C1 + ANSI) and, on
/// top of it, strips Unicode bidi-control code points (explicit
/// embeddings/overrides `U+202A`-`U+202E`, isolates `U+2066`-`U+2069`, the
/// bare marks `U+200E`/`U+200F`) and the zero-width formatting characters
/// (`U+200B`-`U+200D`, `U+FEFF`). `declaredCommands` crosses IPC and the
/// consent dialog (FR-16/FR-18) renders it as the verbatim argv the user is
/// approving — a manifest-controlled bidi override or zero-width char could
/// otherwise reorder or hide part of that line while it visually still reads
/// as consented.
pub(crate) fn sanitize_argv_element(input: &str) -> String {
    super::schema::strip_bidi_and_zero_width(&super::schema::strip_control_sequences(input))
}

fn declared_commands(panels: &[PanelDefinition], predicate: &DetectPredicate) -> Vec<Vec<String>> {
    let mut commands: Vec<Vec<String>> = Vec::new();
    let mut push = |argv: Vec<String>| {
        let argv: Vec<String> = argv.iter().map(|a| sanitize_argv_element(a)).collect();
        if !commands.contains(&argv) {
            commands.push(argv);
        }
    };
    for panel in panels {
        if let Some(provider) = panel.provider.as_ref() {
            let mut base = vec![provider.argv0.clone()];
            base.extend(provider.args.iter().cloned());
            push(base.clone());
            if !provider.page_args.is_empty() {
                let mut paged = base;
                paged.extend(provider.page_args.iter().cloned());
                push(paged);
            }
        }
        if let Some(Source::Process { argv0, args }) = panel.source.as_ref() {
            let mut argv = vec![argv0.clone()];
            argv.extend(args.iter().cloned());
            push(argv);
        }
    }
    if let DetectPredicate::CommandSucceeds { argv } = predicate {
        push(argv.clone());
    }
    commands
}

// ---------- entry point ----------

/// Load and validate one `<dir>/extension.json`. `None` only for FR-4's
/// silent case (no file, or unreadable) — every other outcome, success or
/// failure, is a `LoadedExtension`.
pub(crate) fn load_one(dir: &Path) -> Option<LoadedExtension> {
    let dir_name = dir.file_name()?.to_string_lossy().to_string();
    let manifest_path = dir.join("extension.json");
    let bytes = std::fs::read(&manifest_path).ok()?;

    let failed = |error: AppError| -> Option<LoadedExtension> {
        Some(LoadedExtension {
            id: dir_name.clone(),
            dir: dir.to_path_buf(),
            label: dir_name.clone(),
            min_version_label: None,
            predicate: DetectPredicate::PathExists {
                path: String::new(),
            },
            panels: Vec::new(),
            declared_commands: Vec::new(),
            manifest_sha256: Some(sha256_hex(&bytes)),
            manifest_error: Some(error),
        })
    };

    if bytes.len() > MANIFEST_MAX_BYTES {
        return failed(manifest_invalid(
            invalid(
                "",
                format!("a manifest of at most {MANIFEST_MAX_BYTES} bytes"),
            ),
            &manifest_path,
        ));
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return failed(manifest_invalid(invalid("", "UTF-8 text"), &manifest_path));
    };
    let Ok(doc) = serde_json::from_str::<Value>(text) else {
        return failed(manifest_invalid(invalid("", "valid JSON"), &manifest_path));
    };

    let version = doc.get("manifest").cloned().unwrap_or(Value::Null);
    if version != json!(MANIFEST_VERSION) {
        return failed(manifest_unsupported(version));
    }

    if !super::valid_extension_id(&dir_name) {
        return failed(manifest_invalid(
            invalid("", "a directory name matching ^[a-z][a-z0-9-]{0,31}$"),
            &manifest_path,
        ));
    }
    if let Some(declared_id) = get_str(&doc, "id") {
        if declared_id != dir_name {
            return failed(manifest_invalid(
                invalid("/id", "the directory name, or no id field at all"),
                &manifest_path,
            ));
        }
    }

    match parse_body(&dir_name, &doc) {
        Ok((label, min_version_label, predicate, panels)) => {
            let declared = declared_commands(&panels, &predicate);
            Some(LoadedExtension {
                id: dir_name.clone(),
                dir: dir.to_path_buf(),
                label,
                min_version_label,
                predicate,
                panels,
                declared_commands: declared,
                manifest_sha256: Some(sha256_hex(&bytes)),
                manifest_error: None,
            })
        }
        Err(e) => failed(manifest_invalid(e, &manifest_path)),
    }
}

type ParsedBody = (
    String,
    Option<String>,
    DetectPredicate,
    Vec<PanelDefinition>,
);

fn parse_body(dir_name: &str, doc: &Value) -> VResult<ParsedBody> {
    let label = optional_str(doc, "label").unwrap_or_else(|| dir_name.to_string());
    let min_version_label = optional_str(doc, "minVersionLabel");
    let predicate = parse_predicate(doc, "")?;

    let raw_panels = require_array(doc, "panels", "")?;
    let mut ids_seen: Vec<String> = Vec::new();
    let mut parsed: Vec<RawPanel> = Vec::new();
    for (index, panel) in raw_panels.iter().enumerate() {
        let raw = parse_panel(dir_name, panel, index)?;
        if ids_seen.contains(&raw.slug) {
            return Err(invalid(
                format!("/panels/{index}/id"),
                "a panel id unique within this manifest",
            ));
        }
        ids_seen.push(raw.slug.clone());
        parsed.push(raw);
    }
    link_token_sources(dir_name, &mut parsed)?;

    let panels: Vec<PanelDefinition> = parsed.into_iter().map(|p| p.def).collect();
    Ok((label, min_version_label, predicate, panels))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::testutil::tmp_root;

    fn write_manifest(dir: &Path, json: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("extension.json"), json).unwrap();
    }

    // FR-31: the worked example, loaded from the repo, is the load-and-validate
    // fixture — a schema change that breaks it fails `cargo test` (FR-32).
    #[test]
    fn the_example_plugin_loads_and_validates() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("examples/extensions/plugin-example");
        let ext = load_one(&manifest_dir).expect("the example manifest must be readable");
        assert!(
            ext.manifest_error.is_none(),
            "example manifest failed to validate: {:?}",
            ext.manifest_error
        );
        // FR-3: the id is the DIRECTORY name, never a manifest field — so
        // renaming the directory renames the extension, and this assertion is
        // what catches a manifest that tries to claim an id of its own.
        assert_eq!(ext.id, "plugin-example");
        let panel_ids: Vec<&str> = ext.panels.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(
            panel_ids,
            vec!["plugin-example:branches", "plugin-example:log"]
        );
        let log = ext
            .panels
            .iter()
            .find(|p| p.id == "plugin-example:log")
            .unwrap();
        assert!(log.paginated);
    }

    #[test]
    fn a_missing_extension_json_is_ignored_silently() {
        let root = tmp_root("manifest-missing");
        assert!(load_one(&root.join("nope")).is_none());
    }

    #[test]
    fn an_oversized_manifest_is_invalid() {
        let root = tmp_root("manifest-oversized");
        let dir = root.join("big");
        std::fs::create_dir_all(&dir).unwrap();
        let huge = "x".repeat(MANIFEST_MAX_BYTES + 1);
        std::fs::write(dir.join("extension.json"), huge).unwrap();
        let ext = load_one(&dir).unwrap();
        assert_eq!(ext.manifest_error.unwrap().code, "EXT_MANIFEST_INVALID");
    }

    #[test]
    fn an_unsupported_manifest_version_is_reported() {
        let root = tmp_root("manifest-unsupported");
        let dir = root.join("k8s");
        write_manifest(
            &dir,
            r#"{"manifest":2,"detect":{"kind":"pathExists","path":"x"},"panels":[]}"#,
        );
        let ext = load_one(&dir).unwrap();
        let err = ext.manifest_error.unwrap();
        assert_eq!(err.code, "EXT_MANIFEST_UNSUPPORTED");
        assert_eq!(err.detail.unwrap()["found"], json!(2));
    }

    #[test]
    fn a_directory_name_failing_the_id_pattern_is_invalid() {
        let root = tmp_root("manifest-bad-dir-name");
        let dir = root.join("Not_Valid");
        write_manifest(
            &dir,
            r#"{"manifest":1,"detect":{"kind":"pathExists","path":"x"},"panels":[]}"#,
        );
        let ext = load_one(&dir).unwrap();
        assert_eq!(ext.manifest_error.unwrap().code, "EXT_MANIFEST_INVALID");
    }

    #[test]
    fn a_declared_id_disagreeing_with_the_directory_is_invalid() {
        let root = tmp_root("manifest-id-mismatch");
        let dir = root.join("k8s");
        write_manifest(
            &dir,
            r#"{"manifest":1,"id":"other","detect":{"kind":"pathExists","path":"x"},"panels":[]}"#,
        );
        let ext = load_one(&dir).unwrap();
        let err = ext.manifest_error.unwrap();
        assert_eq!(err.code, "EXT_MANIFEST_INVALID");
        assert_eq!(err.detail.unwrap()["pointer"], json!("/id"));
    }

    // FR-6: one bad panel refuses the WHOLE manifest, and the pointer names it.
    #[test]
    fn one_bad_panel_refuses_the_whole_manifest_with_a_pointer() {
        let root = tmp_root("manifest-bad-panel");
        let dir = root.join("k8s");
        write_manifest(
            &dir,
            r#"{
                "manifest": 1,
                "detect": { "kind": "pathExists", "path": "k8s" },
                "panels": [
                    { "id": "a", "label": "A", "scope": "project", "primitive": "tabel",
                      "emptyCopy": "none" }
                ]
            }"#,
        );
        let ext = load_one(&dir).unwrap();
        let err = ext.manifest_error.unwrap();
        assert_eq!(err.code, "EXT_MANIFEST_INVALID");
        assert_eq!(err.detail.unwrap()["pointer"], json!("/panels/0/primitive"));
        assert!(ext.panels.is_empty());
    }

    // FR-7: a negative `refreshMs` is an out-of-range value, not an absent
    // one — `as_u64()` rejects negative JSON numbers outright, so the parser
    // must fall back to a signed/float read and clamp negatives up rather
    // than dropping the field (which would silently disable auto-refresh).
    #[test]
    fn a_negative_refresh_ms_is_clamped_to_the_floor() {
        let root = tmp_root("manifest-negative-refresh-ms");
        let dir = root.join("k8s");
        write_manifest(
            &dir,
            r#"{
                "manifest": 1,
                "detect": { "kind": "pathExists", "path": "k8s" },
                "panels": [
                    { "id": "a", "label": "A", "scope": "project", "primitive": "stat-row",
                      "emptyCopy": "none", "refreshMs": -500,
                      "provider": { "kind": "command", "argv0": "kubectl", "args": [] } }
                ]
            }"#,
        );
        let ext = load_one(&dir).unwrap();
        assert!(
            ext.manifest_error.is_none(),
            "manifest failed to validate: {:?}",
            ext.manifest_error
        );
        let panel = &ext.panels[0];
        // Pre-clamp: parsed as an in-range representable value, never `None`.
        assert_eq!(panel.refresh_ms, Some(0));
        // Post-clamp (`to_info`, applied once, in the core): raised to the floor.
        assert_eq!(
            panel.to_info().refresh_ms,
            Some(crate::extensions::EXT_REFRESH_FLOOR_MS)
        );
    }

    // FR-9/FR-10: an absolute argv0 and a shell argv0 are both refused.
    #[test]
    fn absolute_and_shell_argv0_are_refused() {
        let root = tmp_root("manifest-argv0");
        for (name, argv0) in [
            ("abs", "/usr/bin/git"),
            ("shell", "bash"),
            ("shell-exe-suffix", "bash.exe"),
            ("shell-uppercase", "SH"),
            ("shell-exe-uppercase", "CMD.EXE"),
            ("shell-mixed-case-exe", "PowerShell.exe"),
        ] {
            let dir = root.join(name);
            write_manifest(
                &dir,
                &format!(
                    r#"{{
                        "manifest": 1,
                        "detect": {{ "kind": "pathExists", "path": "x" }},
                        "panels": [
                            {{ "id": "a", "label": "A", "scope": "project", "primitive": "key-value",
                               "emptyCopy": "none",
                               "provider": {{ "argv0": "{argv0}", "args": [] }} }}
                        ]
                    }}"#
                ),
            );
            let ext = load_one(&dir).unwrap();
            assert_eq!(
                ext.manifest_error.unwrap().code,
                "EXT_MANIFEST_INVALID",
                "{name} must be refused"
            );
        }
    }

    // FR-10: the commandSucceeds detect predicate shares the shell blocklist with
    // provider.argv0 and must reject the same case/suffix variants.
    #[test]
    fn detect_command_succeeds_shell_argv0_variants_are_refused() {
        let root = tmp_root("manifest-detect-argv0");
        for (name, argv0) in [
            ("shell", "bash"),
            ("shell-exe-suffix", "bash.exe"),
            ("shell-uppercase", "SH"),
            ("shell-exe-uppercase", "CMD.EXE"),
            ("shell-mixed-case-exe", "PowerShell.exe"),
        ] {
            let dir = root.join(name);
            write_manifest(
                &dir,
                &format!(
                    r#"{{
                        "manifest": 1,
                        "detect": {{ "kind": "commandSucceeds", "argv": ["{argv0}"] }},
                        "panels": [
                            {{ "id": "a", "label": "A", "scope": "project", "primitive": "key-value",
                               "emptyCopy": "none",
                               "provider": {{ "argv0": "kubectl", "args": [] }} }}
                        ]
                    }}"#
                ),
            );
            let ext = load_one(&dir).unwrap();
            assert_eq!(
                ext.manifest_error.unwrap().code,
                "EXT_MANIFEST_INVALID",
                "{name} must be refused"
            );
        }
    }

    // FR-7: two token slots in one manifest is a structural refusal.
    #[test]
    fn two_token_slots_are_refused() {
        let root = tmp_root("manifest-two-tokens");
        let dir = root.join("dual");
        write_manifest(
            &dir,
            r#"{
                "manifest": 1,
                "detect": { "kind": "pathExists", "path": "x" },
                "panels": [
                    { "id": "list", "label": "List", "scope": "project", "primitive": "table",
                      "emptyCopy": "none", "columns": [{"key":"id","label":"Id","kind":"text"}],
                      "provider": { "argv0": "echo", "args": [] } },
                    { "id": "logs1", "label": "Logs1", "scope": "project", "primitive": "log-tail",
                      "emptyCopy": "none",
                      "tokenSource": { "panelId": "list", "rowKey": "id" },
                      "source": { "kind": "process", "argv0": "echo", "args": ["${token}"] } },
                    { "id": "logs2", "label": "Logs2", "scope": "project", "primitive": "log-tail",
                      "emptyCopy": "none",
                      "tokenSource": { "panelId": "list", "rowKey": "id" },
                      "source": { "kind": "process", "argv0": "echo", "args": ["${token}"] } }
                ]
            }"#,
        );
        let ext = load_one(&dir).unwrap();
        assert_eq!(ext.manifest_error.unwrap().code, "EXT_MANIFEST_INVALID");
    }

    // FR-38 (extensions): a tokenSource naming a non-sibling is refused.
    #[test]
    fn a_token_source_naming_a_non_sibling_is_refused() {
        let root = tmp_root("manifest-bad-token-source");
        let dir = root.join("k8s");
        write_manifest(
            &dir,
            r#"{
                "manifest": 1,
                "detect": { "kind": "pathExists", "path": "x" },
                "panels": [
                    { "id": "logs", "label": "Logs", "scope": "project", "primitive": "log-tail",
                      "emptyCopy": "none",
                      "tokenSource": { "panelId": "nope", "rowKey": "id" },
                      "source": { "kind": "process", "argv0": "echo", "args": ["${token}"] } }
                ]
            }"#,
        );
        let ext = load_one(&dir).unwrap();
        assert_eq!(ext.manifest_error.unwrap().code, "EXT_MANIFEST_INVALID");
    }

    // extension-install FR-51 (review round 3, CRITICAL): declared commands
    // strip C0/C1 control characters and Unicode bidi-control/zero-width code
    // points before they cross IPC to the consent dialog.
    #[test]
    fn declared_commands_strip_control_and_bidi_characters() {
        let root = tmp_root("manifest-declared-commands-bidi");
        let dir = root.join("k8s");
        write_manifest(
            &dir,
            "{\"manifest\":1,\"detect\":{\"kind\":\"pathExists\",\"path\":\"x\"},\"panels\":[\
                {\"id\":\"pods\",\"label\":\"Pods\",\"scope\":\"project\",\"primitive\":\"table\",\
                  \"emptyCopy\":\"none\",\"columns\":[{\"key\":\"id\",\"label\":\"Id\",\"kind\":\"text\"}],\
                  \"provider\":{\"argv0\":\"kubectl\",\"args\":[\"get\\u202epods\\u200b\"]}}\
            ]}",
        );
        let ext = load_one(&dir).unwrap();
        assert!(ext.manifest_error.is_none(), "{:?}", ext.manifest_error);
        assert_eq!(
            ext.declared_commands,
            vec![vec!["kubectl".to_string(), "getpods".to_string()]]
        );
    }

    // extension-install FR-16: declared commands are deduplicated, panels then
    // the predicate's.
    #[test]
    fn declared_commands_are_deduplicated_and_ordered() {
        let root = tmp_root("manifest-declared-commands");
        let dir = root.join("k8s");
        write_manifest(
            &dir,
            r#"{
                "manifest": 1,
                "detect": { "kind": "commandSucceeds", "argv": ["kubectl", "version"] },
                "panels": [
                    { "id": "pods", "label": "Pods", "scope": "project", "primitive": "table",
                      "emptyCopy": "none", "columns": [{"key":"id","label":"Id","kind":"text"}],
                      "provider": { "argv0": "kubectl", "args": ["get", "pods"] } }
                ]
            }"#,
        );
        let ext = load_one(&dir).unwrap();
        assert!(ext.manifest_error.is_none(), "{:?}", ext.manifest_error);
        assert_eq!(
            ext.declared_commands,
            vec![
                vec!["kubectl".to_string(), "get".to_string(), "pods".to_string()],
                vec!["kubectl".to_string(), "version".to_string()],
            ]
        );
    }

    // FR-6: a `weight` above `u32::MAX` must be REJECTED — never
    // truncated/wrapped into a smaller, different weight.
    #[test]
    fn a_column_weight_above_u32_max_is_refused_not_truncated() {
        let root = tmp_root("manifest-column-weight-overflow");
        let dir = root.join("k8s");
        write_manifest(
            &dir,
            r#"{
                "manifest": 1,
                "detect": { "kind": "pathExists", "path": "x" },
                "panels": [
                    { "id": "pods", "label": "Pods", "scope": "project", "primitive": "table",
                      "emptyCopy": "none",
                      "columns": [{"key":"id","label":"Id","kind":"text","weight":4294967296}],
                      "provider": { "argv0": "kubectl", "args": [] } }
                ]
            }"#,
        );
        let ext = load_one(&dir).unwrap();
        let err = ext.manifest_error.unwrap();
        assert_eq!(err.code, "EXT_MANIFEST_INVALID");
        assert_eq!(
            err.detail.unwrap()["pointer"],
            json!("/panels/0/columns/0/weight")
        );
    }
}
