//! FR-28 / FR-22 — one raw Cohorte envelope → exactly one `CohorteEvent` wire
//! member. The payload is rewritten into the contract's normalised shape
//! (ISO → ms, sealed/large blobs dropped, renamed fields), sanitised key by
//! key, then parsed into its typed member. A type outside the catalogue, a
//! known type whose required fields do not parse, or a protocol major ≠ 1
//! becomes `unknown` — never an error, never dropped.

use super::catalogue::{EventHeader, UnknownEvent};
use super::documents::{snapshot_run, StatusRun};
use super::gate::label_for;
use super::sanitize::{self, iso_ms, iso_ms_value, sanitize_value};
use super::CohorteEvent;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// The tool.completed / message.completed preview cap (catalogue: 512).
const SHORT_PREVIEW_BYTES: usize = 512;

pub(crate) struct Normalised {
    pub(crate) event: CohorteEvent,
    /// The RunSnapshotDocument a `snapshot` line embeds (folded, never forwarded).
    pub(crate) snapshot: Option<StatusRun>,
}

fn header_of(project_root: &str, line: &Value, fallback_at: u64) -> Option<EventHeader> {
    let run_id = line["runId"].as_str()?;
    let sequence = line["sequence"].as_u64()?;
    let sub = line["sub"].as_u64().unwrap_or(0);
    let mut phase = line.get("phase").cloned().unwrap_or(Value::Null);
    let mut agent = line.get("agent").cloned().unwrap_or(Value::Null);
    sanitize_value(&mut phase, None);
    sanitize_value(&mut agent, None);
    let word = |k: &str, default: &str| {
        line[k]
            .as_str()
            .map(|s| sanitize::line(s, 64))
            .unwrap_or_else(|| default.to_string())
    };
    Some(EventHeader {
        project_root: project_root.to_string(),
        run_id: sanitize::line(run_id, 256),
        event_id: word("eventId", ""),
        sequence,
        sub,
        durability: word("durability", if sub == 0 { "durable" } else { "ephemeral" }),
        at: line["timestamp"]
            .as_str()
            .and_then(iso_ms)
            .unwrap_or(fallback_at),
        source: word("source", "cohorte"),
        severity: word("severity", "info"),
        summary: sanitize::summary(line["summary"].as_str().unwrap_or("")),
        phase: serde_json::from_value(phase).ok(),
        agent: serde_json::from_value(agent).ok(),
        causation_id: line["causationId"].as_str().map(|s| sanitize::line(s, 256)),
    })
}

fn cost(v: &Value) -> Value {
    if v.is_object() {
        json!({ "currency": v["currency"], "amount": v["amount"], "basis": v["basis"] })
    } else {
        Value::Null
    }
}

fn fix_quota(q: &mut Value) {
    if let Some(o) = q.as_object_mut() {
        match o.get("observedAt").and_then(Value::as_str).and_then(iso_ms) {
            Some(ms) => o.insert("observedAt".into(), json!(ms)),
            None => o.remove("observedAt"),
        };
        if let Some(ws) = o.get_mut("windows").and_then(Value::as_array_mut) {
            for w in ws {
                if let Some(w) = w.as_object_mut() {
                    match w.get("resetsAt").and_then(Value::as_str).and_then(iso_ms) {
                        Some(ms) => w.insert("resetsAt".into(), json!(ms)),
                        None => w.remove("resetsAt"),
                    };
                }
            }
        }
    }
}

fn rename(p: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(v) = p.remove(from) {
        p.insert(to.into(), v);
    }
}

/// agent-output Finding + review.finding's envelope → contract `CohorteFinding`
/// (severity-fallback label; the projection relabels on review.completed).
fn finding(p: &Value, event_id: &str) -> Value {
    let f = &p["finding"];
    let loc = &f["location"];
    let severity = f["severity"].as_str().unwrap_or("info");
    let actual = f["actual"].as_str().unwrap_or("");
    let rule = f["rule"].as_str().unwrap_or("");
    let title = if actual.trim().is_empty() {
        sanitize::title(rule)
    } else {
        sanitize::title(actual)
    };
    let blocking = matches!(severity, "critical" | "major");
    let mut out = json!({
        "id": f["id"].as_str().map(str::to_string).unwrap_or_else(|| format!("evt:{event_id}")),
        "severity": f["severity"],
        "kind": f["kind"],
        "rule": f["rule"],
        "title": title,
        "expected": f["expected"],
        "actual": f["actual"],
        "confidence": f["confidence"],
        "scope": f["scope"],
        "disposition": p["disposition"],
        "blocking": blocking,
        "label": label_for(blocking, severity),
    });
    let o = out.as_object_mut().unwrap();
    for (k, v) in [
        ("file", &loc["file"]),
        ("line", &loc["line"]),
        ("endLine", &loc["endLine"]),
        ("symbol", &loc["symbol"]),
        ("suggestedFix", &f["suggestedFix"]),
        ("reviewerAgentId", &p["reviewer"]["agentId"]),
    ] {
        if !v.is_null() {
            o.insert(k.into(), v.clone());
        }
    }
    out
}

/// Rewrite a raw payload into the contract's shape for `ty` (in place).
fn prepare(ty: &str, payload: &mut Value, event_id: &str) {
    if ty == "review.finding" {
        let f = finding(payload, event_id);
        payload["finding"] = f;
        return;
    }
    let Some(p) = payload.as_object_mut() else {
        return;
    };
    match ty {
        "pipeline.started" => {
            let u = p
                .get("plan")
                .and_then(|pl| pl["unattended"].as_bool())
                .unwrap_or(false);
            p.insert("unattended".into(), json!(u));
            p.remove("plan");
        }
        "pipeline.completed" => {
            if let Some(t) = p.get_mut("totals").and_then(Value::as_object_mut) {
                let c = cost(t.get("monetaryCost").unwrap_or(&Value::Null));
                t.insert("cost".into(), c);
            }
        }
        "model.responded" => {
            let c = cost(p.get("monetaryCost").unwrap_or(&Value::Null));
            p.insert("cost".into(), c);
            if let Some(q) = p.get_mut("quota") {
                fix_quota(q);
            }
        }
        "quota.updated" => {
            if let Some(q) = p.get_mut("quota") {
                fix_quota(q);
            }
        }
        "run.resumed" => {
            let t = p
                .get("report")
                .and_then(|r| r["takeover"].as_bool())
                .unwrap_or(false);
            p.insert("takeover".into(), json!(t));
            p.remove("report");
        }
        "agent.spawned" => rename(p, "isolation", "sandbox"),
        "agent.message.delta" => {
            p.insert("coalesced".into(), json!(1));
        }
        "context.built" => {
            for k in ["entries", "exclusions"] {
                let n = p.get(k).and_then(Value::as_array).map(Vec::len);
                if let Some(n) = n {
                    p.insert(k.into(), json!(n));
                }
            }
        }
        "tool.completed" => {
            let preview = p
                .get("output")
                .and_then(|o| o["preview"].as_str())
                .map(|s| sanitize::cap_bytes(sanitize::strip(s, true), SHORT_PREVIEW_BYTES).0);
            if let Some(pr) = preview {
                p.insert("preview".into(), json!(pr));
            }
            p.remove("output");
        }
        "agent.message.completed" => {
            if let Some(pr) = p.get("preview").and_then(Value::as_str) {
                let pr = sanitize::cap_bytes(sanitize::strip(pr, true), SHORT_PREVIEW_BYTES).0;
                p.insert("preview".into(), json!(pr));
            }
        }
        "approval.requested" => {
            p.remove("args");
            if let Some(pv) = p.get_mut("preview").and_then(Value::as_object_mut) {
                let raw = pv.get("text").and_then(Value::as_str).unwrap_or("");
                let (text, cut) =
                    sanitize::cap_bytes(sanitize::strip(raw, true), sanitize::PREVIEW_BYTES);
                pv.insert("text".into(), json!(text));
                pv.insert("truncated".into(), json!(cut));
            }
            match iso_ms_value(p.get("expiresAt")) {
                Some(ms) => p.insert("expiresAt".into(), json!(ms)),
                None => p.remove("expiresAt"),
            };
        }
        "command.accepted" | "command.completed" | "command.rejected" => {
            rename(p, "type", "commandType");
            p.remove("result");
        }
        _ => {}
    }
}

/// FR-28. `None` only for a line that cannot be ordered (not an object, no
/// `runId`/`sequence`/`type`) — FR-20 skips those.
pub(crate) fn normalise(project_root: &str, line: &Value, fallback_at: u64) -> Option<Normalised> {
    let ty_raw = line["type"].as_str()?;
    let header = header_of(project_root, line, fallback_at)?;
    let unknown = |header: EventHeader, malformed: bool| Normalised {
        event: CohorteEvent::Unknown(UnknownEvent {
            header,
            cohorte_type: sanitize::line(ty_raw, 128),
            malformed,
        }),
        snapshot: None,
    };
    if let Some(pv) = line["protocolVersion"].as_str() {
        if pv.split('.').next() != Some("1") {
            return Some(unknown(header, false));
        }
    }
    let mut payload = line.get("payload").cloned().unwrap_or(Value::Null);
    let snapshot = if ty_raw == "snapshot" {
        let s = snapshot_run(&payload["document"]);
        if let Some(o) = payload.as_object_mut() {
            o.remove("document");
        }
        s
    } else {
        None
    };
    prepare(ty_raw, &mut payload, &header.event_id);
    sanitize_value(&mut payload, None);
    match CohorteEvent::from_parts(ty_raw, header.clone(), payload) {
        None => Some(unknown(header, false)),
        Some(Err(_)) => Some(unknown(header, true)),
        Some(Ok(event)) => Some(Normalised { event, snapshot }),
    }
}

/// FR-22 — within one dump: `agent.message.delta` merged per
/// (runId, messageId, channel) (delta concatenated, tail kept at 8 KiB,
/// `coalesced` = merged count); `tool.progress` → the last per toolCallId.
pub(crate) fn coalesce(events: Vec<Normalised>) -> Vec<Normalised> {
    let mut last_progress: HashMap<(String, String), usize> = HashMap::new();
    for (i, n) in events.iter().enumerate() {
        if let CohorteEvent::ToolProgress(w) = &n.event {
            last_progress.insert((w.header.run_id.clone(), w.payload.tool_call_id.clone()), i);
        }
    }
    let mut out: Vec<Normalised> = Vec::with_capacity(events.len());
    let mut delta_at: HashMap<(String, String, String), usize> = HashMap::new();
    for (i, n) in events.into_iter().enumerate() {
        match &n.event {
            CohorteEvent::ToolProgress(w) => {
                let key = (w.header.run_id.clone(), w.payload.tool_call_id.clone());
                if last_progress.get(&key) == Some(&i) {
                    out.push(n);
                }
            }
            CohorteEvent::AgentMessageDelta(w) => {
                let key = (
                    w.header.run_id.clone(),
                    w.payload.message_id.clone(),
                    w.payload.channel.clone(),
                );
                if let Some(&at) = delta_at.get(&key) {
                    if let CohorteEvent::AgentMessageDelta(first) = &mut out[at].event {
                        let joined = format!("{}{}", first.payload.delta, w.payload.delta);
                        first.payload.delta =
                            sanitize::cap_bytes_tail(joined, sanitize::DELTA_BYTES);
                        first.payload.coalesced += 1;
                    }
                } else {
                    delta_at.insert(key, out.len());
                    out.push(n);
                }
            }
            _ => out.push(n),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::catalogue::WIRE_EVENT_TYPES;
    use crate::cohorte::testutil::{all_envelopes, envelope};

    /// AC-1: one envelope per catalogue type → the member of that type, none unknown.
    #[test]
    fn every_catalogue_type_normalises_to_its_own_member() {
        let lines = all_envelopes();
        assert_eq!(lines.len(), 68);
        for (line, ty) in lines.iter().zip(WIRE_EVENT_TYPES) {
            let n = normalise("/r", line, 0).unwrap();
            let json = serde_json::to_value(&n.event).unwrap();
            assert_eq!(json["type"], *ty, "{ty} became {json}");
            assert_eq!(n.event.log_type(), Some(*ty));
        }
    }

    /// AC-2.
    #[test]
    fn foreign_malformed_and_future_major_envelopes_become_unknown() {
        let foreign = envelope(1, 0, "foo.bar", json!({}));
        let mut missing = envelope(2, 0, "run.paused", json!({}));
        missing["payload"] = json!({ "inFlightEffects": [] });
        let mut v2 = envelope(3, 0, "run.paused", json!({ "parkedAgents": [] }));
        v2["protocolVersion"] = json!("2.0");
        let expect = [
            (&foreign, "foo.bar", false),
            (&missing, "run.paused", true),
            (&v2, "run.paused", false),
        ];
        for (line, ty, malformed) in expect {
            let n = normalise("/r", line, 0).unwrap();
            let CohorteEvent::Unknown(u) = n.event else {
                panic!("{ty} was not unknown")
            };
            assert_eq!((u.cohorte_type.as_str(), u.malformed), (ty, malformed));
        }
        assert!(normalise("/r", &json!("a string"), 0).is_none());
        assert!(normalise("/r", &json!({ "type": "x" }), 0).is_none());
    }

    #[test]
    fn the_header_is_normalised() {
        let mut line = envelope(7, 0, "run.paused", json!({ "parkedAgents": [] }));
        line["summary"] = json!("paused\u{1b}[1m\nnow");
        let n = normalise("/root", &line, 0).unwrap();
        let h = n.event.header().unwrap();
        assert_eq!(h.project_root, "/root");
        assert_eq!(h.sequence, 7);
        assert_eq!(h.at, 1_767_225_607_000);
        assert_eq!(h.summary, "pausednow");
        assert_eq!(h.durability, "durable");
    }

    #[test]
    fn approval_preview_is_capped_and_flags_truncation() {
        let mut line = crate::cohorte::testutil::approval_envelope(5, "apr_1", "ship", &[]);
        line["payload"]["preview"]["text"] = json!("x\n".repeat(4000));
        line["payload"]["expiresAt"] = json!("2026-01-01T00:10:00.000Z");
        let n = normalise("/r", &line, 0).unwrap();
        let CohorteEvent::ApprovalRequested(w) = n.event else {
            panic!()
        };
        assert!(w.payload.preview.truncated);
        assert!(w.payload.preview.text.len() <= sanitize::PREVIEW_BYTES);
        assert!(w.payload.preview.text.contains('\n'));
        assert_eq!(w.payload.expires_at, Some(1_767_226_200_000));
    }

    #[test]
    fn a_finding_with_an_ansi_escape_renders_without_it() {
        let line = crate::cohorte::testutil::finding_envelope(
            4,
            Some("fnd_1"),
            "major",
            "\u{1b}[31mRetries are unbounded\u{1b}[0m",
        );
        let n = normalise("/r", &line, 0).unwrap();
        let CohorteEvent::ReviewFinding(w) = n.event else {
            panic!()
        };
        assert_eq!(w.payload.finding.title, "Retries are unbounded");
        assert_eq!(w.payload.finding.file.as_deref(), Some("src/retry.ts"));
        assert_eq!(w.payload.finding.line, Some(12));
        assert!(w.payload.finding.blocking);
        assert_eq!(w.payload.finding.label, "blocking");
    }

    /// AC-4.
    #[test]
    fn deltas_coalesce_and_progress_keeps_the_last() {
        let mut lines = Vec::new();
        for i in 0..50u64 {
            lines.push(envelope(
                3,
                i + 1,
                "agent.message.delta",
                json!({ "messageId": "m1", "channel": "text", "contentIndex": 0, "delta": "ab" }),
            ));
        }
        for i in 0..10u64 {
            lines.push(envelope(
                3,
                51 + i,
                "tool.progress",
                json!({ "toolCallId": "tc_1_1", "text": format!("step {i}") }),
            ));
        }
        let norm: Vec<Normalised> = lines
            .iter()
            .map(|l| normalise("/r", l, 0).unwrap())
            .collect();
        let out = coalesce(norm);
        assert_eq!(out.len(), 2);
        let CohorteEvent::AgentMessageDelta(d) = &out[0].event else {
            panic!()
        };
        assert_eq!(d.payload.coalesced, 50);
        assert_eq!(d.payload.delta.len(), 100);
        let CohorteEvent::ToolProgress(p) = &out[1].event else {
            panic!()
        };
        assert_eq!(p.payload.text.as_deref(), Some("step 9"));
    }

    #[test]
    fn a_snapshot_line_folds_its_document_and_forwards_last_sequence() {
        let line = envelope(
            9,
            1,
            "snapshot",
            json!({ "document": crate::cohorte::testutil::fixture_snapshot_doc("run_a"), "lastSequence": 9 }),
        );
        let n = normalise("/r", &line, 0).unwrap();
        assert!(n.snapshot.is_some());
        let json = serde_json::to_value(&n.event).unwrap();
        assert_eq!(json["payload"], json!({ "lastSequence": 9 }));
    }
}
