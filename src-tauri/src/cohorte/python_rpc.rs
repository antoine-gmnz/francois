//! The Python Cohorte `cohorte/1` transport. One local JSON-RPC connection is
//! initialized before it carries any request. The service owns credentials and
//! state; François only sees its bounded, redacted protocol responses.

use crate::ipc::{AppError, ErrorCode};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::time::Duration;
use uuid::Uuid;

const MAX_FRAME: usize = 1024 * 1024;

pub(crate) struct RpcClient {
    reader: BufReader<Box<dyn Read + Send>>,
    writer: Box<dyn Write + Send>,
    next_id: u64,
}

fn failed(message: &str) -> AppError {
    AppError::new(ErrorCode::CohorteCommandFailed, message)
}

fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::CohorteOutputInvalid, message)
}

/// FR-2 (cohorte-actions): the executable to spawn — `COHORTE_PYTHON_CLI` when
/// set, else the bare `cohorte` name (resolved through the login-shell PATH by
/// `process_util::spawn`). Shared by `service_endpoint()` and `actions_cli`.
pub(crate) fn cli() -> String {
    std::env::var("COHORTE_PYTHON_CLI").unwrap_or_else(|_| "cohorte".into())
}

/// FR-2: `["--data-dir", <dir>]` when `COHORTE_PYTHON_DATA_DIR` is set, else
/// empty — the same optional flag `service_endpoint()` passes, shared so
/// `actions_cli`'s spawn can't drift from it.
pub(crate) fn data_dir_args() -> Vec<String> {
    std::env::var("COHORTE_PYTHON_DATA_DIR")
        .map(|dir| vec!["--data-dir".to_string(), dir])
        .unwrap_or_default()
}

/// Each `cohorte service …` spawn is bounded: a wedged CLI must surface as an
/// error, never as a detection that stays "checking" forever.
const SERVICE_TIMEOUT: Duration = Duration::from_secs(15);

/// What one `cohorte --json service status|start|stop` document says.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ServiceState {
    Endpoint(String),
    NotRunning,
    /// Running, but no `pipe`/`socket` in the document. Cohorte 1.0.0a3 reads
    /// the address from `service.pid.json`, which a duplicate host deletes on
    /// its way out after losing the "already running" race — the service is
    /// alive yet unreachable until it is restarted.
    RunningWithoutEndpoint,
}

pub(crate) fn parse_service_status(stdout: &[u8]) -> Result<ServiceState, AppError> {
    if stdout.len() > MAX_FRAME {
        return Err(invalid("Cohorte service status is too large"));
    }
    let document: Value =
        serde_json::from_slice(stdout).map_err(|_| invalid("Cohorte service status is invalid"))?;
    let data = document
        .get("data")
        .filter(|_| document["ok"] == true)
        .ok_or_else(|| {
            failed(
                document["error"]["message"]
                    .as_str()
                    .unwrap_or("Cohorte service status failed"),
            )
        })?;
    if data["running"] != true {
        return Ok(ServiceState::NotRunning);
    }
    Ok(data["socket"]
        .as_str()
        .or_else(|| data["pipe"].as_str())
        .map(|e| ServiceState::Endpoint(e.to_owned()))
        .unwrap_or(ServiceState::RunningWithoutEndpoint))
}

fn service(action: &str) -> Result<ServiceState, AppError> {
    let run = crate::process_util::spawn(cli())
        .arg("--json")
        .args(data_dir_args())
        .args(["service", action])
        .run_bounded(SERVICE_TIMEOUT, MAX_FRAME + 1);
    if run.spawn_failed {
        return Err(AppError::new(
            ErrorCode::CohorteCliMissing,
            "Python Cohorte is unavailable",
        ));
    }
    if run.timed_out {
        return Err(AppError::new(
            ErrorCode::CohorteTimeout,
            format!("`cohorte service {action}` did not answer within 15 s"),
        ));
    }
    let state = parse_service_status(&run.stdout);
    if state.is_err() && !run.status.is_some_and(|s| s.success()) {
        return Err(AppError::new(
            ErrorCode::CohorteCliIncompatible,
            "Cohorte must provide the cohorte/1 local service",
        ));
    }
    state
}

/// The next `cohorte service` action to take from what the last one reported.
/// `None` means stop: either an endpoint is in hand or recovery is exhausted.
pub(crate) fn next_service_action(
    state: &ServiceState,
    already: &[&'static str],
) -> Option<&'static str> {
    match state {
        ServiceState::Endpoint(_) => None,
        ServiceState::NotRunning if !already.contains(&"start") => Some("start"),
        ServiceState::RunningWithoutEndpoint if !already.contains(&"stop") => Some("stop"),
        _ => None,
    }
}

/// The CLI is used only to locate or start the persistent user-owned service.
/// All project, run, event and decision traffic uses the local `cohorte/1` RPC.
/// A running service that lost its address is restarted once (stop → start).
pub(crate) fn service_endpoint() -> Result<String, AppError> {
    let mut done: Vec<&'static str> = vec!["status"];
    let mut state = service("status")?;
    while let Some(action) = next_service_action(&state, &done) {
        done.push(action);
        state = service(action)?;
    }
    match state {
        ServiceState::Endpoint(endpoint) => Ok(endpoint),
        ServiceState::RunningWithoutEndpoint => Err(failed(
            "The Cohorte service is running but did not report its address — run `cohorte service stop`, then check again",
        )),
        ServiceState::NotRunning => Err(failed("Cohorte service did not start")),
    }
}

impl RpcClient {
    pub(crate) fn connect(endpoint: &str) -> Result<Self, AppError> {
        #[cfg(unix)]
        let (reader, writer): (Box<dyn Read + Send>, Box<dyn Write + Send>) = {
            let stream = std::os::unix::net::UnixStream::connect(endpoint)
                .map_err(|_| failed("Cannot connect to the Cohorte service"))?;
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .map_err(|_| failed("Cannot configure the Cohorte connection"))?;
            let writer = stream
                .try_clone()
                .map_err(|_| failed("Cannot clone the Cohorte connection"))?;
            (Box::new(stream), Box::new(writer))
        };
        #[cfg(windows)]
        let (reader, writer): (Box<dyn Read + Send>, Box<dyn Write + Send>) = {
            let pipe = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(endpoint)
                .map_err(|_| failed("Cannot connect to the Cohorte named pipe"))?;
            let writer = pipe
                .try_clone()
                .map_err(|_| failed("Cannot clone the Cohorte named pipe"))?;
            (Box::new(pipe), Box::new(writer))
        };
        let mut client = Self {
            reader: BufReader::new(reader),
            writer,
            next_id: 1,
        };
        let hello = client.call_uninitialized(
            "initialize",
            json!({
                "protocol_major": 1,
                "protocol_minor": 0,
                "client": {"name": "francois", "version": env!("CARGO_PKG_VERSION")},
                "capabilities": ["events.replay", "events.live", "requests.respond", "runs.control"]
            }),
        )?;
        if hello["protocol_major"] != 1 {
            return Err(AppError::new(
                ErrorCode::CohorteCliIncompatible,
                "Cohorte service does not support cohorte/1",
            ));
        }
        Ok(client)
    }

    pub(crate) fn call(&mut self, method: &str, params: Value) -> Result<Value, AppError> {
        self.call_uninitialized(method, params)
    }

    fn call_uninitialized(&mut self, method: &str, params: Value) -> Result<Value, AppError> {
        let id = self.next_id;
        self.next_id += 1;
        let frame = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let mut bytes =
            serde_json::to_vec(&frame).map_err(|_| invalid("Cannot encode RPC request"))?;
        bytes.push(b'\n');
        if bytes.len() > MAX_FRAME {
            return Err(invalid("RPC request exceeds the frame limit"));
        }
        self.writer
            .write_all(&bytes)
            .and_then(|_| self.writer.flush())
            .map_err(|_| failed("Cohorte service connection was interrupted"))?;
        loop {
            let document = self.read_frame()?;
            if document.get("method").is_some() {
                continue;
            }
            if document["id"] != id {
                return Err(invalid("Cohorte service replied with a mismatched id"));
            }
            if document.get("error").is_some() {
                let code = document["error"]["data"]["code"]
                    .as_str()
                    .unwrap_or("PROTOCOL_ERROR");
                return Err(AppError::new(ErrorCode::CohorteRejected, code));
            }
            return document
                .get("result")
                .cloned()
                .ok_or_else(|| invalid("Cohorte service returned no result"));
        }
    }

    pub(crate) fn read_frame(&mut self) -> Result<Value, AppError> {
        let mut bytes = Vec::new();
        let count = (&mut self.reader)
            .take((MAX_FRAME + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                    AppError::new(ErrorCode::CohorteTimeout, "Cohorte service read timed out")
                }
                _ => failed("Cohorte event stream was interrupted"),
            })?;
        if count == 0 {
            return Err(failed("Cohorte service closed the connection"));
        }
        if count > MAX_FRAME {
            return Err(invalid("Cohorte response exceeds the frame limit"));
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid("Cohorte service returned invalid JSON"))
    }
}

pub(crate) fn mutation_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    use std::thread;

    #[test]
    fn handshake_precedes_rpc_call() {
        let path = std::path::Path::new("/tmp").join(format!("fc-{}.sock", Uuid::new_v4()));
        let listener = UnixListener::bind(&path).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let hello: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(hello["method"], "initialize");
            assert_eq!(hello["params"]["protocol_major"], 1);
            stream
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocol_major\":1}}\n")
                .unwrap();
            line.clear();
            reader.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "projects.list");
            stream
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"items\":[]}}\n")
                .unwrap();
        });
        let mut client = RpcClient::connect(path.to_str().unwrap()).unwrap();
        assert_eq!(
            client.call("projects.list", json!({})).unwrap()["items"],
            json!([])
        );
        server.join().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod service_tests {
    use super::*;

    fn parse(doc: &str) -> ServiceState {
        parse_service_status(doc.as_bytes()).unwrap()
    }

    #[test]
    fn running_with_pipe_is_an_endpoint() {
        let doc =
            r#"{"ok":true,"data":{"running":true,"pipe":"\\\\.\\pipe\\cohorte-ab","health":{}}}"#;
        assert!(matches!(parse(doc), ServiceState::Endpoint(p) if p.ends_with("cohorte-ab")));
        let doc = r#"{"ok":true,"data":{"running":true,"socket":"/tmp/c.sock"}}"#;
        assert_eq!(parse(doc), ServiceState::Endpoint("/tmp/c.sock".into()));
    }

    #[test]
    fn running_without_address_is_detected() {
        // Verbatim cohorte 1.0.0a3 output after its pid file was deleted.
        let doc = r#"{"ok": true, "data": {"running": true, "health": {"version": "1.0.0a3", "uptime_seconds": 0}}}"#;
        assert_eq!(parse(doc), ServiceState::RunningWithoutEndpoint);
    }

    #[test]
    fn not_running_keeps_its_advertised_pipe_out_of_the_way() {
        let doc = r#"{"ok":true,"data":{"running":false,"pipe":"\\\\.\\pipe\\x"}}"#;
        assert_eq!(parse(doc), ServiceState::NotRunning);
    }

    #[test]
    fn failures_carry_cohortes_message() {
        let err = parse_service_status(br#"{"ok":false,"error":{"message":"boom"}}"#).unwrap_err();
        assert_eq!(err.message, "boom");
        assert!(parse_service_status(b"not json").is_err());
    }

    #[test]
    fn recovery_is_bounded() {
        let none: [&str; 1] = ["status"];
        assert_eq!(
            next_service_action(&ServiceState::NotRunning, &none),
            Some("start")
        );
        assert_eq!(
            next_service_action(&ServiceState::RunningWithoutEndpoint, &none),
            Some("stop")
        );
        // after stop reports "not running", start once
        assert_eq!(
            next_service_action(&ServiceState::NotRunning, &["status", "stop"]),
            Some("start")
        );
        // start still without an address: give up, never loop
        assert_eq!(
            next_service_action(
                &ServiceState::RunningWithoutEndpoint,
                &["status", "stop", "start"]
            ),
            None
        );
        assert_eq!(
            next_service_action(&ServiceState::NotRunning, &["status", "start"]),
            None
        );
        assert_eq!(
            next_service_action(&ServiceState::Endpoint("x".into()), &none),
            None
        );
    }
}
