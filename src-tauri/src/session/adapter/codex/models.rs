//! Account-scoped, bounded App Server catalogue discovery. No vendor-cache fallback.
use crate::ipc::{AppError, ErrorCode, ModelInfo};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

pub(crate) fn valid_effort(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

pub(super) fn spawn_failure() -> AppError {
    AppError::new(ErrorCode::SpawnFailed, "Unable to launch the Codex CLI.")
}

pub(super) fn failure(reason: &str) -> AppError {
    AppError::with_detail(
        ErrorCode::ModelCatalogUnavailable,
        if reason == "unsupported-cli" {
            "Codex model discovery is unavailable. Update or install the Codex CLI and retry."
        } else {
            "Codex models could not be loaded. Retry model discovery."
        },
        json!({"reason":reason}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: String,
    model: String,
    display_name: String,
    description: String,
    hidden: bool,
    supported_reasoning_efforts: Vec<Effort>,
    default_reasoning_effort: String,
    is_default: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Effort {
    reasoning_effort: String,
    description: String,
}
#[derive(Default)]
struct Accumulator {
    models: Vec<ModelInfo>,
    default_id: Option<String>,
    ids: HashSet<String>,
    cursors: HashSet<String>,
}
fn display(value: &str) -> Result<String, AppError> {
    if value.len() > 16 * 1024 {
        return Err(failure("protocol"));
    }
    Ok(value.chars().filter(|c| !c.is_control()).collect())
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= 256 && !id.chars().any(char::is_control)
}
impl Accumulator {
    fn page(&mut self, value: Value) -> Result<Option<String>, AppError> {
        let data = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| failure("protocol"))?;
        let cursor = match value.get("nextCursor") {
            Some(Value::Null) => None,
            Some(Value::String(s))
                if !s.is_empty() && s.len() <= 4096 && self.cursors.insert(s.clone()) =>
            {
                Some(s.clone())
            }
            _ => return Err(failure("protocol")),
        };
        for value in data {
            let row: Row =
                serde_json::from_value(value.clone()).map_err(|_| failure("protocol"))?;
            if !valid_id(&row.id)
                || !valid_id(&row.model)
                || row.supported_reasoning_efforts.len() > 32
                || !valid_effort(&row.default_reasoning_effort)
            {
                return Err(failure("protocol"));
            }
            let label = display(&row.display_name)?;
            let brief = display(&row.description)?;
            let mut efforts = Vec::new();
            for effort in row.supported_reasoning_efforts {
                display(&effort.description)?;
                if !valid_effort(&effort.reasoning_effort) {
                    return Err(failure("protocol"));
                }
                if !efforts.contains(&effort.reasoning_effort) {
                    efforts.push(effort.reasoning_effort);
                }
            }
            if row.hidden || !self.ids.insert(row.model.clone()) {
                continue;
            }
            if self.models.len() == 1000 {
                return Err(failure("limit"));
            }
            if row.is_default && self.default_id.is_none() {
                self.default_id = Some(row.model.clone());
            }
            self.models.push(ModelInfo {
                label: if label.is_empty() {
                    row.model.clone()
                } else {
                    label
                },
                id: row.model,
                brief: (!brief.is_empty()).then_some(brief),
                context_tokens: None,
                default_effort: efforts
                    .contains(&row.default_reasoning_effort)
                    .then_some(row.default_reasoning_effort),
                efforts,
            });
        }
        Ok(cursor)
    }
}

// Every probe remains owned through cleanup and application exit.
static ACTIVE: OnceLock<Mutex<Vec<Weak<Mutex<Child>>>>> = OnceLock::new();
static STOPPING: AtomicBool = AtomicBool::new(false);
struct ProbeChild(Arc<Mutex<Child>>);
impl ProbeChild {
    fn register(child: Child) -> Result<Self, AppError> {
        let child = Self(Arc::new(Mutex::new(child)));
        let mut active = ACTIVE.get_or_init(Default::default).lock().unwrap();
        if STOPPING.load(Ordering::SeqCst) {
            return Err(failure("runtime"));
        }
        active.retain(|weak| weak.strong_count() > 0);
        active.push(Arc::downgrade(&child.0));
        Ok(child)
    }
}
impl Drop for ProbeChild {
    fn drop(&mut self) {
        let mut child = self.0.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}
pub fn kill_probes() {
    STOPPING.store(true, Ordering::SeqCst);
    if let Some(active) = ACTIVE.get() {
        for weak in active.lock().unwrap().drain(..) {
            if let Some(child) = weak.upgrade() {
                let mut child = child.lock().unwrap();
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
fn send(writer: &SyncSender<Value>, value: Value) -> Result<(), AppError> {
    // A server sending requests without reading our rejection cannot block the deadline.
    writer.try_send(value).map_err(|_| failure("runtime"))
}
fn response(
    rx: &Receiver<Result<Value, AppError>>,
    writer: &SyncSender<Value>,
    id: u64,
    deadline: Instant,
) -> Result<Value, AppError> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| failure("timeout"))?;
        let value = rx.recv_timeout(remaining).map_err(|e| {
            failure(match e {
                std::sync::mpsc::RecvTimeoutError::Timeout => "timeout",
                _ => "runtime",
            })
        })??;
        if value.get("method").is_some() {
            if let Some(request_id) = value.get("id") {
                send(
                    writer,
                    json!({"id":request_id,"error":{"code":-32601,"message":"Method not found"}}),
                )?;
            }
            continue;
        }
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            return Err(failure("protocol"));
        }
        if let Some(error) = value.get("error") {
            return Err(failure(
                if error.get("code").and_then(Value::as_i64) == Some(-32601) {
                    "unsupported-cli"
                } else {
                    "runtime"
                },
            ));
        }
        return value
            .get("result")
            .cloned()
            .ok_or_else(|| failure("protocol"));
    }
}

pub(super) fn probe(
    program: &Path,
    home: &Path,
    timeout: Duration,
) -> Result<(Vec<ModelInfo>, Option<String>), AppError> {
    let deadline = Instant::now() + timeout;
    let path = crate::process_util::login_shell_path_env();
    if Instant::now() >= deadline {
        return Err(failure("timeout"));
    }
    let child = ProbeChild::register(
        crate::process_util::spawn(program)
            .args(["app-server", "--listen", "stdio://"])
            .scrubbed_env(path.as_deref())
            .env("CODEX_HOME", home)
            .current_dir(home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .start()
            .map_err(|_| spawn_failure())?,
    )?;
    let stdout = child
        .0
        .lock()
        .unwrap()
        .stdout
        .take()
        .ok_or_else(|| failure("runtime"))?;
    let mut stdin_pipe = child
        .0
        .lock()
        .unwrap()
        .stdin
        .take()
        .ok_or_else(|| failure("runtime"))?;
    let (stdin, writes) = sync_channel::<Value>(4);
    std::thread::spawn(move || {
        for value in writes {
            if serde_json::to_writer(&mut stdin_pipe, &value).is_err()
                || stdin_pipe
                    .write_all(b"\n")
                    .and_then(|_| stdin_pipe.flush())
                    .is_err()
            {
                break;
            }
        }
    });
    let (tx, rx) = sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut total = 0;
        loop {
            let mut bytes = Vec::new();
            let result = reader
                .by_ref()
                .take(2 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut bytes);
            match result {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    if n > 2 * 1024 * 1024 || total > 8 * 1024 * 1024 {
                        let _ = tx.send(Err(failure("limit")));
                        break;
                    }
                    let parsed = serde_json::from_slice(&bytes).map_err(|_| failure("protocol"));
                    let failed = parsed.is_err();
                    if tx.send(parsed).is_err() || failed {
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(Err(failure("runtime")));
                    break;
                }
            }
        }
    });
    send(
        &stdin,
        json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"francois","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false}}}),
    )?;
    response(&rx, &stdin, 1, deadline)?;
    send(&stdin, json!({"method":"initialized"}))?;
    let mut catalog = Accumulator::default();
    let mut cursor: Option<String> = None;
    for page in 0..32 {
        let id = page + 2;
        send(
            &stdin,
            json!({"id":id,"method":"model/list","params":{"cursor":cursor,"limit":100,"includeHidden":false}}),
        )?;
        cursor = catalog.page(response(&rx, &stdin, id, deadline)?)?;
        if cursor.is_none() {
            let default_id = catalog
                .default_id
                .or_else(|| catalog.models.first().map(|row| row.id.clone()));
            return Ok((catalog.models, default_id));
        }
    }
    Err(failure("limit"))
}

#[cfg(test)]
#[path = "catalog-tests.rs"]
mod catalog_tests;
