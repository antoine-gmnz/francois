//! Account rate-limit discovery through Codex App Server.
//!
//! Codex does not expose Claude's `/usage` text command. Its supported account
//! usage surface is the App Server `account/rateLimits/read` request, whose
//! primary and secondary windows map directly onto Francois' existing usage
//! meters.

use crate::usage_meter::UsageMeter;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::time::Instant;

const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;

/// Spawn one bounded App Server probe. The caller owns the child so the app's
/// existing watchdog can kill it if the server stops responding.
pub(crate) fn launch(
    program: &str,
    home: &Path,
) -> Result<(Child, ChildStdin, ChildStdout), &'static str> {
    let path = crate::process_util::login_shell_path_env();
    let mut child = crate::process_util::spawn(program)
        .args(["app-server", "--listen", "stdio://"])
        .scrubbed_env(path.as_deref())
        .env("CODEX_HOME", home)
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .start()
        .map_err(|_| "spawn")?;

    let stdin = child.stdin.take().ok_or("runtime")?;
    let stdout = child.stdout.take().ok_or("runtime")?;
    Ok((child, stdin, stdout))
}

/// Complete the App Server handshake and return the shared rate-limit meters.
pub(crate) fn request(
    stdin: &mut ChildStdin,
    stdout: ChildStdout,
    deadline: Instant,
) -> Result<Vec<UsageMeter>, &'static str> {
    let mut reader = BufReader::new(stdout);
    send(
        stdin,
        json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "francois", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": false }
            }
        }),
    )?;
    response(&mut reader, stdin, 1, deadline)?;
    send(stdin, json!({ "method": "initialized" }))?;
    send(
        stdin,
        json!({ "id": 2, "method": "account/rateLimits/read", "params": null }),
    )?;
    let result = response(&mut reader, stdin, 2, deadline)?;
    meters_from_response(&result).ok_or("protocol")
}

fn send(stdin: &mut ChildStdin, value: Value) -> Result<(), &'static str> {
    serde_json::to_writer(&mut *stdin, &value).map_err(|_| "runtime")?;
    stdin.write_all(b"\n").map_err(|_| "runtime")?;
    stdin.flush().map_err(|_| "runtime")
}

fn response(
    reader: &mut BufReader<ChildStdout>,
    stdin: &mut ChildStdin,
    id: u64,
    deadline: Instant,
) -> Result<Value, &'static str> {
    loop {
        if Instant::now() >= deadline {
            return Err("timeout");
        }
        let mut line = String::new();
        let read = reader.read_line(&mut line).map_err(|_| "runtime")?;
        if read == 0 {
            return Err("runtime");
        }
        if read > MAX_LINE_BYTES {
            return Err("limit");
        }
        let value: Value = serde_json::from_str(&line).map_err(|_| "protocol")?;
        if value.get("method").is_some() {
            if let Some(request_id) = value.get("id") {
                send(
                    stdin,
                    json!({ "id": request_id, "error": { "code": -32601, "message": "Method not found" } }),
                )?;
            }
            continue;
        }
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            return Err("protocol");
        }
        if value.get("error").is_some() {
            return Err("runtime");
        }
        return value.get("result").cloned().ok_or("protocol");
    }
}

/// Convert the App Server response to the shared meter shape. The labels match
/// Claude's plan-limit labels so the existing UI and reset countdown remain
/// useful for either CLI.
pub(crate) fn meters_from_response(result: &Value) -> Option<Vec<UsageMeter>> {
    let limits = result.get("rateLimits")?;
    let mut meters = Vec::new();
    for (key, label) in [
        ("primary", "Current session"),
        ("secondary", "Current week (all models)"),
    ] {
        let Some(window) = limits.get(key) else {
            continue;
        };
        let Some(percent) = window
            .get("usedPercent")
            .or_else(|| window.get("used_percent"))
            .and_then(Value::as_u64)
        else {
            continue;
        };
        let Some(resets_at) = window
            .get("resetsAt")
            .or_else(|| window.get("resets_at"))
            .and_then(reset_text)
        else {
            continue;
        };
        meters.push(UsageMeter {
            label: label.into(),
            percent_used: percent,
            resets_at,
        });
    }
    (!meters.is_empty()).then_some(meters)
}

fn reset_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }
    let seconds = value.as_i64()?;
    let millis = if seconds.unsigned_abs() > 100_000_000_000 {
        seconds
    } else {
        seconds.checked_mul(1_000)?
    };
    let date = chrono::TimeZone::timestamp_millis_opt(&chrono::Utc, millis)
        .single()?
        .with_timezone(&chrono::Local);
    Some(date.format("%b %-d, %-I:%M%P").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_codex_windows_to_shared_usage_meters() {
        let result = json!({
            "rateLimits": {
                "primary": { "usedPercent": 42, "resetsAt": 1_798_000_000_i64 },
                "secondary": { "usedPercent": 7, "resetsAt": 1_798_600_000_i64 }
            }
        });
        let meters = meters_from_response(&result).unwrap();
        assert_eq!(meters.len(), 2);
        assert_eq!(meters[0].label, "Current session");
        assert_eq!(meters[0].percent_used, 42);
        assert!(!meters[0].resets_at.is_empty());
        assert_eq!(meters[1].label, "Current week (all models)");
    }

    #[test]
    fn accepts_a_response_with_one_window() {
        let result = json!({ "rateLimits": { "primary": { "usedPercent": 42, "resetsAt": 1 } } });
        assert_eq!(meters_from_response(&result).unwrap().len(), 1);
    }

    #[test]
    fn rejects_a_response_without_any_valid_window() {
        let result = json!({ "rateLimits": { "primary": { "usedPercent": 42 } } });
        assert!(meters_from_response(&result).is_none());
    }

    #[test]
    fn usage_meter_is_available_from_the_neutral_module() {
        let meter = crate::usage_meter::UsageMeter {
            label: "Current session".into(),
            percent_used: 42,
            resets_at: "tomorrow".into(),
        };
        assert_eq!(meter.percent_used, 42);
    }
}
