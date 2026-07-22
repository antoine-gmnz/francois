// usage.rs — the `app` domain's plan-limit usage (specs/usage-bar.md) AND the
// shared /usage answer grammar.
//
// Two things live here on purpose:
//  * The meter grammar + stream-json answer extraction (`parse_meter_line`,
//    `probe_answer`, `synthetic_text`). These were the /usage transcript card's
//    private helpers in session.rs; usage-bar §6 lifts them here so both features
//    parse one grammar. session.rs imports them back and its card path is unchanged.
//  * The app-scoped usage cache + probe (`UsageState`, `app_get_usage`,
//    `app_refresh_usage`, `francois://app/event`).
//
// LOCK ORDER: `UsageState` is a LEAF. Nothing in this file ever acquires
// `session::Engine.sessions` — not the commands, not the probe thread, not the
// watchdog, not the timers — so it can never participate in a lock cycle with the
// engine. Keep it that way.

use crate::ipc::{ok, AppError, IpcResult};
use crate::session::{no_window, now_ms, PROBE_TIMEOUT_SECS};
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// francois:app:event → the new app-domain event channel (§5.1).
const EVENT_CHANNEL: &str = "francois://app/event";
/// FR-14: an automatic trigger less than this after the last probe START is dropped.
const AUTO_FLOOR_MS: u64 = 60_000;
/// FR-12: the background refresh interval.
const TICK_INTERVAL_SECS: u64 = 300;
/// FR-13: how long after a session leaves `running` the probe fires.
const POST_TURN_DEBOUNCE_SECS: u64 = 15;

// §5.4 — the exact user-facing message for each failure condition.
const MSG_SPAWN_FAILED: &str =
    "Claude Code CLI not found. Install it and ensure 'claude' is on PATH.";
const MSG_TIMED_OUT: &str = "Timed out fetching usage.";
const MSG_NO_ANSWER: &str =
    "The Claude Code CLI returned no answer. Run 'claude' once in a terminal to authenticate.";
const MSG_UNPARSEABLE: &str = "Could not read the usage response.";

// ---------- shared grammar (moved from session.rs, behavior unchanged) ----------

/// One plan-limit meter parsed from the CLI's /usage output (contract UsageMeter,
/// `contract/common.ts`). Shared by the /usage transcript card and the usage bar.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct UsageMeter {
    pub label: String,
    #[serde(rename = "percentUsed")]
    pub percent_used: u64,
    /// verbatim reset text, e.g. 'Jul 22, 5:29pm (Europe/Paris)'
    #[serde(rename = "resetsAt")]
    pub resets_at: String,
}

/// §5 meter line: `^(.+?): (\d+)% used · resets (.+)$` (the `·` is U+00B7).
/// Lazy label — the first `": "` split whose tail matches wins.
pub fn parse_meter_line(line: &str) -> Option<UsageMeter> {
    let mut from = 0;
    while let Some(rel) = line[from..].find(": ") {
        let pos = from + rel;
        if pos > 0 {
            if let Some(m) = parse_meter_tail(&line[..pos], &line[pos + 2..]) {
                return Some(m);
            }
        }
        from = pos + 1;
    }
    None
}

fn parse_meter_tail(label: &str, rest: &str) -> Option<UsageMeter> {
    let digits_end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if digits_end == 0 {
        return None;
    }
    let resets_at = rest[digits_end..].strip_prefix("% used \u{b7} resets ")?;
    if resets_at.is_empty() {
        return None;
    }
    Some(UsageMeter {
        label: label.to_string(),
        percent_used: rest[..digits_end].parse().ok()?,
        resets_at: resets_at.to_string(),
    })
}

/// interactive-commands FR-16 detection: the concatenated `content[].text` of an
/// assistant event whose `message.model` is `"<synthetic>"`. None for real messages.
pub fn synthetic_text(v: &Value) -> Option<String> {
    let msg = v.get("message")?;
    if msg.get("model").and_then(|m| m.as_str()) != Some("<synthetic>") {
        return None;
    }
    let content = msg.get("content")?.as_array()?;
    Some(
        content
            .iter()
            .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
    )
}

/// Extract a probe's answer from its stdout lines — the first synthetic assistant
/// message's text, else the final result event's `result` string. Trailing
/// whitespace stripped; callers treat empty as failure.
pub fn probe_answer(lines: &[String]) -> Option<String> {
    let mut result_text: Option<String> = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("assistant") => {
                if let Some(t) = synthetic_text(&v) {
                    return Some(t.trim_end().to_string());
                }
            }
            Some("result") => {
                if let Some(r) = v.get("result").and_then(|r| r.as_str()) {
                    result_text = Some(r.to_string());
                }
            }
            _ => {}
        }
    }
    result_text.map(|s| s.trim_end().to_string())
}

// ---------- contract shapes (contract/usage-bar.ts §5.2) ----------

/// The app-scoped usage cache. `fetchedAt`/`error` serialize as JSON null when
/// absent — the contract types them `T | null`, so they are NEVER omitted.
#[derive(Serialize, Clone)]
pub struct UsageSnapshot {
    status: String, // empty | loading | ready | error
    meters: Vec<UsageMeter>,
    #[serde(rename = "fetchedAt")]
    fetched_at: Option<u64>,
    error: Option<AppError>,
}

/// FR-4: the pre-first-probe value. Never restored from disk — a snapshot from a
/// previous run is worse than no data.
impl Default for UsageSnapshot {
    fn default() -> Self {
        UsageSnapshot {
            status: "empty".into(),
            meters: Vec::new(),
            fetched_at: None,
            error: None,
        }
    }
}

/// Ack for francois:app:refreshUsage (FR-15) — the result rides the event channel.
#[derive(Serialize)]
pub struct UsageRefreshAck {
    started: bool,
}

/// Payload of francois://app/event — a tagged union with one member today.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
enum AppEvent {
    #[serde(rename = "usage.state")]
    UsageState { snapshot: UsageSnapshot },
}

// ---------- managed state (§6) ----------

#[derive(Default)]
pub struct UsageState(Mutex<UsageInner>);

struct UsageInner {
    snapshot: UsageSnapshot,
    /// Some iff a probe is in flight (FR-7).
    probe: Option<Child>,
    /// Epoch ms of the last probe START — the FR-14 throttle floor. 0 = never.
    last_started_at: u64,
    /// Bumped on every start so a late watchdog/reader can never touch a newer probe.
    generation: u64,
    /// FR-13: a post-turn probe is already scheduled (coalescing).
    debounce_pending: bool,
}

impl Default for UsageInner {
    fn default() -> Self {
        UsageInner {
            snapshot: UsageSnapshot::default(),
            probe: None,
            last_started_at: 0,
            generation: 0,
            debounce_pending: false,
        }
    }
}

// ---------- pure decision logic ----------

fn unavailable(message: &str) -> AppError {
    AppError {
        code: "USAGE_UNAVAILABLE".into(),
        message: message.into(),
    }
}

/// §5.4 row 1: `claude` could not be spawned.
fn spawn_failed() -> AppError {
    AppError {
        code: "SPAWN_FAILED".into(),
        message: MSG_SPAWN_FAILED.into(),
    }
}

/// The verdict of one probe.
enum ProbeOutcome {
    Ready(Vec<UsageMeter>),
    Failed(AppError),
}

/// FR-8/FR-9 + §5.4 (pure; unit-tested). A fully parsed answer always wins — even
/// when the 30s watchdog fired while the last bytes were being read. `timed_out`
/// decides only when nothing parsed, because a killed probe's truncated output is
/// a timeout, not a format drift.
fn probe_outcome(lines: &[String], timed_out: bool) -> ProbeOutcome {
    let answer = probe_answer(lines).filter(|a| !a.is_empty());
    let meters: Vec<UsageMeter> = answer
        .as_deref()
        .map(|a| a.lines().filter_map(parse_meter_line).collect())
        .unwrap_or_default();
    if !meters.is_empty() {
        return ProbeOutcome::Ready(meters);
    }
    if timed_out {
        return ProbeOutcome::Failed(unavailable(MSG_TIMED_OUT));
    }
    match answer {
        // FR-9: an answer with zero meters is an error, never an empty `ready`.
        Some(_) => ProbeOutcome::Failed(unavailable(MSG_UNPARSEABLE)),
        None => ProbeOutcome::Failed(unavailable(MSG_NO_ANSWER)),
    }
}

/// FR-17/FR-18: enter `loading` keeping the previous meters and fetchedAt; the
/// error is cleared because it is non-null iff status is `error` (FR-20).
fn mark_loading(snapshot: &mut UsageSnapshot) {
    snapshot.status = "loading".into();
    snapshot.error = None;
}

/// FR-16/18/19/20: fold a probe outcome into the snapshot. A failure keeps the
/// meters and fetchedAt the user can still read; a success clears the error.
fn apply_outcome(snapshot: &mut UsageSnapshot, outcome: ProbeOutcome, now: u64) {
    match outcome {
        ProbeOutcome::Ready(meters) => {
            snapshot.status = "ready".into();
            snapshot.meters = meters;
            snapshot.fetched_at = Some(now);
            snapshot.error = None;
        }
        ProbeOutcome::Failed(error) => {
            snapshot.status = "error".into();
            snapshot.error = Some(error);
        }
    }
}

/// FR-7/FR-11/FR-14 gate (pure; unit-tested). In flight → never. Manual → always
/// (it bypasses the floor, never FR-7). Automatic → only outside the 60s floor
/// measured from the last probe START; the first probe of the run is never floored.
fn should_start(in_flight: bool, manual: bool, last_started_at: u64, now: u64) -> bool {
    if in_flight {
        return false;
    }
    if manual {
        return true;
    }
    last_started_at == 0 || now.saturating_sub(last_started_at) >= AUTO_FLOOR_MS
}

/// FR-13 coalescing: true when this turn-end is the one that arms the 15s timer.
fn claim_debounce(pending: &mut bool) -> bool {
    if *pending {
        return false;
    }
    *pending = true;
    true
}

/// FR-5/FR-6: the probe invocation. ALWAYS the native `claude` — plan limits are
/// per-account, so there is no session runtime to inherit and `wsl.exe` is never
/// used. No --resume, no --model, no permission flags.
fn probe_invocation() -> (String, Vec<String>) {
    (
        "claude".to_string(),
        vec![
            "-p".into(),
            "/usage".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
        ],
    )
}

/// FR-5: the probe is app-scoped, so it runs in the user's home directory rather
/// than borrowing any session's cwd.
fn probe_cwd() -> Option<std::path::PathBuf> {
    dirs::home_dir()
}

// ---------- probe driver ----------

fn emit_snapshot(app: &AppHandle, snapshot: &UsageSnapshot) {
    let _ = app.emit(
        EVENT_CHANNEL,
        AppEvent::UsageState {
            snapshot: snapshot.clone(),
        },
    );
}

/// Start a probe unless FR-7/FR-14 forbid it. Returns whether one was started —
/// the `{ started }` of FR-15 (a spawn failure still counts as started: it emits
/// its own outcome event). Emits the FR-17 `loading` event BEFORE the spawn.
///
/// The whole start sequence runs under the usage lock so two callers can never
/// both pass the FR-7 check; the lock is a leaf, so this blocks nothing but other
/// usage work.
fn request_probe(app: &AppHandle, manual: bool) -> bool {
    let Some(state) = app.try_state::<UsageState>() else {
        return false;
    };
    let Ok(mut inner) = state.0.lock() else {
        return false; // poisoned — the commands surface INTERNAL, timers just skip
    };
    let now = now_ms();
    if !should_start(inner.probe.is_some(), manual, inner.last_started_at, now) {
        return false;
    }
    inner.last_started_at = now;
    inner.generation = inner.generation.wrapping_add(1);
    let generation = inner.generation;

    mark_loading(&mut inner.snapshot);
    emit_snapshot(app, &inner.snapshot); // FR-17 — before the spawn

    let (program, args) = probe_invocation();
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(home) = probe_cwd() {
        cmd.current_dir(home);
    }
    no_window(&mut cmd); // FR-10 — no console flash
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            apply_outcome(
                &mut inner.snapshot,
                ProbeOutcome::Failed(spawn_failed()),
                now_ms(),
            );
            emit_snapshot(app, &inner.snapshot); // FR-16 — exactly one outcome event
            return true;
        }
    };
    let stdout = child.stdout.take();
    inner.probe = Some(child);
    drop(inner);

    let handle = app.clone();
    std::thread::spawn(move || drain_probe(handle, generation, stdout));
    true
}

/// The detached probe body: read stdout to EOF under a 30s watchdog, then fold the
/// verdict into the snapshot and emit it.
fn drain_probe(app: AppHandle, generation: u64, stdout: Option<ChildStdout>) {
    let done = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    {
        let (app, done, timed_out) = (app.clone(), done.clone(), timed_out.clone());
        std::thread::spawn(move || {
            for _ in 0..(PROBE_TIMEOUT_SECS * 10) {
                std::thread::sleep(Duration::from_millis(100));
                if done.load(Ordering::SeqCst) {
                    return;
                }
            }
            timed_out.store(true, Ordering::SeqCst);
            // Last-moment re-check: if the reader finished in the finalpoll interval
            // it will settle with its own (possibly parsed) verdict, which FR-8 says
            // must win. `time_out_probe` re-checks the generation under the lock, so
            // this is only an optimization, not the correctness barrier.
            if done.load(Ordering::SeqCst) {
                return;
            }
            time_out_probe(&app, generation);
        });
    }

    let mut lines: Vec<String> = Vec::new();
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines() {
            match line {
                Ok(l) => lines.push(l),
                Err(_) => break,
            }
        }
    }
    done.store(true, Ordering::SeqCst);

    let outcome = probe_outcome(&lines, timed_out.load(Ordering::SeqCst));
    if let Some(mut child) = settle(&app, generation, outcome) {
        let _ = child.wait(); // reaped outside the lock
    }
}

/// Release the probe slot and publish its outcome in one critical section, so a
/// probe that started in the meantime can never have its state overwritten.
/// Returns the finished child for the caller to reap.
fn settle(app: &AppHandle, generation: u64, outcome: ProbeOutcome) -> Option<Child> {
    let state = app.try_state::<UsageState>()?;
    let mut inner = state.0.lock().ok()?;
    if inner.generation != generation {
        return None; // superseded — never publish a stale verdict
    }
    let child = inner.probe.take();
    apply_outcome(&mut inner.snapshot, outcome, now_ms());
    emit_snapshot(app, &inner.snapshot); // FR-16 — exactly one outcome event
    // Retire this generation so the watchdog, if it fires between our lock release
    // and its own acquisition, finds a mismatch and stays silent (FR-16).
    inner.generation = inner.generation.wrapping_add(1);
    child
}

/// FR-8 watchdog finish: publish the timeout, RELEASE the slot and retire the
/// generation in one critical section, then kill/reap the child outside the lock.
///
/// Publishing here — rather than only killing and leaving `drain_probe` to settle —
/// is what stops FR-7 from leaking. A killed `claude` can leave a descendant holding
/// the stdout pipe; the reader then never reaches EOF, `settle` never runs, and
/// `inner.probe` would stay `Some` forever, wedging `should_start` into `false` for
/// every future trigger and freezing the bar in `loading` app-wide with no way back.
///
/// Retiring the generation makes the two finishers mutually exclusive: whichever
/// takes the lock first publishes, the other sees the mismatch and returns, so
/// exactly one outcome event is emitted either way (FR-16).
fn time_out_probe(app: &AppHandle, generation: u64) {
    let Some(state) = app.try_state::<UsageState>() else {
        return;
    };
    let child = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        if inner.generation != generation {
            return; // the reader already settled it, or a newer probe owns the slot
        }
        let child = inner.probe.take();
        apply_outcome(
            &mut inner.snapshot,
            ProbeOutcome::Failed(unavailable(MSG_TIMED_OUT)),
            now_ms(),
        );
        emit_snapshot(app, &inner.snapshot); // FR-16 — exactly one outcome event
        inner.generation = inner.generation.wrapping_add(1);
        child
    };
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait(); // reaped outside the lock
    }
}

/// §7 #9: kill the probe on app exit — no orphan `claude` process.
pub fn kill_probe(app: &AppHandle) {
    let Some(state) = app.try_state::<UsageState>() else {
        return;
    };
    let Ok(mut inner) = state.0.lock() else {
        return;
    };
    if let Some(mut child) = inner.probe.take() {
        let _ = child.kill();
    }
}

// ---------- core-side timers (FR-11/12/13) ----------

/// FR-11 + FR-12: probe once during setup, then every 5 minutes. Core-side so the
/// schedule survives a frontend reload.
pub fn start_timers(app: AppHandle) {
    {
        let app = app.clone();
        std::thread::spawn(move || {
            request_probe(&app, false);
        });
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(TICK_INTERVAL_SECS));
        request_probe(&app, false);
    });
}

/// FR-13: a session left `running`, so usage moved — probe 15s later. Concurrent
/// turn-ends coalesce into a single probe, and the fired timer is still subject to
/// FR-7/FR-14. Called from session.rs OUTSIDE the engine lock (see LOCK ORDER).
pub fn note_turn_ended(app: &AppHandle) {
    let Some(state) = app.try_state::<UsageState>() else {
        return;
    };
    {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        if !claim_debounce(&mut inner.debounce_pending) {
            return;
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(POST_TURN_DEBOUNCE_SECS));
        if let Some(state) = app.try_state::<UsageState>() {
            if let Ok(mut inner) = state.0.lock() {
                inner.debounce_pending = false;
            }
        }
        request_probe(&app, false);
    });
}

// ---------- commands (§5.1) ----------

/// francois:app:getUsage — the cached snapshot. FR-22: never triggers a probe.
#[tauri::command(async)]
pub fn app_get_usage(state: State<'_, UsageState>) -> IpcResult<UsageSnapshot> {
    match state.0.lock() {
        Ok(inner) => ok(inner.snapshot.clone()),
        // §5.4: INTERNAL is reserved for a poisoned state lock.
        Err(_) => crate::ipc::err("INTERNAL", "usage state is unavailable"),
    }
}

/// francois:app:refreshUsage — request a probe (FR-15). Never carries the result.
#[tauri::command(async)]
pub fn app_refresh_usage(app: AppHandle) -> IpcResult<UsageRefreshAck> {
    ok(UsageRefreshAck {
        started: request_probe(&app, true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn ndjson(lines: &[Value]) -> Vec<String> {
        lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect()
    }

    fn sample_meter() -> UsageMeter {
        UsageMeter {
            label: "Current session".into(),
            percent_used: 14,
            resets_at: "Jul 22, 5:29pm (Europe/Paris)".into(),
        }
    }

    // ---------- moved from session.rs (grammar shared with the /usage card) ----------

    #[test]
    fn meter_line_parses_probed_samples() {
        // real probed output (spec §1)
        let m = parse_meter_line(
            "Current session: 14% used \u{b7} resets Jul 22, 5:29pm (Europe/Paris)",
        )
        .unwrap();
        assert_eq!(m.label, "Current session");
        assert_eq!(m.percent_used, 14);
        assert_eq!(m.resets_at, "Jul 22, 5:29pm (Europe/Paris)");
        let m = parse_meter_line(
            "Current week (all models): 34% used \u{b7} resets Jul 25, 11:00am (Europe/Paris)",
        )
        .unwrap();
        assert_eq!(m.label, "Current week (all models)");
        assert_eq!(m.percent_used, 34);
    }

    #[test]
    fn meter_line_drift_returns_none() {
        assert!(parse_meter_line("Current session: 14% consumed").is_none());
        assert!(parse_meter_line("Current session: 14% used . resets Jul 22").is_none()); // ASCII dot, not U+00B7
        assert!(parse_meter_line("Current session: x% used \u{b7} resets Jul 22").is_none());
        assert!(parse_meter_line("Current session: 14% used \u{b7} resets ").is_none()); // empty resets
        assert!(parse_meter_line("no meter here").is_none());
    }

    #[test]
    fn probe_answer_prefers_first_synthetic_assistant() {
        let lines = ndjson(&[
            json!({ "type": "system", "subtype": "init" }),
            json!({ "type": "assistant", "message": { "model": "<synthetic>",
                "content": [{ "type": "text", "text": "Current session: 14% used" }, { "type": "text", "text": " \n" }] } }),
            json!({ "type": "result", "subtype": "success", "result": "other" }),
        ]);
        // content[].text concatenated + trailing whitespace stripped (FR-8)
        assert_eq!(
            probe_answer(&lines).as_deref(),
            Some("Current session: 14% used")
        );
    }

    #[test]
    fn probe_answer_falls_back_to_result() {
        let lines = ndjson(&[
            json!({ "type": "assistant", "message": { "model": "claude-opus-4-8", "content": [{ "type": "text", "text": "real turn" }] } }),
            json!({ "type": "result", "subtype": "success", "result": "from result\n" }),
        ]);
        assert_eq!(probe_answer(&lines).as_deref(), Some("from result"));
        assert!(probe_answer(&[String::from("not json")]).is_none());
        assert!(probe_answer(&[]).is_none());
    }

    #[test]
    fn synthetic_detection_requires_synthetic_model() {
        let synth = json!({ "message": { "model": "<synthetic>", "content": [{ "type": "text", "text": "Unknown command: /x" }] } });
        assert_eq!(
            synthetic_text(&synth).as_deref(),
            Some("Unknown command: /x")
        );
        let real = json!({ "message": { "model": "claude-opus-4-8", "content": [{ "type": "text", "text": "hi" }] } });
        assert!(synthetic_text(&real).is_none());
        assert!(synthetic_text(&json!({})).is_none());
    }

    // ---------- usage-bar: serialization (§5.2) ----------

    #[test]
    fn usage_snapshot_serializes_to_contract_shape_with_explicit_nulls() {
        // §5.2 / acceptance: `fetchedAt` and `error` are JSON null, never omitted.
        assert_eq!(
            serde_json::to_value(UsageSnapshot::default()).unwrap(),
            json!({ "status": "empty", "meters": [], "fetchedAt": null, "error": null })
        );

        let mut snap = UsageSnapshot::default();
        apply_outcome(
            &mut snap,
            ProbeOutcome::Ready(vec![sample_meter()]),
            1_700_000_000_000,
        );
        assert_eq!(
            serde_json::to_value(&snap).unwrap(),
            json!({
                "status": "ready",
                "meters": [{ "label": "Current session", "percentUsed": 14,
                             "resetsAt": "Jul 22, 5:29pm (Europe/Paris)" }],
                "fetchedAt": 1_700_000_000_000u64,
                "error": null,
            })
        );

        let event = serde_json::to_value(AppEvent::UsageState {
            snapshot: snap.clone(),
        })
        .unwrap();
        assert_eq!(
            event,
            json!({ "type": "usage.state", "snapshot": serde_json::to_value(&snap).unwrap() })
        );
    }

    #[test]
    fn error_snapshot_serializes_the_app_error_shape() {
        let mut snap = UsageSnapshot::default();
        apply_outcome(&mut snap, ProbeOutcome::Failed(spawn_failed()), 42);
        assert_eq!(
            serde_json::to_value(&snap).unwrap(),
            json!({
                "status": "error",
                "meters": [],
                "fetchedAt": null,
                "error": { "code": "SPAWN_FAILED",
                           "message": "Claude Code CLI not found. Install it and ensure 'claude' is on PATH." },
            })
        );
    }

    #[test]
    fn refresh_ack_serializes_to_contract_shape() {
        assert_eq!(
            serde_json::to_value(UsageRefreshAck { started: false }).unwrap(),
            json!({ "started": false })
        );
    }

    // ---------- usage-bar: probe verdict (FR-8, FR-9, §5.4) ----------

    #[test]
    fn probe_outcome_prefers_parsed_meters_over_the_timeout() {
        // FR-8: an answer fully read just before the 30s kill still wins.
        let lines = ndjson(&[
            json!({ "type": "assistant", "message": { "model": "<synthetic>", "content": [
                { "type": "text", "text": "Current session: 14% used \u{b7} resets soon\nCurrent week (all models): 34% used \u{b7} resets Jul 25" }] } }),
        ]);
        for timed_out in [true, false] {
            let ProbeOutcome::Ready(meters) = probe_outcome(&lines, timed_out) else {
                panic!("expected a ready outcome (timed_out={timed_out})");
            };
            // FR-23: every meter, in CLI order, unfiltered.
            assert_eq!(meters.len(), 2);
            assert_eq!(meters[0].label, "Current session");
            assert_eq!(meters[1].percent_used, 34);
        }
    }

    #[test]
    fn probe_outcome_maps_every_failure_to_its_spec_error() {
        // §5.4 row 2: killed by the watchdog with nothing parsed.
        let ProbeOutcome::Failed(e) = probe_outcome(&[], true) else {
            panic!("expected a failure");
        };
        assert_eq!(e.code, "USAGE_UNAVAILABLE");
        assert_eq!(e.message, "Timed out fetching usage.");

        // §5.4 row 3: exited with no answer text.
        let ProbeOutcome::Failed(e) = probe_outcome(&[], false) else {
            panic!("expected a failure");
        };
        assert_eq!(e.code, "USAGE_UNAVAILABLE");
        assert_eq!(
            e.message,
            "The Claude Code CLI returned no answer. Run 'claude' once in a terminal to authenticate."
        );

        // §5.4 row 4 / FR-9: an answer that parses to zero meters is an ERROR,
        // never an empty `ready` — the bar has no raw-text fallback.
        let drifted = ndjson(&[
            json!({ "type": "result", "subtype": "success", "result": "totally new format" }),
        ]);
        let ProbeOutcome::Failed(e) = probe_outcome(&drifted, false) else {
            panic!("expected a failure");
        };
        assert_eq!(e.code, "USAGE_UNAVAILABLE");
        assert_eq!(e.message, "Could not read the usage response.");

        // A truncated (killed) answer that parses to zero meters reports the real
        // cause — the timeout (FR-8: `timed_out` decides when nothing parsed).
        let ProbeOutcome::Failed(e) = probe_outcome(&drifted, true) else {
            panic!("expected a failure");
        };
        assert_eq!(e.message, "Timed out fetching usage.");
    }

    #[test]
    fn spawn_failure_carries_the_spec_code_and_message() {
        // §5.4 row 1 / §7 #1 — the actionable "not on PATH" wording.
        let e = spawn_failed();
        assert_eq!(e.code, "SPAWN_FAILED");
        assert_eq!(
            e.message,
            "Claude Code CLI not found. Install it and ensure 'claude' is on PATH."
        );
    }

    // ---------- usage-bar: snapshot invariants (FR-18/19/20) ----------

    #[test]
    fn a_failed_probe_retains_meters_and_fetched_at() {
        let mut snap = UsageSnapshot::default();
        apply_outcome(&mut snap, ProbeOutcome::Ready(vec![sample_meter()]), 1_000);
        assert_eq!(snap.status, "ready");

        // FR-17/FR-18: loading keeps the previous data and clears the error.
        mark_loading(&mut snap);
        assert_eq!(snap.status, "loading");
        assert_eq!(snap.meters.len(), 1);
        assert_eq!(snap.fetched_at, Some(1_000));
        assert!(snap.error.is_none());

        // FR-18/FR-19: a failure never erases readable data or bumps fetchedAt.
        apply_outcome(&mut snap, ProbeOutcome::Failed(spawn_failed()), 9_999);
        assert_eq!(snap.status, "error");
        assert_eq!(snap.meters.len(), 1);
        assert_eq!(snap.fetched_at, Some(1_000));
        assert_eq!(snap.error.as_ref().unwrap().code, "SPAWN_FAILED");

        // FR-20: the next success clears the error and replaces the meters.
        apply_outcome(
            &mut snap,
            ProbeOutcome::Ready(vec![sample_meter(), sample_meter()]),
            2_000,
        );
        assert_eq!(snap.status, "ready");
        assert_eq!(snap.meters.len(), 2);
        assert_eq!(snap.fetched_at, Some(2_000));
        assert!(snap.error.is_none());
    }

    #[test]
    fn loading_before_any_success_keeps_the_empty_shape() {
        let mut snap = UsageSnapshot::default();
        mark_loading(&mut snap);
        assert_eq!(snap.status, "loading");
        assert!(snap.meters.is_empty());
        assert_eq!(snap.fetched_at, None);
        assert!(snap.error.is_none());
    }

    // ---------- usage-bar: refresh policy (FR-7, FR-11, FR-14) ----------

    #[test]
    fn probe_gate_enforces_single_flight_and_the_auto_floor() {
        let t = 1_000_000u64;
        // FR-7: nothing starts while a probe is in flight — a manual refresh included.
        assert!(!should_start(true, false, t - 600_000, t));
        assert!(!should_start(true, true, t - 600_000, t));
        // FR-11: the first (setup) probe is never floored.
        assert!(should_start(false, false, 0, t));
        // FR-14: an automatic trigger inside 60s of the last probe START is dropped.
        assert!(!should_start(false, false, t - 59_999, t));
        assert!(should_start(false, false, t - 60_000, t));
        // FR-14: a manual refresh bypasses the floor.
        assert!(should_start(false, true, t - 1, t));
    }

    #[test]
    fn post_turn_debounce_coalesces_concurrent_turn_ends() {
        // FR-13 / §7 #8: many sessions finishing inside the window → one probe.
        let mut pending = false;
        assert!(claim_debounce(&mut pending));
        assert!(!claim_debounce(&mut pending));
        assert!(!claim_debounce(&mut pending));
        pending = false; // the timer fired and released the claim
        assert!(claim_debounce(&mut pending));
    }

    // ---------- usage-bar: the invocation (FR-5, FR-6) ----------

    #[test]
    fn probe_invocation_is_native_claude_with_no_session_flags() {
        let (program, args) = probe_invocation();
        // FR-6: ALWAYS the native runtime — never `wsl.exe claude`.
        assert_eq!(program, "claude");
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        assert_eq!(
            argv,
            ["-p", "/usage", "--output-format", "stream-json", "--verbose"]
        );
        // FR-5: no --resume, no --model, no permission flags.
        for banned in [
            "--resume",
            "--model",
            "--permission-mode",
            "--dangerously-skip-permissions",
        ] {
            assert!(!argv.contains(&banned), "{banned} must never be passed");
        }
    }

    #[test]
    fn probe_runs_in_the_user_home_directory() {
        // FR-5: app-scoped, so it borrows no session's cwd.
        assert_eq!(probe_cwd(), dirs::home_dir());
    }
}
