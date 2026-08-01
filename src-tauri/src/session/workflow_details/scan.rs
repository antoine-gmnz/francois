//! FR-3/FR-5: folding the run directory into the incremental scan state.
//!
//! Per file the core keeps the byte offset it last consumed and the running
//! aggregate that offset produced, so a rescan parses only the appended tail —
//! a scan never re-reads a file's consumed prefix. A file that shrank (rotated
//! or rewritten) cannot be tailed, so its aggregate is rebuilt from zero.

use super::*;

/// `agent-<id>.jsonl` → `<id>`.
fn transcript_agent_id(name: &str) -> Option<String> {
    let id = name.strip_prefix("agent-")?.strip_suffix(".jsonl")?;
    (!id.is_empty() && !id.contains(".meta")).then(|| id.to_string())
}

/// `agent-<id>.meta.json` → `<id>`.
fn meta_agent_id(name: &str) -> Option<String> {
    let id = name.strip_prefix("agent-")?.strip_suffix(".meta.json")?;
    (!id.is_empty()).then(|| id.to_string())
}

/// §7: a `result` value of any shape becomes a capped string — pretty-printed
/// when it is JSON, so the agent view can render exactly what the row previews.
fn stringify_result(v: Option<&Value>) -> String {
    let text = match v {
        Some(Value::String(s)) => s.clone(),
        Some(other) => serde_json::to_string_pretty(other).unwrap_or_default(),
        None => String::new(),
    };
    cap_chars(&text, RESULT_CAP)
}

/// FR-3: `journal.jsonl` — a `started` line mints the record, a `result` line
/// sets the result (⇒ `done`). Unparseable lines are skipped.
fn apply_journal_line(state: &mut ScanState, line: &str) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let Some(id) = json_str(&v, &["agentId", "agent_id", "id"]) else {
        return;
    };
    if !state.journal_order.iter().any(|a| a == &id) {
        state.journal_order.push(id.clone());
    }
    let kind = json_str(&v, &["type", "event", "kind"]).unwrap_or_default();
    if kind.contains("result") {
        let value = v
            .get("result")
            .or_else(|| v.get("value"))
            .or_else(|| v.get("output"));
        state.results.insert(id, stringify_result(value));
    }
}

/// FR-3: one `agent-<id>.jsonl` line folded into the running aggregate.
fn apply_transcript_line(agg: &mut AgentAgg, line: &str) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if let Some(ts) = line_timestamp(&v) {
        if agg.started_at.is_none() {
            agg.started_at = Some(ts);
        }
        agg.last_at = Some(ts);
    }
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if ty == "user" && agg.prompt.is_none() {
        let line = first_nonblank_line(&user_line_text(&v), PROMPT_CAP);
        if !line.is_empty() {
            agg.prompt = Some(line);
        }
    }
    if ty == "assistant" {
        if let Some(usage) = v.get("message").and_then(|m| m.get("usage")) {
            agg.tokens.add(&WorkflowTokens {
                input: usage_field(usage, &["input_tokens", "inputTokens"]),
                output: usage_field(usage, &["output_tokens", "outputTokens"]),
                cache_read: usage_field(
                    usage,
                    &["cache_read_input_tokens", "cacheReadInputTokens"],
                ),
                cache_creation: usage_field(
                    usage,
                    &["cache_creation_input_tokens", "cacheCreationInputTokens"],
                ),
            });
        }
    }
}

fn usage_field(usage: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .filter_map(|k| usage.get(*k))
        .filter_map(|v| v.as_u64())
        .next()
        .unwrap_or(0)
}

fn read_meta(path: &Path) -> Option<AgentMeta> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    Some(AgentMeta {
        agent_type: json_str(&v, &["agentType", "agent_type", "type"]),
        model: json_str(&v, &["model", "modelId"]),
    })
}

/// FR-3/FR-5: fold everything new in the run directory into `state`. FR-10: a
/// directory that is missing, unreadable or shaped unexpectedly simply adds
/// nothing — no error, no panic.
pub(crate) fn scan_run_dir(dir: &Path, state: &mut ScanState) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    for name in names {
        let path = dir.join(&name);
        if name == "journal.jsonl" {
            let mut cursor = state.cursors.get(&name).copied().unwrap_or(0);
            let (lines, reset) = read_new_lines(&path, &mut cursor);
            state.cursors.insert(name.clone(), cursor);
            if reset {
                state.journal_order.clear();
                state.results.clear();
            }
            for line in lines {
                apply_journal_line(state, &line);
            }
        } else if let Some(id) = transcript_agent_id(&name) {
            let mut cursor = state.cursors.get(&name).copied().unwrap_or(0);
            let (lines, reset) = read_new_lines(&path, &mut cursor);
            state.cursors.insert(name.clone(), cursor);
            let agg = state.aggs.entry(id).or_default();
            if reset {
                *agg = AgentAgg::default();
            }
            for line in lines {
                apply_transcript_line(agg, &line);
            }
        } else if let Some(id) = meta_agent_id(&name) {
            if !state.metas.contains_key(&id) {
                if let Some(meta) = read_meta(&path) {
                    state.metas.insert(id, meta);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use serde_json::json;

    // ---------- FR-3: the scan ----------

    #[test]
    fn scan_yields_one_record_per_agent_with_type_model_span_prompt_and_tokens() {
        let d = fixture();
        let detail = detail_of(&d, &running_run(), &[]);
        assert_eq!(detail.agents.len(), 2);
        let a1 = &detail.agents[0];
        assert_eq!(a1.agent_id, "a1");
        assert_eq!(a1.agent_type, "frontend");
        assert_eq!(a1.model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(a1.started_at, 1_785_492_000_000); // 2026-07-31T10:00:00Z
        assert_eq!(a1.prompt, "review the frontend"); // first non-blank line only
        assert_eq!(
            a1.tokens,
            WorkflowTokens {
                input: 10,
                output: 5,
                cache_read: 2,
                cache_creation: 1
            }
        );
        assert_eq!(a1.result.as_deref(), Some("12 findings"));
        // an agent with no meta.json is `workflow-subagent`, model unknown
        let a2 = &detail.agents[1];
        assert_eq!(a2.agent_type, "workflow-subagent");
        assert_eq!(a2.model, None);
        // the run total is the sum
        assert_eq!(
            detail.tokens,
            WorkflowTokens {
                input: 30,
                output: 12,
                cache_read: 4,
                cache_creation: 2
            }
        );
        assert_eq!(detail.id, "run-1");
        assert_eq!(detail.session_id, "s1");
        assert!(detail.pending_asks.is_empty());
    }

    #[test]
    fn agents_are_ordered_by_start_then_by_journal_appearance() {
        // FR-3: a2 STARTED first on disk even though the journal lists it second.
        let d = RunDir::new();
        d.write(
            "journal.jsonl",
            &format!(
                "{}\n{}\n",
                json!({ "type": "started", "agentId": "a1" }),
                json!({ "type": "started", "agentId": "a2" }),
            ),
        );
        d.write(
            "agent-a1.jsonl",
            &user_line_at("2026-07-31T10:00:30.000Z", "b"),
        );
        d.write(
            "agent-a2.jsonl",
            &user_line_at("2026-07-31T10:00:10.000Z", "a"),
        );
        let detail = detail_of(&d, &running_run(), &[]);
        assert_eq!(
            detail
                .agents
                .iter()
                .map(|a| a.agent_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a2", "a1"]
        );
    }

    // ---------- FR-5: incremental rescan ----------

    #[test]
    fn a_rescan_reads_only_the_appended_tail_and_totals_match_a_full_re_read() {
        let d = fixture();
        let mut state = ScanState::default();
        scan_run_dir(d.path(), &mut state);
        let before = state.consumed("agent-a1.jsonl");
        d.append(
            "agent-a1.jsonl",
            &assistant_line("2026-07-31T10:01:00.000Z", "more", 3, 4),
        );
        scan_run_dir(d.path(), &mut state);
        assert!(state.consumed("agent-a1.jsonl") > before);

        let mut fresh = ScanState::default();
        scan_run_dir(d.path(), &mut fresh);
        let run = terminal_run();
        let dir = d.path().to_string_lossy().to_string();
        assert_eq!(
            build_detail(&run, "s1", &dir, false, &state, &[]),
            build_detail(&run, "s1", &dir, false, &fresh, &[])
        );
        assert_eq!(
            build_detail(&run, "s1", &dir, false, &state, &[]).agents[0].tokens,
            WorkflowTokens {
                input: 13,
                output: 9,
                cache_read: 4,
                cache_creation: 2
            }
        );
    }

    #[test]
    fn a_shrunken_file_is_re_read_from_zero() {
        // FR-5: a file that shrank (rotated / rewritten) cannot be tailed.
        let d = fixture();
        let mut state = ScanState::default();
        scan_run_dir(d.path(), &mut state);
        d.write(
            "agent-a1.jsonl",
            &user_line_at("2026-07-31T10:05:00.000Z", "restarted"),
        );
        scan_run_dir(d.path(), &mut state);
        let detail = build_detail(
            &terminal_run(),
            "s1",
            &d.path().to_string_lossy(),
            false,
            &state,
            &[],
        );
        // a1's aggregate was rebuilt from zero, not tailed — and because its new
        // first line is LATER than a2's, FR-3's order puts it second.
        let a1 = detail
            .agents
            .iter()
            .find(|a| a.agent_id == "a1")
            .expect("a1 is still listed");
        assert_eq!(a1.prompt, "restarted");
        assert_eq!(a1.tokens, WorkflowTokens::default());
        assert_eq!(a1.started_at, 1_785_492_300_000); // 10:05:00Z, the rewrite
        assert_eq!(
            detail
                .agents
                .iter()
                .map(|a| a.agent_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a2", "a1"]
        );
    }

    #[test]
    fn a_trailing_partial_line_is_skipped_until_it_completes() {
        // §7: `workflows_agent` for a file mid-write.
        let d = RunDir::new();
        d.write(
            "agent-a1.jsonl",
            &user_line_at("2026-07-31T10:00:00.000Z", "go"),
        );
        d.append("agent-a1.jsonl", "{\"type\":\"assist");
        let mut state = ScanState::default();
        scan_run_dir(d.path(), &mut state);
        let dir = d.path().to_string_lossy().to_string();
        assert_eq!(
            build_detail(&running_run(), "s1", &dir, false, &state, &[]).agents[0].prompt,
            "go"
        );
        // the rest of the line lands → the next flush picks it up
        d.append(
            "agent-a1.jsonl",
            "ant\",\"timestamp\":\"2026-07-31T10:00:09.000Z\",\"message\":{\"usage\":{\"output_tokens\":4}}}\n",
        );
        scan_run_dir(d.path(), &mut state);
        assert_eq!(
            build_detail(&terminal_run(), "s1", &dir, false, &state, &[]).agents[0]
                .tokens
                .output,
            4
        );
    }

    // ---------- FR-10: soft failure ----------

    #[test]
    fn a_missing_or_malformed_directory_yields_an_empty_detail_and_never_panics() {
        let mut state = ScanState::default();
        scan_run_dir(Path::new("/definitely/not/here"), &mut state);
        assert!(build_detail(
            &running_run(),
            "s1",
            "/definitely/not/here",
            false,
            &state,
            &[]
        )
        .agents
        .is_empty());

        let d = RunDir::new();
        d.write("journal.jsonl", "not json at all\n{oops\n");
        d.write("agent-a1.jsonl", "\u{0}\u{0}garbage\n");
        d.write("agent-a1.meta.json", "{ broken");
        d.write("unrelated.txt", "hello");
        let detail = detail_of(&d, &running_run(), &[]);
        // the transcript FILE is authoritative for existence (§7) — a1 is listed
        // even though every line of it was unparseable.
        assert_eq!(detail.agents.len(), 1);
        assert_eq!(detail.agents[0].agent_type, "workflow-subagent");
        assert_eq!(detail.agents[0].started_at, 0);
        assert_eq!(detail.agents[0].prompt, "");
    }

    #[test]
    fn a_result_for_an_unknown_agent_mints_the_record_from_the_journal_alone() {
        // §7: span and tokens stay absent until its file appears.
        let d = RunDir::new();
        d.write(
            "journal.jsonl",
            &format!(
                "{}\n",
                json!({ "type": "result", "agentId": "a9", "result": { "ok": true, "n": 3 } })
            ),
        );
        let detail = detail_of(&d, &running_run(), &[]);
        assert_eq!(detail.agents.len(), 1);
        assert_eq!(detail.agents[0].agent_id, "a9");
        assert_eq!(detail.agents[0].status, "done");
        assert_eq!(detail.agents[0].started_at, 0);
        // an object result is stringified (pretty) for the row AND the view
        let result = detail.agents[0].result.clone().unwrap();
        assert!(result.contains("\"ok\""), "{result}");
    }

    #[test]
    fn a_large_result_is_capped_at_2000_chars() {
        let d = RunDir::new();
        d.write(
            "journal.jsonl",
            &format!(
                "{}\n",
                json!({ "type": "result", "agentId": "a1", "result": "x".repeat(5_000) })
            ),
        );
        let detail = detail_of(&d, &running_run(), &[]);
        assert_eq!(
            detail.agents[0].result.as_deref().unwrap().chars().count(),
            RESULT_CAP
        );
    }
}
