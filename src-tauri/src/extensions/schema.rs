//! `extensions` FR-25 + FR-51 — payload validation and the core-side
//! sanitization. Unchanged by `extension-install` except that a `lines`
//! provider is now driven by manifest-declared fields (`provider.rs`)
//! instead of a compiled `NdjsonFormat`/`LineFormat` — docker's NDJSON
//! adapter is GONE along with the compiled registry (extension-install §1).
//!
//! Two rules carry this file:
//!  * A provider's stdout is validated against the payload schema for the
//!    panel's DECLARED primitive. It validates whole or not at all — a
//!    partially-valid payload is never partially rendered (FR-25).
//!  * Every provider-derived string is sanitized HERE, in the core, before it
//!    crosses IPC — not at display time (FR-51).

use super::provider::rows_from_lines;
use super::{
    KeyValueRow, OutputFormat, PanelData, PanelDefinition, PrimitiveKind, StatTile, StatusTone,
    EXT_FIELD_MAX_CHARS,
};
use serde_json::Value;
use std::collections::HashMap;

/// FR-25: the one failure this module can produce. It carries no provider
/// text — the message the user sees is composed from the panel's own
/// definition.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SchemaError;

// ---------- FR-51: sanitization ----------

pub(crate) fn strip_control_sequences(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let code = c as u32;
        if code < 0x20 || code == 0x7f || (0x80..=0x9f).contains(&code) {
            continue;
        }
        out.push(c);
    }
    out
}

pub(crate) fn sanitize_field(input: &str, max_chars: usize) -> String {
    let stripped = strip_control_sequences(input);
    truncate_chars(&stripped, max_chars)
}

/// Unicode bidi-control (explicit embeddings/overrides `U+202A`-`U+202E`,
/// isolates `U+2066`-`U+2069`, the bare marks `U+200E`/`U+200F`) and
/// zero-width formatting code points (`U+200B`-`U+200D`, `U+FEFF`). Shared by
/// every manifest-controlled string that crosses IPC and must not carry a
/// directional or hiding override — `manifest::sanitize_argv_element` (the
/// declared-commands consent line) and `sanitize_field_strict` below.
pub(crate) fn strip_bidi_and_zero_width(input: &str) -> String {
    input
        .chars()
        .filter(|c| {
            !matches!(*c,
                '\u{200b}'..='\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
                | '\u{feff}'
            )
        })
        .collect()
}

/// Like `sanitize_field`, but also strips bidi-control/zero-width code
/// points via `strip_bidi_and_zero_width` — for manifest-controlled fields
/// (e.g. `detect::sanitize_reason_field`) that must close the same
/// sanitization-boundary gap `sanitize_argv_element` closes for argv.
pub(crate) fn sanitize_field_strict(input: &str, max_chars: usize) -> String {
    let stripped = strip_bidi_and_zero_width(&strip_control_sequences(input));
    truncate_chars(&stripped, max_chars)
}

pub(crate) fn sanitize_line(input: &str) -> String {
    sanitize_field(input, EXT_FIELD_MAX_CHARS)
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let mut out: String = input.chars().take(max_chars).collect();
    out.push('…');
    out
}

// ---------- FR-25: per-primitive validation ----------

fn field(obj: &serde_json::Map<String, Value>, key: &str) -> Result<String, SchemaError> {
    match obj.get(key) {
        Some(Value::String(s)) => Ok(sanitize_field(s, EXT_FIELD_MAX_CHARS)),
        _ => Err(SchemaError),
    }
}

fn optional_field(
    obj: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, SchemaError> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(sanitize_field(s, EXT_FIELD_MAX_CHARS))),
        _ => Err(SchemaError),
    }
}

fn tone(obj: &serde_json::Map<String, Value>) -> Result<StatusTone, SchemaError> {
    match obj.get("tone") {
        None | Some(Value::Null) => Ok(StatusTone::Neutral),
        Some(Value::String(s)) => StatusTone::from_wire(s).ok_or(SchemaError),
        _ => Err(SchemaError),
    }
}

fn cell_value(value: &Value) -> Result<String, SchemaError> {
    let raw = match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        _ => return Err(SchemaError),
    };
    Ok(sanitize_field(&raw, EXT_FIELD_MAX_CHARS))
}

fn key_value_data(root: &Value) -> Result<PanelData, SchemaError> {
    let rows = root
        .get("rows")
        .and_then(|v| v.as_array())
        .ok_or(SchemaError)?;
    let rows = rows
        .iter()
        .map(|row| {
            let obj = row.as_object().ok_or(SchemaError)?;
            Ok(KeyValueRow {
                key: field(obj, "key")?,
                value: field(obj, "value")?,
                tone: tone(obj)?,
            })
        })
        .collect::<Result<Vec<_>, SchemaError>>()?;
    Ok(PanelData::KeyValue { rows })
}

fn stat_row_data(root: &Value) -> Result<PanelData, SchemaError> {
    let tiles = root
        .get("tiles")
        .and_then(|v| v.as_array())
        .ok_or(SchemaError)?;
    let tiles = tiles
        .iter()
        .map(|tile| {
            let obj = tile.as_object().ok_or(SchemaError)?;
            Ok(StatTile {
                label: field(obj, "label")?,
                value: field(obj, "value")?,
                sublabel: optional_field(obj, "sublabel")?,
            })
        })
        .collect::<Result<Vec<_>, SchemaError>>()?;
    Ok(PanelData::StatRow { tiles })
}

fn table_data(
    root: &Value,
    offset: u32,
    limit: u32,
    paginated: bool,
) -> Result<PanelData, SchemaError> {
    let raw_rows = root
        .get("rows")
        .and_then(|v| v.as_array())
        .ok_or(SchemaError)?;
    let rows = raw_rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let obj = row.as_object().ok_or(SchemaError)?;
            let id = match obj.get("id") {
                Some(Value::String(s)) => sanitize_field(s, EXT_FIELD_MAX_CHARS),
                Some(Value::Number(n)) => n.to_string(),
                None | Some(Value::Null) => (offset as usize + index).to_string(),
                _ => return Err(SchemaError),
            };
            let mut cells: HashMap<String, String> = HashMap::new();
            match obj.get("cells") {
                Some(Value::Object(map)) => {
                    for (k, v) in map.iter() {
                        cells.insert(sanitize_field(k, EXT_FIELD_MAX_CHARS), cell_value(v)?);
                    }
                }
                None | Some(Value::Null) => {}
                _ => return Err(SchemaError),
            }
            Ok(super::TableRow {
                id,
                cells,
                tone: tone(obj)?,
            })
        })
        .collect::<Result<Vec<_>, SchemaError>>()?;
    let payload_offset = root.get("offset").and_then(|v| v.as_u64());
    let has_more = match root.get("hasMore") {
        Some(Value::Bool(b)) => *b,
        None | Some(Value::Null) => paginated && rows.len() as u32 >= limit && limit > 0,
        _ => return Err(SchemaError),
    };
    Ok(PanelData::Table {
        rows,
        offset: payload_offset.map(|o| o as u32).unwrap_or(offset),
        has_more,
    })
}

/// One provider's stdout → the panel's `PanelData`, or `EXT_SCHEMA_INVALID`.
/// The panel's DECLARED primitive picks the schema — a provider cannot decide
/// which shape it is answering with.
pub(crate) fn panel_data(
    panel: &PanelDefinition,
    stdout: &[u8],
    offset: u32,
    limit: u32,
) -> Result<PanelData, SchemaError> {
    let provider = panel.provider.as_ref().ok_or(SchemaError)?;
    let text = String::from_utf8_lossy(stdout);
    match &provider.output {
        OutputFormat::Json => {
            let root: Value = serde_json::from_str(text.trim()).map_err(|_| SchemaError)?;
            match panel.primitive {
                PrimitiveKind::KeyValue => key_value_data(&root),
                PrimitiveKind::StatRow => stat_row_data(&root),
                PrimitiveKind::Table => table_data(&root, offset, limit, panel.paginated),
                PrimitiveKind::LogTail => Err(SchemaError),
            }
        }
        // FR-21/FR-22: `lines` feeds `table` only — enforced already at load
        // time (manifest.rs), re-asserted here defensively.
        OutputFormat::Lines {
            separator,
            fields,
            id_field,
        } => {
            if panel.primitive != PrimitiveKind::Table {
                return Err(SchemaError);
            }
            let rows = rows_from_lines(separator, fields, id_field.as_deref(), &text);
            let has_more = panel.paginated && limit > 0 && rows.len() as u32 >= limit;
            Ok(PanelData::Table {
                rows,
                offset,
                has_more,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::{ColumnKind, ColumnSpec, PanelScope, ProviderSpec};

    #[test]
    fn ansi_sequences_are_stripped_in_the_core() {
        assert_eq!(sanitize_field("\u{1b}[31mred\u{1b}[0m", 512), "red");
        assert_eq!(sanitize_field("\u{1b}]0;title\u{7}web", 512), "web");
        assert_eq!(sanitize_field("\u{1b}]0;t\u{1b}\\web", 512), "web");
        assert_eq!(sanitize_field("a\u{1b}Bc", 512), "ac");
    }

    #[test]
    fn control_characters_are_stripped_in_the_core() {
        assert_eq!(sanitize_field("a\u{7}b\rc\nd\u{0}e", 512), "abcde");
        assert_eq!(sanitize_field("a\u{9b}[31mb", 512), "a[31mb");
        assert_eq!(sanitize_field("tab\there", 512), "tabhere");
        assert_eq!(strip_control_sequences("a\nb\u{7}c"), "abc");
    }

    #[test]
    fn a_markup_shaped_value_survives_as_inert_text() {
        let evil = "<img src=x onerror=alert(1)>";
        assert_eq!(sanitize_field(evil, 512), evil);
    }

    #[test]
    fn fields_are_truncated_to_the_declared_maximum() {
        let long = "x".repeat(600);
        let out = sanitize_field(&long, EXT_FIELD_MAX_CHARS);
        assert_eq!(out.chars().count(), EXT_FIELD_MAX_CHARS + 1);
        assert!(out.ends_with('…'));
        let wide = "é".repeat(600);
        assert_eq!(
            sanitize_field(&wide, EXT_FIELD_MAX_CHARS).chars().count(),
            EXT_FIELD_MAX_CHARS + 1
        );
        assert_eq!(sanitize_field("short", 512), "short");
    }

    fn key_value_panel() -> PanelDefinition {
        PanelDefinition {
            id: "test:health".into(),
            label: "Health".into(),
            scope: PanelScope::Project,
            primitive: PrimitiveKind::KeyValue,
            paginated: false,
            refresh_ms: None,
            columns: None,
            empty_copy: "nothing to report".into(),
            token_source: None,
            provider: Some(ProviderSpec {
                argv0: "test".into(),
                args: vec![],
                page_args: vec![],
                output: OutputFormat::Json,
            }),
            source: None,
        }
    }

    fn stat_row_panel() -> PanelDefinition {
        PanelDefinition {
            primitive: PrimitiveKind::StatRow,
            ..key_value_panel()
        }
    }

    fn table_panel(paginated: bool, output: OutputFormat) -> PanelDefinition {
        PanelDefinition {
            id: "test:table".into(),
            primitive: PrimitiveKind::Table,
            paginated,
            columns: Some(vec![ColumnSpec {
                key: "id".into(),
                label: "Id".into(),
                kind: ColumnKind::Text,
                weight: None,
            }]),
            provider: Some(ProviderSpec {
                argv0: "test".into(),
                args: vec![],
                page_args: vec![],
                output,
            }),
            ..key_value_panel()
        }
    }

    fn log_tail_panel() -> PanelDefinition {
        PanelDefinition {
            primitive: PrimitiveKind::LogTail,
            provider: None,
            source: Some(super::super::Source::File {
                path_template: "x.log".into(),
            }),
            ..key_value_panel()
        }
    }

    #[test]
    fn a_key_value_payload_validates_whole() {
        let stdout = br#"{"rows":[{"key":"pipeline","value":"ok","tone":"ok"},{"key":"specs","value":"3"}]}"#;
        let data = panel_data(&key_value_panel(), stdout, 0, 100).unwrap();
        let PanelData::KeyValue { rows } = data else {
            panic!("expected key-value data")
        };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].tone, StatusTone::Ok);
        assert_eq!(rows[1].tone, StatusTone::Neutral);
    }

    #[test]
    fn a_payload_of_the_wrong_shape_is_rejected_whole() {
        for stdout in [
            &br#"{"rows":"nope"}"#[..],
            &br#"{"items":[]}"#[..],
            &br#"not json at all"#[..],
            &br#"{"rows":[{"key":"a","value":"b"},{"key":"c"}]}"#[..],
            &br#"{"rows":[{"key":"a","value":"b","tone":"accent"}]}"#[..],
        ] {
            assert_eq!(
                panel_data(&key_value_panel(), stdout, 0, 100),
                Err(SchemaError),
                "{}",
                String::from_utf8_lossy(stdout)
            );
        }
    }

    #[test]
    fn a_zero_row_payload_is_a_success() {
        let data = panel_data(&key_value_panel(), br#"{"rows":[]}"#, 0, 100).unwrap();
        assert_eq!(data, PanelData::KeyValue { rows: vec![] });
    }

    #[test]
    fn a_stat_row_payload_validates_its_tiles() {
        let stdout = br#"{"tiles":[{"label":"spend","value":"$4.10","sublabel":"today"},{"label":"turns","value":"12"}]}"#;
        let PanelData::StatRow { tiles } = panel_data(&stat_row_panel(), stdout, 0, 100).unwrap()
        else {
            panic!("expected stat-row data")
        };
        assert_eq!(tiles[0].sublabel.as_deref(), Some("today"));
        assert_eq!(tiles[1].sublabel, None);
        assert_eq!(
            panel_data(&stat_row_panel(), br#"{"tiles":[{"label":"a"}]}"#, 0, 100),
            Err(SchemaError)
        );
    }

    #[test]
    fn a_table_payload_carries_its_offset_and_has_more() {
        let stdout = br#"{"rows":[{"id":"a","cells":{"project":"francois","sessions":3},"tone":"busy"}],"offset":100,"hasMore":true}"#;
        let panel = table_panel(false, OutputFormat::Json);
        let PanelData::Table {
            rows,
            offset,
            has_more,
        } = panel_data(&panel, stdout, 0, 100).unwrap()
        else {
            panic!("expected table data")
        };
        assert_eq!(offset, 100);
        assert!(has_more);
        assert_eq!(rows[0].tone, StatusTone::Busy);
        assert_eq!(rows[0].cells.get("sessions").unwrap(), "3");
    }

    #[test]
    fn a_structured_cell_value_fails_the_payload() {
        let stdout = br#"{"rows":[{"id":"a","cells":{"x":{"y":1}}}]}"#;
        assert_eq!(
            panel_data(&table_panel(false, OutputFormat::Json), stdout, 0, 100),
            Err(SchemaError)
        );
    }

    #[test]
    fn a_line_oriented_provider_feeds_the_table_primitive() {
        let output = OutputFormat::Lines {
            separator: "\u{1f}".into(),
            fields: vec![
                "id".into(),
                "commit".into(),
                "when".into(),
                "subject".into(),
            ],
            id_field: Some("id".into()),
        };
        let panel = table_panel(true, output);
        let stdout =
            "aaa\u{1f}aa\u{1f}1700000000\u{1f}first\nbbb\u{1f}bb\u{1f}1700000060\u{1f}second\n";
        let PanelData::Table {
            rows,
            offset,
            has_more,
        } = panel_data(&panel, stdout.as_bytes(), 100, 2).unwrap()
        else {
            panic!("expected table data")
        };
        assert_eq!(offset, 100);
        assert!(has_more, "a full page means there may be another");
        assert_eq!(rows[0].id, "aaa");
        assert_eq!(rows[0].cells.get("commit").unwrap(), "aa");
        // A short page ends the pagination.
        let PanelData::Table { has_more, .. } =
            panel_data(&panel, stdout.as_bytes(), 0, 100).unwrap()
        else {
            panic!("expected table data")
        };
        assert!(!has_more);
    }

    #[test]
    fn an_unpaginated_table_never_reports_has_more() {
        let output = OutputFormat::Lines {
            separator: "\u{1f}".into(),
            fields: vec!["branch".into()],
            id_field: Some("branch".into()),
        };
        let panel = table_panel(false, output);
        let PanelData::Table { has_more, .. } =
            panel_data(&panel, "main\u{1f}\n".as_bytes(), 0, 1).unwrap()
        else {
            panic!("expected table data")
        };
        assert!(!has_more);
    }

    #[test]
    fn a_log_tail_panel_never_resolves_through_a_provider_call() {
        assert_eq!(
            panel_data(&log_tail_panel(), b"whatever", 0, 100),
            Err(SchemaError)
        );
    }
}
