//! workflow-panel: `Workflow` tool run tracking for pane [6].
//!
//! A workflow run is never dispatched from Francois — the assistant calls the
//! harness's `Workflow` tool during a turn, and everything the panel shows is
//! read back out of the session's own NDJSON stream:
//!
//!   content_block_start(Workflow)  → mint the run (`running`, clock starts)
//!   content_block_stop             → the input JSON has fully accumulated, so
//!                                    the script's `export const meta` block can
//!                                    finally be parsed for name/description/phases
//!   tool_result                    → the dispatch ACK (the tool returns
//!                                    immediately), so it carries the `wf_…` run
//!                                    id but never ends the run — only an error
//!                                    result does
//!   task-notification              → the run finished (the notification the
//!                                    harness injects when the workflow completes)
//!   turn end                       → backstop: nothing is left `running`
//!
//! Phase PROGRESS is deliberately absent: the workflow's own agents do not
//! surface in the parent stream, so the panel lists the phases the script
//! DECLARED and reports no per-phase state rather than inventing one.
//!
//! Everything here is PURE over `Session` and returns the `WorkflowRun`s its
//! caller must emit; the AppHandle wrappers at the end only lock → mutate →
//! drop the lock → emit, so no emit ever happens while Engine.sessions is held
//! (the file-wide lock rule).

use super::*;

use crate::ipc::{err, ok, IpcResult};
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

/// The harness's multi-agent orchestration tool. Unlike `is_subagent_tool` there
/// is no second spelling — `Workflow` is the only name it ships under.
pub(crate) fn is_workflow_tool(tool: &str) -> bool {
    tool == "Workflow"
}

/// What a dispatch's input says about the run, before any of it is observed.
pub(crate) struct WorkflowMeta {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) phases: Vec<WorkflowPhaseInfo>,
}

// ---------- parsing the dispatch input (pure) ----------

/// The `{ … }` object literal that follows `export const meta =` in a workflow
/// script, as raw source text. `None` when the script declares no meta block.
///
/// This is JavaScript source, not JSON, so it is brace-matched by hand rather
/// than parsed — quoted braces (`'{'`, "}", template literals) never count
/// toward the depth, which is the only way the scan can go wrong on real
/// scripts. Escapes inside a string are skipped so a `'\''` cannot end it early.
fn meta_block(script: &str) -> Option<&str> {
    let anchor = script.find("export const meta")?;
    let rest = &script[anchor..];
    let open = rest.find('{')?;
    let bytes = rest.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut i = open;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'\'' | b'"' | b'`' => quote = Some(c),
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&rest[open..=i]);
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    None
}

/// Byte offset of `key` used as an object KEY in `src` — i.e. followed (past
/// whitespace) by `:`, and not preceded by an identifier character, so `name`
/// never matches inside `filename` or `agentName`. Returns the offset of the
/// character right after the colon.
fn key_value_start(src: &str, key: &str) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = src[from..].find(key) {
        let at = from + rel;
        from = at + key.len();
        let prev_ok = at == 0 || {
            let p = bytes[at - 1];
            !(p.is_ascii_alphanumeric() || p == b'_' || p == b'$')
        };
        if !prev_ok {
            continue;
        }
        let mut i = from;
        // an optional closing quote for a quoted key ('name': …)
        if i < bytes.len() && (bytes[i] == b'\'' || bytes[i] == b'"') {
            i += 1;
        }
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b':' {
            return Some(i + 1);
        }
    }
    None
}

/// The string value of `key` in the object-literal source `src`. Handles the
/// three JS quote styles and backslash escapes; returns `None` for a key that
/// is absent or whose value is not a plain string literal.
fn field_string(src: &str, key: &str) -> Option<String> {
    let start = key_value_start(src, key)?;
    let bytes = src.as_bytes();
    let mut i = start;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    let quote = *bytes.get(i)?;
    if quote != b'\'' && quote != b'"' && quote != b'`' {
        return None;
    }
    i += 1;
    let mut out = String::new();
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'\\' {
            // keep the escaped character verbatim (\' → ', \n stays a literal n:
            // these strings are display labels, not code we re-execute)
            if let Some(&next) = bytes.get(i + 1) {
                out.push(next as char);
            }
            i += 2;
            continue;
        }
        if c == quote {
            return Some(out);
        }
        out.push(c as char);
        i += 1;
    }
    None
}

/// The raw source of `key: [ … ]` in `src`, brackets included, or `None`.
fn array_block<'a>(src: &'a str, key: &str) -> Option<&'a str> {
    let start = key_value_start(src, key)?;
    let bytes = src.as_bytes();
    let mut i = start;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if *bytes.get(i)? != b'[' {
        return None;
    }
    let open = i;
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'\'' | b'"' | b'`' => quote = Some(c),
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&src[open..=i]);
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    None
}

/// Split an array literal's source into its top-level `{ … }` element sources.
fn object_elements(arr: &str) -> Vec<&str> {
    let bytes = arr.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut quote: Option<u8> = None;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'\'' | b'"' | b'`' => quote = Some(c),
                b'{' => {
                    if depth == 0 {
                        start = i;
                    }
                    depth += 1;
                }
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        out.push(&arr[start..=i]);
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    out
}

/// The declared phases of a meta block, in order. A phase with no `title` is
/// dropped — an unlabelled row would say nothing.
fn parse_phases(meta: &str) -> Vec<WorkflowPhaseInfo> {
    let Some(arr) = array_block(meta, "phases") else {
        return Vec::new();
    };
    object_elements(arr)
        .into_iter()
        .filter_map(|el| {
            let title = field_string(el, "title")?;
            if title.is_empty() {
                return None;
            }
            Some(WorkflowPhaseInfo {
                title,
                detail: field_string(el, "detail").filter(|d| !d.is_empty()),
            })
        })
        .collect()
}

/// The last path segment of `path`, without its extension — the display name for
/// a `scriptPath` dispatch. Handles both separators: the path comes from the
/// model's tool call, not from this OS.
fn file_stem(path: &str) -> String {
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match base.rfind('.') {
        Some(dot) if dot > 0 => base[..dot].to_string(),
        _ => base.to_string(),
    }
}

/// FR-4: what a dispatch's (fully accumulated) input says about the run.
///
/// Ladder, richest source first: an inline `script`'s own meta block → the saved
/// workflow `name` → the `scriptPath` file stem. A dispatch that gives none of
/// them still yields a usable card rather than a blank one.
pub(crate) fn parse_workflow_meta(input: &Value) -> WorkflowMeta {
    let script = input.get("script").and_then(|s| s.as_str()).unwrap_or("");
    if let Some(meta) = meta_block(script) {
        // the phases array carries its own `title`/`detail` keys — take it out of
        // the way first so `description` can never match inside a phase entry.
        let phases = parse_phases(meta);
        let without_phases = match array_block(meta, "phases") {
            Some(arr) => meta.replacen(arr, "", 1),
            None => meta.to_string(),
        };
        let name = field_string(&without_phases, "name").unwrap_or_default();
        if !name.is_empty() {
            return WorkflowMeta {
                name,
                description: field_string(&without_phases, "description").unwrap_or_default(),
                phases,
            };
        }
    }
    if let Some(name) = input.get("name").and_then(|n| n.as_str()) {
        if !name.is_empty() {
            return WorkflowMeta {
                name: name.to_string(),
                description: String::new(),
                phases: Vec::new(),
            };
        }
    }
    let stem = input
        .get("scriptPath")
        .and_then(|p| p.as_str())
        .map(file_stem)
        .unwrap_or_default();
    WorkflowMeta {
        name: if stem.is_empty() {
            "workflow".to_string()
        } else {
            stem
        },
        description: String::new(),
        phases: Vec::new(),
    }
}

/// FR-6: the `wf_…` run id the dispatch ack reports, if any. Scanned rather than
/// JSON-parsed — the ack is free text that happens to contain the id.
pub(crate) fn extract_run_id(text: &str) -> Option<String> {
    let at = text.find("wf_")?;
    let id: String = text[at..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    // "wf_" alone is a prefix, not an id
    (id.len() > 3).then_some(id)
}

// ---------- state transitions (pure over Session) ----------

impl Session {
    fn insert_workflow(&mut self, run: WorkflowRun) {
        if !self.workflows.contains_key(&run.id) {
            self.workflow_order.push(run.id.clone());
        }
        self.workflows.insert(run.id.clone(), run);
    }

    /// FR-7: this session's runs in first-seen order.
    pub(crate) fn workflow_list(&self) -> Vec<WorkflowRun> {
        self.workflow_order
            .iter()
            .filter_map(|id| self.workflows.get(id))
            .cloned()
            .collect()
    }
}

/// FR-2: a `Workflow` dispatch starts — mint its record and stash the
/// correlation key. Name/description/phases stay provisional until
/// `apply_workflow_meta` sees the complete input (FR-4).
pub(crate) fn mint_workflow(
    s: &mut Session,
    session_id: &str,
    run_uuid: &str,
    tool_use_id: &str,
    at: u64,
) -> WorkflowRun {
    let run = WorkflowRun {
        id: run_uuid.to_string(),
        session_id: session_id.to_string(),
        name: "workflow".into(),
        description: String::new(),
        status: "running".into(),
        started_at: at, // FR-5: never changes
        ended_at: None,
        phases: Vec::new(),
        run_id: None,
        last_activity: None,
        // workflow-details FR-1: both land with the dispatch ack, never before.
        transcript_dir: None,
        pending_asks: None,
    };
    s.insert_workflow(run.clone());
    s.workflow_by_tool
        .insert(tool_use_id.to_string(), run_uuid.to_string());
    run
}

/// FR-4: the dispatch's input finished accumulating — fill in what the script
/// declared. Returns the updated run to emit, or `None` when nothing changed
/// (an unknown key, or a meta that adds nothing).
pub(crate) fn apply_workflow_meta(
    s: &mut Session,
    run_uuid: &str,
    meta: WorkflowMeta,
) -> Option<WorkflowRun> {
    let run = s.workflows.get_mut(run_uuid)?;
    if run.name == meta.name && run.description == meta.description && run.phases == meta.phases {
        return None;
    }
    run.name = meta.name;
    run.description = meta.description;
    run.phases = meta.phases;
    Some(run.clone())
}

/// FR-6: the dispatch's tool_result. The `Workflow` tool returns as soon as the
/// run is queued, so a SUCCESS result is only an acknowledgement — it records
/// the run id and leaves the clock running (the same reading async-agents FR-5
/// gives a background dispatch). An ERROR result is terminal: the run never
/// started, so nothing else will ever report on it.
///
/// workflow-details FR-1/FR-2: the same ack is where the run's `Transcript dir:`
/// and `Script file:` come from — each kept only when it resolves on disk. The
/// transcript dir rides on the run (the tab needs it); the script path is
/// core-only state on the session.
pub(crate) fn apply_workflow_dispatch_result(
    s: &mut Session,
    run_uuid: &str,
    result_text: &str,
    is_error: bool,
    at: u64,
) -> Option<WorkflowRun> {
    if !s.workflows.contains_key(run_uuid) {
        return None;
    }
    if is_error {
        let run = s.workflows.get_mut(run_uuid)?;
        run.status = "error".into();
        run.ended_at = Some(at);
        let label = first_nonblank_line(result_text, 120);
        run.last_activity = Some(if label.is_empty() {
            "dispatch failed".to_string()
        } else {
            label
        });
        return Some(run.clone());
    }
    // FR-2: resolved BEFORE the run is borrowed, so the script path can be
    // stashed on the session in the same pass.
    let paths = resolve_ack_paths(result_text);
    let run = s.workflows.get_mut(run_uuid)?;
    run.run_id = extract_run_id(result_text);
    run.last_activity = Some("running in the background".to_string());
    run.transcript_dir = paths.transcript_dir;
    let updated = run.clone();
    match paths.script_path {
        Some(p) => {
            s.workflow_scripts
                .insert(run_uuid.to_string(), PathBuf::from(p));
        }
        None => {
            s.workflow_scripts.remove(run_uuid);
        }
    }
    Some(updated)
}

/// FR-8 ladder: the run id verbatim → the workflow's name → (only when
/// `allow_sole`) the single running run.
///
/// The sole-candidate rung is separated out because this ladder interleaves with
/// async-agents': the NAMED rungs run before the agent ladder (so a lone
/// background agent cannot swallow a workflow's notice), and this loose one runs
/// after it (so a lone workflow cannot swallow an agent's).
pub(crate) fn resolve_notice_workflow(s: &Session, text: &str, allow_sole: bool) -> Option<String> {
    let running: Vec<&WorkflowRun> = s
        .workflow_order
        .iter()
        .filter_map(|id| s.workflows.get(id))
        .filter(|w| w.status == "running")
        .collect();
    for w in &running {
        if let Some(rid) = &w.run_id {
            if !rid.is_empty() && text.contains(rid.as_str()) {
                return Some(w.id.clone());
            }
        }
    }
    for w in &running {
        if !w.name.is_empty() && text.contains(w.name.as_str()) {
            return Some(w.id.clone());
        }
    }
    if allow_sole && running.len() == 1 {
        return Some(running[0].id.clone());
    }
    None
}

/// FR-8: a resolved task-notification closes its run. `notice_is_error` is the
/// same word test the agent trail uses, so "workflow failed" and "workflow
/// completed" land on the same statuses in both panels.
pub(crate) fn apply_workflow_notice(
    s: &mut Session,
    run_uuid: &str,
    text: &str,
    at: u64,
) -> Option<WorkflowRun> {
    let run = s.workflows.get_mut(run_uuid)?;
    let label = first_nonblank_line(text, 120);
    run.status = if notice_is_error(text) {
        "error"
    } else {
        "done"
    }
    .into();
    run.ended_at = Some(at);
    run.last_activity = Some(if label.is_empty() {
        "completed".to_string()
    } else {
        label
    });
    Some(run.clone())
}

/// FR-9 turn-end backstop: no run of this session is left `running`, so the
/// elapsed clock never ticks past the turn that owns it. Mirrors
/// `finalize_agents`, and runs at the same two call sites.
pub(crate) fn finalize_workflows(s: &mut Session, errored: bool, at: u64) -> Vec<WorkflowRun> {
    let running: Vec<String> = s
        .workflow_order
        .iter()
        .filter(|id| {
            s.workflows
                .get(*id)
                .map(|w| w.status == "running")
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let mut out = Vec::new();
    for id in running {
        if let Some(w) = s.workflows.get_mut(&id) {
            w.status = if errored { "error" } else { "done" }.into();
            w.ended_at = Some(at);
            w.last_activity = Some("ended with the turn".to_string());
            out.push(w.clone());
        }
    }
    out
}

// ---------- AppHandle wrappers (lock → mutate → drop → emit) ----------

/// workflow-details FR-6: which of these updates left `running` with a
/// transcript directory recorded — the runs whose watch, if any, is owed the
/// final flush that stops it deterministically. A run leaving `running` here
/// (a task-notification, a dispatch error, or the turn-end backstop) is its
/// ONLY terminal transition on some paths — no further filesystem write ever
/// follows for the 300 ms debounce to catch (the "stragglers" §7 names) —
/// so this is the one place every terminal transition passes through. Pulled
/// out so the decision is testable without an `AppHandle`.
pub(crate) fn terminal_watch_run_ids(runs: &[WorkflowRun]) -> Vec<String> {
    runs.iter()
        .filter(|r| r.status != "running" && r.transcript_dir.is_some())
        .map(|r| r.id.clone())
        .collect()
}

pub(crate) fn emit_workflow_updates(env: &dyn SessionEnv, runs: Vec<WorkflowRun>) {
    let terminal_ids = terminal_watch_run_ids(&runs);
    for run in runs {
        env.emit_session(SessionEvent::WorkflowUpdate { run });
    }
    for run_id in terminal_ids {
        // flush_workflow_detail is a no-op flush when no watch is running (it
        // still emits the frozen detail once and stops the watch if there is
        // one) — safe to call whether or not a tab was ever opened.
        flush_workflow_detail(env, &run_id);
    }
}

/// FR-2: called from the stream reader when a `Workflow` tool_use block opens.
/// Returns the minted run id so the caller can correlate the rest of the block.
pub(crate) fn on_workflow_start(
    env: &dyn SessionEnv,
    session_id: &str,
    tool_use_id: &str,
) -> String {
    let run_uuid = uuid();
    let minted = {
        let mut map = env.engine().sessions.lock().unwrap();
        map.get_mut(session_id)
            .map(|s| mint_workflow(s, session_id, &run_uuid, tool_use_id, now_ms()))
    };
    if let Some(run) = minted {
        env.emit_session(SessionEvent::WorkflowUpdate { run });
    }
    run_uuid
}

/// FR-4: called when the dispatch's input JSON has fully accumulated.
pub(crate) fn on_workflow_input_complete(
    env: &dyn SessionEnv,
    session_id: &str,
    run_uuid: &str,
    input: &Value,
) {
    let meta = parse_workflow_meta(input);
    let updated = {
        let mut map = env.engine().sessions.lock().unwrap();
        map.get_mut(session_id)
            .and_then(|s| apply_workflow_meta(s, run_uuid, meta))
    };
    emit_workflow_updates(env, updated.into_iter().collect());
}

/// FR-6: called from the tool_result reconciliation for a `Workflow` dispatch.
pub(crate) fn on_workflow_dispatch_result(
    env: &dyn SessionEnv,
    session_id: &str,
    run_uuid: &str,
    result_text: &str,
    is_error: bool,
) {
    let updated = {
        let mut map = env.engine().sessions.lock().unwrap();
        map.get_mut(session_id).and_then(|s| {
            apply_workflow_dispatch_result(s, run_uuid, result_text, is_error, now_ms())
        })
    };
    emit_workflow_updates(env, updated.into_iter().collect());
}

/// FR-8: offer a task-notification to the workflow ladder. Returns whether it
/// was claimed — the caller falls through to the agent ladder when it was not.
pub(crate) fn handle_workflow_notification(
    env: &dyn SessionEnv,
    session_id: &str,
    v: &Value,
    allow_sole: bool,
) -> bool {
    let text = user_line_text(v);
    let updated = {
        let mut map = env.engine().sessions.lock().unwrap();
        map.get_mut(session_id).and_then(|s| {
            let id = resolve_notice_workflow(s, &text, allow_sole)?;
            apply_workflow_notice(s, &id, &text, now_ms())
        })
    };
    let claimed = updated.is_some();
    emit_workflow_updates(env, updated.into_iter().collect());
    claimed
}

// ---------- commands (spec §5) ----------

#[tauri::command]
pub fn workflows_list(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Vec<WorkflowRun>> {
    let map = engine.sessions.lock().unwrap();
    match map.get(&session_id) {
        Some(s) => ok(s.workflow_list()),
        None => err("SESSION_NOT_FOUND", "session not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    const SCRIPT: &str = r#"
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
phase('Scan')
"#;

    // ---------- meta parsing (FR-4) ----------

    #[test]
    fn parse_workflow_meta_reads_name_description_and_phases_from_a_script() {
        let meta = parse_workflow_meta(&json!({ "script": SCRIPT }));
        assert_eq!(meta.name, "find-flaky-tests");
        assert_eq!(meta.description, "Find flaky tests and propose fixes");
        assert_eq!(
            meta.phases,
            vec![
                WorkflowPhaseInfo {
                    title: "Scan".into(),
                    detail: Some("grep test logs for retries".into()),
                },
                WorkflowPhaseInfo {
                    title: "Fix".into(),
                    detail: Some("one agent per flaky test".into()),
                },
            ]
        );
    }

    #[test]
    fn parse_workflow_meta_handles_double_quotes_and_a_phase_without_detail() {
        let script = r#"export const meta = { name: "audit", description: "", phases: [{ title: "Sweep" }] }"#;
        let meta = parse_workflow_meta(&json!({ "script": script }));
        assert_eq!(meta.name, "audit");
        assert_eq!(meta.description, "");
        assert_eq!(
            meta.phases,
            vec![WorkflowPhaseInfo {
                title: "Sweep".into(),
                detail: None
            }]
        );
    }

    #[test]
    fn parse_workflow_meta_is_not_confused_by_phase_titles() {
        // FR-4: `description` must not be matched inside a phase entry, and a
        // phase's own `detail` must not become the run's description.
        let script = r#"export const meta = {
          phases: [{ title: 'Review', detail: 'description of the pass' }],
          name: 'review-changes',
          description: 'the real one',
        }"#;
        let meta = parse_workflow_meta(&json!({ "script": script }));
        assert_eq!(meta.name, "review-changes");
        assert_eq!(meta.description, "the real one");
    }

    #[test]
    fn parse_workflow_meta_ignores_a_brace_inside_a_string() {
        let script = r#"export const meta = { name: 'braces', description: 'uses { and } in text', phases: [] }"#;
        let meta = parse_workflow_meta(&json!({ "script": script }));
        assert_eq!(meta.name, "braces");
        assert_eq!(meta.description, "uses { and } in text");
    }

    #[test]
    fn parse_workflow_meta_falls_back_to_the_saved_name_then_the_script_path() {
        assert_eq!(
            parse_workflow_meta(&json!({ "name": "cycle" })).name,
            "cycle"
        );
        assert_eq!(
            parse_workflow_meta(&json!({ "scriptPath": "C:\\tmp\\wf\\review-changes.mjs" })).name,
            "review-changes"
        );
        assert_eq!(
            parse_workflow_meta(&json!({ "scriptPath": "/tmp/wf/deep-audit.js" })).name,
            "deep-audit"
        );
    }

    #[test]
    fn parse_workflow_meta_without_any_hint_still_names_the_run() {
        let meta = parse_workflow_meta(&json!({}));
        assert_eq!(meta.name, "workflow");
        assert_eq!(meta.description, "");
        assert!(meta.phases.is_empty());
    }

    #[test]
    fn parse_workflow_meta_ignores_a_meta_block_with_no_name() {
        // an unparsable/nameless meta must not shadow the `name` input.
        let script = "export const meta = { description: 'no name here' }";
        let meta = parse_workflow_meta(&json!({ "script": script, "name": "saved-one" }));
        assert_eq!(meta.name, "saved-one");
    }

    #[test]
    fn is_workflow_tool_matches_only_the_workflow_tool() {
        assert!(is_workflow_tool("Workflow"));
        assert!(!is_workflow_tool("Task"));
        assert!(!is_workflow_tool("Agent"));
    }

    // ---------- the run id in the dispatch ack (FR-6) ----------

    #[test]
    fn extract_run_id_finds_the_wf_token() {
        assert_eq!(
            extract_run_id("started as wf_ab12cd34ef, see /workflows").as_deref(),
            Some("wf_ab12cd34ef")
        );
        assert_eq!(
            extract_run_id(r#"{"runId":"wf_9x8y7z-abc"}"#).as_deref(),
            Some("wf_9x8y7z-abc")
        );
        assert_eq!(extract_run_id("no id here"), None);
        assert_eq!(extract_run_id("wf_ alone"), None);
    }

    // ---------- lifecycle (FR-2/FR-6/FR-8/FR-9) ----------

    fn minted(s: &mut Session) -> String {
        let id = "run-1".to_string();
        mint_workflow(s, "s1", &id, "toolu_w", 1_000);
        let _ = apply_workflow_meta(s, &id, parse_workflow_meta(&json!({ "script": SCRIPT })));
        id
    }

    #[test]
    fn mint_registers_a_running_run_in_first_seen_order() {
        let mut s = test_session();
        mint_workflow(&mut s, "s1", "run-1", "toolu_a", 1_000);
        mint_workflow(&mut s, "s1", "run-2", "toolu_b", 2_000);
        let list = s.workflow_list();
        assert_eq!(
            list.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(),
            vec!["run-1", "run-2"]
        );
        assert_eq!(list[0].status, "running");
        assert_eq!(list[0].started_at, 1_000);
        assert!(list[0].ended_at.is_none());
        assert_eq!(s.workflow_by_tool.get("toolu_b").unwrap(), "run-2");
    }

    #[test]
    fn apply_meta_fills_the_card_then_reports_no_second_change() {
        let mut s = test_session();
        mint_workflow(&mut s, "s1", "run-1", "toolu_w", 1_000);
        let meta = parse_workflow_meta(&json!({ "script": SCRIPT }));
        let updated = apply_workflow_meta(&mut s, "run-1", meta).expect("meta updates the run");
        assert_eq!(updated.name, "find-flaky-tests");
        assert_eq!(updated.phases.len(), 2);
        // re-applying the same meta is not a change → no redundant emission
        let again = parse_workflow_meta(&json!({ "script": SCRIPT }));
        assert!(apply_workflow_meta(&mut s, "run-1", again).is_none());
    }

    #[test]
    fn a_successful_dispatch_result_is_only_an_ack() {
        // FR-6: the tool returns as soon as the run is queued — the clock keeps running.
        let mut s = test_session();
        let id = minted(&mut s);
        let run = apply_workflow_dispatch_result(
            &mut s,
            &id,
            "Workflow started: wf_abc123 (see /workflows)",
            false,
            2_000,
        )
        .expect("the ack updates the run");
        assert_eq!(run.status, "running");
        assert!(run.ended_at.is_none());
        assert_eq!(run.run_id.as_deref(), Some("wf_abc123"));
    }

    #[test]
    fn the_ack_puts_its_transcript_dir_on_the_run_and_its_script_on_the_session() {
        // workflow-details FR-1/FR-2: each path is the remainder of its line, and
        // is kept ONLY when it resolves — a directory for the transcript, a file
        // for the script.
        let dir = std::env::temp_dir().join(format!("francois-ack-{}", uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("wf.js");
        std::fs::write(&script, "//").unwrap();

        let mut s = test_session();
        let id = minted(&mut s);
        let run = apply_workflow_dispatch_result(
            &mut s,
            &id,
            &format!(
                "Workflow started: wf_abc123\nTranscript dir: {}\nScript file: {}\n",
                dir.display(),
                script.display()
            ),
            false,
            2_000,
        )
        .expect("the ack updates the run");
        assert_eq!(run.run_id.as_deref(), Some("wf_abc123"));
        assert_eq!(
            run.transcript_dir.as_deref(),
            Some(dir.to_string_lossy().as_ref())
        );
        assert_eq!(s.workflow_scripts.get(&id), Some(&script));

        // FR-1: an ack carrying neither leaves both absent…
        let mut plain = test_session();
        let pid = minted(&mut plain);
        let bare =
            apply_workflow_dispatch_result(&mut plain, &pid, "Workflow started: wf_x1", false, 1)
                .unwrap();
        assert_eq!(bare.transcript_dir, None);
        assert!(plain.workflow_scripts.is_empty());
        // …and FR-2: a path that does not resolve is treated as absent.
        let mut gone = test_session();
        let gid = minted(&mut gone);
        let unresolved = apply_workflow_dispatch_result(
            &mut gone,
            &gid,
            "Transcript dir: /no/such/dir\nScript file: /no/such.js",
            false,
            1,
        )
        .unwrap();
        assert_eq!(unresolved.transcript_dir, None);
        assert!(gone.workflow_scripts.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_errored_dispatch_result_ends_the_run() {
        let mut s = test_session();
        let id = minted(&mut s);
        let run = apply_workflow_dispatch_result(&mut s, &id, "script syntax error", true, 2_000)
            .unwrap();
        assert_eq!(run.status, "error");
        assert_eq!(run.ended_at, Some(2_000));
        assert_eq!(run.last_activity.as_deref(), Some("script syntax error"));
    }

    #[test]
    fn a_notification_resolves_by_run_id_then_name_then_the_single_run() {
        let mut s = test_session();
        let id = minted(&mut s);
        let _ = apply_workflow_dispatch_result(&mut s, &id, "wf_abc123", false, 2_000);
        // second, unrelated run so the single-candidate rung cannot be what matches
        mint_workflow(&mut s, "s1", "run-2", "toolu_x", 2_500);
        assert_eq!(
            resolve_notice_workflow(&s, "task-notification: wf_abc123 finished", false).as_deref(),
            Some("run-1")
        );
        assert_eq!(
            resolve_notice_workflow(&s, "workflow find-flaky-tests completed", false).as_deref(),
            Some("run-1")
        );
        // no id, no name, two candidates → unresolved rather than guessed
        assert_eq!(
            resolve_notice_workflow(&s, "something finished", true),
            None
        );
    }

    #[test]
    fn the_sole_run_rung_only_fires_when_the_caller_allows_it() {
        // FR-8: the named rungs run BEFORE the agent ladder and this one AFTER it,
        // so an unnamed notice never jumps the queue on a lone background agent.
        let mut s = test_session();
        minted(&mut s);
        assert_eq!(resolve_notice_workflow(&s, "all done", false), None);
        assert_eq!(
            resolve_notice_workflow(&s, "all done", true).as_deref(),
            Some("run-1")
        );
    }

    #[test]
    fn a_notification_closes_its_run_and_an_error_notice_marks_it_errored() {
        let mut s = test_session();
        let id = minted(&mut s);
        let run =
            apply_workflow_notice(&mut s, &id, "Workflow completed: 4 findings", 5_000).unwrap();
        assert_eq!(run.status, "done");
        assert_eq!(run.ended_at, Some(5_000));
        assert_eq!(
            run.last_activity.as_deref(),
            Some("Workflow completed: 4 findings")
        );

        let mut s2 = test_session();
        let id2 = minted(&mut s2);
        let errored =
            apply_workflow_notice(&mut s2, &id2, "Workflow failed: agent died", 5_000).unwrap();
        assert_eq!(errored.status, "error");
    }

    #[test]
    fn turn_end_finalizes_every_running_run_exactly_once() {
        let mut s = test_session();
        let id = minted(&mut s);
        let _ = apply_workflow_notice(&mut s, &id, "done", 3_000);
        mint_workflow(&mut s, "s1", "run-2", "toolu_x", 3_500);
        let closed = finalize_workflows(&mut s, false, 9_000);
        assert_eq!(closed.len(), 1); // the already-closed run is left alone
        assert_eq!(closed[0].id, "run-2");
        assert_eq!(closed[0].status, "done");
        assert_eq!(closed[0].ended_at, Some(9_000));
        assert_eq!(
            closed[0].last_activity.as_deref(),
            Some("ended with the turn")
        );
        // and nothing is left running
        assert!(finalize_workflows(&mut s, false, 10_000).is_empty());
    }

    #[test]
    fn turn_end_after_an_error_marks_the_run_errored() {
        let mut s = test_session();
        minted(&mut s);
        let closed = finalize_workflows(&mut s, true, 9_000);
        assert_eq!(closed[0].status, "error");
    }

    // ---------- FR-6: which updates owe their watch a final flush ----------

    fn run_with(id: &str, status: &str, transcript_dir: Option<&str>) -> WorkflowRun {
        let mut run = test_workflow_run();
        run.id = id.into();
        run.status = status.into();
        run.transcript_dir = transcript_dir.map(|d| d.to_string());
        run
    }

    #[test]
    fn terminal_watch_run_ids_picks_only_terminal_runs_with_a_transcript_dir() {
        // a run leaving `running` here (a notice, a dispatch error, or the
        // turn-end backstop) may be the ONLY terminal transition it ever gets —
        // no further filesystem write follows for the debounce to catch — so
        // every such run with a directory to watch must be picked up.
        let runs = vec![
            run_with("still-running", "running", Some("/tmp/wf/a")), // untouched
            run_with("no-dir", "done", None),                        // never had a watch
            run_with("done-with-dir", "done", Some("/tmp/wf/b")),
            run_with("errored-with-dir", "error", Some("/tmp/wf/c")),
        ];
        let mut ids = terminal_watch_run_ids(&runs);
        ids.sort();
        assert_eq!(ids, vec!["done-with-dir", "errored-with-dir"]);
    }

    #[test]
    fn terminal_watch_run_ids_is_empty_for_no_runs() {
        assert!(terminal_watch_run_ids(&[]).is_empty());
    }

    #[test]
    fn transitions_on_an_unknown_run_are_no_ops() {
        let mut s = test_session();
        assert!(apply_workflow_meta(
            &mut s,
            "nope",
            WorkflowMeta {
                name: "x".into(),
                description: String::new(),
                phases: Vec::new()
            }
        )
        .is_none());
        assert!(apply_workflow_dispatch_result(&mut s, "nope", "ack", false, 1).is_none());
        assert!(apply_workflow_notice(&mut s, "nope", "done", 1).is_none());
    }

    // ---------- contract shape (§5) ----------

    #[test]
    fn workflow_run_serializes_the_contract_shape() {
        let run = WorkflowRun {
            id: "w1".into(),
            session_id: "s1".into(),
            name: "review-changes".into(),
            description: "Review changed files".into(),
            status: "running".into(),
            started_at: 1_000,
            ended_at: None,
            phases: vec![WorkflowPhaseInfo {
                title: "Review".into(),
                detail: None,
            }],
            run_id: Some("wf_abc123".into()),
            last_activity: Some("running in the background".into()),
            transcript_dir: Some("/tmp/wf/run-1".into()),
            pending_asks: Some(2),
        };
        let v = serde_json::to_value(&run).unwrap();
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["startedAt"], 1_000);
        assert_eq!(v["runId"], "wf_abc123");
        assert_eq!(v["lastActivity"], "running in the background");
        assert_eq!(v["phases"][0]["title"], "Review");
        // workflow-details FR-1/FR-24
        assert_eq!(v["transcriptDir"], "/tmp/wf/run-1");
        assert_eq!(v["pendingAsks"], 2);
        // absent, never null (a `detail?`/`endedAt?` optional in the contract)
        assert!(v.get("endedAt").is_none());
        assert!(v["phases"][0].get("detail").is_none());
        assert!(serde_json::to_value(test_workflow_run())
            .unwrap()
            .get("pendingAsks")
            .is_none());
    }
}
