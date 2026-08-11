//! FR-25 + FR-51 — payload validation and the core-side sanitization.
//!
//! Two rules carry this file:
//!  * A provider's stdout is validated against the payload schema for the
//!    panel's DECLARED primitive. It validates whole or not at all — a
//!    partially-valid payload is never partially rendered (FR-25).
//!  * Every provider-derived string is sanitized HERE, in the core, before it
//!    crosses IPC — not at display time (FR-51). ANSI escapes and C0/C1 control
//!    characters are stripped and each field is truncated to 512 characters with
//!    a trailing `…`, so a branch named `<img src=x onerror=…>` reaches the
//!    webview as inert text with nothing executable left in it.

use super::provider::{rows_from_lines, rows_from_ndjson};
use super::{
    KeyValueRow, OutputFormat, PanelData, PanelDefinition, PrimitiveKind, StatTile, StatusTone,
    TableRow, EXT_FIELD_MAX_CHARS,
};
use serde_json::Value;
use std::collections::HashMap;

/// FR-25: the one failure this module can produce. It carries no provider text —
/// the message the user sees is composed from the panel's own definition.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SchemaError;

// ---------- FR-51: sanitization ----------

/// Strip ANSI escape sequences and C0/C1 control characters, including `\n` —
/// every field this sanitizer ever sees is single-line by the time it gets here
/// (log-tail BODIES are split into lines upstream and sanitized one at a time
/// via `sanitize_line`).
pub(crate) fn strip_control_sequences(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.next() {
                // CSI — consume parameter/intermediate bytes up to the final byte.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC — runs until BEL or ST (`ESC \`).
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
                // Any other two-character escape: both characters go.
                _ => {}
            }
            continue;
        }
        // C0 (incl. DEL) and C1 — never renderable, and the classic smuggling
        // channel for terminal control in a "plain" string.
        let code = c as u32;
        if code < 0x20 || code == 0x7f || (0x80..=0x9f).contains(&code) {
            continue;
        }
        out.push(c);
    }
    out
}

/// FR-51: strip, then truncate to `max_chars` with a trailing `…`.
pub(crate) fn sanitize_field(input: &str, max_chars: usize) -> String {
    let stripped = strip_control_sequences(input);
    truncate_chars(&stripped, max_chars)
}

/// A `log-tail` line: same stripping, same 512-character bound, newlines already
/// consumed by the line split above it.
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

/// A declared tone. Absent reads as `neutral`; present-but-unknown is a schema
/// failure rather than a silent downgrade — a provider inventing tones is a
/// provider Francois does not understand.
fn tone(obj: &serde_json::Map<String, Value>) -> Result<StatusTone, SchemaError> {
    match obj.get("tone") {
        None | Some(Value::Null) => Ok(StatusTone::Neutral),
        Some(Value::String(s)) => StatusTone::from_wire(s).ok_or(SchemaError),
        _ => Err(SchemaError),
    }
}

/// A `cells` value. Scalars are accepted and stringified (a provider counting
/// rows emits a number); an object or an array is a shape Francois does not
/// render, so it fails the payload.
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
                // Stable within a page is all FR-36 asks; the index is that.
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
            Ok(TableRow {
                id,
                cells,
                tone: tone(obj)?,
            })
        })
        .collect::<Result<Vec<_>, SchemaError>>()?;
    // FR-31: the provider answers `{ rows, offset, hasMore }`; a provider that
    // answers only `rows` is still valid and simply has no further page.
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
                // A log-tail panel never resolves through a provider call.
                PrimitiveKind::LogTail => Err(SchemaError),
            }
        }
        // FR-54: line-oriented and NDJSON providers feed `table` only.
        OutputFormat::Lines(fmt) => {
            if panel.primitive != PrimitiveKind::Table {
                return Err(SchemaError);
            }
            let rows = rows_from_lines(fmt, &text);
            let has_more = panel.paginated && limit > 0 && rows.len() as u32 >= limit;
            Ok(PanelData::Table {
                rows,
                offset,
                has_more,
            })
        }
        OutputFormat::Ndjson(fmt) => {
            if panel.primitive != PrimitiveKind::Table {
                return Err(SchemaError);
            }
            let rows = rows_from_ndjson(fmt, &text).map_err(|_| SchemaError)?;
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
    use crate::extensions::registry;

    // FR-51: ANSI sequences never reach the webview.
    #[test]
    fn ansi_sequences_are_stripped_in_the_core() {
        assert_eq!(sanitize_field("\u{1b}[31mred\u{1b}[0m", 512), "red");
        assert_eq!(sanitize_field("\u{1b}]0;title\u{7}web", 512), "web");
        assert_eq!(sanitize_field("\u{1b}]0;t\u{1b}\\web", 512), "web");
        assert_eq!(sanitize_field("a\u{1b}Bc", 512), "ac");
    }

    // FR-51: C0/C1 controls go too — including the ones a terminal acts on.
    #[test]
    fn control_characters_are_stripped_in_the_core() {
        assert_eq!(sanitize_field("a\u{7}b\rc\nd\u{0}e", 512), "abcde");
        assert_eq!(sanitize_field("a\u{9b}[31mb", 512), "a[31mb");
        assert_eq!(sanitize_field("tab\there", 512), "tabhere");
        // Newlines go too — sanitize_field's single-line contract.
        assert_eq!(strip_control_sequences("a\nb\u{7}c"), "abc");
    }

    // §7: a hostile-looking branch name survives as INERT TEXT — nothing is
    // escaped away, because nothing about it is executable once it is a string.
    #[test]
    fn a_markup_shaped_value_survives_as_inert_text() {
        let evil = "<img src=x onerror=alert(1)>";
        assert_eq!(sanitize_field(evil, 512), evil);
    }

    // FR-51: 512 characters, with a trailing ellipsis so truncation is visible.
    #[test]
    fn fields_are_truncated_to_the_declared_maximum() {
        let long = "x".repeat(600);
        let out = sanitize_field(&long, EXT_FIELD_MAX_CHARS);
        assert_eq!(out.chars().count(), EXT_FIELD_MAX_CHARS + 1);
        assert!(out.ends_with('…'));
        // Multi-byte characters are counted as characters, never bytes.
        let wide = "é".repeat(600);
        assert_eq!(
            sanitize_field(&wide, EXT_FIELD_MAX_CHARS).chars().count(),
            EXT_FIELD_MAX_CHARS + 1
        );
        assert_eq!(sanitize_field("short", 512), "short");
    }

    fn panel(id: &str) -> &'static PanelDefinition {
        registry::panel(id).unwrap().1
    }

    // FR-25: a validated key-value payload, tones included.
    #[test]
    fn a_key_value_payload_validates_whole() {
        let stdout = br#"{"rows":[{"key":"pipeline","value":"ok","tone":"ok"},{"key":"specs","value":"3"}]}"#;
        let data = panel_data(panel("cohorte:health"), stdout, 0, 100).unwrap();
        let PanelData::KeyValue { rows } = data else {
            panic!("expected key-value data");
        };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].tone, StatusTone::Ok);
        // A missing tone reads as neutral, not as an error.
        assert_eq!(rows[1].tone, StatusTone::Neutral);
    }

    // FR-25: the wrong shape is EXT_SCHEMA_INVALID — never a partial render.
    #[test]
    fn a_payload_of_the_wrong_shape_is_rejected_whole() {
        for stdout in [
            &br#"{"rows":"nope"}"#[..],
            &br#"{"items":[]}"#[..],
            &br#"not json at all"#[..],
            // The second row is broken: the FIRST one is discarded with it.
            &br#"{"rows":[{"key":"a","value":"b"},{"key":"c"}]}"#[..],
            // An unknown tone is a provider Francois does not understand.
            &br#"{"rows":[{"key":"a","value":"b","tone":"accent"}]}"#[..],
        ] {
            assert_eq!(
                panel_data(panel("cohorte:health"), stdout, 0, 100),
                Err(SchemaError),
                "{}",
                String::from_utf8_lossy(stdout)
            );
        }
    }

    // §7: `{ "rows": [] }` is a SUCCESS. The section's empty copy renders — the
    // frontend must be able to tell it apart from an error, so it gets data.
    #[test]
    fn a_zero_row_payload_is_a_success() {
        let data = panel_data(panel("cohorte:health"), br#"{"rows":[]}"#, 0, 100).unwrap();
        assert_eq!(data, PanelData::KeyValue { rows: vec![] });
    }

    #[test]
    fn a_stat_row_payload_validates_its_tiles() {
        let stdout = br#"{"tiles":[{"label":"spend","value":"$4.10","sublabel":"today"},{"label":"turns","value":"12"}]}"#;
        let PanelData::StatRow { tiles } =
            panel_data(panel("cohorte:cost"), stdout, 0, 100).unwrap()
        else {
            panic!("expected stat-row data");
        };
        assert_eq!(tiles[0].sublabel.as_deref(), Some("today"));
        assert_eq!(tiles[1].sublabel, None);
        assert_eq!(
            panel_data(
                panel("cohorte:cost"),
                br#"{"tiles":[{"label":"a"}]}"#,
                0,
                100
            ),
            Err(SchemaError)
        );
    }

    // FR-31: `{ rows, offset, hasMore }` off a JSON table provider.
    #[test]
    fn a_table_payload_carries_its_offset_and_has_more() {
        let stdout = br#"{"rows":[{"id":"a","cells":{"project":"francois","sessions":3},"tone":"busy"}],"offset":100,"hasMore":true}"#;
        let PanelData::Table {
            rows,
            offset,
            has_more,
        } = panel_data(panel("cohorte:fleet"), stdout, 0, 100).unwrap()
        else {
            panic!("expected table data");
        };
        assert_eq!(offset, 100);
        assert!(has_more);
        assert_eq!(rows[0].tone, StatusTone::Busy);
        // A numeric cell is stringified rather than rejected.
        assert_eq!(rows[0].cells.get("sessions").unwrap(), "3");
    }

    // FR-36: an object-valued cell is a shape no primitive renders.
    #[test]
    fn a_structured_cell_value_fails_the_payload() {
        let stdout = br#"{"rows":[{"id":"a","cells":{"x":{"y":1}}}]}"#;
        assert_eq!(
            panel_data(panel("cohorte:fleet"), stdout, 0, 100),
            Err(SchemaError)
        );
    }

    // FR-54: git's line output becomes rows without a per-extension seam, and
    // `hasMore` is decided by the page being full (FR-31/FR-32).
    #[test]
    fn a_line_oriented_provider_feeds_the_table_primitive() {
        let stdout = "aaa\u{1f}aa\u{1f}Ada\u{1f}1700000000\u{1f}first\nbbb\u{1f}bb\u{1f}Ada\u{1f}1700000060\u{1f}second\n";
        let PanelData::Table {
            rows,
            offset,
            has_more,
        } = panel_data(panel("git:log"), stdout.as_bytes(), 100, 2).unwrap()
        else {
            panic!("expected table data");
        };
        assert_eq!(offset, 100);
        assert!(has_more, "a full page means there may be another");
        assert_eq!(rows[0].id, "aaa");
        assert_eq!(rows[0].cells.get("commit").unwrap(), "aa");
        assert_eq!(rows[0].cells.get("when").unwrap(), "1700000000000");
        // A short page ends the pagination.
        let PanelData::Table { has_more, .. } =
            panel_data(panel("git:log"), stdout.as_bytes(), 0, 100).unwrap()
        else {
            panic!("expected table data");
        };
        assert!(!has_more);
    }

    // An unpaginated table never claims another page.
    #[test]
    fn an_unpaginated_table_never_reports_has_more() {
        let stdout = "main\u{1f}abc\u{1f}1700000000\u{1f}subject\n";
        let PanelData::Table { has_more, .. } =
            panel_data(panel("git:branches"), stdout.as_bytes(), 0, 1).unwrap()
        else {
            panic!("expected table data");
        };
        assert!(!has_more);
    }

    // A log-tail panel has no provider at all — it opens a stream instead.
    #[test]
    fn a_log_tail_panel_never_resolves_through_a_provider_call() {
        assert_eq!(
            panel_data(panel("docker:logs"), b"whatever", 0, 100),
            Err(SchemaError)
        );
    }
}
