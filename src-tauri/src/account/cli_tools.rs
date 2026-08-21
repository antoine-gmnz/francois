//! The vendor CLIs a provider's login route is driven by — is one installed on
//! this machine, and install it if not.
//!
//! **Why this is not part of an account.** A CLI is installed once per MACHINE;
//! every account on that provider shares it. Hanging "installed?" off an
//! `Account` would make five Anthropic rows carry five copies of one fact that
//! is neither per-account nor persistable — the user can `npm rm -g` between two
//! renders. So this is a probe with no state: `cli_tools` re-reads PATH on every
//! call and the answer is never cached across one.
//!
//! **Why npm, and only npm.** Francois already installs itself that way
//! (`update::UPDATE_COMMAND`), which means `update::npm_root_global` has already
//! solved finding npm — including `npm.cmd` on Windows, where `CreateProcessW`
//! will not run the shim directly. The vendors also document a `curl … | bash`
//! installer each; running one on the user's behalf would mean this app piping
//! a remote script into a shell, in three different forms across three
//! platforms, to reach the same three packages.
//!
//! multi-provider-grok FR-28: `grok` now backs a real `grok-cli` `AccountKind`
//! (`account/grok.rs`) — installing it here is the first half of the xAI
//! route, `account_add_grok` + `account_grok_login` the rest. It reads
//! `GROK_HOME` for its config tree, the same shape `CODEX_HOME` gives Codex.

use super::{emit, AccountEvent};
use crate::ipc::AppError;
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

/// How long a `--version` probe may take before it is killed and the tool is
/// reported installed-but-unversioned. Generous for a cold Node start, far
/// short of anything a user would read as a hang: three of these run per
/// `cli_tools` call, and the modal blocks on the response.
const VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(4000);
const VERSION_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// How much of npm's output rides along in a failure's `detail`. Enough to carry
/// the real reason (EACCES, a 404 on the package, a registry timeout), bounded
/// so a pathological log cannot be pushed through the event channel wholesale.
const FAILURE_TAIL_BYTES: usize = 2000;

/// One row of the static catalog. Not configurable and not persisted — a new
/// entry is a code change, which is the point: an arbitrary package name
/// arriving over IPC and reaching `npm i -g` would be a command-injection
/// surface with a user-facing button on it.
struct CliToolSpec {
    id: &'static str,
    bin: &'static str,
    npm_package: &'static str,
    docs_url: &'static str,
}

const TOOLS: &[CliToolSpec] = &[
    CliToolSpec {
        id: "claude",
        bin: "claude",
        npm_package: "@anthropic-ai/claude-code",
        docs_url: "https://docs.claude.com/en/docs/claude-code/overview",
    },
    CliToolSpec {
        id: "codex",
        bin: "codex",
        npm_package: "@openai/codex",
        docs_url: "https://developers.openai.com/codex/cli",
    },
    CliToolSpec {
        id: "grok",
        bin: "grok",
        npm_package: "@xai-official/grok",
        docs_url: "https://docs.x.ai/build/overview",
    },
];

fn spec(id: &str) -> Option<&'static CliToolSpec> {
    TOOLS.iter().find(|t| t.id == id)
}

/// Mirrors `CliToolStatus` in contract/multi-account.ts.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct CliToolStatus {
    pub(crate) id: String,
    pub(crate) bin: String,
    pub(crate) installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) program: Option<String>,
    #[serde(rename = "npmPackage")]
    pub(crate) npm_package: String,
    #[serde(rename = "docsUrl")]
    pub(crate) docs_url: String,
}

/// Which tools have an `npm i -g` running right now. Guards the button against
/// a double-click and two installs against writing the same global prefix at
/// once; per-tool rather than global, so installing `grok` never blocks
/// installing `codex`.
fn in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

#[cfg_attr(not(test), allow(dead_code))] // only the unit tests read the set back
fn install_in_flight(id: &str) -> bool {
    in_flight()
        .lock()
        .map(|set| set.contains(id))
        .unwrap_or(false)
}

fn claim_install(id: &str) -> bool {
    in_flight()
        .lock()
        .map(|mut set| set.insert(id.to_string()))
        .unwrap_or(false)
}

fn release_install(id: &str) {
    if let Ok(mut set) = in_flight().lock() {
        set.remove(id);
    }
}

/// Probe all three. Sequential rather than threaded: the version probes are the
/// only slow part and they are bounded, so three at 4s worst case beats the
/// join machinery — and the common case is three sub-100ms answers.
pub(crate) fn probe_all() -> Vec<CliToolStatus> {
    TOOLS.iter().map(probe).collect()
}

fn probe(spec: &CliToolSpec) -> CliToolStatus {
    let program = crate::process_util::resolve_program(spec.bin);
    let version = program.as_deref().and_then(probe_version);
    CliToolStatus {
        id: spec.id.to_string(),
        bin: spec.bin.to_string(),
        installed: program.is_some(),
        version,
        program: program.map(|p| p.to_string_lossy().into_owned()),
        npm_package: spec.npm_package.to_string(),
        docs_url: spec.docs_url.to_string(),
    }
}

/// `<program> --version`, first line, bounded by `VERSION_TIMEOUT`.
///
/// A timeout returns `None` and the tool still reports `installed: true` — the
/// executable is on PATH, and a CLI that is slow to print a banner (or that
/// decides to check for its own update first) has not stopped being installed.
fn probe_version(program: &std::path::Path) -> Option<String> {
    let mut cmd = std::process::Command::new(program);
    cmd.arg("--version");
    if let Some(path) = crate::session::claude_path_env() {
        cmd.env("PATH", path);
    }
    // A version probe must never inherit the app's stdin: `grok` with no
    // arguments is a TUI, and a CLI that mis-parses the flag could otherwise sit
    // waiting on a terminal that will never answer.
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    crate::process_util::no_window(&mut cmd);
    let mut child = cmd.spawn().ok()?;

    let deadline = std::time::Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(VERSION_POLL),
            // Killed at the deadline, then reaped — a `Child` dropped without a
            // wait leaves a zombie, and this runs on every modal open.
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    first_version_line(&out)
}

/// The pure half: pick the line a user would recognise as a version out of
/// whatever the CLI printed. Leading blank lines and banner padding are common
/// enough to be worth skipping rather than reporting as an empty version.
pub(crate) fn first_version_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(80).collect())
}

/// Start `npm i -g <package>` for one tool, streaming its merged output onto
/// `francois://account/event` and re-probing when it exits.
///
/// Returns once the child is SPAWNED. A global install routinely takes tens of
/// seconds, and blocking the command would freeze the modal for all of it — the
/// same trade `account_codex_login` makes with the browser round-trip.
pub(crate) fn start_install(app: &AppHandle, id: &str) -> Result<(), AppError> {
    let Some(spec) = spec(id) else {
        return Err(error("INVALID_INPUT", format!("unknown CLI tool '{id}'")));
    };
    if !claim_install(spec.id) {
        return Err(error(
            "INVALID_INPUT",
            format!("an install of {} is already running", spec.bin),
        ));
    }

    match spawn_npm_install(spec.npm_package) {
        Ok(child) => {
            watch_install(app.clone(), spec.id, child);
            Ok(())
        }
        Err(e) => {
            release_install(spec.id);
            Err(e)
        }
    }
}

/// `npm i -g <package>`, output merged into one pipe.
///
/// npm is invoked through `npm_program()` rather than `Command::new("npm")` for
/// the reason `codex_program` documents: npm ships as `npm.cmd` on Windows and
/// bare `npm` fails with `NotFound` there even though it works in every shell.
fn spawn_npm_install(package: &str) -> Result<std::process::Child, AppError> {
    let Some(npm) = npm_program() else {
        return Err(error(
            "CLI_INSTALL_UNAVAILABLE",
            "npm could not be found on PATH, so Francois cannot install this CLI. \
             Install Node.js (which ships npm), or install the CLI yourself.",
        ));
    };

    let mut cmd = std::process::Command::new(npm);
    // `--no-fund --no-audit`: neither produces anything the user can act on
    // here, and both add seconds and noise to the stream this UI renders.
    cmd.args(["install", "--global", "--no-fund", "--no-audit", package]);
    if let Some(path) = crate::session::claude_path_env() {
        cmd.env("PATH", path);
    }
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    // `null` stdin, piped output: npm prompts for nothing under `-g`, and a
    // pipe with no writer would turn any prompt into an immediate EOF rather
    // than a hang. Both streams are piped because npm splits progress and
    // warnings across them and the user needs one readable transcript.
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::process_util::no_window(&mut cmd);
    cmd.spawn()
        .map_err(|e| error("SPAWN_FAILED", format!("could not start npm: {e}")))
}

/// npm's executable, Windows shim included. Deliberately not `update`'s
/// `npm_root_global` — that answers "where does npm install globally", which
/// needs a full `npm root -g` round trip this path has no use for.
fn npm_program() -> Option<std::ffi::OsString> {
    crate::process_util::resolve_program("npm").map(Into::into)
}

/// Pump both pipes onto the event channel, then re-probe and publish the
/// outcome. One thread per stream plus the waiter, because a single-threaded
/// read of stdout would block while stderr fills its buffer and deadlock the
/// child — the classic pipe deadlock, and npm writes to both.
fn watch_install(app: AppHandle, id: &'static str, mut child: std::process::Child) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let tail = std::sync::Arc::new(Mutex::new(String::new()));

    let mut pumps = Vec::new();
    for stream in [
        stdout.map(|s| Box::new(s) as Box<dyn Read + Send>),
        stderr.map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let app = app.clone();
        let tail = tail.clone();
        pumps.push(std::thread::spawn(move || pump(&app, id, stream, &tail)));
    }

    std::thread::spawn(move || {
        let status = child.wait();
        // Join AFTER the wait, so no output written just before exit is lost
        // between the last read and the done event the UI treats as terminal.
        for pump in pumps {
            let _ = pump.join();
        }
        release_install(id);

        let tools = probe_all();
        let installed = tools.iter().any(|t| t.id == id && t.installed);
        let error = match status {
            // FR-note: npm's exit code is not the last word. An install that
            // reports failure while the binary IS now on PATH (a postinstall
            // warning surfacing as non-zero) must not tell the user it failed,
            // and the re-probe is what settles it.
            Ok(s) if s.success() || installed => None,
            Ok(s) => Some(install_failure(s.code(), &tail)),
            Err(e) => Some(error(
                "CLI_INSTALL_FAILED",
                format!("npm did not finish: {e}"),
            )),
        };
        emit(
            &app,
            AccountEvent::CliInstallDone {
                tool: id.to_string(),
                tools,
                error,
            },
        );
    });
}

fn pump(app: &AppHandle, id: &'static str, mut stream: Box<dyn Read + Send>, tail: &Mutex<String>) {
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                if let Ok(mut tail) = tail.lock() {
                    tail.push_str(&chunk);
                    // Bounded from the FRONT: a failure's cause is at the end.
                    // Trimmed on a char boundary so the tail stays valid UTF-8.
                    if tail.len() > FAILURE_TAIL_BYTES {
                        let cut = tail.len() - FAILURE_TAIL_BYTES;
                        let cut = (cut..tail.len())
                            .find(|i| tail.is_char_boundary(*i))
                            .unwrap_or(tail.len());
                        *tail = tail[cut..].to_string();
                    }
                }
                emit(
                    app,
                    AccountEvent::CliInstallOutput {
                        tool: id.to_string(),
                        data: chunk,
                    },
                );
            }
        }
    }
}

fn install_failure(code: Option<i32>, tail: &Mutex<String>) -> AppError {
    let tail = tail.lock().map(|t| t.clone()).unwrap_or_default();
    AppError {
        code: "CLI_INSTALL_FAILED".into(),
        message: match code {
            Some(c) => format!("npm exited with code {c}"),
            None => "npm was terminated before it finished".into(),
        },
        detail: Some(json!({ "code": code, "tail": tail.trim_end() })),
    }
}

fn error(code: &str, message: impl Into<String>) -> AppError {
    AppError {
        code: code.into(),
        message: message.into(),
        detail: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The catalog is the whole trust boundary: `start_install` will only ever
    /// pass one of THESE package names to npm, and an id off this list is
    /// refused before a process exists.
    #[test]
    fn the_catalog_covers_the_three_documented_clis() {
        let ids: Vec<&str> = TOOLS.iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["claude", "codex", "grok"]);
        assert_eq!(
            spec("claude").unwrap().npm_package,
            "@anthropic-ai/claude-code"
        );
        assert_eq!(spec("codex").unwrap().npm_package, "@openai/codex");
        assert_eq!(spec("grok").unwrap().npm_package, "@xai-official/grok");
        assert!(spec("grok--; rm -rf /").is_none());
    }

    /// A probe answers for all three whether or not any is installed — the
    /// modal renders a row per tool and a missing entry would render nothing.
    #[test]
    fn a_probe_answers_for_every_tool_and_agrees_with_itself() {
        let tools = probe_all();
        assert_eq!(tools.len(), TOOLS.len());
        for tool in &tools {
            // `program` is present exactly when installed — the UI keys its
            // "where is it" line off that and must never show a path for a CLI
            // it just said was missing.
            assert_eq!(tool.installed, tool.program.is_some(), "{}", tool.id);
            assert!(!tool.npm_package.is_empty());
            if !tool.installed {
                assert!(tool.version.is_none(), "{}", tool.id);
            }
        }
    }

    #[test]
    fn a_status_serializes_under_the_contract_field_names() {
        let json = serde_json::to_value(CliToolStatus {
            id: "grok".into(),
            bin: "grok".into(),
            installed: false,
            version: None,
            program: None,
            npm_package: "@xai-official/grok".into(),
            docs_url: "https://docs.x.ai/build/overview".into(),
        })
        .unwrap();
        assert_eq!(json["id"], "grok");
        assert_eq!(json["installed"], false);
        assert_eq!(json["npmPackage"], "@xai-official/grok");
        // Absent, not null: `version?`/`program?` are optional in the contract,
        // and a null would typecheck as `string | undefined` nowhere.
        assert!(json.get("version").is_none());
        assert!(json.get("program").is_none());
    }

    #[test]
    fn the_install_events_serialize_under_their_contract_tags() {
        let out = serde_json::to_value(AccountEvent::CliInstallOutput {
            tool: "codex".into(),
            data: "added 1 package\n".into(),
        })
        .unwrap();
        assert_eq!(out["type"], "cli.install.output");
        assert_eq!(out["tool"], "codex");
        assert_eq!(out["data"], "added 1 package\n");

        let done = serde_json::to_value(AccountEvent::CliInstallDone {
            tool: "claude".into(),
            tools: vec![],
            error: None,
        })
        .unwrap();
        assert_eq!(done["type"], "cli.install.done");
        // Success is the ABSENCE of `error`, which is what the frontend branches
        // on — a null here would read as a failure with no message.
        assert!(done.get("error").is_none());
    }

    #[test]
    fn a_version_line_is_the_first_non_blank_one_bounded() {
        assert_eq!(
            first_version_line("\n\n1.2.3\nextra\n").as_deref(),
            Some("1.2.3")
        );
        assert_eq!(
            first_version_line("  grok 1.0.4  ").as_deref(),
            Some("grok 1.0.4")
        );
        assert_eq!(first_version_line("   \n  \n"), None);
        assert_eq!(first_version_line(""), None);
        assert_eq!(first_version_line(&"v".repeat(500)).unwrap().len(), 80);
    }

    /// Multi-byte output must not panic the tail trimmer — npm prints box glyphs
    /// in its update notice, and a naive byte slice would split one.
    #[test]
    fn the_failure_tail_trims_on_a_char_boundary() {
        let tail = Mutex::new(String::new());
        let chunk = "╭─ npm warn ─╮\n".repeat(400);
        {
            let mut t = tail.lock().unwrap();
            t.push_str(&chunk);
            if t.len() > FAILURE_TAIL_BYTES {
                let cut = t.len() - FAILURE_TAIL_BYTES;
                let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap();
                *t = t[cut..].to_string();
            }
        }
        let err = install_failure(Some(1), &tail);
        assert_eq!(err.code, "CLI_INSTALL_FAILED");
        assert_eq!(err.message, "npm exited with code 1");
        let detail = err.detail.unwrap();
        assert_eq!(detail["code"], 1);
        assert!(detail["tail"].as_str().unwrap().len() <= FAILURE_TAIL_BYTES);
    }

    /// Nothing is in flight until an install claims it, and a claim is released
    /// — otherwise the button would stay disabled for the rest of the run.
    #[test]
    fn an_install_claim_is_exclusive_and_released() {
        let id = "test-tool-claim";
        assert!(!install_in_flight(id));
        assert!(claim_install(id));
        assert!(install_in_flight(id));
        assert!(!claim_install(id), "a second claim is refused");
        release_install(id);
        assert!(!install_in_flight(id));
    }
}
