// dnd.rs — OS Do Not Disturb / Focus / Quiet Hours probe (specs/audio-cues.md
// FR-14..FR-20). A cross-cutting top-level module: it belongs to no domain,
// only the `app` command surface.
//
// PERMISSIVE DEGRADE (FR-15): `app_dnd_state` NEVER returns `Err`. A missing
// file, an unparseable payload, a failed subprocess, a timeout, or an unknown
// OS all resolve to `DndState { dnd: false, supported: false }`. This keeps
// the probe non-authoritative per the 2026-08-11 `api` decision — it may only
// *suppress* a convenience cue, never gate anything. Core holds no state
// between calls.

use crate::ipc::{ok, IpcResult};
use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct DndState {
    pub dnd: bool,
    pub supported: bool,
}

impl DndState {
    const UNSUPPORTED: DndState = DndState {
        dnd: false,
        supported: false,
    };
}

/// francois:app:dndState → Result<DndState> (FR-14). Never Err (FR-15).
// FR-6: an OS state-file read run on a sync command blocks the MAIN thread —
// same rationale as diff/commands.rs:48-56.
#[tauri::command(async)]
pub fn app_dnd_state() -> IpcResult<DndState> {
    ok(probe())
}

#[cfg(target_os = "macos")]
fn probe() -> DndState {
    macos::probe()
}

#[cfg(target_os = "windows")]
fn probe() -> DndState {
    windows::probe()
}

/// FR-19: Linux has no probe. Executes nothing — no DBus, no subprocess.
#[cfg(target_os = "linux")]
fn probe() -> DndState {
    DndState::UNSUPPORTED
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn probe() -> DndState {
    DndState::UNSUPPORTED
}

// ---------------------------------------------------------------------------
// macOS (FR-16): reads the same undocumented DB the Focus/DND UI itself
// writes to. Both file names have moved across OS releases, hence FR-15/FR-18.
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod macos {
    use super::DndState;
    use std::path::PathBuf;

    fn db_dir() -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join("Library/DoNotDisturb/DB"))
    }

    pub fn probe() -> DndState {
        match db_dir() {
            Some(dir) => probe_in(&dir),
            None => DndState::UNSUPPORTED,
        }
    }

    /// Injectable seam (remediation 2026-08-17): `probe()` reads the real
    /// `~/Library/DoNotDisturb/DB`, but the degrade path (both files absent,
    /// e.g. a locked-down / freshly provisioned machine) needs to be exercised
    /// deterministically — point this at a tempdir fixture instead.
    fn probe_in(dir: &std::path::Path) -> DndState {
        // Ventura+: ModeConfigurations.json. Preferred — tried first.
        if let Ok(text) = std::fs::read_to_string(dir.join("ModeConfigurations.json")) {
            return match parse_mode_configurations(&text) {
                Some(dnd) => DndState {
                    dnd,
                    supported: true,
                },
                None => DndState::UNSUPPORTED,
            };
        }
        // Monterey fallback: Assertions.json.
        if let Ok(text) = std::fs::read_to_string(dir.join("Assertions.json")) {
            return match parse_assertions(&text) {
                Some(dnd) => DndState {
                    dnd,
                    supported: true,
                },
                None => DndState::UNSUPPORTED,
            };
        }
        DndState::UNSUPPORTED
    }

    /// Ventura+ shape: `{"data":[{"modeConfigurations":{"<id>":{"enabled":0|1,...},...}}]}`.
    /// DND is on iff any mode configuration's `enabled` is truthy.
    fn parse_mode_configurations(text: &str) -> Option<bool> {
        let v: serde_json::Value = serde_json::from_str(text).ok()?;
        let entries = v.get("data")?.as_array()?;
        let mut any_enabled = false;
        for entry in entries {
            let Some(modes) = entry.get("modeConfigurations").and_then(|m| m.as_object()) else {
                continue;
            };
            for cfg in modes.values() {
                let enabled = cfg.get("enabled");
                if enabled.and_then(|e| e.as_i64()) == Some(1)
                    || enabled.and_then(|e| e.as_bool()) == Some(true)
                {
                    any_enabled = true;
                }
            }
        }
        Some(any_enabled)
    }

    /// Monterey shape: `{"data":[{"storeAssertionRecords":[...]}]}`. DND is on
    /// iff any entry carries a non-empty assertion record list.
    fn parse_assertions(text: &str) -> Option<bool> {
        let v: serde_json::Value = serde_json::from_str(text).ok()?;
        let entries = v.get("data")?.as_array()?;
        let mut any = false;
        for entry in entries {
            if let Some(records) = entry
                .get("storeAssertionRecords")
                .and_then(|r| r.as_array())
            {
                if !records.is_empty() {
                    any = true;
                }
            }
        }
        Some(any)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const MODE_CONFIGURATIONS_OFF: &str = r#"{"data":[{"modeConfigurations":{"com.apple.donotdisturb.mode.default":{"enabled":0}}}]}"#;
        const MODE_CONFIGURATIONS_ON: &str = r#"{"data":[{"modeConfigurations":{"com.apple.donotdisturb.mode.default":{"enabled":1}}}]}"#;
        const MODE_CONFIGURATIONS_ON_BOOL: &str = r#"{"data":[{"modeConfigurations":{"com.apple.donotdisturb.mode.default":{"enabled":true}}}]}"#;
        const ASSERTIONS_OFF: &str = r#"{"data":[{"storeAssertionRecords":[]}]}"#;
        const ASSERTIONS_ON: &str =
            r#"{"data":[{"storeAssertionRecords":[{"assertionDetails":{}}]}]}"#;

        #[test]
        fn mode_configurations_parses_off() {
            assert_eq!(
                parse_mode_configurations(MODE_CONFIGURATIONS_OFF),
                Some(false)
            );
        }

        #[test]
        fn mode_configurations_parses_on() {
            assert_eq!(
                parse_mode_configurations(MODE_CONFIGURATIONS_ON),
                Some(true)
            );
        }

        #[test]
        fn mode_configurations_parses_on_bool_variant() {
            assert_eq!(
                parse_mode_configurations(MODE_CONFIGURATIONS_ON_BOOL),
                Some(true)
            );
        }

        #[test]
        fn assertions_parses_off() {
            assert_eq!(parse_assertions(ASSERTIONS_OFF), Some(false));
        }

        #[test]
        fn assertions_parses_on() {
            assert_eq!(parse_assertions(ASSERTIONS_ON), Some(true));
        }

        #[test]
        fn unparseable_returns_none() {
            assert_eq!(parse_mode_configurations("not json"), None);
            assert_eq!(parse_assertions("not json"), None);
        }

        #[test]
        fn missing_shape_returns_none() {
            assert_eq!(parse_mode_configurations(r#"{"unexpected":true}"#), None);
            assert_eq!(parse_assertions(r#"{"unexpected":true}"#), None);
        }

        // Isolated tempdir per test so parallel `cargo test` runs never collide.
        fn temp_fixture_dir(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "francois-dnd-test-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_default()
            ));
            std::fs::create_dir_all(&dir).expect("create tempdir fixture");
            dir
        }

        // FR-15 degrade path: both DND files absent (e.g. a locked-down or
        // freshly provisioned machine that has never opened Focus/DND) must
        // resolve to UNSUPPORTED, never panic or error.
        #[test]
        fn probe_in_both_files_absent_degrades_to_unsupported() {
            let dir = temp_fixture_dir("both-absent");
            assert_eq!(probe_in(&dir), DndState::UNSUPPORTED);
            let _ = std::fs::remove_dir_all(&dir);
        }

        // FR-15 degrade path: ModeConfigurations.json present but unparseable
        // and Assertions.json absent — falls all the way through to UNSUPPORTED.
        #[test]
        fn probe_in_unparseable_mode_configurations_and_no_fallback_degrades() {
            let dir = temp_fixture_dir("unparseable-no-fallback");
            std::fs::write(dir.join("ModeConfigurations.json"), "not json").unwrap();
            assert_eq!(probe_in(&dir), DndState::UNSUPPORTED);
            let _ = std::fs::remove_dir_all(&dir);
        }

        // FR-15/FR-16 happy path exercised through the same integration seam
        // (not just the pure parse function), proving probe_in reads the file
        // it is pointed at.
        #[test]
        fn probe_in_reads_mode_configurations_file() {
            let dir = temp_fixture_dir("mode-configurations-on");
            std::fs::write(dir.join("ModeConfigurations.json"), MODE_CONFIGURATIONS_ON).unwrap();
            assert_eq!(
                probe_in(&dir),
                DndState {
                    dnd: true,
                    supported: true
                }
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        // Monterey fallback exercised through probe_in when ModeConfigurations
        // is absent but Assertions.json is present.
        #[test]
        fn probe_in_falls_back_to_assertions_file() {
            let dir = temp_fixture_dir("assertions-fallback");
            std::fs::write(dir.join("Assertions.json"), ASSERTIONS_ON).unwrap();
            assert_eq!(
                probe_in(&dir),
                DndState {
                    dnd: true,
                    supported: true
                }
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        // FR-18 canary: fails loudly when macOS moves the DND DB surface. Reads
        // real OS state (not a fixture) — deliberately, that's the point of a
        // canary — but treats a permission failure (no Full Disk Access) as
        // inconclusive rather than a false "OS moved" failure, since sandboxed
        // dev/CI environments routinely lack that TCC grant.
        #[test]
        fn canary_db_dir_and_files_parse_as_json() {
            let Some(dir) = db_dir() else {
                panic!("dnd canary: no home dir resolvable on macOS");
            };
            match std::fs::metadata(&dir) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    panic!("dnd canary: {dir:?} no longer exists — macOS moved the DND DB");
                }
                Err(_) => return, // permission denied — inconclusive on this machine
            }
            for name in ["ModeConfigurations.json", "Assertions.json"] {
                let path = dir.join(name);
                if let Ok(text) = std::fs::read_to_string(&path) {
                    assert!(
                        serde_json::from_str::<serde_json::Value>(&text).is_ok(),
                        "dnd canary: {path:?} no longer parses as JSON"
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows (FR-17): the toast-enable flag under HKCU. Read via `reg query`
// (not a raw registry FFI binding) to stay in the same "system CLI, not a
// binding" posture the rest of the core uses for git/PTY.
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
mod windows {
    use super::DndState;
    use std::process::{Output, Stdio};
    use std::time::{Duration, Instant};

    const KEY_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings";
    const VALUE_NAME: &str = "NOC_GLOBAL_SETTING_TOASTS_ENABLED";
    /// FR-15: a hung `reg.exe` must degrade, not block the invoke forever.
    const REG_QUERY_TIMEOUT: Duration = Duration::from_secs(3);

    pub fn probe() -> DndState {
        probe_via(query_toasts_enabled)
    }

    /// Injectable seam (remediation 2026-08-17): exercises the full
    /// `Result<Option<u32>, ()> -> DndState` mapping — including the
    /// spawn-failure / timeout `Err(())` branch — without actually shelling
    /// out to `reg.exe`.
    fn probe_via(query: impl Fn() -> Result<Option<u32>, ()>) -> DndState {
        match query() {
            // 0 ⇒ toasts globally disabled ⇒ treat as DND on (FR-17).
            Ok(Some(0)) => DndState {
                dnd: true,
                supported: true,
            },
            Ok(Some(_)) => DndState {
                dnd: false,
                supported: true,
            },
            // Absent ⇒ dnd:false, supported:true (FR-17) — a normal state, not
            // a probe failure: most machines never touch this value.
            Ok(None) => DndState {
                dnd: false,
                supported: true,
            },
            Err(_) => DndState::UNSUPPORTED,
        }
    }

    fn query_toasts_enabled() -> Result<Option<u32>, ()> {
        query_toasts_enabled_via(|| run_reg_query(REG_QUERY_TIMEOUT))
    }

    /// Injectable seam (remediation 2026-08-17): the FR-15 degrade path for
    /// "`reg` fails to spawn" / "`reg` times out" is exercised by passing a
    /// `spawn` closure that returns `Err(())` — no real subprocess involved.
    fn query_toasts_enabled_via(spawn: impl Fn() -> Result<Output, ()>) -> Result<Option<u32>, ()> {
        let output = spawn()?;
        if !output.status.success() {
            // Key or value not present.
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&output.stdout);
        Ok(parse_toasts_enabled(&text))
    }

    /// Spawns `reg query` without blocking the invoke indefinitely: polls
    /// `try_wait()` until the child exits or `timeout` elapses, killing the
    /// child and returning `Err(())` on expiry (FR-15's "a timeout" case).
    fn run_reg_query(timeout: Duration) -> Result<Output, ()> {
        let mut child = crate::process_util::spawn("reg")
            .args(["query", &format!("HKCU\\{KEY_PATH}"), "/v", VALUE_NAME])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .start()
            .map_err(|_| ())?;

        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_status)) => return child.wait_with_output().map_err(|_| ()),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(());
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return Err(()),
            }
        }
    }

    /// Parses `reg query <key> /v NOC_GLOBAL_SETTING_TOASTS_ENABLED` stdout,
    /// e.g. `    NOC_GLOBAL_SETTING_TOASTS_ENABLED    REG_DWORD    0x0`.
    /// `None` ⇒ the value line is not present in the output.
    fn parse_toasts_enabled(text: &str) -> Option<u32> {
        for line in text.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with(VALUE_NAME) {
                continue;
            }
            let hex = trimmed.rsplit(char::is_whitespace).next()?;
            let hex = hex.trim_start_matches("0x").trim_start_matches("0X");
            return u32::from_str_radix(hex, 16).ok();
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const TOASTS_ENABLED: &str = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\r\n    NOC_GLOBAL_SETTING_TOASTS_ENABLED    REG_DWORD    0x1\r\n\r\n";
        const TOASTS_DISABLED: &str = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\r\n    NOC_GLOBAL_SETTING_TOASTS_ENABLED    REG_DWORD    0x0\r\n\r\n";
        const NO_VALUE: &str =
            "ERROR: The system was unable to find the specified registry key or value.\r\n";

        #[test]
        fn parses_enabled() {
            assert_eq!(parse_toasts_enabled(TOASTS_ENABLED), Some(1));
        }

        #[test]
        fn parses_disabled() {
            assert_eq!(parse_toasts_enabled(TOASTS_DISABLED), Some(0));
        }

        #[test]
        fn absent_value_returns_none() {
            assert_eq!(parse_toasts_enabled(NO_VALUE), None);
        }

        // FR-15 degrade path: `reg` fails to spawn (missing binary, spawn
        // error, or — via run_reg_query's own timeout handling — a hang) must
        // propagate as Err(()), never panic.
        #[test]
        fn query_via_spawn_failure_propagates_err() {
            assert_eq!(query_toasts_enabled_via(|| Err(())), Err(()));
        }

        #[test]
        fn query_via_success_parses_output() {
            use std::os::windows::process::ExitStatusExt;
            let output = query_toasts_enabled_via(|| {
                Ok(Output {
                    status: std::process::ExitStatus::from_raw(0),
                    stdout: TOASTS_DISABLED.as_bytes().to_vec(),
                    stderr: Vec::new(),
                })
            });
            assert_eq!(output, Ok(Some(0)));
        }

        // FR-15/§9: "a failed subprocess" must resolve app_dnd_state to
        // Ok(UNSUPPORTED), not just Err(()) at the query layer — exercised
        // through the full probe_via mapping.
        #[test]
        fn probe_via_degrades_to_unsupported_on_spawn_failure() {
            assert_eq!(probe_via(|| Err(())), DndState::UNSUPPORTED);
        }

        #[test]
        fn probe_via_toasts_disabled_reports_dnd_on() {
            assert_eq!(
                probe_via(|| Ok(Some(0))),
                DndState {
                    dnd: true,
                    supported: true
                }
            );
        }

        #[test]
        fn probe_via_absent_value_reports_supported_not_dnd() {
            assert_eq!(
                probe_via(|| Ok(None)),
                DndState {
                    dnd: false,
                    supported: true
                }
            );
        }

        // FR-18 canary: `reg.exe` must still be invocable and the probe's own
        // query must not error for any reason other than "value absent" (a
        // non-zero exit is itself a legitimate absent-value outcome, handled
        // above) — only a failure to spawn the process indicates the surface
        // moved from under us.
        #[test]
        fn canary_registry_key_readable() {
            let result = crate::process_util::spawn("reg")
                .args(["query", &format!("HKCU\\{KEY_PATH}"), "/v", VALUE_NAME])
                .output();
            assert!(
                result.is_ok(),
                "dnd canary: `reg query` could not even be spawned: {:?}",
                result.err()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "linux")]
    fn linux_is_always_unsupported() {
        assert_eq!(
            probe(),
            DndState {
                dnd: false,
                supported: false
            }
        );
    }

    #[test]
    fn app_dnd_state_never_errs() {
        // FR-15: the command wraps `probe()` in `ok(...)` unconditionally —
        // there is no `err(...)` return path in this file at all.
        let result = app_dnd_state();
        match result {
            IpcResult::Ok { ok, .. } => assert!(ok),
            IpcResult::Err { .. } => panic!("app_dnd_state must never return Err (FR-15)"),
        }
    }
}
