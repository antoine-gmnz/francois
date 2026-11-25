//! token-viewer: the session's context window, broken down by what fills it
//! (specs/token-viewer.md FR-1..FR-9).
//!
//! The data is Claude Code's own `get_context_usage` stdio control request,
//! asked of a SEPARATE short-lived `claude -p [--resume <thread>]` child — the
//! per-turn child owns its stdin (stdio.rs) and is never touched here. The CLI
//! answers without a user message and without an API turn.
//!
//! Two halves:
//!  * pure — `parse_context_usage`, `match_reply`, `probe_args` and the
//!    cache/freshness decision `plan` — unit-tested against the real fixtures;
//!  * I/O — `run_probe` (spawn, write one line, read until the matching reply,
//!    bounded by a deadline) and `breakdown_in_engine`, which owns the
//!    single-flight slot and the write-back.
//!
//! Freshness (FR-4/FR-9) is a fingerprint rather than two timestamps: the
//! session's turn-end epoch (bumped at every turn end — `note_turn_ended`),
//! its model id and its Claude thread id, captured when the probe LAUNCHES. A
//! counter cannot collide inside one millisecond, and comparing the model and
//! thread directly covers a model switch and a `/clear` with no stamp sites.
//!
//! FR-7 single flight: a second caller while a probe runs WAITS for that
//! probe's outcome (bounded) — returning `breakdown: null` instead would
//! collide with the contract's meaning of null ("a turn is live").

use super::{status, AgentRuntime, Engine, Session};
use crate::ipc::{ok, AppError, ErrorCode, IpcResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, State};

/// FR-6: the probe's deadline.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// How much longer than the probe's own deadline a joining caller waits.
const JOIN_GRACE: Duration = Duration::from_secs(5);

const NOT_CLAUDE: &str = "Context breakdown is only available for Claude Code sessions.";
const TIMED_OUT: &str = "Timed out measuring context.";
const REFUSED: &str =
    "This Claude Code version cannot report a context breakdown \u{2014} update Claude Code.";
const UNEXPECTED: &str = "Unexpected context report.";
const EXITED: &str = "Claude Code exited before reporting its context.";

// ---------- contract mirror (contract/token-viewer.ts) ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContextRowKind {
    Used,
    Free,
    Buffer,
    Deferred,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextCategory {
    pub id: Option<String>,
    pub name: String,
    pub tokens: u64,
    pub kind: ContextRowKind,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextMcpTool {
    pub name: String,
    pub server_name: String,
    pub tokens: u64,
    pub is_loaded: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextMemoryFile {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub tokens: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextAgent {
    pub agent_type: String,
    pub source: String,
    pub tokens: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextSkill {
    pub name: String,
    pub source: String,
    pub tokens: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    pub model: String,
    pub total_tokens: u64,
    pub max_tokens: u64,
    pub percentage: f64,
    pub categories: Vec<ContextCategory>,
    pub mcp_tools: Vec<ContextMcpTool>,
    pub memory_files: Vec<ContextMemoryFile>,
    pub agents: Vec<ContextAgent>,
    pub skills: Vec<ContextSkill>,
    pub auto_compact_threshold: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdownResponse {
    pub breakdown: Option<ContextBreakdown>,
    pub measured_at: Option<u64>,
    pub stale: bool,
}

// ---------- per-session state ----------

/// What the cached measurement was taken against (see the module doc).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Fingerprint {
    turn_epoch: u64,
    model_id: String,
    thread: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Measured {
    breakdown: ContextBreakdown,
    /// epoch ms of the probe's LAUNCH — a turn that starts and ends inside the
    /// probe still leaves the figure stale.
    measured_at: u64,
    fingerprint: Fingerprint,
}

/// One in-flight probe: its child (killed on session remove / app exit) and
/// the outcome every joining caller waits on.
#[derive(Default)]
pub(crate) struct Flight {
    child: Mutex<Option<Child>>,
    outcome: Mutex<Option<Result<ContextBreakdownResponse, AppError>>>,
    landed: Condvar,
}

impl Flight {
    pub(crate) fn kill(&self) {
        if let Some(c) = self
            .child
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
        {
            let _ = c.kill();
        }
    }

    fn publish(&self, outcome: Result<ContextBreakdownResponse, AppError>) {
        *self.outcome.lock().unwrap_or_else(|p| p.into_inner()) = Some(outcome);
        self.landed.notify_all();
    }

    fn wait(&self, timeout: Duration) -> Result<ContextBreakdownResponse, AppError> {
        let guard = self.outcome.lock().unwrap_or_else(|p| p.into_inner());
        let (guard, _) = self
            .landed
            .wait_timeout_while(guard, timeout, |o| o.is_none())
            .unwrap_or_else(|p| p.into_inner());
        guard.clone().unwrap_or_else(|| Err(unavailable(TIMED_OUT)))
    }
}

/// token-viewer §6: in-memory only — a restored session measures on first open.
#[derive(Default)]
pub(crate) struct ContextState {
    cache: Option<Measured>,
    turn_epoch: u64,
    flight: Option<Arc<Flight>>,
}

impl ContextState {
    /// Called at every turn end (finish, failure, compact): the conversation
    /// moved, so any cached figure now predates it.
    pub(crate) fn note_turn_ended(&mut self) {
        self.turn_epoch += 1;
    }

    /// The in-flight probe, if any — for the remove / app-exit kill paths.
    pub(crate) fn flight(&self) -> Option<Arc<Flight>> {
        self.flight.clone()
    }
}

fn fingerprint_of(s: &Session) -> Fingerprint {
    Fingerprint {
        turn_epoch: s.context.turn_epoch,
        model_id: s.model_id.clone(),
        thread: s.claude_session_id.clone(),
    }
}

/// FR-3: a turn is live while the status says so OR a child still owns the
/// session's stdin (a settled session reads `idle` with its child alive).
fn is_live(s: &Session) -> bool {
    status::is_busy(&s.status) || s.current.is_some()
}

// ---------- pure decisions ----------

#[derive(Debug, PartialEq)]
enum Plan {
    Answer(ContextBreakdownResponse),
    Probe,
}

/// FR-9: what the cache is worth right now.
fn response_of(
    cache: Option<&Measured>,
    now: &Fingerprint,
    live: bool,
) -> ContextBreakdownResponse {
    match cache {
        Some(m) => ContextBreakdownResponse {
            breakdown: Some(m.breakdown.clone()),
            measured_at: Some(m.measured_at),
            stale: live || m.fingerprint != *now,
        },
        // §7 "turn live, no cache" → null + stale.
        None => ContextBreakdownResponse {
            breakdown: None,
            measured_at: None,
            stale: live,
        },
    }
}

/// FR-3/FR-4: never probe a live turn; reuse a fresh cache unless forced.
fn plan(live: bool, refresh: bool, cache: Option<&Measured>, now: &Fingerprint) -> Plan {
    if live {
        return Plan::Answer(response_of(cache, now, true));
    }
    match cache {
        Some(m) if !refresh && m.fingerprint == *now => {
            Plan::Answer(response_of(cache, now, false))
        }
        _ => Plan::Probe,
    }
}

/// FR-5: the probe's claude argv. No permission flags, no prompt.
fn probe_args(model_id: &str, resume: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model_id,
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    if let Some(thread) = resume {
        args.push("--resume".into());
        args.push(thread.into());
    }
    args
}

fn request_line(request_id: &str) -> String {
    serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "get_context_usage" },
    })
    .to_string()
}

/// FR-5/FR-6: `None` for every line that is not OUR reply (hooks, system,
/// another request's response, non-JSON); otherwise the parsed answer.
fn match_reply(line: &str, request_id: &str) -> Option<Result<ContextBreakdown, AppError>> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "control_response" {
        return None;
    }
    let response = v.get("response")?;
    if response.get("request_id")?.as_str()? != request_id {
        return None;
    }
    Some(match response.get("subtype").and_then(Value::as_str) {
        Some("success") => response
            .get("response")
            .ok_or_else(|| unavailable(UNEXPECTED))
            .and_then(parse_context_usage),
        _ => Err(unavailable(REFUSED)),
    })
}

fn num(v: Option<&Value>) -> Option<u64> {
    let v = v?;
    v.as_u64()
        .or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f.round() as u64))
}

fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn objects(v: Option<&Value>) -> impl Iterator<Item = &Value> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| e.is_object())
}

fn category(row: &Value) -> Option<ContextCategory> {
    let kind = match row.get("kind") {
        Some(k) => serde_json::from_value::<ContextRowKind>(k.clone()).ok()?,
        None if row.get("isDeferred").and_then(Value::as_bool) == Some(true) => {
            ContextRowKind::Deferred
        }
        None => return None,
    };
    Some(ContextCategory {
        id: row.get("id").and_then(Value::as_str).map(str::to_string),
        name: text(row, "name"),
        tokens: num(row.get("tokens")).unwrap_or(0),
        kind,
    })
}

/// FR-8: the `get_context_usage` answer → `ContextBreakdown`, leniently.
fn parse_context_usage(r: &Value) -> Result<ContextBreakdown, AppError> {
    let max_tokens = num(r.get("maxTokens")).filter(|m| *m > 0);
    let (Some(max_tokens), Some(rows)) =
        (max_tokens, r.get("categories").and_then(Value::as_array))
    else {
        return Err(unavailable(UNEXPECTED));
    };
    let categories: Vec<ContextCategory> = rows.iter().filter_map(category).collect();
    let total_tokens = num(r.get("totalTokens")).unwrap_or_else(|| {
        categories
            .iter()
            .filter(|c| c.kind == ContextRowKind::Used)
            .map(|c| c.tokens)
            .sum()
    });
    let percentage = r
        .get("percentage")
        .and_then(Value::as_f64)
        .unwrap_or_else(|| (total_tokens as f64 * 100.0 / max_tokens as f64).round());
    let auto_compact_threshold =
        if r.get("isAutoCompactEnabled").and_then(Value::as_bool) == Some(false) {
            None
        } else {
            num(r.get("autoCompactThreshold"))
        };
    Ok(ContextBreakdown {
        model: text(r, "model"),
        total_tokens,
        max_tokens,
        percentage,
        categories,
        mcp_tools: objects(r.get("mcpTools"))
            .map(|t| ContextMcpTool {
                name: text(t, "name"),
                server_name: text(t, "serverName"),
                tokens: num(t.get("tokens")).unwrap_or(0),
                is_loaded: t.get("isLoaded").and_then(Value::as_bool),
            })
            .collect(),
        memory_files: objects(r.get("memoryFiles"))
            .map(|f| ContextMemoryFile {
                path: text(f, "path"),
                kind: text(f, "type"),
                tokens: num(f.get("tokens")).unwrap_or(0),
            })
            .collect(),
        agents: objects(r.get("agents"))
            .map(|a| ContextAgent {
                agent_type: text(a, "agentType"),
                source: text(a, "source"),
                tokens: num(a.get("tokens")).unwrap_or(0),
            })
            .collect(),
        skills: objects(r.get("skills").and_then(|s| s.get("skillFrontmatter")))
            .map(|s| ContextSkill {
                name: text(s, "name"),
                source: text(s, "source"),
                tokens: num(s.get("tokens")).unwrap_or(0),
            })
            .collect(),
        auto_compact_threshold,
    })
}

fn unavailable(message: &str) -> AppError {
    AppError::new(ErrorCode::ContextBreakdownUnavailable, message)
}

// ---------- I/O ----------

/// Where and how the probe runs, read off the session under its lock.
pub(crate) struct ProbeTarget {
    cwd: String,
    model_id: String,
    runtime: String,
    worktree_distro: Option<String>,
    resume: Option<String>,
}

/// A fully built spawn: program, argv, extra env, cwd (`None` for WSL, whose
/// cwd rides `--cd` inside the distro).
pub(crate) struct ProbeSpawn {
    program: String,
    argv: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<String>,
}

/// FR-5: the production spawn — the same path `usage_probe.rs` takes (session
/// runtime incl. WSL + stored distro, account config dir, session cwd).
fn claude_spawn(t: &ProbeTarget, config_dir: Option<&str>) -> ProbeSpawn {
    let args = probe_args(&t.model_id, t.resume.as_deref());
    let (program, argv) =
        super::claude_invocation(&t.runtime, &t.cwd, args, t.worktree_distro.as_deref());
    ProbeSpawn {
        program,
        argv,
        env: super::account_env(config_dir, &t.runtime, &[]),
        cwd: (t.runtime != "wsl").then(|| t.cwd.clone()),
    }
}

fn kill_and_reap(flight: &Flight) {
    if let Some(mut c) = flight
        .child
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// FR-5/FR-6: spawn (login-shell PATH via `process_util`), write the request,
/// read stdout on a helper thread until OUR reply, bounded by `timeout`; then
/// close stdin and kill/reap. `still_wanted` is re-checked once the child is
/// in the slot — a session removed between reserve and spawn found the slot
/// empty, so the child is killed here instead.
fn run_probe(
    spawn: ProbeSpawn,
    flight: &Flight,
    timeout: Duration,
    still_wanted: impl FnOnce() -> bool,
) -> Result<ContextBreakdown, AppError> {
    let mut cmd = crate::process_util::spawn(&spawn.program)
        .args(&spawn.argv)
        .envs(spawn.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if let Some(cwd) = &spawn.cwd {
        cmd = cmd.current_dir(cwd);
    }
    let mut child = cmd
        .start()
        .map_err(|e| unavailable(&format!("Could not start Claude Code ({e}).")))?;
    let stdout = child.stdout.take();
    let mut stdin = child.stdin.take();
    *flight.child.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
    if !still_wanted() {
        kill_and_reap(flight);
        return Err(AppError::new(ErrorCode::SessionNotFound, "no such session"));
    }

    let request_id = super::uuid();
    let wrote = stdin
        .as_mut()
        .map(|i| writeln!(i, "{}", request_line(&request_id)).and_then(|_| i.flush()));
    if !matches!(wrote, Some(Ok(()))) {
        kill_and_reap(flight);
        return Err(unavailable(EXITED));
    }

    let (tx, rx) = mpsc::channel();
    if let Some(out) = stdout {
        // Detached: if a kill only reaches a shim (wsl.exe) whose grandchild
        // keeps the pipe open, this thread may outlive the probe — the caller
        // never waits on it, so the single-flight slot cannot stick.
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines() {
                let Ok(line) = line else { break };
                if let Some(answer) = match_reply(&line, &request_id) {
                    let _ = tx.send(answer);
                    return;
                }
            }
        });
    }
    let outcome = match rx.recv_timeout(timeout) {
        Ok(answer) => answer,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(unavailable(TIMED_OUT)),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(unavailable(EXITED)),
    };
    drop(stdin);
    kill_and_reap(flight);
    outcome
}

enum Step {
    Answer(ContextBreakdownResponse),
    Join(Arc<Flight>),
    Launch(Arc<Flight>, ProbeTarget, Fingerprint, u64),
}

/// FR-1..FR-9 over an `Engine`, with the spawn and the deadline injected —
/// the command resolves only the config dir. Never holds the sessions lock
/// across spawn, read or wait.
fn breakdown_in_engine(
    engine: &Engine,
    session_id: &str,
    refresh: bool,
    timeout: Duration,
    make_spawn: impl FnOnce(&ProbeTarget) -> ProbeSpawn,
) -> Result<ContextBreakdownResponse, AppError> {
    let step = engine
        .with_session_mut(session_id, |s| {
            if s.agent_runtime != AgentRuntime::ClaudeCode {
                return Err(unavailable(NOT_CLAUDE));
            }
            let now = fingerprint_of(s);
            if let Plan::Answer(r) = plan(is_live(s), refresh, s.context.cache.as_ref(), &now) {
                return Ok(Step::Answer(r));
            }
            if let Some(f) = &s.context.flight {
                return Ok(Step::Join(f.clone()));
            }
            let flight = Arc::new(Flight::default());
            s.context.flight = Some(flight.clone());
            let target = ProbeTarget {
                cwd: s.cwd.clone(),
                model_id: s.model_id.clone(),
                runtime: s.runtime.clone(),
                worktree_distro: s.worktree_distro.clone(),
                resume: s.claude_session_id.clone(),
            };
            Ok(Step::Launch(flight, target, now, super::now_ms()))
        })
        .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))??;

    let (flight, target, fingerprint, launched_at) = match step {
        Step::Answer(r) => return Ok(r),
        Step::Join(f) => return f.wait(timeout + JOIN_GRACE),
        Step::Launch(f, t, fp, at) => (f, t, fp, at),
    };
    let ours = |s: &Session| {
        s.context
            .flight
            .as_ref()
            .is_some_and(|f| Arc::ptr_eq(f, &flight))
    };
    let probed = run_probe(make_spawn(&target), &flight, timeout, || {
        engine.with_session(session_id, ours).unwrap_or(false)
    });

    // Write-back: only into the session that launched us (§7 "deleted
    // mid-probe" → discarded). A failure leaves the previous cache intact.
    let outcome = engine
        .with_session_mut(session_id, |s| {
            if !ours(s) {
                return Err(AppError::new(ErrorCode::SessionNotFound, "no such session"));
            }
            s.context.flight = None;
            let breakdown = probed?;
            s.context.cache = Some(Measured {
                breakdown,
                measured_at: launched_at,
                fingerprint,
            });
            Ok(response_of(
                s.context.cache.as_ref(),
                &fingerprint_of(s),
                is_live(s),
            ))
        })
        .unwrap_or_else(|| Err(AppError::new(ErrorCode::SessionNotFound, "no such session")));
    flight.publish(outcome.clone());
    outcome
}

// ---------- command ----------

/// francois:session:contextBreakdown — `invoke('session_context_breakdown',
/// { sessionId, refresh })`, flat args (`refresh` optional, default false).
#[tauri::command(async)]
pub fn session_context_breakdown(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    refresh: Option<bool>,
) -> IpcResult<ContextBreakdownResponse> {
    let Some(account_id) = engine.with_session(&session_id, |s| s.account_id.clone()) else {
        return AppError::new(ErrorCode::SessionNotFound, "no such session").into();
    };
    let config_dir = crate::account::claude_config_dir_of(&app, &account_id);
    match breakdown_in_engine(
        &engine,
        &session_id,
        refresh.unwrap_or(false),
        PROBE_TIMEOUT,
        |t| claude_spawn(t, config_dir.as_deref()),
    ) {
        Ok(r) => ok(r),
        Err(e) => e.into(),
    }
}

#[cfg(test)]
mod tests;
