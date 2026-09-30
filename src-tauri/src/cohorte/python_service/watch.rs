//! Native durable events plus periodic request and run reconciliation.
use super::*;
fn wire_event(root: &str, raw: &Value) -> Option<CohorteEvent> {
    let entry = log_entry(raw)?;
    let header = EventHeader {
        project_root: root.into(),
        run_id: entry.run_id,
        event_id: raw["event_id"].as_str().unwrap_or("").into(),
        sequence: entry.sequence,
        sub: 0,
        durability: "durable".into(),
        at: entry.at,
        source: "cohorte/1".into(),
        severity: entry.severity,
        summary: entry.summary,
        phase: None,
        agent: None,
        causation_id: None,
    };
    if raw["type"] == "run.state_changed" {
        let data = &raw["data"];
        let payload = json!({"from":data["from"]["status"],"to":data["to"]["status"],"reason":super::super::sanitize::summary(data["cause"].as_str().unwrap_or("native transition")),"actor":{"kind":"engine","id":"cohorte"}});
        if let Some(Ok(event)) =
            CohorteEvent::from_parts("run.state.changed", header.clone(), payload)
        {
            return Some(event);
        }
    }
    if let Some(Ok(event)) =
        CohorteEvent::from_parts(&entry.type_, header.clone(), raw["data"].clone())
    {
        return Some(event);
    }
    Some(CohorteEvent::Unknown(UnknownEvent {
        header,
        cohorte_type: entry.type_,
        malformed: false,
    }))
}

fn process_event(
    state: &PythonState,
    app: &AppHandle,
    root: &str,
    raw: &Value,
    gates: &mut HashMap<String, String>,
) -> Result<(), AppError> {
    let seq = raw["seq"]
        .as_u64()
        .ok_or_else(|| bad("Cohorte event has no sequence"))?;
    if seq <= cursor(state, root) {
        return Ok(());
    }
    let run_id = raw["run_id"].as_str();
    let run = if let Some(id) = run_id {
        {
            let mut run = get_run(&mut client()?, root, id, seq)?;
            run.host.alive = state.workers.alive(id);
            Some(run)
        }
    } else {
        None
    };
    if let Some(event) = wire_event(root, raw) {
        emit(app, &event);
    }
    if let Some(run) = run {
        let next_gate = run.gate.as_ref().map(|g| g.request.approval_id.clone());
        if let (Some(gate), false) = (
            run.gate.as_ref(),
            gates.get(&run.run_id) == next_gate.as_ref(),
        ) {
            emit(
                app,
                &CohorteEvent::GateOpened(super::super::catalogue::GateOpened {
                    project_root: root.into(),
                    gate: Box::new(gate.clone()),
                }),
            );
        }
        if let Some(previous) = gates.get(&run.run_id) {
            if next_gate.as_ref() != Some(previous) {
                emit(
                    app,
                    &CohorteEvent::GateResolved(super::super::catalogue::GateResolved {
                        project_root: root.into(),
                        run_id: run.run_id.clone(),
                        approval_id: previous.clone(),
                        decision: "unknown".into(),
                        actor: None,
                    }),
                );
            }
        }
        if let Some(gate) = next_gate {
            gates.insert(run.run_id.clone(), gate);
        } else {
            gates.remove(&run.run_id);
        }
        emit(
            app,
            &CohorteEvent::RunUpdated(RunUpdated { run: Box::new(run) }),
        );
    }
    state
        .cursors
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(root.into(), seq);
    Ok(())
}

fn refresh(
    state: &PythonState,
    app: &AppHandle,
    root: &str,
    gates: &mut HashMap<String, String>,
    known: &mut std::collections::HashSet<String>,
) -> Result<(), AppError> {
    let mut snapshot = client()?;
    let current = runs(&mut snapshot, root, cursor(state, root))?;
    let next = current
        .iter()
        .map(|run| run.run_id.clone())
        .collect::<std::collections::HashSet<_>>();
    for removed in known.difference(&next) {
        gates.remove(removed);
        emit(
            app,
            &CohorteEvent::RunRemoved(super::super::catalogue::RunRemoved {
                project_root: root.into(),
                run_id: removed.clone(),
            }),
        );
    }
    for mut run in current {
        run.host.alive = state.workers.alive(&run.run_id);
        if run.last_error.is_none() {
            if let Some(error) = state.workers.failure(&run.run_id) {
                run.last_error = Some(crate::cohorte::ErrorInfo {
                    code: format!("{:?}", error.code),
                    class: None,
                    message: error.message,
                    remediation: error
                        .detail
                        .as_ref()
                        .and_then(|detail| detail["remediation"].as_str())
                        .map(String::from),
                    retryable: error
                        .detail
                        .as_ref()
                        .and_then(|detail| detail["retryable"].as_bool()),
                });
            }
        }
        let next_gate = run
            .gate
            .as_ref()
            .map(|gate| gate.request.approval_id.clone());
        if gates.get(&run.run_id) != next_gate.as_ref() {
            if let Some(previous) = gates.remove(&run.run_id) {
                emit(
                    app,
                    &CohorteEvent::GateResolved(super::super::catalogue::GateResolved {
                        project_root: root.into(),
                        run_id: run.run_id.clone(),
                        approval_id: previous,
                        decision: "unknown".into(),
                        actor: None,
                    }),
                );
            }
            if let Some(gate) = &run.gate {
                gates.insert(run.run_id.clone(), gate.request.approval_id.clone());
                emit(
                    app,
                    &CohorteEvent::GateOpened(super::super::catalogue::GateOpened {
                        project_root: root.into(),
                        gate: Box::new(gate.clone()),
                    }),
                );
            }
        }
        emit(
            app,
            &CohorteEvent::RunUpdated(RunUpdated { run: Box::new(run) }),
        );
    }
    *known = next;
    emit(
        app,
        &CohorteEvent::DetectionChanged(DetectionChanged {
            detection: detected(&mut snapshot, root)?,
        }),
    );
    Ok(())
}
fn database_stamp(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        Some(format!("{:?}", metadata.created().ok()?))
    }
}
pub(super) fn watch_loop(
    state: Arc<PythonState>,
    app: AppHandle,
    root: String,
    active: Arc<AtomicBool>,
) {
    let mut gates = HashMap::new();
    let mut known = std::collections::HashSet::new();
    let db = execution::actual_data_dir(&root)
        .ok()
        .map(|dir| Path::new(&dir).join("cohorte.sqlite3"));
    let mut stamp = db.as_ref().and_then(|path| database_stamp(path));
    while active.load(Ordering::Relaxed) {
        let result = (|| -> Result<(), AppError> {
            let mut connection = client()?;
            let registered = project(&mut connection, &root)?;
            refresh(&state, &app, &root, &mut gates, &mut known)?;
            let subscribed = connection.call(
                "events.subscribe",
                json!({"project_id":registered["id"],"after_seq":cursor(&state,&root)}),
            )?;
            for raw in items(&subscribed)? {
                process_event(&state, &app, &root, raw, &mut gates)?;
            }
            emit(
                &app,
                &CohorteEvent::WatchStatus(super::super::catalogue::WatchStatus {
                    project_root: root.clone(),
                    healthy: true,
                    error: None,
                    next_poll_in_ms: 5000,
                }),
            );
            let mut refreshed = std::time::Instant::now();
            while active.load(Ordering::Relaxed) {
                match connection.read_frame() {
                    Ok(frame) if frame["method"] == "events.notification" => {
                        process_event(&state, &app, &root, &frame["params"], &mut gates)?
                    }
                    Ok(_) => {}
                    Err(error) if error.code == ErrorCode::CohorteTimeout => {}
                    Err(error) => return Err(error),
                }
                if refreshed.elapsed() >= Duration::from_secs(2) {
                    let next = db.as_ref().and_then(|path| database_stamp(path));
                    if stamp != next {
                        stamp = next;
                        state
                            .cursors
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&root);
                        return Err(bad("Cohorte database changed; replay cursor reset"));
                    }
                    refresh(&state, &app, &root, &mut gates, &mut known)?;
                    refreshed = std::time::Instant::now();
                }
            }
            Ok(())
        })();
        if result.is_err() && active.load(Ordering::Relaxed) {
            emit(
                &app,
                &CohorteEvent::WatchStatus(super::super::catalogue::WatchStatus {
                    project_root: root.clone(),
                    healthy: false,
                    error: Some(super::super::catalogue::WatchError {
                        code: ErrorCode::CohorteCommandFailed,
                        message: "Cohorte service disconnected; replay will resume".into(),
                    }),
                    next_poll_in_ms: 1000,
                }),
            );
            thread::sleep(Duration::from_secs(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_state_transition_is_typed_and_failed_logs_are_safe() {
        let raw = json!({"run_id":"r","seq":7,"event_id":"e","type":"run.state_changed","occurred_at":"2026-01-01T00:00:00Z","data":{"from":{"stage":"checks","status":"running"},"to":{"stage":"checks","status":"failed"},"cause":"phase.checks.failed"}});
        assert!(matches!(
            wire_event("/project", &raw),
            Some(CohorteEvent::RunStateChanged(_))
        ));
        let entry = log_entry(&raw).unwrap();
        assert_eq!(entry.severity, "error");
        assert!(entry.summary.contains("failed"));
    }
}
