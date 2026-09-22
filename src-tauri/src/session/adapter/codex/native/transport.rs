//! One supervised JSONL connection. Responses are correlated before callbacks;
//! neither native errors nor secret-bearing response bodies become diagnostics.
use super::protocol::{self, Envelope, RequestId};
use crate::ipc::{AppError, ErrorCode};
use crate::process_util::OwnedChild;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

type Response = Result<Value, AppError>;
pub(super) type Receiver = Arc<dyn Fn(Result<Envelope, AppError>) + Send + Sync>;

pub(super) struct Transport {
    owner: Option<Arc<OwnedChild>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    pending: Mutex<HashMap<RequestId, mpsc::SyncSender<Response>>>,
    next: AtomicI64,
    closed: AtomicBool,
    receive: Receiver,
}
pub(super) fn unavailable() -> AppError {
    AppError::new(
        ErrorCode::RuntimeUnavailable,
        "Codex connection is unavailable",
    )
}
pub(super) fn protocol_error() -> AppError {
    AppError::new(
        ErrorCode::RuntimeProtocolError,
        "Codex returned an invalid native message",
    )
}
impl Transport {
    pub(super) fn spawn(
        ctx: &crate::session::application::TurnContext,
        receive: Receiver,
    ) -> Result<Arc<Self>, AppError> {
        let (program, args) = super::invocation::invocation(ctx);
        Self::spawn_program(
            &program,
            &args,
            if ctx.runtime == "wsl" { "" } else { &ctx.cwd },
            &ctx.execution.environment,
            receive,
        )
    }
    pub(super) fn spawn_program(
        program: &str,
        args: &[String],
        cwd: &str,
        environment: &[(String, String)],
        receive: Receiver,
    ) -> Result<Arc<Self>, AppError> {
        let mut command = crate::process_util::spawn(program);
        if !cwd.is_empty() {
            command = command.current_dir(cwd);
        }
        let child = command
            .args(args)
            .envs(environment.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .start_owned()
            .map_err(|error| {
                AppError::new(
                    ErrorCode::SpawnFailed,
                    if error.kind() == std::io::ErrorKind::NotFound {
                        super::super::CODEX_MISSING_HINT
                    } else {
                        "Could not start the Codex native process"
                    },
                )
            })?;
        let child = Arc::new(child);
        let stdin = child.take_stdin().ok_or_else(unavailable)?;
        let mut frames = child.take_frames().ok_or_else(unavailable)?;
        let connection = Arc::new(Self {
            owner: Some(child),
            writer: Mutex::new(Some(Box::new(stdin))),
            pending: Mutex::new(HashMap::new()),
            next: AtomicI64::new(0),
            closed: AtomicBool::new(false),
            receive,
        });
        let weak = Arc::downgrade(&connection);
        std::thread::spawn(move || loop {
            let frame = frames.read_frame();
            let Some(connection) = weak.upgrade() else {
                break;
            };
            if connection.closed.load(Ordering::SeqCst) {
                break;
            }
            match frame {
                Ok(Some(frame)) if frame.trim().is_empty() => continue,
                Ok(Some(frame)) => match protocol::decode_frame(frame.as_bytes()) {
                    Ok(envelope) => connection.ingest(envelope),
                    Err(_) => {
                        connection.fail(protocol_error());
                        break;
                    }
                },
                Ok(None) => {
                    connection.fail(unavailable());
                    break;
                }
                Err(error) => {
                    connection.fail(error);
                    break;
                }
            }
        });
        Ok(connection)
    }
    fn ingest(&self, envelope: Envelope) {
        let response = match envelope {
            Envelope::Success { id, result } => Some((id, Ok(result))),
            Envelope::Failure { id, code } => Some((
                id,
                Err(AppError::new(
                    if code == -32600 {
                        ErrorCode::SessionNotRunning
                    } else {
                        ErrorCode::RuntimeProtocolError
                    },
                    format!("Codex rejected native request ({code})"),
                )),
            )),
            event => {
                (self.receive)(Ok(event));
                None
            }
        };
        if let Some((id, response)) = response {
            let sender = self.pending.lock().unwrap().remove(&id);
            // Late or duplicate responses have no authority. They never consume
            // another request with an equal-looking string/number identifier.
            if let Some(sender) = sender {
                let _ = sender.send(response);
            }
        }
    }
    pub(super) fn write(&self, value: &Value) -> Result<(), AppError> {
        let mut writer = self.writer.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            return Err(unavailable());
        }
        let writer = writer.as_mut().ok_or_else(unavailable)?;
        serde_json::to_writer(&mut *writer, value).map_err(|_| unavailable())?;
        writer
            .write_all(b"\n")
            .and_then(|_| writer.flush())
            .map_err(|_| unavailable())
    }
    /// The absolute deadline covers the whole request, unaffected by unrelated
    /// notifications. Model execution has no deadline; this waits for its ack.
    pub(super) fn call(
        &self,
        deadline: Instant,
        encode: impl FnOnce(&RequestId) -> Result<Value, AppError>,
    ) -> Response {
        let next = self.next.fetch_add(1, Ordering::SeqCst);
        if next == i64::MAX {
            return Err(protocol_error());
        }
        let id = RequestId::Integer(next + 1);
        let wire = encode(&id)?;
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock().unwrap();
            if self.closed.load(Ordering::SeqCst) {
                return Err(unavailable());
            }
            if pending.len() >= 128 {
                return Err(protocol_error());
            }
            pending.insert(id.clone(), sender);
        }
        if let Err(error) = self.write(&wire) {
            self.pending.lock().unwrap().remove(&id);
            self.fail(error.clone());
            return Err(error);
        }
        let response = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        self.pending.lock().unwrap().remove(&id);
        match response {
            Ok(result) => result,
            Err(_) => {
                let error = AppError::new(
                    ErrorCode::RuntimeUnavailable,
                    "Codex did not acknowledge the native request before its deadline",
                );
                self.fail(error.clone());
                Err(error)
            }
        }
    }
    pub(super) fn fail(&self, error: AppError) {
        if self.close_once() {
            (self.receive)(Err(error));
        }
    }
    fn close_once(&self) -> bool {
        if self.closed.swap(true, Ordering::SeqCst) {
            return false;
        }
        // Stop the owned tree before acquiring stdin: a blocked pipe write is
        // released by termination and cannot hold session shutdown hostage.
        if let Some(owner) = &self.owner {
            let _ = owner.terminate();
        }
        self.writer.lock().unwrap().take();
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(unavailable()));
        }
        true
    }
    pub(super) fn close(&self) {
        self.close_once();
    }
    pub(super) fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn transport() -> Arc<Transport> {
        Arc::new(Transport {
            owner: None,
            writer: Mutex::new(Some(Box::new(Vec::<u8>::new()))),
            pending: Mutex::new(HashMap::new()),
            next: AtomicI64::new(0),
            closed: AtomicBool::new(false),
            receive: Arc::new(|_| {}),
        })
    }
    #[test]
    fn exact_response_id_routes_once_without_crossing_string_and_number() {
        let transport = transport();
        let (numeric_tx, numeric_rx) = mpsc::sync_channel(1);
        let (string_tx, string_rx) = mpsc::sync_channel(1);
        transport
            .pending
            .lock()
            .unwrap()
            .insert(RequestId::Integer(1), numeric_tx);
        transport
            .pending
            .lock()
            .unwrap()
            .insert(RequestId::String("1".into()), string_tx);
        transport.ingest(Envelope::Success {
            id: RequestId::String("1".into()),
            result: json!("string"),
        });
        assert_eq!(string_rx.try_recv().unwrap().unwrap(), json!("string"));
        assert!(numeric_rx.try_recv().is_err());
        transport.ingest(Envelope::Success {
            id: RequestId::String("1".into()),
            result: json!("replay"),
        });
        transport.ingest(Envelope::Success {
            id: RequestId::Integer(1),
            result: json!("number"),
        });
        assert_eq!(numeric_rx.try_recv().unwrap().unwrap(), json!("number"));
    }
    #[test]
    fn close_releases_waiters_and_rejects_every_future_write() {
        let transport = transport();
        let (sender, receiver) = mpsc::sync_channel(1);
        transport
            .pending
            .lock()
            .unwrap()
            .insert(RequestId::Integer(1), sender);
        transport.close();
        transport.close();
        assert!(receiver.try_recv().unwrap().is_err());
        assert!(transport.write(&json!({"secret":"never-written"})).is_err());
    }
    #[test]
    fn expired_request_deadline_closes_even_if_notifications_keep_arriving() {
        let transport = transport();
        for _ in 0..100 {
            transport.ingest(Envelope::Notification {
                method: "noise".into(),
                params: json!({}),
            });
        }
        assert!(transport
            .call(Instant::now(), |id| Ok(protocol::request(
                id,
                "initialize",
                json!({})
            )))
            .is_err());
        assert!(transport.closed.load(Ordering::SeqCst));
        assert!(transport.pending.lock().unwrap().is_empty());
    }
}
