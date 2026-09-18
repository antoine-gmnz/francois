//! workflow-details: the run directory a `Workflow` dispatch names in its ack,
//! read back as a live model of the run (specs/workflow-details.md §4).
//!
//! A workflow's own agents never surface in the parent session's NDJSON stream —
//! they only exist ON DISK, under the `Transcript dir:` the dispatch ack names:
//!
//!   journal.jsonl          → one `started` / `result` line per agent
//!   agent-<id>.jsonl       → that agent's full transcript, timestamped, with
//!                            per-message token usage
//!   agent-<id>.meta.json   → its `agentType` / `model`
//!
//! This file owns the DATA MODEL the whole domain touches — the contract types
//! and the incremental scan state — plus the handful of readers every child
//! needs; each child owns one concern and its own tests:
//!
//!   scan.rs        FR-3/FR-5  fold the run directory into `ScanState`
//!   detail.rs      FR-3/FR-4  project that state onto a `WorkflowDetail`
//!   transcript.rs  FR-8       one agent's conversation as `AgentBlock`s
//!   ack.rs         FR-1/FR-2  the two paths the dispatch ack names
//!   asks.rs        FR-20..24  which run a parked ask belongs to
//!   commands.rs    §5         the three `francois:workflows:*` channels
//!
//! Everything here is PURE over `(&Path, &mut ScanState)` / `(&Session, &Value)`,
//! which is what makes it unit-testable against a throwaway directory. The
//! AppHandle side (the watcher, the emissions) lives in `workflow_watch.rs`.
//!
//! FR-10 is the domain-wide rule: every read is fallible and fails SOFT. An
//! unreadable or unexpectedly-shaped file yields fewer agents or thinner
//! records — never an error response, never a panic.

use super::*;

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

mod ack;
mod asks;
mod commands;
mod detail;
mod scan;
mod transcript;

pub use ack::*;
pub use asks::*;
pub use commands::*;
pub use detail::*;
pub(crate) use scan::*;
pub(crate) use transcript::*;

#[cfg(test)]
pub mod testutil;

/// FR-8: the transcript window, mirroring agent-tab's own cap.
const AGENT_BLOCK_CAP: usize = 400;
/// FR-8: per-block ceiling on assistant text, mirroring agent-tab's.
const AGENT_BLOCK_TEXT_CAP: usize = 8_000;
/// FR-3 / §7: a stringified return value is capped for BOTH the row and the view.
const RESULT_CAP: usize = 2_000;
/// FR-3: the prompt line.
const PROMPT_CAP: usize = 200;
/// FR-9: the script source cap.
const SCRIPT_CAP: usize = 200 * 1024;

// ---------- contract types (contract/workflow-details.ts) ----------

#[derive(Serialize, Clone, Copy, Default, PartialEq, Debug)]
pub struct WorkflowTokens {
    input: u64,
    output: u64,
    #[serde(rename = "cacheRead")]
    cache_read: u64,
    #[serde(rename = "cacheCreation")]
    cache_creation: u64,
}

impl WorkflowTokens {
    fn add(&mut self, other: &WorkflowTokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_creation += other.cache_creation;
    }
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct WorkflowAgentInfo {
    #[serde(rename = "agentId")]
    agent_id: String,
    #[serde(rename = "agentType")]
    agent_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    status: String, // running | done | stopped | waiting
    #[serde(rename = "startedAt")]
    started_at: u64,
    #[serde(rename = "lastAt", skip_serializing_if = "Option::is_none")]
    last_at: Option<u64>,
    prompt: String,
    tokens: WorkflowTokens,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
}

/// FR-20..FR-25. Correlation ONLY — the card's payload stays where it already
/// lives (the turn's pending maps + the session transcript block).
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct WorkflowPendingAsk {
    #[serde(rename = "blockId")]
    pub(crate) block_id: String,
    pub(crate) kind: String, // permission | question
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    pub(crate) agent_id: Option<String>,
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub(crate) tool_name: Option<String>,
    pub(crate) confidence: String, // exact | inferred
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct WorkflowDetail {
    id: String,
    /// `pub(crate)` for `workflow_watch.rs`: the event envelope carries the
    /// session id alongside the detail (§5), and the watcher is a sibling module.
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    #[serde(rename = "transcriptDir")]
    pub(crate) transcript_dir: String,
    #[serde(rename = "hasScript")]
    has_script: bool,
    agents: Vec<WorkflowAgentInfo>,
    tokens: WorkflowTokens,
    #[serde(rename = "pendingAsks")]
    pending_asks: Vec<WorkflowPendingAsk>,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct WorkflowAgentTranscript {
    blocks: Vec<Value>,
    dropped: u32,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct WorkflowScript {
    path: String,
    source: String,
    truncated: bool,
}

// ---------- FR-5: the incremental scan state ----------

/// What one `agent-<id>.jsonl` has told us so far. Kept as a RUNNING aggregate
/// (never a copy of the file) so a rescan only has to fold the appended tail in.
#[derive(Default, Clone, PartialEq, Debug)]
struct AgentAgg {
    started_at: Option<u64>,
    last_at: Option<u64>,
    prompt: Option<String>,
    tokens: WorkflowTokens,
}

/// `agent-<id>.meta.json`, read once (it is rewritten wholesale, never appended).
#[derive(Default, Clone, PartialEq, Debug)]
struct AgentMeta {
    agent_type: Option<String>,
    model: Option<String>,
}

/// FR-5: per-file byte offsets + the running aggregates they produced. A scan
/// never re-reads a file's consumed prefix.
#[derive(Default)]
pub(crate) struct ScanState {
    /// file name → bytes consumed so far (complete lines only).
    cursors: HashMap<String, u64>,
    /// agentIds in first-appearance order in `journal.jsonl` (FR-3 tie-break).
    journal_order: Vec<String>,
    /// agentId → stringified `result` value (⇒ `done`, FR-4).
    results: HashMap<String, String>,
    /// agentId → what its transcript file has said so far.
    aggs: HashMap<String, AgentAgg>,
    /// agentId → its meta.json.
    metas: HashMap<String, AgentMeta>,
}

impl ScanState {
    /// FR-8: is this an agent the scan has seen? (Anything short of this is
    /// `WORKFLOW_AGENT_NOT_FOUND`.)
    pub fn knows_agent(&self, agent_id: &str) -> bool {
        self.aggs.contains_key(agent_id)
            || self.metas.contains_key(agent_id)
            || self.results.contains_key(agent_id)
            || self.journal_order.iter().any(|a| a == agent_id)
    }

    /// FR-3: every agent this run has, in the FR-3 order (start, then journal
    /// appearance). Agents with no transcript file yet sort last.
    fn agent_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.journal_order.clone();
        let mut extra: Vec<String> = self
            .aggs
            .keys()
            .chain(self.metas.keys())
            .chain(self.results.keys())
            .filter(|id| !ids.contains(id))
            .cloned()
            .collect();
        extra.sort();
        extra.dedup();
        ids.extend(extra);
        ids.sort_by_key(|id| {
            self.aggs
                .get(id)
                .and_then(|a| a.started_at)
                .unwrap_or(u64::MAX)
        });
        ids
    }

    #[cfg(test)]
    fn consumed(&self, name: &str) -> u64 {
        self.cursors.get(name).copied().unwrap_or(0)
    }
}

/// FR-6: one run's scan state plus the `notify` watcher keeping it live. Held in
/// `Engine.workflow_scans`; dropping the entry stops the watch.
#[derive(Default)]
pub struct ScanEntry {
    pub(crate) state: ScanState,
    /// `Some` ⇔ a watch is running for this run (at most one, FR-6).
    pub(crate) watcher: Option<notify::RecommendedWatcher>,
}

// ---------- shared readers (used by more than one child) ----------

/// The complete lines appended since `cursor`, advancing it past exactly what
/// was consumed. A trailing PARTIAL line (a file mid-write) is left unconsumed
/// so the next flush picks it up whole. The bool is FR-5's shrink signal: the
/// file got shorter, so its aggregate must be rebuilt from zero.
fn read_new_lines(path: &Path, cursor: &mut u64) -> (Vec<String>, bool) {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return (Vec::new(), false);
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reset = false;
    if len < *cursor {
        *cursor = 0;
        reset = true;
    }
    if f.seek(SeekFrom::Start(*cursor)).is_err() {
        return (Vec::new(), reset);
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return (Vec::new(), reset);
    }
    let Some(nl) = buf.iter().rposition(|b| *b == b'\n') else {
        return (Vec::new(), reset);
    };
    let consumed = &buf[..=nl];
    *cursor += consumed.len() as u64;
    let text = String::from_utf8_lossy(consumed);
    (
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect(),
        reset,
    )
}
/// The first of `keys` present on `v` as a non-empty string.
fn json_str(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|k| v.get(*k))
        .filter_map(|x| x.as_str())
        .find(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// A line's epoch-ms stamp. Accepts both spellings the harnesses use: a number
/// (already epoch ms) and an RFC-3339 string.
fn line_timestamp(v: &Value) -> Option<u64> {
    for key in ["timestamp", "at", "time"] {
        let Some(x) = v.get(key) else { continue };
        if let Some(n) = x.as_u64() {
            return Some(n);
        }
        if let Some(s) = x.as_str() {
            if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
                return Some(t.timestamp_millis().max(0) as u64);
            }
        }
    }
    None
}

fn cap_chars(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        s.chars().take(n).collect()
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---------- §5: the wire shapes ----------

    #[test]
    fn detail_serializes_the_contract_shape() {
        let detail = WorkflowDetail {
            id: "run-1".into(),
            session_id: "s1".into(),
            transcript_dir: "/tmp/run-1".into(),
            has_script: true,
            agents: vec![WorkflowAgentInfo {
                agent_id: "a1".into(),
                agent_type: "workflow-subagent".into(),
                model: None,
                status: "running".into(),
                started_at: 1_000,
                last_at: None,
                prompt: "do it".into(),
                tokens: WorkflowTokens::default(),
                result: None,
            }],
            tokens: WorkflowTokens {
                input: 1,
                output: 2,
                cache_read: 3,
                cache_creation: 4,
            },
            pending_asks: vec![WorkflowPendingAsk {
                block_id: "b1".into(),
                kind: "permission".into(),
                agent_id: None,
                tool_name: Some("Bash".into()),
                confidence: "inferred".into(),
            }],
        };
        let v = serde_json::to_value(&detail).unwrap();
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["transcriptDir"], "/tmp/run-1");
        assert_eq!(v["hasScript"], true);
        assert_eq!(v["tokens"]["cacheRead"], 3);
        assert_eq!(v["tokens"]["cacheCreation"], 4);
        let a = &v["agents"][0];
        assert_eq!(a["agentId"], "a1");
        assert_eq!(a["agentType"], "workflow-subagent");
        assert_eq!(a["startedAt"], 1_000);
        // absent, never null
        assert!(a.get("model").is_none());
        assert!(a.get("lastAt").is_none());
        assert!(a.get("result").is_none());
        let ask = &v["pendingAsks"][0];
        assert_eq!(ask["blockId"], "b1");
        assert_eq!(ask["kind"], "permission");
        assert_eq!(ask["toolName"], "Bash");
        assert_eq!(ask["confidence"], "inferred");
        assert!(ask.get("agentId").is_none());
    }

    #[test]
    fn script_and_transcript_serialize_the_contract_shape() {
        let v = serde_json::to_value(WorkflowScript {
            path: "/tmp/wf.js".into(),
            source: "//".into(),
            truncated: false,
        })
        .unwrap();
        assert_eq!(
            v,
            json!({ "path": "/tmp/wf.js", "source": "//", "truncated": false })
        );

        let t = serde_json::to_value(WorkflowAgentTranscript {
            blocks: vec![json!({ "kind": "assistant" })],
            dropped: 7,
        })
        .unwrap();
        assert_eq!(
            t,
            json!({ "blocks": [{ "kind": "assistant" }], "dropped": 7 })
        );
    }
}
