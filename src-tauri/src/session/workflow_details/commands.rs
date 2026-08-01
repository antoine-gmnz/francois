//! §5: the three `francois:workflows:*` channels this feature owns, plus FR-9's
//! script read (the only one of the three with no state behind it).

use super::*;

use crate::ipc::{err, ok, IpcResult};
use tauri::{AppHandle, State};

// ---------- FR-9: the script the harness wrote ----------

/// FR-9: the source at `path`, capped at 200 KB. `None` ⇔ nothing readable is
/// there (⇒ `WORKFLOW_NO_SCRIPT`).
pub(crate) fn read_script(path: &Path) -> Option<WorkflowScript> {
    if !path.is_file() {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let truncated = bytes.len() > SCRIPT_CAP;
    let slice = if truncated {
        // A raw byte cut can land inside a multi-byte UTF-8 character; walk
        // back to the last full character so `from_utf8_lossy` never has to
        // paper over a split one with a replacement character.
        &bytes[..last_char_boundary(&bytes, SCRIPT_CAP)]
    } else {
        &bytes[..]
    };
    Some(WorkflowScript {
        path: path.to_string_lossy().to_string(),
        source: String::from_utf8_lossy(slice).to_string(),
        truncated,
    })
}

/// The largest UTF-8 char boundary at or before `cap`. A UTF-8 continuation
/// byte always has its top two bits `10`, so walking back over those (at most
/// 3 — the longest encoded char is 4 bytes) lands on the start of a char.
fn last_char_boundary(bytes: &[u8], cap: usize) -> usize {
    let mut i = cap.min(bytes.len());
    while i > 0 && bytes[i] & 0b1100_0000 == 0b1000_0000 {
        i -= 1;
    }
    i
}
// ---------- commands (§5) ----------

/// `francois:workflows:detail` (FR-7) — the current detail, starting the FR-6
/// watch if it is not already running.
#[tauri::command(async)]
pub fn workflows_detail(
    app: AppHandle,
    engine: State<'_, Engine>,
    run_id: String,
) -> IpcResult<WorkflowDetail> {
    match compute_detail(&engine, &run_id) {
        Ok(detail) => {
            // FR-6: a run that is ALREADY terminal gets no watch — this response
            // is its final scan, and everything it reports is frozen.
            if !run_is_terminal(&engine, &run_id) {
                start_workflow_watch(&app, &run_id, &detail.transcript_dir);
            }
            ok(detail)
        }
        Err((code, message)) => err(code, message),
    }
}

/// `francois:workflows:agent` (FR-8) — one agent's own transcript.
#[tauri::command(async)]
pub fn workflows_agent(
    engine: State<'_, Engine>,
    run_id: String,
    agent_id: String,
) -> IpcResult<WorkflowAgentTranscript> {
    let found = {
        let map = engine.sessions.lock().unwrap();
        find_run(&map, &run_id)
    };
    let Some((_, run, _)) = found else {
        return err("WORKFLOW_NOT_FOUND", "no such workflow run");
    };
    // No transcript directory ⇒ the scan has seen no agent at all, which is
    // exactly what WORKFLOW_AGENT_NOT_FOUND says (the only agent-level code this
    // channel declares).
    let Some(dir) = run.transcript_dir.clone() else {
        return err("WORKFLOW_AGENT_NOT_FOUND", "no such agent in this run");
    };
    let known = {
        let mut scans = engine.workflow_scans.lock().unwrap();
        let entry = scans.entry(run_id.clone()).or_default();
        scan_run_dir(Path::new(&dir), &mut entry.state);
        entry.state.knows_agent(&agent_id)
    };
    if !known {
        return err("WORKFLOW_AGENT_NOT_FOUND", "no such agent in this run");
    }
    ok(read_agent_transcript(Path::new(&dir), &agent_id))
}

/// `francois:workflows:script` (FR-9) — the source the harness wrote to disk.
#[tauri::command(async)]
pub fn workflows_script(engine: State<'_, Engine>, run_id: String) -> IpcResult<WorkflowScript> {
    let found = {
        let map = engine.sessions.lock().unwrap();
        find_run(&map, &run_id)
    };
    let Some((_, _, script)) = found else {
        return err("WORKFLOW_NOT_FOUND", "no such workflow run");
    };
    match script.as_deref().and_then(read_script) {
        Some(s) => ok(s),
        None => err("WORKFLOW_NO_SCRIPT", "this run has no readable script file"),
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    // ---------- FR-9: the script ----------

    #[test]
    fn read_script_returns_the_source_and_caps_it_at_200kb() {
        let d = RunDir::new();
        d.write("wf.js", "export const meta = { name: 'x' }\n");
        let s = read_script(&d.path().join("wf.js")).expect("readable");
        assert_eq!(s.source, "export const meta = { name: 'x' }\n");
        assert!(!s.truncated);
        assert!(s.path.ends_with("wf.js"));

        d.write("big.js", &"z".repeat(SCRIPT_CAP + 100));
        let big = read_script(&d.path().join("big.js")).unwrap();
        assert_eq!(big.source.len(), SCRIPT_CAP);
        assert!(big.truncated);

        assert!(read_script(&d.path().join("nope.js")).is_none());
    }

    #[test]
    fn read_script_does_not_split_a_multi_byte_char_at_the_cap_boundary() {
        // a 3-byte char (€) placed so it straddles the SCRIPT_CAP byte offset —
        // a raw byte slice would land inside it and `from_utf8_lossy` would
        // silently substitute a replacement character.
        let d = RunDir::new();
        let mut body = "a".repeat(SCRIPT_CAP - 1);
        body.push('€');
        body.push_str(&"b".repeat(50));
        d.write("split.js", &body);

        let s = read_script(&d.path().join("split.js")).unwrap();
        assert!(s.truncated);
        // the whole char is dropped rather than split — no replacement char,
        // and the cut lands one byte short of SCRIPT_CAP rather than exactly
        // on it.
        assert_eq!(s.source, "a".repeat(SCRIPT_CAP - 1));
        assert!(!s.source.contains('\u{FFFD}'));
    }
}
