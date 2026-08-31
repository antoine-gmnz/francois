//! FR-3/FR-4/FR-22: the scan state projected onto the contract's
//! `WorkflowDetail`, and the engine-side resolution of a run id (FR-7).
//!
//! Every clock-dependent value the tab shows (elapsed, bar extents) is derived
//! in the frontend — what is computed here is only what disk and the attributed
//! ask set can say.

use super::*;
use crate::ipc::{AppError, ErrorCode};

// ---------- FR-3/FR-4/FR-22: the detail ----------

/// FR-3: the scan state projected onto the contract's `WorkflowDetail`, for the
/// run as the panel currently knows it. Pure — every clock-dependent value the
/// tab shows (elapsed, bar extents) is derived in the frontend.
pub(crate) fn build_detail(
    run: &WorkflowRun,
    session_id: &str,
    transcript_dir: &str,
    has_script: bool,
    state: &ScanState,
    asks: &[WorkflowPendingAsk],
) -> WorkflowDetail {
    let run_terminal = run.status != "running";
    let mut total = WorkflowTokens::default();
    let agents: Vec<WorkflowAgentInfo> = state
        .agent_ids()
        .into_iter()
        .map(|id| {
            let agg = state.aggs.get(&id).cloned().unwrap_or_default();
            let meta = state.metas.get(&id).cloned().unwrap_or_default();
            let result = state.results.get(&id).cloned();
            // FR-4: three-valued from disk — the journal has no failure event, so
            // a dead agent is a `started` with no `result`, never an error.
            let mut status = if result.is_some() {
                "done"
            } else if run_terminal {
                "stopped"
            } else {
                "running"
            };
            // FR-22: `waiting` is imposed by an attributed ask and overrides
            // `running` ONLY.
            if status == "running" && asks.iter().any(|a| a.agent_id.as_deref() == Some(&id)) {
                status = "waiting";
            }
            total.add(&agg.tokens);
            WorkflowAgentInfo {
                agent_id: id,
                agent_type: meta
                    .agent_type
                    .unwrap_or_else(|| "workflow-subagent".to_string()),
                model: meta.model,
                // the timer freezes only once the agent has stopped moving
                last_at: (status == "done" || status == "stopped")
                    .then_some(agg.last_at)
                    .flatten(),
                status: status.to_string(),
                started_at: agg.started_at.unwrap_or(0),
                prompt: agg.prompt.unwrap_or_default(),
                tokens: agg.tokens,
                result,
            }
        })
        .collect();
    WorkflowDetail {
        id: run.id.clone(),
        session_id: session_id.to_string(),
        transcript_dir: transcript_dir.to_string(),
        has_script,
        agents,
        tokens: total,
        pending_asks: asks.to_vec(),
    }
}
// ---------- resolving a run (§5) ----------

/// `(sessionId, run, scriptPath)` for a run id, across every live session. Run
/// ids are uuids minted by the core, so at most one session can own one.
pub(crate) fn find_run(
    map: &HashMap<String, Session>,
    run_id: &str,
) -> Option<(String, WorkflowRun, Option<PathBuf>)> {
    map.values().find_map(|s| {
        s.workflows.get(run_id).map(|run| {
            (
                s.id.clone(),
                run.clone(),
                s.workflow_scripts.get(run_id).cloned(),
            )
        })
    })
}

/// FR-7: the current detail of a run, rescanning (FR-5) first. `Err` carries the
/// contract's error code.
pub fn compute_detail(engine: &Engine, run_id: &str) -> Result<WorkflowDetail, AppError> {
    let found = {
        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        find_run(&map, run_id)
    };
    let Some((session_id, run, script)) = found else {
        return Err(AppError::new(
            ErrorCode::WorkflowNotFound,
            "no such workflow run",
        ));
    };
    let Some(dir) = run.transcript_dir.clone() else {
        return Err(AppError::new(
            ErrorCode::WorkflowNoTranscript,
            "this run reported no transcript directory",
        ));
    };
    let asks = engine
        .workflow_asks
        .lock()
        .unwrap()
        .get(run_id)
        .cloned()
        .unwrap_or_default();
    let has_script = script.map(|p| p.is_file()).unwrap_or(false);
    let mut scans = engine.workflow_scans.lock().unwrap();
    let entry = scans.entry(run_id.to_string()).or_default();
    scan_run_dir(Path::new(&dir), &mut entry.state);
    Ok(build_detail(
        &run,
        &session_id,
        &dir,
        has_script,
        &entry.state,
        &asks,
    ))
}

/// FR-6: is this run past its last flush? A run that no longer exists counts as
/// terminal — whatever was watching it has nothing left to report.
pub fn run_is_terminal(engine: &Engine, run_id: &str) -> bool {
    let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
    find_run(&map, run_id)
        .map(|(_, run, _)| run.status != "running")
        .unwrap_or(true)
}

/// FR-20 rung 2's input: runId → the agentIds each run's scan has seen.
pub fn seen_agents(engine: &Engine) -> HashMap<String, Vec<String>> {
    engine
        .workflow_scans
        .lock()
        .unwrap()
        .iter()
        .map(|(run_id, entry)| (run_id.clone(), entry.state.agent_ids()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use crate::session::testutil::*;

    // ---------- FR-4: status ----------

    #[test]
    fn an_unfinished_agent_is_running_while_the_run_is_and_stopped_once_it_is_terminal() {
        let d = fixture();
        let running = detail_of(&d, &running_run(), &[]);
        assert_eq!(running.agents[0].status, "done"); // a1 has a result line
        assert_eq!(running.agents[1].status, "running");
        assert_eq!(running.agents[1].last_at, None); // absent while running

        let stopped = detail_of(&d, &terminal_run(), &[]);
        assert_eq!(stopped.agents[0].status, "done");
        assert_eq!(stopped.agents[1].status, "stopped"); // never called an error
        assert_eq!(stopped.agents[1].last_at, Some(1_785_492_030_000));
    }

    #[test]
    fn an_attributed_ask_makes_its_agent_waiting_and_nothing_else() {
        // FR-22: `waiting` overrides `running` ONLY.
        let d = fixture();
        let asks = vec![WorkflowPendingAsk {
            block_id: "b1".into(),
            kind: "permission".into(),
            agent_id: Some("a2".into()),
            tool_name: Some("Bash".into()),
            confidence: "exact".into(),
        }];
        let detail = detail_of(&d, &running_run(), &asks);
        assert_eq!(detail.agents[1].status, "waiting");
        assert_eq!(detail.pending_asks, asks);

        // a `done` agent is never flipped to waiting
        let on_done = vec![WorkflowPendingAsk {
            agent_id: Some("a1".into()),
            ..asks[0].clone()
        }];
        assert_eq!(
            detail_of(&d, &running_run(), &on_done).agents[0].status,
            "done"
        );
        // and once the ask is gone the disk-derived status is restored
        assert_eq!(
            detail_of(&d, &running_run(), &[]).agents[1].status,
            "running"
        );
    }

    // ---------- FR-7: resolving a run off the engine ----------

    /// A one-session engine whose `run-1` points at `dir` and whose `run-2` has
    /// no transcript directory at all.
    fn detail_engine(dir: &RunDir) -> Engine {
        let mut s = test_session();
        mint_workflow(&mut s, "s1", "run-1", "toolu_w", 1_000);
        mint_workflow(&mut s, "s1", "run-2", "toolu_x", 1_000);
        s.workflows.get_mut("run-1").unwrap().transcript_dir =
            Some(dir.path().to_string_lossy().to_string());
        test_engine_with(s)
    }

    #[test]
    fn compute_detail_reads_the_run_and_keeps_its_scan_state_for_the_next_call() {
        let d = fixture();
        let engine = detail_engine(&d);
        let detail = compute_detail(&engine, "run-1").expect("resolves");
        assert_eq!(detail.agents.len(), 2);
        assert_eq!(detail.transcript_dir, d.path().to_string_lossy());
        assert!(!detail.has_script); // no `Script file:` was ever resolved
        assert_eq!(detail.tokens.input, 30);

        // FR-5: the state lives on the Engine, so the SECOND call tails the file
        // instead of re-reading it — and totals the same as a full re-read would.
        d.append(
            "agent-a2.jsonl",
            &assistant_line("2026-07-31T10:02:00.000Z", "more", 1, 1),
        );
        assert_eq!(compute_detail(&engine, "run-1").unwrap().tokens.input, 31);
        // FR-20 rung 2 reads its candidate agent ids out of that same state
        assert_eq!(
            seen_agents(&engine).get("run-1").map(|ids| ids.len()),
            Some(2)
        );
    }

    #[test]
    fn compute_detail_reports_the_two_contract_error_codes() {
        // FR-7: an unknown run id, and a run that never named a directory.
        let d = fixture();
        let engine = detail_engine(&d);
        assert_eq!(
            compute_detail(&engine, "nope").unwrap_err().code,
            ErrorCode::WorkflowNotFound
        );
        assert_eq!(
            compute_detail(&engine, "run-2").unwrap_err().code,
            ErrorCode::WorkflowNoTranscript
        );
    }

    #[test]
    fn an_attributed_ask_reaches_the_detail_and_leaves_with_the_ask() {
        // FR-22/FR-24 end to end over the engine's registries: the ask rides on
        // `pendingAsks`, its agent reports `waiting`, and dropping it restores
        // the disk-derived status.
        let d = fixture();
        let engine = detail_engine(&d);
        {
            let mut asks = engine.workflow_asks.lock().unwrap();
            push_ask(&mut asks, "run-1", ask("b1", Some("a2")));
        }
        let blocked = compute_detail(&engine, "run-1").unwrap();
        assert_eq!(blocked.pending_asks.len(), 1);
        assert_eq!(blocked.pending_asks[0].block_id, "b1");
        assert_eq!(blocked.agents[1].status, "waiting");

        {
            let mut asks = engine.workflow_asks.lock().unwrap();
            assert_eq!(drop_ask(&mut asks, "b1"), Some(("run-1".into(), 0)));
        }
        let freed = compute_detail(&engine, "run-1").unwrap();
        assert!(freed.pending_asks.is_empty());
        assert_eq!(freed.agents[1].status, "running");
    }
}
