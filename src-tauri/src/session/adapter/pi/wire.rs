//! session/adapter/pi/wire.rs — the private Pi RPC wire protocol
//! (specs/pi-rpc-sessions.md §5, FR-2/FR-3): LF-delimited JSON framing, plus
//! the shapes that ride it. Never exported outside this module (spec §5:
//! "Private wire types belong only in session/adapter/pi/wire.rs").
//!
//! **Provisional.** No real protocol capture exists yet
//! (specs/research/pi-integration-audit.md's "Open evidence" section) — the
//! command/response envelope and the three certified event kinds below are
//! this feature's best-effort mirror of the upstream RPC doc the audit links
//! (LF-delimited JSON; `id`-correlated command/response pairs; uncorrelated
//! events; prompt acceptance distinct from completion; `agent_settled`
//! distinct from `agent_end`). A future certification pass reconciles these
//! against a real capture — see the spec's acceptance criterion "Sanitized
//! real captures identify the certified artifact; provisional fixtures are
//! labelled."

use crate::ipc::{AppError, ErrorCode};
use crate::session::attachments::{mime_type_for_extension, Attachment};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// FR-2: one wire record (a line, before its LF) may be at most this large.
pub(crate) const MAX_RECORD_BYTES: usize = 32 * 1024 * 1024;

// ---------------------------------------------------------------- framing

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrameError {
    /// FR-2: a record exceeded [`MAX_RECORD_BYTES`] before its terminating LF.
    OversizeRecord,
    /// A line's bytes did not decode as UTF-8.
    InvalidUtf8,
}

/// FR-2: LF-only framing that tolerates a trailing CR (CRLF) and preserves
/// U+2028/U+2029 within strings — those are 3-byte UTF-8 sequences distinct
/// from ASCII CR/LF, so splitting on raw `\n` bytes never touches them.
/// Buffering happens at the BYTE level between delimiters, so a multi-byte
/// UTF-8 character split across two `read()` calls is never decoded until its
/// line is complete: LF (`0x0A`) cannot appear as a UTF-8 continuation byte
/// (those are always `0x80..=0xBF`), so splitting raw bytes on it is always
/// safe, whatever landed mid-character in one `read()`.
#[derive(Default)]
pub(crate) struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Feed newly-read bytes; returns every complete line now buffered, or
    /// the first framing error encountered. FR-2: an oversize or malformed
    /// record fails the connection explicitly — the caller must not keep
    /// buffering past this point, so a caller that gets `Err` must not call
    /// `feed` again.
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>, FrameError> {
        self.buf.extend_from_slice(bytes);
        let mut lines = Vec::new();
        loop {
            let Some(pos) = self.buf.iter().position(|&b| b == b'\n') else {
                if self.buf.len() > MAX_RECORD_BYTES {
                    return Err(FrameError::OversizeRecord);
                }
                break;
            };
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // the LF itself
            if line.last() == Some(&b'\r') {
                line.pop(); // tolerate CRLF
            }
            if line.len() > MAX_RECORD_BYTES {
                return Err(FrameError::OversizeRecord);
            }
            match String::from_utf8(line) {
                Ok(s) => lines.push(s),
                Err(_) => return Err(FrameError::InvalidUtf8),
            }
        }
        Ok(lines)
    }
}

// ---------------------------------------------------------------- outbound

/// FR-4/FR-5: the outbound command kinds this MVP adapter sends.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PiCommandKind {
    /// FR-4: the whole handshake — no model call or user prompt needed.
    GetState,
    /// FR-4: acceptance only — `agent_settled` governs completion, not this.
    Prompt,
    /// The one cancellation verb this MVP wires up (`RuntimeSessionControl::cancel`).
    Interrupt,
}

impl PiCommandKind {
    pub(crate) fn wire_name(self) -> &'static str {
        match self {
            Self::GetState => "get_state",
            Self::Prompt => "prompt",
            Self::Interrupt => "interrupt",
        }
    }
}

/// spec §5: `PiCommand { id, type, ...validated fields }`.
#[derive(Serialize, Debug, Clone)]
pub(crate) struct PiCommand {
    pub(crate) id: String,
    #[serde(flatten)]
    pub(crate) body: PiCommandBody,
}

/// FR-7: one image content part of a `prompt` command — bytes resolved and
/// base64-encoded server-side (`build_prompt_body`), never round-tripped
/// from React.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub(crate) struct PiPromptImage {
    pub(crate) data: String,
    #[serde(rename = "mimeType")]
    pub(crate) mime_type: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type")]
pub(crate) enum PiCommandBody {
    #[serde(rename = "get_state")]
    GetState,
    #[serde(rename = "prompt")]
    Prompt {
        text: String,
        /// FR-7: empty for a text-only prompt, so the wire shape is
        /// byte-identical to before this field existed for the common case.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        images: Vec<PiPromptImage>,
    },
    #[serde(rename = "interrupt")]
    Interrupt,
}

/// FR-7: build a `prompt` command's body from the user's text and the
/// session's CURRENT attachment records, resolving only the ones the text
/// actually references — the same `@refPath` convention
/// `Session::validate_attachment_submission` already checks before a send is
/// even attempted. Rejects with `RUNTIME_UNSUPPORTED` before anything is read
/// off disk when a referenced attachment is an image and the connection's own
/// capability snapshot marks `images` unavailable — the adapter's own gate,
/// independent of (and in addition to) the generic session-level one, since
/// `PiConnection` is the only thing that knows the ACTUAL wire shape a model
/// without vision would otherwise receive. Image bytes are read and
/// base64-encoded HERE, server-side, and never travel back through React —
/// FR-7's "never transmit base64 back to React".
pub(crate) fn build_prompt_body(
    text: String,
    attachments: &[Attachment],
    images_supported: bool,
) -> Result<PiCommandBody, AppError> {
    let referenced_images: Vec<&Attachment> = attachments
        .iter()
        .filter(|a| a.kind == "image" && text.contains(&format!("@{}", a.ref_path)))
        .collect();
    if !referenced_images.is_empty() && !images_supported {
        return Err(AppError::new(
            ErrorCode::RuntimeUnsupported,
            "runtime images capability is unavailable",
        ));
    }
    let mut images = Vec::with_capacity(referenced_images.len());
    for a in referenced_images {
        let bytes = std::fs::read(&a.stored_path).map_err(|e| {
            AppError::new(
                ErrorCode::RuntimeUnavailable,
                format!("could not read attachment {}: {e}", a.name),
            )
        })?;
        use base64::Engine as _;
        images.push(PiPromptImage {
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            mime_type: mime_type_for_extension(&a.name).to_string(),
        });
    }
    Ok(PiCommandBody::Prompt { text, images })
}

impl PiCommand {
    pub(crate) fn kind(&self) -> PiCommandKind {
        match &self.body {
            PiCommandBody::GetState => PiCommandKind::GetState,
            PiCommandBody::Prompt { .. } => PiCommandKind::Prompt,
            PiCommandBody::Interrupt => PiCommandKind::Interrupt,
        }
    }

    /// The LF-terminated wire line for this command (FR-2: LF-only framing).
    pub(crate) fn to_line(&self) -> String {
        let mut line = serde_json::to_string(self).expect("PiCommand always serializes");
        line.push('\n');
        line
    }
}

// ---------------------------------------------------------------- inbound

/// spec §5: `PiResponse { id, command, success, data?, error? }`.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub(crate) struct PiResponse {
    pub(crate) id: String,
    pub(crate) command: String,
    pub(crate) success: bool,
    #[serde(default)]
    pub(crate) data: Option<Value>,
    #[serde(default)]
    pub(crate) error: Option<String>,
}

/// FR-3: the certified event union this MVP recognizes as "known" (their
/// mandatory fields are enforced — a missing one is a protocol failure).
/// `Unknown` carries the raw kind string for the per-kind/per-generation
/// diagnostic notice.
///
/// pi-transcript-events FR-1 (review round 3): `Recognized` carries the raw
/// kind for the FR-1 transcript event vocabulary (`message_start`,
/// `content_delta`, `text_end`, `message_end`, `toolcall_start/delta/end`,
/// `tool_execution_start/update/end`, `compaction_start/end`, `retry`,
/// `queue_update`) — these are known, healthy wire traffic that
/// `normalize::TranscriptReducer` (fed the same raw line separately by
/// `dispatcher::apply_transcript_line`) already owns; `ProtocolEngine` must
/// not count them as errors or diagnose them as unknown. `Unknown` stays
/// reserved for genuinely unrecognized kinds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PiEvent {
    AgentSettled,
    AgentEnd,
    TurnEnd,
    Recognized(&'static str),
    Unknown(String),
}

#[derive(Debug, PartialEq)]
pub(crate) enum Frame {
    Response(PiResponse),
    Event(PiEvent),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ParseError {
    InvalidJson,
    /// Not shaped like either a response or an event.
    NotAFrame,
    /// An event carries an empty/non-string `type`.
    EmptyEventType,
    /// A known event kind is missing one of its mandatory fields.
    MissingField {
        kind: &'static str,
        field: &'static str,
    },
}

/// A response carries `id`+`command`+`success`; an event carries `type` and
/// none of those three — the discriminator between the two frame shapes.
///
/// pi-transcript-events: also what `dispatcher::spawn_reader` uses to decide
/// whether a raw line is worth handing to `normalize::TranscriptReducer` at
/// all — a response object has no `type` field, so feeding it there would
/// misread as "a transcript event missing its type" and fail the reducer.
pub(crate) fn looks_like_response(value: &Value) -> bool {
    value.get("id").and_then(Value::as_str).is_some()
        && value.get("command").and_then(Value::as_str).is_some()
        && value.get("success").and_then(Value::as_bool).is_some()
}

fn looks_like_event(value: &Value) -> bool {
    value.get("type").is_some()
}

/// FR-2/FR-3: parse one already-framed, already-decoded line. Pure — no
/// correlation-table lookups here (that is the dispatcher's job); this only
/// decides what SHAPE the line is and whether a known event's mandatory
/// fields are present.
pub(crate) fn parse_line(line: &str) -> Result<Frame, ParseError> {
    let value: Value = serde_json::from_str(line).map_err(|_| ParseError::InvalidJson)?;
    if looks_like_response(&value) {
        let resp: PiResponse =
            serde_json::from_value(value).map_err(|_| ParseError::InvalidJson)?;
        return Ok(Frame::Response(resp));
    }
    if looks_like_event(&value) {
        return parse_event(&value).map(Frame::Event);
    }
    Err(ParseError::NotAFrame)
}

fn parse_event(value: &Value) -> Result<PiEvent, ParseError> {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
        .ok_or(ParseError::EmptyEventType)?;
    match kind {
        "agent_settled" => Ok(PiEvent::AgentSettled),
        "agent_end" => Ok(PiEvent::AgentEnd),
        "turn_end" => {
            if value.get("reason").and_then(Value::as_str).is_none() {
                return Err(ParseError::MissingField {
                    kind: "turn_end",
                    field: "reason",
                });
            }
            Ok(PiEvent::TurnEnd)
        }
        // pi-transcript-events FR-1: transcript-owned kinds — recognized here
        // only so `ProtocolEngine` doesn't misclassify healthy traffic as
        // `Unknown`; their own mandatory-field validation lives in
        // `normalize::TranscriptReducer`, which is fed the same raw line.
        "message_start" => Ok(PiEvent::Recognized("message_start")),
        "content_delta" => Ok(PiEvent::Recognized("content_delta")),
        "text_end" => Ok(PiEvent::Recognized("text_end")),
        "message_end" => Ok(PiEvent::Recognized("message_end")),
        "toolcall_start" => Ok(PiEvent::Recognized("toolcall_start")),
        "toolcall_delta" => Ok(PiEvent::Recognized("toolcall_delta")),
        "toolcall_end" => Ok(PiEvent::Recognized("toolcall_end")),
        "tool_execution_start" => Ok(PiEvent::Recognized("tool_execution_start")),
        "tool_execution_update" => Ok(PiEvent::Recognized("tool_execution_update")),
        "tool_execution_end" => Ok(PiEvent::Recognized("tool_execution_end")),
        "compaction_start" => Ok(PiEvent::Recognized("compaction_start")),
        "compaction_end" => Ok(PiEvent::Recognized("compaction_end")),
        "retry" => Ok(PiEvent::Recognized("retry")),
        "queue_update" => Ok(PiEvent::Recognized("queue_update")),
        other => Ok(PiEvent::Unknown(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------- framing

    #[test]
    fn feeds_one_line_at_a_time_and_tolerates_crlf() {
        let mut r = FrameReader::new();
        assert_eq!(
            r.feed(b"{\"a\":1}\n{\"b\":2}\r\n").unwrap(),
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string(),]
        );
    }

    #[test]
    fn buffers_a_line_split_across_two_feeds() {
        let mut r = FrameReader::new();
        assert!(r.feed(b"{\"a\":").unwrap().is_empty());
        assert_eq!(r.feed(b"1}\n").unwrap(), vec!["{\"a\":1}".to_string()]);
    }

    /// FR-2: a multi-byte UTF-8 character split across two `read()` chunks —
    /// the exact fragmentation class the spec names — must still decode
    /// correctly once its line completes.
    #[test]
    fn a_multi_byte_utf8_character_split_across_two_feeds_decodes_correctly() {
        let line = "{\"text\":\"caf\u{e9}\"}\n"; // é is 2 bytes (0xC3 0xA9)
        let bytes = line.as_bytes();
        let split_inside_char = bytes.iter().position(|&b| b == 0xC3).unwrap() + 1;
        let mut r = FrameReader::new();
        assert!(r.feed(&bytes[..split_inside_char]).unwrap().is_empty());
        let lines = r.feed(&bytes[split_inside_char..]).unwrap();
        assert_eq!(lines, vec!["{\"text\":\"caf\u{e9}\"}".to_string()]);
    }

    /// FR-2: U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR) are 3-byte UTF-8
    /// sequences with no ASCII CR/LF byte inside them — a byte-level LF split
    /// must never fragment them.
    #[test]
    fn preserves_u2028_and_u2029_within_a_line() {
        let mut r = FrameReader::new();
        let text = "line one\u{2028}line two\u{2029}line three";
        let payload = serde_json::json!({ "text": text }).to_string();
        let lines = r.feed(format!("{payload}\n").as_bytes()).unwrap();
        let decoded: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(decoded["text"], text);
    }

    #[test]
    fn an_unterminated_record_past_the_cap_fails_explicitly() {
        let mut r = FrameReader::new();
        let chunk = vec![b'a'; MAX_RECORD_BYTES + 1];
        assert_eq!(r.feed(&chunk), Err(FrameError::OversizeRecord));
    }

    #[test]
    fn a_terminated_record_exactly_at_the_cap_is_accepted() {
        let mut r = FrameReader::new();
        let mut chunk = vec![b'a'; MAX_RECORD_BYTES];
        chunk.push(b'\n');
        assert_eq!(r.feed(&chunk).unwrap().len(), 1);
    }

    #[test]
    fn invalid_utf8_bytes_fail_explicitly_rather_than_lossy_decoding() {
        let mut r = FrameReader::new();
        let mut chunk = vec![0xFFu8, 0xFE];
        chunk.push(b'\n');
        assert_eq!(r.feed(&chunk), Err(FrameError::InvalidUtf8));
    }

    // ---------------------------------------------------------------- commands

    #[test]
    fn a_prompt_command_serializes_id_type_and_text() {
        let cmd = PiCommand {
            id: "abc".into(),
            body: PiCommandBody::Prompt {
                text: "fix the bug".into(),
                images: Vec::new(),
            },
        };
        let line = cmd.to_line();
        assert!(line.ends_with('\n'));
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "id": "abc", "type": "prompt", "text": "fix the bug" })
        );
        assert_eq!(cmd.kind(), PiCommandKind::Prompt);
        assert_eq!(cmd.kind().wire_name(), "prompt");
    }

    #[test]
    fn get_state_and_interrupt_carry_no_extra_fields() {
        let get_state = PiCommand {
            id: "1".into(),
            body: PiCommandBody::GetState,
        };
        let v: Value = serde_json::from_str(get_state.to_line().trim_end()).unwrap();
        assert_eq!(v, serde_json::json!({ "id": "1", "type": "get_state" }));

        let interrupt = PiCommand {
            id: "2".into(),
            body: PiCommandBody::Interrupt,
        };
        let v: Value = serde_json::from_str(interrupt.to_line().trim_end()).unwrap();
        assert_eq!(v, serde_json::json!({ "id": "2", "type": "interrupt" }));
    }

    // ------------------------------------------------------- FR-7: build_prompt_body

    fn attachment(
        id: &str,
        kind: &str,
        ref_path: &str,
        stored_path: &str,
        name: &str,
    ) -> Attachment {
        Attachment {
            id: id.into(),
            session_id: "s1".into(),
            kind: kind.into(),
            origin_path: None,
            stored_path: stored_path.into(),
            ref_path: ref_path.into(),
            name: name.into(),
            bytes: 1,
            copied: true,
            state: "sent".into(),
            created_at: 0,
        }
    }

    #[test]
    fn a_text_only_prompt_carries_no_images() {
        let body = build_prompt_body("just text, no refs".into(), &[], true).unwrap();
        match body {
            PiCommandBody::Prompt { text, images } => {
                assert_eq!(text, "just text, no refs");
                assert!(images.is_empty());
            }
            _ => panic!("expected a prompt body"),
        }
    }

    #[test]
    fn a_referenced_image_is_resolved_and_base64_encoded_never_left_as_a_path() {
        let dir = std::env::temp_dir().join(format!(
            "francois-pi-wire-{}-{}",
            std::process::id(),
            crate::ids::uuid()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shot.png");
        std::fs::write(&path, b"hello").unwrap();
        let a = attachment(
            "a1",
            "image",
            ".francois/attachments/a3f9c1e2/shot.png",
            &path.to_string_lossy(),
            "shot.png",
        );

        let body = build_prompt_body(
            "look at @.francois/attachments/a3f9c1e2/shot.png".into(),
            &[a],
            true,
        )
        .unwrap();

        match body {
            PiCommandBody::Prompt { images, .. } => {
                assert_eq!(images.len(), 1);
                assert_eq!(images[0].mime_type, "image/png");
                use base64::Engine as _;
                assert_eq!(
                    base64::engine::general_purpose::STANDARD
                        .decode(&images[0].data)
                        .unwrap(),
                    b"hello"
                );
            }
            _ => panic!("expected a prompt body"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreferenced_attachment_is_never_resolved() {
        let a = attachment(
            "a1",
            "image",
            ".francois/attachments/a3f9c1e2/shot.png",
            "/does/not/exist.png",
            "shot.png",
        );
        let body = build_prompt_body("nothing attached here".into(), &[a], true).unwrap();
        match body {
            PiCommandBody::Prompt { images, .. } => assert!(images.is_empty()),
            _ => panic!("expected a prompt body"),
        }
    }

    #[test]
    fn a_referenced_image_is_rejected_before_submission_when_images_are_unsupported() {
        let a = attachment(
            "a1",
            "image",
            ".francois/attachments/a3f9c1e2/shot.png",
            "/does/not/exist.png",
            "shot.png",
        );
        let err = build_prompt_body(
            "look at @.francois/attachments/a3f9c1e2/shot.png".into(),
            &[a],
            false,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::RuntimeUnsupported);
    }

    #[test]
    fn a_referenced_file_attachment_is_never_resolved_as_an_image() {
        // FR-7: "File paths remain explicit user attachments, not guessed
        // URLs" — a non-image kind never becomes image content, whatever the
        // capability snapshot says, and never touches the filesystem for it.
        let a = attachment(
            "a1",
            "file",
            ".francois/attachments/a3f9c1e2/report.pdf",
            "/does/not/exist.pdf",
            "report.pdf",
        );
        let body = build_prompt_body(
            "see @.francois/attachments/a3f9c1e2/report.pdf".into(),
            &[a],
            false,
        )
        .unwrap();
        match body {
            PiCommandBody::Prompt { images, .. } => assert!(images.is_empty()),
            _ => panic!("expected a prompt body"),
        }
    }

    #[test]
    fn a_missing_referenced_image_file_fails_explicitly_rather_than_silently_dropping() {
        let a = attachment(
            "a1",
            "image",
            ".francois/attachments/a3f9c1e2/shot.png",
            "/definitely/does/not/exist-francois-test.png",
            "shot.png",
        );
        let err = build_prompt_body(
            "look at @.francois/attachments/a3f9c1e2/shot.png".into(),
            &[a],
            true,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::RuntimeUnavailable);
    }

    // ---------------------------------------------------------------- parsing

    #[test]
    fn parses_a_successful_response_with_data() {
        let line = serde_json::json!({
            "id": "req-1", "command": "get_state", "success": true,
            "data": { "runtimeId": "rt-1", "sessionFile": "/tmp/x.jsonl" }
        })
        .to_string();
        match parse_line(&line).unwrap() {
            Frame::Response(resp) => {
                assert_eq!(resp.id, "req-1");
                assert_eq!(resp.command, "get_state");
                assert!(resp.success);
                assert_eq!(resp.data.unwrap()["runtimeId"], "rt-1");
            }
            _ => panic!("expected a response frame"),
        }
    }

    #[test]
    fn parses_a_failed_response_with_an_error_string() {
        let line = serde_json::json!({
            "id": "req-2", "command": "prompt", "success": false, "error": "queue full"
        })
        .to_string();
        match parse_line(&line).unwrap() {
            Frame::Response(resp) => {
                assert!(!resp.success);
                assert_eq!(resp.error.as_deref(), Some("queue full"));
            }
            _ => panic!("expected a response frame"),
        }
    }

    #[test]
    fn known_events_parse_without_needing_a_command_id() {
        assert_eq!(
            parse_line(r#"{"type":"agent_settled"}"#)
                .ok()
                .map(|f| match f {
                    Frame::Event(e) => e,
                    _ => panic!(),
                }),
            Some(PiEvent::AgentSettled)
        );
        assert!(matches!(
            parse_line(r#"{"type":"agent_end"}"#),
            Ok(Frame::Event(PiEvent::AgentEnd))
        ));
        assert!(matches!(
            parse_line(r#"{"type":"turn_end","reason":"done"}"#),
            Ok(Frame::Event(PiEvent::TurnEnd))
        ));
    }

    /// FR-3: missing fields in KNOWN events are protocol failures.
    #[test]
    fn a_known_event_missing_a_mandatory_field_is_a_protocol_failure() {
        assert_eq!(
            parse_line(r#"{"type":"turn_end"}"#),
            Err(ParseError::MissingField {
                kind: "turn_end",
                field: "reason"
            })
        );
    }

    /// FR-3: a VALID but unrecognized event kind is not a failure — it is
    /// counted and ignored (the dispatcher owns the per-kind/per-generation
    /// notice; this layer only classifies it as `Unknown`).
    #[test]
    fn a_valid_unknown_event_kind_parses_as_unknown_not_an_error() {
        match parse_line(r#"{"type":"some_future_event","extra":true}"#).unwrap() {
            Frame::Event(PiEvent::Unknown(kind)) => assert_eq!(kind, "some_future_event"),
            _ => panic!("expected an unknown event"),
        }
    }

    /// pi-transcript-events FR-1 (review round 3): every FR-1 transcript
    /// event kind parses as `Recognized`, never `Unknown` — this is what
    /// keeps `ProtocolEngine::on_event` from misclassifying normal transcript
    /// traffic as an error.
    #[test]
    fn fr1_transcript_event_kinds_parse_as_recognized_not_unknown() {
        for kind in [
            "message_start",
            "content_delta",
            "text_end",
            "message_end",
            "toolcall_start",
            "toolcall_delta",
            "toolcall_end",
            "tool_execution_start",
            "tool_execution_update",
            "tool_execution_end",
            "compaction_start",
            "compaction_end",
            "retry",
            "queue_update",
        ] {
            let line = serde_json::json!({ "type": kind }).to_string();
            match parse_line(&line).unwrap() {
                Frame::Event(PiEvent::Recognized(k)) => assert_eq!(k, kind),
                other => panic!("expected {kind} to parse as Recognized, got {other:?}"),
            }
        }
    }

    #[test]
    fn an_empty_event_type_is_rejected() {
        assert_eq!(
            parse_line(r#"{"type":""}"#),
            Err(ParseError::EmptyEventType)
        );
    }

    #[test]
    fn neither_a_response_nor_an_event_is_not_a_frame() {
        assert_eq!(parse_line(r#"{"foo":"bar"}"#), Err(ParseError::NotAFrame));
    }

    #[test]
    fn invalid_json_is_rejected() {
        assert_eq!(parse_line("not json"), Err(ParseError::InvalidJson));
    }
}
