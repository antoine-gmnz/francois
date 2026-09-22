//! Shared fixtures for the cohorte tests: raw Cohorte envelopes (one per
//! catalogue type, shaped like dev.8's store dump), status documents, and two
//! injectable runners — a scripted fake and a real stub-script CLI.

use super::catalogue::*;
use super::cli::{Runner, SystemRunner};
use super::projection::RunProjection;
use super::wire::normalise;
use super::*;
use crate::github::gh::RoutedRun;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

pub(crate) const BASE_MS: u64 = 1_767_225_600_000; // 2026-01-01T00:00:00.000Z

pub(crate) fn iso(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

pub(crate) fn out(code: i32, stdout: &str) -> RoutedRun {
    RoutedRun {
        code,
        stdout: stdout.as_bytes().to_vec(),
        stderr: String::new(),
        spawn_failed: false,
        timed_out: false,
        capped: false,
    }
}

pub(crate) fn missing() -> RoutedRun {
    RoutedRun {
        code: -1,
        stdout: Vec::new(),
        stderr: "cohorte: failed to start".into(),
        spawn_failed: true,
        timed_out: false,
        capped: false,
    }
}

// ---------- runners ----------

/// Scripted runner: rules match `program args…` by prefix, first rule wins;
/// `git` falls through to the real runner (temp-repo tests), anything else
/// unmatched fails to spawn.
#[derive(Default)]
pub(crate) struct FakeRunner {
    always: Mutex<Vec<(String, RoutedRun)>>,
    calls: Mutex<Vec<String>>,
}

fn clone_run(r: &RoutedRun) -> RoutedRun {
    RoutedRun {
        code: r.code,
        stdout: r.stdout.clone(),
        stderr: r.stderr.clone(),
        spawn_failed: r.spawn_failed,
        timed_out: r.timed_out,
        capped: r.capped,
    }
}

impl FakeRunner {
    pub(crate) fn on(&self, prefix: &str, r: RoutedRun) -> &Self {
        self.always.lock().unwrap().push((prefix.into(), r));
        self
    }
    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    /// Calls whose line starts with `prefix`.
    pub(crate) fn count(&self, prefix: &str) -> usize {
        self.calls()
            .iter()
            .filter(|c| c.starts_with(prefix))
            .count()
    }
}

impl Runner for FakeRunner {
    fn run(
        &self,
        program: &str,
        dir: &str,
        args: &[String],
        timeout: Duration,
        cap: usize,
    ) -> RoutedRun {
        let line = format!("{program} {}", args.join(" "));
        self.calls.lock().unwrap().push(line.clone());
        if let Some((_, r)) = self
            .always
            .lock()
            .unwrap()
            .iter()
            .find(|(p, _)| line.starts_with(p.as_str()))
        {
            return clone_run(r);
        }
        if program == "git" {
            return SystemRunner.run(program, dir, args, timeout, cap);
        }
        missing()
    }
}

/// A real script standing in for `cohorte` (spawned through the real runner).
pub(crate) struct StubCli {
    dir: PathBuf,
    script: PathBuf,
}

impl Drop for StubCli {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl StubCli {
    fn new(unix: &str, windows: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("francois-cohorte-stub-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = if cfg!(windows) {
            let p = dir.join("cohorte.cmd");
            std::fs::write(&p, windows).unwrap();
            p
        } else {
            let p = dir.join("cohorte");
            std::fs::write(&p, unix).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            p
        };
        StubCli { dir, script }
    }
    pub(crate) fn printing(text: &str) -> Self {
        Self::new(
            &format!("#!/bin/sh\necho {text}\n"),
            &format!("@echo off\r\necho {text}\r\n"),
        )
    }
    pub(crate) fn sleeping() -> Self {
        Self::new(
            "#!/bin/sh\nsleep 5\n",
            "@echo off\r\nping -n 3 127.0.0.1 >nul 2>nul\r\n",
        )
    }
    pub(crate) fn dir(&self) -> String {
        self.dir.to_string_lossy().into_owned()
    }
}

impl Runner for StubCli {
    fn run(
        &self,
        program: &str,
        dir: &str,
        args: &[String],
        timeout: Duration,
        cap: usize,
    ) -> RoutedRun {
        let program = if program == "cohorte" {
            self.script.to_string_lossy().into_owned()
        } else {
            program.to_string()
        };
        SystemRunner.run(&program, dir, args, timeout, cap)
    }
}

// ---------- envelopes ----------

pub(crate) fn envelope(seq: u64, sub: u64, ty: &str, payload: Value) -> Value {
    json!({
        "protocolVersion": "1.0",
        "eventId": format!("evt_{seq:04}{sub:04}"),
        "sequence": seq,
        "sub": sub,
        "durability": if sub == 0 { "durable" } else { "ephemeral" },
        "timestamp": iso(BASE_MS + seq * 1000 + sub),
        "runId": "run_a",
        "type": ty,
        "source": "cohorte",
        "summary": ty,
        "severity": "info",
        "payload": payload,
        "redactions": []
    })
}

fn agent(role: &str, surface: &str) -> Value {
    json!({ "agentId": format!("agt_{role}_{surface}"), "role": role, "surface": surface, "incarnation": 1, "attempt": 1 })
}
fn phase_ref(state: &str) -> Value {
    json!({ "phaseRunId": format!("phs_{state}_1"), "state": state, "iteration": 1 })
}
fn err() -> Value {
    json!({ "code": "runtime/crashed", "class": "runtime", "message": "boom", "impact": "i", "retryable": true, "remediation": "retry" })
}
fn stop() -> Value {
    json!({ "reason": "review-clean", "detail": "d", "resumable": false })
}
fn tokens() -> Value {
    json!({ "input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0, "total": 3 })
}
fn quota() -> Value {
    json!({ "known": true, "source": "response-headers", "provider": "anthropic",
        "windows": [{ "name": "5h", "usedPercent": 10, "resetsAt": "2026-01-01T05:00:00.000Z" }],
        "observedAt": "2026-01-01T00:00:00.000Z" })
}
fn artifact() -> Value {
    json!({ "artifactId": "art_1", "kind": "report", "path": "reports/review.json", "sha256": "x", "bytes": 10 })
}
fn lock() -> Value {
    json!({ "scope": "run", "key": "k", "mode": "exclusive", "owner": "o", "fencingToken": 1 })
}
fn actor() -> Value {
    json!({ "kind": "human", "id": "me", "transport": "cli" })
}
fn touch() -> Value {
    json!({ "path": "src/a.ts", "op": "modify", "bytes": 3 })
}
fn check() -> Value {
    json!({ "name": "test", "status": "passed", "argv": ["npm", "test"], "exitCode": 0, "durationMs": 1200, "treeDigest": "t" })
}
fn sandbox() -> Value {
    json!({ "level": "L0-process", "backend": "none", "filesystem": "advisory", "network": "unenforced" })
}
fn model() -> Value {
    json!({ "provider": "anthropic", "model": "sonnet" })
}

pub(crate) fn raw_approval(apr: &str, kind: &str, options: &[&str], phase: &str) -> Value {
    let mut p = json!({
        "approvalId": apr, "kind": kind, "phase": phase_ref(phase), "agent": agent("reviewer", "api"),
        "affectedPaths": [], "preview": { "kind": "text", "text": "Ship it?" },
        "args": { "sealed": true },
        "ruleId": "ship", "reason": "ship gate",
        "asks": [{ "stage": "approval", "ruleId": "ship", "reason": "r" }],
        "allowedDecisions": ["allow-once", "deny"], "unattended": "wait",
        "cli": format!("cohorte approve {apr}")
    });
    if !options.is_empty() {
        p["options"] = json!(options);
    }
    p
}

/// A raw payload for every catalogue type (dev.8 shapes).
pub(crate) fn raw_payload(ty: &str) -> Value {
    let tc = "tc_1_1";
    match ty {
        "pipeline.started" => json!({ "profile": "feature", "tableVersion": 1,
            "spec": { "id": "auth-retry", "sha256": "s", "kind": "feature" }, "snapshotDigest": "abcdef123",
            "runtime": { "id": "pi", "version": "1.0", "pinDigest": "pin123" }, "plan": { "unattended": false },
            "base": { "branch": "main", "sha": "b0" }, "integrationBranch": "cohorte/auth-retry",
            "cohorteVersion": "3.0.0-dev.8", "hostId": "h" }),
        "pipeline.completed" => {
            json!({ "stop": stop(), "integration": { "branch": "cohorte/auth-retry", "headSha": "h1", "treeDigest": "t" },
            "totals": { "usage": {}, "tokens": tokens(), "monetaryCost": "not_applicable", "fixRounds": 1, "durationMs": 1000 } })
        }
        "pipeline.failed" => {
            json!({ "state": "FAILED", "error": err(), "stop": stop(), "checkpointSequence": 3 })
        }
        "run.state.changed" => {
            json!({ "transitionId": "t", "defId": "T1", "tableVersion": 1, "from": "BUILD", "to": "TEST",
            "reason": "phase-passed", "actor": actor(), "guards": [], "idempotencyKey": "k" })
        }
        "run.paused" => json!({ "parkedAgents": ["agt_implementer_api"], "inFlightEffects": [] }),
        "run.resumed" => json!({ "mode": "unpause", "report": { "takeover": false } }),
        "run.cancelled" => json!({ "reason": "r", "cancelledAgents": [], "worktreesKept": false }),
        "run.host.attached" => {
            json!({ "hostId": "h", "pid": 42, "cohorteVersion": "3.0.0", "fencingToken": 1, "takeover": false })
        }
        "run.host.detached" => json!({ "hostId": "h", "cause": "exit" }),
        "phase.started" => {
            json!({ "phase": phase_ref("BUILD"), "contractId": "c", "contractVersion": 1,
            "planned": [{ "agentId": "agt_implementer_api", "role": "implementer", "surface": "api" }], "budget": {} })
        }
        "phase.completed" => {
            json!({ "phase": phase_ref("BUILD"), "outcome": "passed", "outputs": [artifact()], "checks": [check()], "durationMs": 100 })
        }
        "check.started" => json!({ "name": "test", "argv": ["npm", "test"], "slot": "api" }),
        "check.completed" => check(),
        "error" => json!({ "error": err(), "fatal": false }),
        "checkpoint.created" => {
            json!({ "atSequence": 3, "snapshotSha256": "s", "chainHash": "c", "chainMac": "m", "cause": "interval" })
        }
        "agent.declared" => {
            json!({ "agent": agent("implementer", "api"), "owner": "api", "ownedPaths": ["src/**"], "grantsDigest": "g",
            "requestedModel": model(), "thinking": "low", "routingReason": "default", "budget": {} })
        }
        "agent.spawned" => json!({ "agent": agent("implementer", "api"),
            "worktree": { "slot": "api", "path": "/r/../orbit-auth-retry", "branch": "cohorte/auth-retry/api", "baseSha": "b0" },
            "tools": ["bash"], "systemPromptSha256": "s", "effectiveSystemPromptSha256": "s", "authMode": "subscription", "isolation": sandbox() }),
        "agent.started" => json!({ "agent": agent("implementer", "api"), "taskSha256": "t" }),
        "agent.state.changed" => {
            json!({ "agent": agent("implementer", "api"), "from": "running", "to": "waiting", "reason": "tool-wait", "attemptConsumed": false })
        }
        "agent.completed" => {
            json!({ "agent": agent("implementer", "api"), "status": "completed", "summary": "done", "confidence": 0.9,
            "output": artifact(), "artifacts": [artifact()], "findings": 0, "questions": [], "usage": { "tokens": 10 } })
        }
        "agent.failed" => {
            json!({ "agent": agent("implementer", "api"), "error": err(), "willRetry": true, "nextIncarnation": 2 })
        }
        "agent.turn.started" => json!({ "turn": 1 }),
        "agent.turn.completed" => json!({ "turn": 1, "toolCalls": 2 }),
        "agent.message.started" => json!({ "messageId": "m1", "role": "assistant" }),
        "agent.message.delta" => {
            json!({ "messageId": "m1", "channel": "text", "contentIndex": 0, "delta": "hi" })
        }
        "agent.message.completed" => {
            json!({ "messageId": "m1", "role": "assistant", "preview": "hi", "textSha256": "s", "bytes": 2, "stop": "stop" })
        }
        "agent.message.accepted" => {
            json!({ "agent": agent("implementer", "api"), "messageId": "m2", "delivery": "steer" })
        }
        "runtime.warning" => json!({ "code": "stale-auth", "message": "m" }),
        "model.requested" => {
            json!({ "requestId": "r1", "model": model(), "expectedAuthMode": "subscription", "attempt": 1 })
        }
        "model.responded" => json!({ "requestId": "r1", "requestedModel": model(),
            "effectiveModel": { "provider": "anthropic", "model": "sonnet", "api": "x" }, "authMode": "subscription", "authSource": "oauth",
            "status": "ok", "httpStatus": 200, "durationMs": 900, "tokens": tokens(),
            "monetaryCost": { "currency": "USD", "amount": 0.5, "basis": "catalogue", "priceCatalogVersion": "1" },
            "quota": quota(), "attempt": 1 }),
        "context.built" => {
            json!({ "agent": agent("implementer", "api"), "manifestSha256": "m", "tokenEstimate": 100, "tokenLimit": 1000,
            "entries": [{ "id": "a" }, { "id": "b" }], "reductions": [], "exclusions": [{ "pattern": ".env", "reason": "secret" }], "manifest": artifact() })
        }
        "escalation.applied" => json!({ "agent": agent("implementer", "api"),
            "step": { "kind": "model-tier", "role": "implementer", "from": "fast", "to": "coding" }, "because": "b" }),
        "tool.requested" => {
            json!({ "toolCallId": tc, "tool": "bash", "args": { "cmd": "ls" }, "argsSha256": "s" })
        }
        "tool.denied" => {
            json!({ "toolCallId": tc, "tool": "bash", "stage": "command", "ruleId": "r", "reason": "no",
            "overridable": true, "evaluatedRules": [], "approvalId": "apr_9" })
        }
        "tool.rejected" => json!({ "tool": "nope", "cause": "unknown-tool", "message": "m" }),
        "tool.started" => {
            json!({ "toolCallId": tc, "tool": "bash", "effectId": "eff_1", "decision": "allow", "ruleId": "r",
            "normalizedArgs": {}, "replayClass": "idempotent", "sandbox": sandbox() })
        }
        "tool.progress" => json!({ "toolCallId": tc, "text": "..." }),
        "tool.completed" => {
            json!({ "toolCallId": tc, "tool": "bash", "effectId": "eff_1", "isError": false, "exitCode": 0,
            "timedOut": false, "durationMs": 10, "waitedMs": 1,
            "output": { "sha256": "s", "bytes": 3, "truncated": false, "preview": "ok" }, "filesTouched": [touch()], "replayed": false })
        }
        "file.read" => json!({ "toolCallId": tc, "file": { "path": "src/a.ts", "op": "read" } }),
        "file.written" => {
            json!({ "toolCallId": tc, "file": touch(), "diffStat": { "added": 10, "removed": 2 } })
        }
        "file.changed" => {
            json!({ "slot": "api", "files": [touch()], "detectedBy": "post-command-scan" })
        }
        "review.started" => {
            json!({ "phase": phase_ref("REVIEW"), "reviewRef": { "ref": "r", "sha": "s", "treeDigest": "t" },
            "surfaces": ["api"], "reviewers": ["agt_reviewer_api"] })
        }
        "review.finding" => raw_finding(Some("fnd_1"), "major", "a"),
        "review.completed" => {
            json!({ "verdict": "findings", "blocking": 1, "blockingItems": ["fnd_1"], "fingerprint": "",
            "unreviewed": [], "counts": { "critical": 0, "major": 1, "minor": 0, "info": 0 }, "clean": false })
        }
        "review.approved" => json!({ "reviewRef": { "ref": "r", "sha": "s", "treeDigest": "t" },
            "waivers": [{ "findingId": "fnd_1", "approvalId": "apr_1" }] }),
        "approval.requested" => raw_approval("apr_1", "ship", &[], "SHIP"),
        "approval.resolved" => {
            json!({ "approvalId": "apr_1", "decision": "allow-once", "actor": actor(), "commandId": "cmd_1" })
        }
        "budget.updated" => {
            json!({ "scope": { "level": "run", "id": "run_a" }, "consumed": { "tokens": 5 }, "limit": { "tokens": 10 }, "threshold": 50 })
        }
        "budget.exceeded" => {
            json!({ "scope": { "level": "run", "id": "run_a" }, "counter": "tokens", "limit": 10, "consumed": 11 })
        }
        "quota.updated" => {
            json!({ "provider": "anthropic", "authMode": "subscription", "quota": quota() })
        }
        "auth.required" => {
            json!({ "provider": "anthropic", "cause": "expired", "cli": "cohorte auth login" })
        }
        "retry.scheduled" => {
            json!({ "target": { "kind": "agent", "id": "agt_implementer_api" }, "attempt": 1, "maxAttempts": 3,
            "delayMs": 1000, "cause": err() })
        }
        "command.accepted" => {
            json!({ "commandId": "cmd_1", "type": "approve", "actor": actor(), "authVerified": true, "scheme": "hmac" })
        }
        "command.completed" => json!({ "commandId": "cmd_1", "type": "approve", "result": {} }),
        "command.rejected" => json!({ "commandId": "cmd_1", "type": "approve", "error": err() }),
        "git.worktree.created" => {
            json!({ "slot": "api", "path": "/r/../orbit-auth-retry", "branch": "cohorte/auth-retry/api", "baseSha": "b0", "effectId": "eff_2" })
        }
        "git.worktree.provisioned" => {
            json!({ "slot": "api", "lockfileSha256": "l", "network": false, "effectId": "eff_3" })
        }
        "git.worktree.quarantined" => {
            json!({ "slot": "api", "resetTo": "b0", "patch": artifact(), "compensated": [] })
        }
        "git.worktree.removed" => json!({ "slot": "api", "path": "/r/../orbit-auth-retry" }),
        "git.commit.created" => {
            json!({ "slot": "api", "branch": "b", "sha": "c1", "kind": "result", "treeDigest": "t", "paths": ["src/a.ts"], "effectId": "eff_4" })
        }
        "git.merge.completed" => {
            json!({ "from": "b", "into": "cohorte/auth-retry", "mergeSha": "m1", "treeDigest": "t", "effectId": "eff_5" })
        }
        "git.merge.conflicted" => {
            json!({ "from": "b", "into": "cohorte/auth-retry", "files": ["a"] })
        }
        "repo.change.detected" => {
            json!({ "slot": "api", "expected": "x", "actual": "y", "files": [touch()] })
        }
        "lock.acquired" | "lock.released" | "lock.stolen" => lock(),
        "snapshot" => json!({ "document": fixture_snapshot_doc("run_a"), "lastSequence": 5 }),
        "heartbeat" => json!({ "hostAlive": true, "lastSequence": 5 }),
        other => panic!("no fixture for {other}"),
    }
}

fn ephemeral(ty: &str) -> bool {
    matches!(
        ty,
        "agent.turn.started"
            | "agent.message.started"
            | "agent.message.delta"
            | "tool.progress"
            | "snapshot"
            | "heartbeat"
    )
}

/// AC-1's fixture: one NDJSON envelope per catalogue type, in catalogue order.
pub(crate) fn all_envelopes() -> Vec<Value> {
    WIRE_EVENT_TYPES
        .iter()
        .enumerate()
        .map(|(i, ty)| envelope(i as u64 + 1, u64::from(ephemeral(ty)), ty, raw_payload(ty)))
        .collect()
}

pub(crate) fn all_wire_events() -> Vec<CohorteEvent> {
    all_envelopes()
        .iter()
        .map(|l| normalise("/r", l, 0).unwrap().event)
        .collect()
}

fn raw_finding(id: Option<&str>, severity: &str, actual: &str) -> Value {
    let mut f = json!({ "severity": severity, "kind": "quality", "rule": "bounded-retries",
        "location": { "file": "src/retry.ts", "line": 12 }, "expected": "e", "actual": actual,
        "confidence": 0.8, "scope": "in-scope" });
    if let Some(id) = id {
        f["id"] = json!(id);
    }
    json!({ "finding": f, "reviewer": agent("reviewer", "api"), "disposition": "kept" })
}

pub(crate) fn finding_envelope(seq: u64, id: Option<&str>, severity: &str, actual: &str) -> Value {
    envelope(seq, 0, "review.finding", raw_finding(id, severity, actual))
}

pub(crate) fn approval_envelope(seq: u64, apr: &str, kind: &str, options: &[&str]) -> Value {
    envelope(
        seq,
        0,
        "approval.requested",
        raw_approval(apr, kind, options, "REVIEW"),
    )
}

pub(crate) fn resolve_envelope(seq: u64, apr: &str, decision: &str) -> Value {
    envelope(
        seq,
        0,
        "approval.resolved",
        json!({ "approvalId": apr, "decision": decision, "actor": actor() }),
    )
}

/// A feature run up to REVIEW (seq 1..15): PREFLIGHT, BUILD (one implementer in
/// a worktree, a +10 −2 write), TEST, then REVIEW with a running reviewer.
pub(crate) fn feature_run_lines() -> Vec<Value> {
    let started = |seq, st: &str, planned: Value| {
        envelope(
            seq,
            0,
            "phase.started",
            json!({ "phase": phase_ref(st), "contractId": "c", "contractVersion": 1, "planned": planned, "budget": {} }),
        )
    };
    let done = |seq, st: &str| {
        envelope(
            seq,
            0,
            "phase.completed",
            json!({ "phase": phase_ref(st), "outcome": "passed", "outputs": [], "checks": [], "durationMs": 100 }),
        )
    };
    let mut state = raw_payload("run.state.changed");
    state["from"] = json!("TEST");
    state["to"] = json!("REVIEW");
    let mut rev_start = raw_payload("agent.started");
    rev_start["agent"] = agent("reviewer", "api");
    let mut rev_line = envelope(14, 0, "agent.started", rev_start);
    rev_line["phase"] = phase_ref("REVIEW");
    vec![
        envelope(1, 0, "pipeline.started", raw_payload("pipeline.started")),
        started(2, "PREFLIGHT", json!([])),
        done(3, "PREFLIGHT"),
        started(
            4,
            "BUILD",
            json!([{ "agentId": "agt_implementer_api", "role": "implementer", "surface": "api" }]),
        ),
        envelope(5, 0, "agent.spawned", raw_payload("agent.spawned")),
        envelope(6, 0, "agent.started", raw_payload("agent.started")),
        envelope(7, 0, "file.written", raw_payload("file.written")),
        envelope(8, 0, "agent.completed", raw_payload("agent.completed")),
        done(9, "BUILD"),
        started(10, "TEST", json!([])),
        done(11, "TEST"),
        envelope(12, 0, "run.state.changed", state),
        started(
            13,
            "REVIEW",
            json!([{ "agentId": "agt_reviewer_api", "role": "reviewer", "surface": "api" }]),
        ),
        rev_line,
        envelope(15, 0, "review.started", raw_payload("review.started")),
    ]
}

pub(crate) fn fold(lines: &[Value]) -> RunProjection {
    let mut p = RunProjection::new("/r", "run_a");
    for l in lines {
        p.apply(&normalise("/r", l, 0).unwrap().event);
    }
    p
}

// ---------- documents ----------

pub(crate) fn fixture_record(run_id: &str, state: &str) -> Value {
    json!({ "runId": run_id, "profile": "feature", "tableVersion": 1, "specId": "auth-retry", "specSha256": "s",
        "title": "", "state": state, "lastSequence": 12, "lastHash": "h", "version": 3,
        "snapshotDigest": "abcdef123", "plan": { "runtime": { "id": "pi", "version": "1.0" }, "unattended": false },
        "pinnedInstallDir": "/i", "baseBranch": "main", "baseSha": "b0", "integrationBranch": "cohorte/auth-retry",
        "hostPid": 7, "hostHeartbeatAt": iso(BASE_MS + 10_000), "cancelRequested": false, "pauseRequested": false,
        "schemaVersion": 1, "cohorteVersion": "3.0.0-dev.8", "purgeable": false,
        "startedAt": iso(BASE_MS), "updatedAt": iso(BASE_MS + 5_000) })
}

pub(crate) fn fixture_snapshot_doc(run_id: &str) -> Value {
    json!({ "documentVersion": 1, "protocolVersion": "1.0", "cohorteVersion": "3.0.0-dev.8",
        "generatedAt": iso(BASE_MS), "lastSequence": 5,
        "run": { "runId": run_id, "profile": "feature", "title": "Auth retry",
            "spec": { "id": "auth-retry", "kind": "feature", "sha256": "s" }, "state": "WAITING_APPROVAL",
            "status": "waiting-approval", "since": iso(BASE_MS + 4_000), "resumeTo": "REVIEW",
            "iteration": { "fixRounds": 0, "maxFixRounds": 3, "reviewRounds": 1 },
            "host": { "alive": true, "heartbeatAt": iso(BASE_MS + 4_000), "pid": 7 },
            "git": { "base": { "branch": "main", "sha": "b0" }, "integrationBranch": "cohorte/auth-retry" },
            "plan": { "runtime": { "id": "pi", "version": "1.0" }, "unattended": false },
            "snapshotDigest": "abcdef123", "startedAt": iso(BASE_MS) },
        "phases": [
            { "state": "PREFLIGHT", "label": "Preflight", "status": "completed", "runs": [] },
            { "state": "BUILD", "label": "Build", "status": "completed", "runs": [{ "phaseRunId": "phs_BUILD_1", "iteration": 1,
                "status": "completed", "startedAt": iso(BASE_MS + 1_000), "endedAt": iso(BASE_MS + 2_000), "outcome": "passed",
                "agents": [{ "agentId": "agt_implementer_api", "role": "implementer", "surface": "api", "label": "Implementer · api",
                    "status": "completed", "lifecycle": "completed", "attempt": 1, "incarnation": 1,
                    "model": { "requested": model() }, "worktree": "/r/../orbit-auth-retry", "usage": {} }],
                "checks": [] }] },
            { "state": "REVIEW", "label": "Review", "status": "waiting-approval", "runs": [] },
            { "state": "SHIP", "label": "Ship", "status": "pending", "runs": [] }
        ],
        "approvals": { "pending": [{ "approvalId": "apr_1", "kind": "ship", "what": "ship it", "since": iso(BASE_MS + 4_000), "cli": "cohorte approve apr_1" }], "resolved": 0 },
        "budgets": [], "usage": { "tokens": tokens(), "monetaryCost": "not_applicable", "byProvider": [] },
        "locks": [], "inDoubtEffects": [] })
}

// ---------- typed records ----------

pub(crate) fn header(seq: u64, sub: u64) -> EventHeader {
    EventHeader {
        project_root: "/r".into(),
        run_id: "run_a".into(),
        event_id: format!("evt_{seq}"),
        sequence: seq,
        sub,
        durability: "durable".into(),
        at: BASE_MS,
        source: "cohorte".into(),
        severity: "info".into(),
        summary: "s".into(),
        phase: None,
        agent: None,
        causation_id: None,
    }
}

pub(crate) fn sample_run() -> CohorteRun {
    fold(&feature_run_lines()).to_run(BASE_MS)
}

pub(crate) fn sample_detection() -> CohorteDetection {
    CohorteDetection {
        start_dir: "/r".into(),
        state: "detected".into(),
        root: Some("/r".into()),
        dir: Some("/r/.cohorte".into()),
        found_via: Some("walk-up".into()),
        has_project_file: true,
        state_backend: Some("sqlite".into()),
        root_branch: Some("main".into()),
        runtime: Some("pi".into()),
        cli: CliInfo {
            installed: true,
            version: Some("3.0.0-dev.8".into()),
            supported_range: SUPPORTED_RANGE.into(),
            compatible: true,
        },
        checked_at: BASE_MS,
    }
}

pub(crate) fn derived_events() -> Vec<CohorteEvent> {
    let mut lines = feature_run_lines();
    lines.push(finding_envelope(20, Some("fnd_1"), "major", "unbounded"));
    lines.push(approval_envelope(
        21,
        "apr_1",
        "review-leftovers",
        &["ship", "send to fix"],
    ));
    let run = fold(&lines).to_run(BASE_MS);
    let gate = run.gate.clone().unwrap();
    vec![
        CohorteEvent::DetectionChanged(DetectionChanged {
            detection: sample_detection(),
        }),
        CohorteEvent::RunUpdated(RunUpdated { run: Box::new(run) }),
        CohorteEvent::RunRemoved(RunRemoved {
            project_root: "/r".into(),
            run_id: "run_a".into(),
        }),
        CohorteEvent::GateOpened(GateOpened {
            project_root: "/r".into(),
            gate: Box::new(gate),
        }),
        CohorteEvent::GateResolved(GateResolved {
            project_root: "/r".into(),
            run_id: "run_a".into(),
            approval_id: "apr_1".into(),
            decision: "unknown".into(),
            actor: Some("human:me".into()),
        }),
        CohorteEvent::WatchStatus(WatchStatus {
            project_root: "/r".into(),
            healthy: true,
            error: None,
            next_poll_in_ms: 3000,
        }),
    ]
}

pub(crate) fn finding(id: &str, severity: &str) -> Finding {
    Finding {
        id: id.into(),
        severity: severity.into(),
        kind: "quality".into(),
        rule: "r".into(),
        title: "t".into(),
        expected: "e".into(),
        actual: "a".into(),
        file: None,
        line: None,
        end_line: None,
        symbol: None,
        confidence: 0.5,
        suggested_fix: None,
        scope: "in-scope".into(),
        disposition: "kept".into(),
        reviewer_agent_id: None,
        blocking: false,
        label: "minor".into(),
    }
}

pub(crate) fn phase(state: &str) -> Phase {
    Phase {
        state: state.into(),
        label: state.into(),
        status: "pending".into(),
        iteration: 0,
        started_at: None,
        ended_at: None,
        duration_ms: None,
        outcome: None,
        steps: vec![],
        checks: vec![],
    }
}

pub(crate) fn request(apr: &str, kind: &str, options: Option<Vec<&str>>) -> ApprovalRequest {
    ApprovalRequest {
        approval_id: apr.into(),
        kind: kind.into(),
        agent: None,
        phase: Some(PhaseRef {
            phase_run_id: "phs_SHIP_1".into(),
            state: "SHIP".into(),
            iteration: 1,
        }),
        tool: None,
        affected_paths: vec![],
        preview: ApprovalPreview {
            kind: "text".into(),
            text: "t".into(),
            truncated: false,
        },
        options: options.map(|o| o.into_iter().map(String::from).collect()),
        rule_id: "r".into(),
        reason: "why".into(),
        asks: vec![],
        allowed_decisions: vec!["allow-once".into(), "deny".into()],
        expires_at: None,
        unattended: "wait".into(),
        cli: format!("cohorte approve {apr}"),
    }
}
