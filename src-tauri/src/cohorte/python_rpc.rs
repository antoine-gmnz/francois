//! The Python Cohorte `cohorte/1` transport. One local JSON-RPC connection is
//! initialized before it carries any request. The service owns credentials and
//! state; François only sees its bounded, redacted protocol responses.

use crate::ipc::{AppError, ErrorCode};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
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

fn cli() -> String {
    std::env::var("COHORTE_PYTHON_CLI").unwrap_or_else(|_| "cohorte".into())
}

/// The CLI is used only to locate or start the persistent user-owned service.
/// All project, run, event and decision traffic uses the local `cohorte/1` RPC.
pub(crate) fn service_endpoint() -> Result<String, AppError> {
    let executable = cli();
    for action in ["status", "start"] {
        let mut command = crate::process_util::spawn(&executable).arg("--json");
        if let Ok(data_dir) = std::env::var("COHORTE_PYTHON_DATA_DIR") {
            command = command.args(["--data-dir", &data_dir]);
        }
        let output = command.args(["service", action]).output().map_err(|_| {
            AppError::new(
                ErrorCode::CohorteCliMissing,
                "Python Cohorte is unavailable",
            )
        })?;
        if !output.status.success() || output.stdout.len() > MAX_FRAME {
            return Err(AppError::new(
                ErrorCode::CohorteCliIncompatible,
                "Cohorte must provide the cohorte/1 local service",
            ));
        }
        let document: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| invalid("Cohorte service status is invalid"))?;
        let data = document
            .get("data")
            .filter(|_| document["ok"] == true)
            .ok_or_else(|| failed("Cohorte service status failed"))?;
        if data["running"] == true {
            return data["socket"]
                .as_str()
                .or_else(|| data["pipe"].as_str())
                .map(str::to_owned)
                .ok_or_else(|| invalid("Cohorte service returned no endpoint"));
        }
    }
    Err(failed("Cohorte service did not start"))
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
